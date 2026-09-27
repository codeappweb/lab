#!/usr/bin/env node
// Engine runner — executable sequence:
//   select approved topic -> researching -> drafting -> validating -> ready
//   -> publishing -> published, with checkpoints, idempotency, locks,
//   retries/backoff, per-run limits, pause/resume, emergency stop,
//   hard stop at target_total.
//
// Commands:
//   node scripts/engine/runner.mjs status
//   node scripts/engine/runner.mjs preflight
//   node scripts/engine/runner.mjs plan [--limit N]
//   node scripts/engine/runner.mjs run --topics <file> [--dry-run]
//   node scripts/engine/runner.mjs pause | resume | stop
//   node scripts/engine/runner.mjs retry <JOB-ID>
//   node scripts/engine/runner.mjs verify <slug> [--sha <sha>] [--live]
//
// Safety: `run` without --dry-run REFUSES unless generation_enabled=true in
// data/engine-config.json. Emergency stop halts everything until `resume`.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.mjs';
import { StateStore } from './state.mjs';
import * as provider from './provider.mjs';
import { expandCandidates } from './topics.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function log(msg) { console.log('[engine] ' + msg); }
function fail(msg) { console.error('[engine] FATAL: ' + msg); process.exit(1); }

function listPosts(root) {
  const dir = path.join(root, '_posts');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(f => f.endsWith('.md'));
}
const slugOf = f => f.replace(/^\d{4}-\d{2}-\d{2}-/, '').replace(/\.md$/, '');

function manifestEntries(root) {
  const file = path.join(root, 'data', 'article-manifest.jsonl');
  const out = [];
  if (!fs.existsSync(file)) return out;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* skip corrupt line */ }
  }
  return out;
}

function approvedQueueSize(root) {
  const published = new Set(listPosts(root).map(slugOf));
  const seen = new Set();
  let n = 0;
  for (const e of manifestEntries(root)) {
    if (e.status !== 'planned') continue;
    const slug = e.slug || e.id;
    if (published.has(slug) || seen.has(slug)) continue;
    seen.add(slug); n++;
  }
  return n;
}

const cmd = process.argv[2];
const cfg = loadConfig(ROOT, fs);
const store = new StateStore(ROOT);

switch (cmd) {
  case 'status': {
    const posts = listPosts(ROOT).length;
    const byState = {};
    for (const j of store.data.jobs) byState[j.state] = (byState[j.state] || 0) + 1;
    console.log(JSON.stringify({
      published_posts: posts,
      target_total: cfg.target_total,
      remaining_to_target: Math.max(0, cfg.target_total - posts),
      approved_queue: approvedQueueSize(ROOT),
      jobs: byState,
      active_jobs: store.activeJobs().length,
      emergency_stop: store.data.emergency_stop,
      paused: store.data.paused,
      generation_enabled: cfg.generation_enabled,
      dry_run: cfg.dry_run,
      provider: cfg.provider,
      lock: store.data.lock,
      checkpoint: store.data.checkpoint
    }, null, 2));
    break;
  }

  case 'preflight': {
    const report = provider.preflight(ROOT, cfg);
    console.log(JSON.stringify(report, null, 2));
    if (!report.real_writer) log('NOTE: no real automated writer; local-session mode is the real path, mock is orchestration-test only');
    break;
  }

  case 'plan': {
    const posts = listPosts(ROOT).map(slugOf);
    const candidates = expandCandidates(ROOT, posts, manifestEntries(ROOT));
    const limIdx = process.argv.indexOf('--limit');
    const lim = limIdx >= 0 ? parseInt(process.argv[limIdx + 1], 10) : Infinity;
    const out = path.join(ROOT, 'data', 'topic-candidates.json');
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, JSON.stringify({
      generated_at: new Date().toISOString(),
      note: 'Candidates are NOT approved topics. Approval moves selected entries into the manifest with status "planned".',
      count: Math.min(candidates.length, lim),
      candidates: candidates.slice(0, lim)
    }, null, 2) + '\n');
    log('wrote data/topic-candidates.json with ' + Math.min(candidates.length, lim) + ' deduplicated candidates (approved manifest queue: ' + approvedQueueSize(ROOT) + ')');
    break;
  }

  case 'run': {
    if (store.isStopped()) fail('emergency stop is active; run `resume` only after review');
    const args = process.argv.slice(3);
    const dryRun = args.includes('--dry-run') || cfg.dry_run;
    if (!dryRun && !cfg.generation_enabled) {
      fail('generation_enabled=false in data/engine-config.json — refusing to run. Unattended generation stays disabled by design.');
    }
    const tIdx = args.indexOf('--topics');
    const topicsFile = tIdx >= 0 ? args[tIdx + 1] : null;
    const topics = topicsFile ? JSON.parse(fs.readFileSync(path.resolve(topicsFile), 'utf8')) : [];
    const list = Array.isArray(topics) ? topics : topics.topics || topics.candidates || [];
    if (!list.length) fail('no topics provided; run `plan`, approve topics into the manifest, then run');

    const runId = 'RUN-' + new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
    if (!store.acquireLock(runId, cfg)) fail('another run holds the lock (concurrency protection)');
    const started = Date.now();
    let produced = 0;
    try {
      for (const t of list) {
        if (store.isStopped()) { log('emergency stop observed mid-run; checkpoint saved'); break; }
        if (store.data.paused) { log('paused; resumable from checkpoint'); break; }
        if (produced >= cfg.per_run_article_limit) { log('per-run article limit reached'); break; }
        if ((Date.now() - started) / 1000 > cfg.per_run_seconds_limit) { log('per-run time limit reached'); break; }
        store.heartbeat(runId);

        const slug = t.slug;
        if (!slug) { log('skip topic without slug'); continue; }
        if (listPosts(ROOT).length >= cfg.target_total) { log('hard stop: target_total ' + cfg.target_total + ' reached'); break; }

        let job = store.jobBySlug(slug);
        if (job) log('job ' + job.id + ' for ' + slug + ' exists in state ' + job.state + ' — idempotent resume');
        else { job = store.createJob({ slug, topic: t }); store.transition(job.id, 'researching'); }

        const alreadyWritten = listPosts(ROOT).some(f => f.endsWith('-' + slug + '.md'));
        const postPath = path.join(ROOT, '_posts', new Date().toISOString().slice(0, 10) + '-' + slug + '.md');

        if (job.state === 'researching' && !alreadyWritten) store.transition(job.id, 'drafting');
        if (job.state === 'drafting' && !alreadyWritten) {
          try {
            const draft = provider.makeDraft(ROOT, job, cfg, cfg.provider);
            if (!dryRun) {
              fs.mkdirSync(path.dirname(postPath), { recursive: true });
              fs.writeFileSync(postPath, draft);
            }
            store.recordArtifact(job.id, 'file_written', dryRun ? 'dry-run: not written' : postPath);
            store.transition(job.id, 'validating');
          } catch (e) {
            store.recordError(job.id, e.message);
            if (job.retries < cfg.max_retries) {
              job.retries++; store.save();
              await new Promise(r => setTimeout(r, cfg.backoff_ms * job.retries));
              continue;
            }
            store.transition(job.id, 'failed', e.message);
            continue;
          }
        }
        if (job.state === 'validating') {
          if (dryRun) {
            log('dry-run: ' + slug + ' would proceed to validation gates (validate-deploy.mjs) and only then to ready/publish');
            store.transition(job.id, 'blocked', 'dry-run stops before publish');
          } else {
            store.transition(job.id, 'ready', 'awaiting validate-deploy green before publish');
            log(slug + ': ready — publish requires gates green, commit, Pages build, live verify');
          }
        }
        produced++;
      }
    } finally {
      store.data.runs.push({
        id: runId, started_at: new Date(started).toISOString(), ended_at: new Date().toISOString(),
        counts: { produced, considered: list.length }, status: dryRun ? 'dry-run' : 'run'
      });
      store.releaseLock(runId);
      store.save();
    }
    break;
  }

  case 'pause': store.data.paused = true; store.save(); log('paused — run refuses new work until resume'); break;
  case 'resume': store.data.paused = false; store.data.emergency_stop = false; store.save(); log('resumed'); break;
  case 'stop':
    store.data.emergency_stop = true; store.save();
    fail('EMERGENCY STOP recorded — all runs halted until explicit resume after review'); break;

  case 'retry': {
    const id = process.argv[3];
    const job = store.jobById(id);
    if (!job) fail('unknown job ' + id);
    if (!['failed', 'blocked'].includes(job.state)) fail('retry only valid for failed/blocked jobs (state=' + job.state + ')');
    store.transition(id, 'planned', 'manual retry');
    log(id + ' re-planned; next run resumes from checkpoint'); break;
  }

  case 'verify': {
    const slug = process.argv[3];
    const shaIdx = process.argv.indexOf('--sha');
    const sha = shaIdx >= 0 ? process.argv[shaIdx + 1] : null;
    const live = process.argv.includes('--live');
    const job = store.jobBySlug(slug);
    if (!job) fail('no active job for ' + slug);
    if (sha) { store.recordArtifact(job.id, 'committed_sha', sha); log('commit recorded'); }
    if (live) { store.recordArtifact(job.id, 'verified_live', new Date().toISOString()); store.transition(job.id, 'published', 'verified live'); log('published (verified live)'); }
    break;
  }

  default:
    console.error('Usage: runner.mjs status | preflight | plan | run --topics <file> [--dry-run] | pause | resume | stop | retry <id> | verify <slug> [--sha <sha>] [--live]');
    process.exit(2);
}
