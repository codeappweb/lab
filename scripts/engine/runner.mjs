#!/usr/bin/env node
// Engine runner — honest, executable sequence:
//   approved topic (manifest status=planned)
//     -> planned -> researching (real evidence required)
//     -> drafting (draft written to drafts/, NEVER to _posts)
//     -> validating (draft-level checks always; full repo gate suite when
//                    publishing for real)
//     -> ready (publication eligibility established ONLY after validation
//               actually succeeds)
//     -> publishing (file moved into _posts, gates re-run, commit created)
//     -> published (ONLY after live verification: expected URL responds 200
//                   with the expected content identity AND the deployed Pages
//                   revision matches the expected commit sha)
//   | blocked | failed at every stage.
//
// Commands (all support --root <dir> for isolated test roots):
//   node scripts/engine/runner.mjs status
//   node scripts/engine/runner.mjs preflight
//   node scripts/engine/runner.mjs plan [--limit N]
//   node scripts/engine/runner.mjs run --topics <file> [--dry-run] [--push]
//   node scripts/engine/runner.mjs run --resume [--dry-run] [--push]
//   node scripts/engine/runner.mjs pause | resume | stop
//   node scripts/engine/runner.mjs retry <JOB-ID>
//   node scripts/engine/runner.mjs recover
//   node scripts/engine/runner.mjs verify <slug> --sha <sha>
//
// Safety: `run` without --dry-run REFUSES unless generation_enabled=true in
// data/engine-config.json. The mock provider refuses to publish at all.
// `verify` never trusts flags: it checks the live URL, the content identity
// and the deployed revision before recording verified_live.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.mjs';
import { StateStore, freshState } from './state.mjs';
import * as provider from './provider.mjs';
import { expandCandidates } from './topics.mjs';
import { parseFM } from '../lib/lab.mjs';

const DEFAULT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const ROOT = rootFromArgs(process.argv);
const SITEDOMAIN = 'https://codeappweb.github.io/lab';

function rootFromArgs(argv) {
  const i = argv.indexOf('--root');
  if (i >= 0 && argv[i + 1]) return argv[i + 1].replace(/\/+$/, '');
  return DEFAULT_ROOT;
}

function log(msg) { console.log('[engine] ' + msg); }
function fail(msg) { console.error('[engine] FATAL: ' + msg); process.exit(1); }

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

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
    try { out.push(JSON.parse(line)); }
    catch { console.error('[engine] WARNING: corrupt manifest line reported (not silently ignored): ' + line.slice(0, 80)); }
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

// Vietnamese word count — documented method: whitespace-split syllable tokens
// (identical to scripts/validate-content-quality.mjs).
function wordCountVN(body) {
  return (body || '').replace(/[#>*_`\[\]()|-]/g, ' ').split(/\s+/).filter(t => /[a-zA-Zà-ỹÀ-Ỹ0-9]/.test(t)).length;
}

// Draft-level validation. ALWAYS runs before a job may become ready.
function validateDraft(draftText, job, cfg, mode, dryRun) {
  const errors = [];
  const fm = parseFM(draftText);
  const d = fm.data;
  const isMock = d.mock === true;
  if (isMock && !dryRun) errors.push('mock draft in a real (non-dry-run) run — mock content can never be published (provider="' + mode + '")');
  if (isMock && mode !== 'mock') errors.push('draft declares mock:true but provider is "' + mode + '" — fixture contamination');
  if (!d.title) errors.push('draft missing title');
  if (!d.description) errors.push('draft missing description');
  if (!d.id) errors.push('draft missing id');
  if (!d.parent_category || !d.child_category) errors.push('draft missing parent_category/child_category');
  if (!d.search_intent) errors.push('draft missing search_intent');
  if (!isMock) {
    const words = wordCountVN(fm.body);
    if (words < cfg.words_min || words > cfg.words_max) {
      errors.push('draft body ' + words + ' Vietnamese syllable-tokens outside required range ' + cfg.words_min + '-' + cfg.words_max + ' (documented VN counting method)');
    }
  }
  return { errors, fm };
}

function runGateSuite(root) {
  const gate = path.join(root, 'scripts', 'validate-deploy.mjs');
  if (!fs.existsSync(gate)) {
    const e = new Error('gate suite scripts/validate-deploy.mjs not found under ' + root);
    e.code = 'E_GATE_MISSING';
    throw e;
  }
  const r = spawnSync(process.execPath, [gate, '--root', root], { stdio: 'inherit', cwd: root });
  if (r.status !== 0) {
    const e = new Error('validation gates FAILED (exit ' + r.status + ') — publication blocked');
    e.code = 'E_GATES_FAILED';
    throw e;
  }
}

const cmd = process.argv[2];
const cfg = loadConfig(ROOT, fs);

// `recover` must work when the state file is corrupt, i.e. when no StateStore
// can be constructed. Handle it before anything touches the store.
if (cmd === 'recover') {
  const stateFile = path.join(ROOT, 'data', 'engine-state.json');
  let healthy = false;
  try { new StateStore(ROOT); healthy = true; } catch (e) { if (e.code !== 'E_STATE_CORRUPT') throw e; }
  if (healthy) {
    log('state file is healthy — nothing to recover');
  } else {
    const ts = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
    const archived = path.join(ROOT, 'data', 'engine-state.corrupt-' + ts + '.json');
    if (fs.existsSync(stateFile)) fs.copyFileSync(stateFile, archived);
    const d = freshState();
    d.recovery = { at: new Date().toISOString(), reason: 'manual recover from corrupt state', archived_to: path.basename(archived) };
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    fs.writeFileSync(stateFile, JSON.stringify(d, null, 2) + '\n');
    log('corrupt state archived to ' + path.basename(archived) + ' and a fresh state written. Review the archived file before deleting it.');
  }
  process.exit(0);
}

let store;
try {
  store = new StateStore(ROOT);
} catch (e) {
  if (e.code === 'E_STATE_CORRUPT') {
    fail(e.message);
  } else throw e;
}

switch (cmd) {
  case 'status': {
    const posts = listPosts(ROOT).length;
    const byState = {};
    for (const j of store.data.jobs) byState[j.state] = (byState[j.state] || 0) + 1;
    const pf = provider.preflight(ROOT, cfg);
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
      writer_status: { status: pf.status, automated_generation_possible: pf.automated_generation_possible, reason: pf.reason },
      lock: store.data.lock,
      checkpoint: store.data.checkpoint,
      recovery: store.data.recovery
    }, null, 2));
    break;
  }

  case 'preflight': {
    const report = provider.preflight(ROOT, cfg);
    console.log(JSON.stringify(report, null, 2));
    if (report.status === 'blocked') fail('provider is BLOCKED: ' + report.reason);
    if (report.status === 'test-only') log('NOTE: mock is orchestration-test only — never a real writer; nothing can be published from mock');
    if (report.status === 'manual-draft-ingestion') log('NOTE: manual draft ingestion — drafts must be authored in a local Mistral/Vibe session into drafts/; this is not automated writing');
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
    if (!dryRun && cfg.provider === 'mock') {
      fail('provider=mock cannot publish — mock content is test-only and must never reach production. Use a real writer path (mistral_vibe_local) for controlled publishing.');
    }
    const wantPush = args.includes('--push');

    // Build the work list ----------------------------------------------------
    const jobs = [];
    const rejected = [];

    if (args.includes('--resume')) {
      store.reload();
      for (const j of store.data.jobs) {
        if (['planned','researching','drafting','validating','ready'].includes(j.state)) jobs.push(j.id);
      }
      log('resume: ' + jobs.length + ' in-flight job(s) eligible from durable state');
    }

    const tIdx = args.indexOf('--topics');
    if (tIdx >= 0 && args[tIdx + 1]) {
      const topicsFile = path.resolve(args[tIdx + 1]);
      const topics = JSON.parse(fs.readFileSync(topicsFile, 'utf8'));
      const list = Array.isArray(topics) ? topics : topics.topics || topics.candidates || [];
      const manifest = manifestEntries(ROOT);
      const approved = new Map(manifest.filter(e => e.status === 'planned').map(e => [e.slug || e.id, e]));
      for (const t of list) {
        const slug = t.slug;
        if (!slug) { rejected.push({ slug: null, reason: 'topic without slug' }); continue; }
        if (!approved.has(slug)) {
          rejected.push({ slug, reason: 'NOT APPROVED: slug absent from data/article-manifest.jsonl with status=planned. Approve the topic first (docs/ENGINE-RUNBOOK.md).' });
          continue;
        }
        let job = store.jobBySlug(slug);
        if (!job) job = store.createJob({ slug, topic: t });
        else if (job.state === 'published') { rejected.push({ slug, reason: 'job already published' }); continue; }
        if (!jobs.includes(job.id)) jobs.push(job.id);
      }
    }

    for (const r of rejected) console.error('[engine] REJECTED: ' + (r.slug || '<no slug>') + ' — ' + r.reason);
    if (!jobs.length) {
      fail('no eligible work. Use `run --topics <approved-topics.json>` and/or `run --resume` (docs/ENGINE-RUNBOOK.md)');
    }

    const runId = 'RUN-' + new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
    if (!store.acquireLock(runId, cfg)) fail('another run holds the lock (concurrency protection)');
    const started = Date.now();
    let produced = 0;
    try {
      for (const jobId of jobs) {
        // Re-read DURABLE state every iteration: pause/stop issued by another
        // process (or before a crash) must be observed here, not stale memory.
        store.reload();
        if (store.isStopped()) { log('emergency stop observed mid-run; checkpoint saved'); break; }
        if (store.data.paused) { log('paused; resumable via `run --resume`'); break; }
        if (produced >= cfg.per_run_article_limit) { log('per-run article limit reached'); break; }
        if ((Date.now() - started) / 1000 > cfg.per_run_seconds_limit) { log('per-run time limit reached'); break; }
        store.heartbeat(runId);

        let job = store.jobById(jobId);
        if (!job) { log('job ' + jobId + ' disappeared from state; skipping'); continue; }
        if (listPosts(ROOT).length >= cfg.target_total) { log('hard stop: target_total ' + cfg.target_total + ' reached'); break; }
        const alreadyPublished = listPosts(ROOT).some(f => f.endsWith('-' + job.slug + '.md'));

        try {
          processJob(job, { dryRun, wantPush, alreadyPublished });
          produced++;
        } catch (e) {
          store.reload();
          job = store.jobById(jobId);
          store.recordError(jobId, e.message);
          if (['E_NO_EVIDENCE','E_NO_DRAFT','E_NO_OUTLINE','E_PROVIDER_UNAVAILABLE','E_GATE_MISSING'].includes(e.code)) {
            if (job.state !== 'blocked' && job.state !== 'failed') store.transition(jobId, 'blocked', e.code + ': ' + e.message);
            log(job.slug + ': BLOCKED — ' + e.message);
          } else if ((job.retries || 0) < cfg.max_retries) {
            job.retries = (job.retries || 0) + 1;
            store.save();
            log(job.slug + ': transient failure (attempt ' + job.retries + '/' + cfg.max_retries + '): ' + e.message);
            await sleep(Math.min(cfg.backoff_ms * job.retries, 30000));
            // Bounded retry that actually retries the work.
            try {
              processJob(store.jobById(jobId), { dryRun, wantPush, alreadyPublished });
              produced++;
            } catch (e2) {
              store.reload();
              store.recordError(jobId, e2.message);
              const j2 = store.jobById(jobId);
              if (j2.state !== 'failed' && j2.state !== 'blocked') store.transition(jobId, 'failed', 'retries exhausted: ' + e2.message);
              log(j2.slug + ': FAILED after ' + j2.retries + ' retries — ' + e2.message);
            }
          } else {
            if (job.state !== 'failed' && job.state !== 'blocked') store.transition(jobId, 'failed', 'retries exhausted: ' + e.message);
            log(job.slug + ': FAILED — ' + e.message);
          }
        }
      }
    } finally {
      store.reload();
      store.data.runs.push({
        id: runId, started_at: new Date(started).toISOString(), ended_at: new Date().toISOString(),
        counts: { produced, considered: jobs.length, rejected: rejected.length },
        rejected: rejected.map(r => ({ slug: r.slug, reason: r.reason })),
        status: dryRun ? 'dry-run' : 'run'
      });
      store.releaseLock(runId);
      store.save();
    }
    break;
  }

  case 'pause': store.reload(); store.data.paused = true; store.save(); log('paused — runs refuse new work until resume'); break;
  case 'resume': store.reload(); store.data.paused = false; store.data.emergency_stop = false; store.save(); log('resumed'); break;
  case 'stop':
    store.reload(); store.data.emergency_stop = true; store.save();
    fail('EMERGENCY STOP recorded — all runs halted until explicit resume after review'); break;

  case 'retry': {
    const id = process.argv[3];
    const job = store.jobById(id);
    if (!job) fail('unknown job ' + id);
    if (!['failed', 'blocked'].includes(job.state)) fail('retry only valid for failed/blocked jobs (state=' + job.state + ')');
    job.retries = 0;
    store.transition(id, 'planned', 'manual retry; execute with `run --resume`');
    log(id + ' re-planned. The retry only takes effect when a run processes it: node scripts/engine/runner.mjs run --resume ' + (cfg.dry_run || !cfg.generation_enabled ? '--dry-run' : ''));
    break;
  }

  case 'verify': {
    const slug = process.argv[3];
    const shaIdx = process.argv.indexOf('--sha');
    const sha = shaIdx >= 0 ? process.argv[shaIdx + 1] : null;
    const job = store.jobBySlug(slug);
    if (!job) fail('no job for ' + slug);
    if (!sha) fail('expected deployed revision (--sha <commit-sha>) is REQUIRED — verified_live is never recorded without it');
    if (job.committed_sha && job.committed_sha !== sha) fail('--sha ' + sha + ' does not match recorded committed_sha ' + job.committed_sha);
    store.recordArtifact(job.id, 'committed_sha', sha);

    // 1. Live article check: the expected URL must respond 200 AND contain the
    //    expected content identity. A flag is not evidence.
    const expectedUrl = SITEDOMAIN + '/' + slug + '/';
    let status = 0, body = '';
    try {
      const r = await fetch(expectedUrl + '?v=' + Date.now(), { redirect: 'follow' });
      status = r.status;
      body = await r.text();
    } catch { /* network unavailable */ }
    if (status !== 200) fail('BLOCKED: expected URL ' + expectedUrl + ' did not respond 200 (got ' + status + ') — verified_live NOT recorded');
    const title = job.topic && job.topic.title ? String(job.topic.title) : slug;
    if (!body.toLowerCase().includes(title.toLowerCase().slice(0, 40))) {
      fail('BLOCKED: page at ' + expectedUrl + ' does not contain the expected article identity — verified_live NOT recorded');
    }

    // 2. The deployed Pages revision must match the expected sha.
    let pages = null;
    try {
      pages = JSON.parse(execFileSync('gh', ['api', '/repos/codeappweb/lab/pages'], { encoding: 'utf8' }));
    } catch (e) {
      fail('BLOCKED: cannot read GitHub Pages status via `gh api` (' + (e.message || e) + ') — verified_live NOT recorded');
    }
    if (!pages || pages.status !== 'built') fail('BLOCKED: Pages status is ' + (pages && pages.status) + ', not "built" — verified_live NOT recorded');
    let latestBuild = null;
    try {
      const builds = JSON.parse(execFileSync('gh', ['api', '/repos/codeappweb/lab/pages/builds?per_page=1'], { encoding: 'utf8' }));
      latestBuild = Array.isArray(builds) ? builds[0] : ((builds.builds || [])[0]);
    } catch { /* handled below */ }
    if (!latestBuild || latestBuild.commit !== sha) {
      fail('BLOCKED: latest Pages build commit is ' + (latestBuild && latestBuild.commit) + ', expected ' + sha + ' — the deployed revision does not contain this article; verified_live NOT recorded');
    }
    store.recordArtifact(job.id, 'verified_live', { at: new Date().toISOString(), url: expectedUrl, status, deployed_commit: latestBuild.commit });
    if (job.state === 'publishing') store.transition(job.id, 'published', 'verified live at expected URL with matching deployed revision');
    log(slug + ': verified live — URL 200, content identity matched, deployed revision == ' + sha);
    break;
  }

  default:
    console.error('Usage: runner.mjs status | preflight | plan | run --topics <file> | run --resume [--dry-run] [--push] | pause | resume | stop | retry <id> | recover | verify <slug> --sha <sha>');
    process.exit(2);
}

// ---------------------------------------------------------------------------
// Job processing — one pass through the state machine for one job.
function processJob(job, opts) {
  const { dryRun, wantPush, alreadyPublished } = opts;

  if (alreadyPublished && ['planned','researching','drafting','validating','ready'].includes(job.state)) {
    if (!job.file_written) store.recordArtifact(job.id, 'file_written', 'pre-existing post file detected');
    store.transition(job.id, 'blocked', 'post file already exists in _posts; refusing duplicate work');
    log(job.slug + ': BLOCKED — post file already exists in _posts');
    return store.jobById(job.id);
  }

  if (job.state === 'planned') store.transition(job.id, 'researching');

  if (job.state === 'researching') {
    const evidence = provider.collectEvidence(ROOT, job, cfg, cfg.provider);
    store.recordArtifact(job.id, 'evidence', { kind: evidence.kind || 'meta', note: 'evidence collected', at: new Date().toISOString() });
    store.transition(job.id, 'drafting');
  }

  if (job.state === 'drafting') {
    const outline = provider.buildOutline(ROOT, job, cfg, cfg.provider);
    store.recordArtifact(job.id, 'outline', { sections: outline.sections || [] });
    const draft = provider.makeDraft(ROOT, job, cfg, cfg.provider);
    const draftPath = path.join(ROOT, 'drafts', job.slug + '.md');
    if (!dryRun) {
      fs.mkdirSync(path.dirname(draftPath), { recursive: true });
      fs.writeFileSync(draftPath, draft);
    }
    store.recordArtifact(job.id, 'draft_written', dryRun ? 'dry-run: draft validated in memory, not written' : draftPath);
    store.transition(job.id, 'validating');
  }

  if (job.state === 'validating') {
    // Validation ACTUALLY runs here. ready is reachable only on success.
    const draftPath = path.join(ROOT, 'drafts', job.slug + '.md');
    let draftText = null;
    if (fs.existsSync(draftPath)) draftText = fs.readFileSync(draftPath, 'utf8');
    else if (dryRun && cfg.provider === 'mock') draftText = provider.makeDraft(ROOT, job, cfg, cfg.provider); // deterministic mock
    if (!draftText) {
      const e = new Error('draft missing at ' + draftPath + ' — cannot validate');
      e.code = 'E_NO_DRAFT';
      throw e;
    }
    const { errors } = validateDraft(draftText, job, cfg, cfg.provider, dryRun);
    if (errors.length) {
      const e = new Error('draft validation failed: ' + errors.join('; '));
      e.code = 'E_DRAFT_INVALID';
      throw e;
    }
    store.recordArtifact(job.id, 'validation', { draft_checks: 'passed', at: new Date().toISOString(), gates: dryRun ? 'dry-run: draft-level checks only' : 'draft-level + full repo gate suite' });
    store.transition(job.id, 'ready', 'draft validation passed; publication eligibility established');
  }

  if (job.state === 'ready') {
    if (dryRun) {
      log(job.slug + ': ready in DRY-RUN — nothing written to _posts; publishing requires a real run (generation_enabled=true) plus gates + commit + Pages build + live verify');
      return store.jobById(job.id);
    }
    store.transition(job.id, 'publishing');
  }

  if (job.state === 'publishing') {
    if (dryRun) return store.jobById(job.id);
    const draftPath = path.join(ROOT, 'drafts', job.slug + '.md');
    if (!fs.existsSync(draftPath)) {
      const e = new Error('draft missing at ' + draftPath + ' — cannot publish');
      e.code = 'E_NO_DRAFT';
      throw e;
    }
    const postPath = path.join(ROOT, '_posts', new Date().toISOString().slice(0, 10) + '-' + job.slug + '.md');
    // Full repo gate suite over the current tree, then again with the new
    // post included. Any failure blocks publishing and reverts the file.
    runGateSuite(ROOT);
    fs.mkdirSync(path.dirname(postPath), { recursive: true });
    fs.copyFileSync(draftPath, postPath);
    try {
      runGateSuite(ROOT);
    } catch (e) {
      try { fs.unlinkSync(postPath); } catch { /* already gone */ }
      throw e;
    }
    store.recordArtifact(job.id, 'file_written', postPath);
    // Commit (never push unless --push was explicitly requested).
    let sha = null;
    try {
      const rel = path.relative(ROOT, postPath);
      execFileSync('git', ['add', rel, 'data/engine-state.json'], { cwd: ROOT });
      execFileSync('git', ['commit', '-m', 'content(engine): publish ' + job.slug + ' (controlled, gates green)'], { cwd: ROOT });
      sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();
      if (wantPush) {
        execFileSync('git', ['push'], { cwd: ROOT });
        log(job.slug + ': committed and pushed ' + sha.slice(0, 8));
      } else {
        log(job.slug + ': committed ' + sha.slice(0, 8) + ' (NOT pushed). Push, wait for the Pages build, then run: node scripts/engine/runner.mjs verify ' + job.slug + ' --sha ' + sha);
      }
    } catch (e) {
      // Commit infrastructure unavailable: file written and gates green, but
      // publication is NOT complete — honest failure, nothing hidden.
      const err = new Error('commit failed: ' + (e.message || e) + ' — file written but not committed; commit/push manually, then verify');
      err.code = 'E_COMMIT_FAILED';
      store.recordError(job.id, err.message);
      throw err;
    }
    store.recordArtifact(job.id, 'committed_sha', sha);
    log(job.slug + ': published ONLY after `verify ' + job.slug + ' --sha ' + sha + '` confirms the live article and deployed revision');
    return store.jobById(job.id);
  }

  return store.jobById(job.id);
}
