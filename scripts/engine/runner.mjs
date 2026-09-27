#!/usr/bin/env node
// Engine runner — honest, executable sequence:
//   approved topic (manifest status=planned)
//     -> planned -> researching (real evidence required)
//     -> drafting (draft written to drafts/, NEVER to _posts)
//     -> validating (draft-level checks always; full repo gate suite when
//                    publishing for real)
//     -> ready (publication eligibility established ONLY after validation
//               actually succeeds)
//     -> publishing (milestone-driven, resumable without duplicates:
//                    file_write_planned -> file_written -> gates+build green
//                    -> committed_sha [content commit, post file ONLY]
//                    -> pushed -> verify)
//     -> published (ONLY after live verification: expected URL responds 200
//                   with the expected content identity AND the deployed
//                   Pages revision CONTAINS the content commit — compare
//                   status identical/ahead, never fragile SHA equality)
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
// and the deployed revision (compare API) before recording verified_live.
// It persists the recorded state as a LOCAL state commit and never pushes —
// so no commit/deploy/verify loop can occur.
//
// Concurrency & durability contract:
//   - the execution lock is acquired BEFORE any job is created or mutated;
//   - the lock is released in a finally block on every path (including
//     "no eligible work" and validation refusals);
//   - pause/stop are re-read from durable state before every job, between
//     stages, and immediately before irreversible publication operations;
//   - an interrupted publishing job resumes from its recorded milestones
//     without duplicate posts, duplicate commits or silent overwrites;
//     ambiguous evidence (file differs from draft, recorded sha absent from
//     the repository) is BLOCKED with actionable diagnostics.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.mjs';
import { StateStore, freshState, deployedRevisionOk } from './state.mjs';
import * as provider from './provider.mjs';
import { expandCandidates } from './topics.mjs';
import { parseFM } from '../lib/lab.mjs';

const DEFAULT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const ROOT = rootFromArgs(process.argv);
const SITEDOMAIN = 'https://codeappweb.github.io/lab';
// Error codes that BLOCK a job (no retry): they are deterministic failures.
const BLOCKING_CODES = ['E_NO_EVIDENCE', 'E_NO_DRAFT', 'E_NO_OUTLINE', 'E_PROVIDER_UNAVAILABLE', 'E_GATE_MISSING', 'E_DRAFT_INVALID', 'E_RESUME_AMBIGUOUS', 'E_DUPLICATE_POST', 'E_COMMIT_FAILED', 'E_BUILD_MISSING'];
// Codes that halt the run but leave the job resumable (never 'failed').
const HALT_CODES = ['E_RUN_HALTED'];

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

// ---------------------------------------------------------------------------
// Durable state/artifact persistence.
//
// The CONTENT commit (M4) and the STATE commits are deliberately separate:
// the content commit contains the post file ONLY, so its SHA is a stable,
// reviewable content identity; every later mutation of engine state
// (committed_sha, pushed, verified_live, regenerated artifacts: manifest,
// sitemap shards, progress, related-posts, taxonomy, topic queue) is
// committed through persistState() as its own "state(engine): ..." commit.
//
// persistState commits ONLY the engine-owned artifact paths (git commit with
// a pathspec — never touches unrelated staged files from another session),
// and ONLY when at least one of them actually changed (`git status
// --porcelain` guard), so re-running can never produce an empty state commit
// or a state-commit -> deploy -> verify -> state-commit loop: verify persists
// verified_live in the LOCAL tree and does NOT push (documented behavior;
// the next publishing run or a manual push carries it).
const STATE_ARTIFACT_PATHS = [
  'data/engine-state.json',
  'data/article-manifest.jsonl',
  'data/progress.json',
  'data/related-posts.json',
  'data/category-members.json',
  'data/article-taxonomy.yml',
  'data/topic-queue.json',
  'sitemaps',
  'reports',
];

// Returns true when a state commit was created. Returns false when there was
// nothing to commit, or when the root is not a git work tree (isolated
// selftest roots without git stay fully supported).
function persistState(root, label) {
  try {
    execFileSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: root, stdio: 'ignore' });
  } catch {
    return false;
  }
  let raw;
  try {
    raw = execFileSync('git', ['status', '--porcelain', '-z', '--', ...STATE_ARTIFACT_PATHS], { cwd: root, encoding: 'utf8' });
  } catch (e) {
    log('WARNING: cannot inspect state artifact status — state NOT committed: ' + (e.message || e));
    return false;
  }
  // Parse -z entries. A rename ('R ') carries the old path as an extra
  // NUL-separated token that is NOT a path to commit.
  const toks = raw.split('\0').filter(t => t !== '');
  const entries = [];
  for (let i = 0; i < toks.length; i++) {
    entries.push(toks[i].slice(3));
    if (toks[i].startsWith('R ')) i++;
  }
  if (!entries.length) return false;
  try {
    // Intent-to-add untracked engine artifacts (harmless for tracked ones),
    // then a pathspec commit that stages and commits exactly these paths,
    // leaving any unrelated staged files still staged and untouched.
    execFileSync('git', ['add', '-N', '--', ...entries], { cwd: root, stdio: 'pipe' });
    execFileSync('git', ['commit', '-m', 'state(engine): ' + label, '--', ...entries], { cwd: root, stdio: 'pipe' });
    return true;
  } catch (e) {
    log('WARNING: state commit failed — engine state remains valid in the working tree, persist manually with: git commit -m "state(engine): ' + label + '" -- data sitemaps reports (' + (e.message || e) + ')');
    return false;
  }
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

// Content gate suite (scripts/validate-deploy.mjs) over the current tree.
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

// Build gates: deterministic regeneration + real Jekyll build + rendered-output
// validation. Every real publication path MUST pass these; a failed build or
// rendered-link/sitemap check prevents publication. When the toolchain is
// unavailable the publication is BLOCKED (E_BUILD_MISSING) — never skipped.
function runBuildGates(root) {
  const gen = path.join(root, 'scripts', 'gen-site-data.mjs');
  if (fs.existsSync(gen)) {
    const g = spawnSync(process.execPath, [gen], { stdio: 'inherit', cwd: root });
    if (g.status !== 0) {
      const e = new Error('deterministic regeneration (gen-site-data) FAILED (exit ' + g.status + ') — publication blocked');
      e.code = 'E_GATES_FAILED';
      throw e;
    }
  }
  let buildOk = false, buildErr = null;
  try {
    const b = spawnSync('bundle', ['exec', 'jekyll', 'build'], { cwd: root, encoding: 'utf8' });
    if (b.status === 0) buildOk = true;
    else buildErr = (b.stderr || b.stdout || '').slice(0, 300);
  } catch (e) { buildErr = e.message; }
  if (!buildOk) {
    try {
      const b2 = spawnSync('jekyll', ['build'], { cwd: root, encoding: 'utf8' });
      if (b2.status === 0) buildOk = true;
      else buildErr = buildErr || (b2.stderr || b2.stdout || '').slice(0, 300);
    } catch (e) { buildErr = buildErr || e.message; }
  }
  if (!buildOk) {
    const e = new Error('Jekyll build unavailable or failed (' + (buildErr || 'unknown') + ') — publication BLOCKED (E_BUILD_MISSING). Install the toolchain (bundle install) or fix the build; rendering checks are never skipped.');
    e.code = 'E_BUILD_MISSING';
    throw e;
  }
  const vb = path.join(root, 'scripts', 'validate-built.mjs');
  if (!fs.existsSync(vb)) {
    const e = new Error('rendered-output validator scripts/validate-built.mjs not found under ' + root + ' — publication BLOCKED (E_BUILD_MISSING; rendered checks are mandatory on every publication path)');
    e.code = 'E_BUILD_MISSING';
    throw e;
  }
  const r = spawnSync(process.execPath, [vb, '--site', path.join(root, '_site')], { stdio: 'inherit', cwd: root });
  if (r.status !== 0) {
    const e = new Error('rendered-output validation FAILED (exit ' + r.status + ') — rendered links/sitemap must be valid before publication');
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
    if (report.status === 'test-only') console.error('[engine] NOTE: mock is orchestration-test only — never a real writer; nothing can be published from mock');
    if (report.status === 'manual-draft-ingestion') console.error('[engine] NOTE: manual draft ingestion — drafts must be authored in a local Mistral/Vibe session into drafts/; this is not automated writing');
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

    // CONCURRENCY CONTRACT: acquire the execution lock BEFORE creating or
    // mutating any job. All failure paths after this point flow through the
    // finally block, so the lock can never leak (note: process.exit would NOT
    // run finally — nothing below may call fail()/exit inside the try).
    const runId = 'RUN-' + new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
    if (!store.acquireLock(runId, cfg)) fail('another run holds the lock (concurrency protection)');
    const started = Date.now();
    let produced = 0;
    let exitAfterFinally = 0;   // 0 = success path; 1 = no eligible work
    let haltNote = null;
    const rejected = [];
    const jobs = [];
    try {
      store.reload();
      if (store.isStopped()) { log('emergency stop observed before work; lock released'); haltNote = 'stopped'; }
      else if (store.data.paused) { log('paused before work; resumable via `run --resume`'); haltNote = 'paused'; }

      // Build the work list AFTER the lock is held.
      if (!haltNote) {
        if (args.includes('--resume')) {
          // --resume includes EVERY resumable state, including in-flight
          // 'publishing' jobs: an interrupted publication is recovered from
          // its recorded milestones without duplicates.
          for (const j of store.data.jobs) {
            if (['planned', 'researching', 'drafting', 'validating', 'ready', 'publishing'].includes(j.state)) jobs.push(j.id);
            // Push-stage recovery: a job blocked by a FAILED PUSH has its
            // content commit recorded (committed_sha) but not pushed. It is
            // resumable directly at the push stage — no re-draft, no
            // duplicate post, no duplicate commit.
            else if (j.state === 'blocked' && j.committed_sha && !j.pushed) jobs.push(j.id);
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
          log('no eligible work. Use `run --topics <approved-topics.json>` and/or `run --resume` (docs/ENGINE-RUNBOOK.md)');
          exitAfterFinally = 1;
        }

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

          // Retry loop that HONORS cfg.max_retries (the old code retried once
          // inline regardless of the configured limit).
          let attempt = 0;
          for (;;) {
            try {
              processJob(job, { dryRun, wantPush, alreadyPublished });
              produced++;
              break;
            } catch (e) {
              store.reload();
              job = store.jobById(jobId);
              store.recordError(jobId, e.message);
              if (HALT_CODES.includes(e.code)) {
                // pause/stop observed between stages: leave the job in its
                // current state (resumable, NOT failed) and stop the run.
                haltNote = e.message;
                log(job.slug + ': HALTED (resumable via `run --resume`) — ' + e.message);
                break;
              }
              if (BLOCKING_CODES.includes(e.code)) {
                if (job.state !== 'blocked' && job.state !== 'failed') store.transition(jobId, 'blocked', e.code + ': ' + e.message);
                log(job.slug + ': BLOCKED — ' + e.message);
                break;
              }
              // Transient: bounded retry with backoff.
              if (attempt < cfg.max_retries) {
                attempt++;
                job.retries = (job.retries || 0) + 1;
                store.save();
                log(job.slug + ': transient failure (attempt ' + attempt + '/' + cfg.max_retries + '): ' + e.message);
                await sleep(Math.min(cfg.backoff_ms * attempt, 30000));
                store.reload();
                const again = store.jobById(jobId);
                if (!again || !['planned', 'researching', 'drafting', 'validating', 'ready', 'publishing'].includes(again.state)) break;
                continue; // actually retry the work
              }
              if (job.state !== 'failed' && job.state !== 'blocked') store.transition(jobId, 'failed', 'retries exhausted: ' + e.message);
              log(job.slug + ': FAILED after ' + cfg.max_retries + ' retries — ' + e.message);
              break;
            }
          }
          if (haltNote) break;
        }
      }
    } finally {
      store.reload();
      store.data.runs.push({
        id: runId, started_at: new Date(started).toISOString(), ended_at: new Date().toISOString(),
        counts: { produced, considered: jobs.length, rejected: rejected.length },
        rejected: rejected.map(r => ({ slug: r.slug, reason: r.reason })),
        status: dryRun ? 'dry-run' : 'run',
        halted: haltNote || null
      });
      store.releaseLock(runId);
      store.save();
    }
    if (exitAfterFinally) process.exit(1);
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
    // The content commit is recorded FIRST (it is the durable fact); the live
    // checks below decide whether verified_live may also be recorded. verify
    // itself NEVER commits — there is no commit/deploy/verify loop.
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

    // 2. The deployed Pages revision must CONTAIN the expected content commit.
    //    A file in _posts is NOT a verified published article, and later
    //    state/report commits legitimately follow the content commit, so
    //    SHA-equality is the wrong test: use the compare API (identical or
    //    ahead = the deployed revision includes the content commit).
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
    if (!latestBuild || !latestBuild.commit) {
      fail('BLOCKED: latest Pages build commit unknown — verified_live NOT recorded');
    }
    let compareStatus = null;
    try {
      const cmp = JSON.parse(execFileSync('gh', ['api', '/repos/codeappweb/lab/compare/' + sha + '...' + latestBuild.commit], { encoding: 'utf8' }));
      compareStatus = cmp.status; // identical | ahead | behind | diverged
    } catch (e) {
      fail('BLOCKED: cannot compare content commit with deployed revision via `gh api` (' + (e.message || e) + ') — verified_live NOT recorded');
    }
    const verdict = deployedRevisionOk(sha, latestBuild.commit, compareStatus);
    if (!verdict.ok) {
      fail('BLOCKED: ' + verdict.reason + ' (content ' + sha.slice(0, 8) + ', deployed ' + latestBuild.commit.slice(0, 8) + ') — verified_live NOT recorded');
    }
    store.recordArtifact(job.id, 'verified_live', { at: new Date().toISOString(), url: expectedUrl, status, deployed_commit: latestBuild.commit, compare: compareStatus });
    if (job.state === 'publishing') store.transition(job.id, 'published', 'verified live at expected URL; deployed revision contains content commit (' + compareStatus + ')');
    // Persist verified_live as a LOCAL state commit only. Deliberately NOT
    // pushed here: pushing from `verify` would re-trigger a Pages build and
    // invite a state-commit -> deploy -> verify -> state-commit loop. The
    // state commit travels with the next publishing run or a manual push;
    // until then verified_live is durable in the local branch only.
    const persisted = persistState(ROOT, 'record verified_live for ' + slug);
    if (persisted) log(slug + ': verified_live persisted in a local state commit (NOT pushed — no verify/deploy loop)');
    log(slug + ': verified live — URL 200, content identity matched, deployed revision contains ' + sha + ' (' + compareStatus + ')');
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

  // pause/stop are re-checked between stages and BEFORE irreversible operations
  // (copying into _posts, committing). A pause observed here halts the run and
  // leaves the job in its current state — resumable, never failed.
  function assertNotHalted() {
    store.reload();
    if (store.isStopped()) { const e = new Error('emergency stop observed between stages'); e.code = 'E_RUN_HALTED'; throw e; }
    if (store.data.paused) { const e = new Error('pause observed between stages'); e.code = 'E_RUN_HALTED'; throw e; }
  }

  if (alreadyPublished && ['planned', 'researching', 'drafting', 'validating', 'ready'].includes(job.state)) {
    if (!job.file_written) store.recordArtifact(job.id, 'file_written', 'pre-existing post file detected');
    store.transition(job.id, 'blocked', 'post file already exists in _posts; refusing duplicate work');
    log(job.slug + ': BLOCKED — post file already exists in _posts');
    return store.jobById(job.id);
  }

  // Push-stage recovery: a job blocked by a failed push (content commit
  // exists, not pushed) re-enters publishing directly. The milestone-driven
  // flow below then skips copy/gates/commit (all milestones present) and
  // retries only the push — no duplicate post, no duplicate commit.
  if (job.state === 'blocked' && job.committed_sha && !job.pushed) {
    store.transition(job.id, 'publishing', 'resume: recovering push stage after failed push (content commit ' + String(job.committed_sha).slice(0, 8) + ' already exists)');
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
      log(job.slug + ': ready in DRY-RUN — nothing written to _posts; publishing requires a real run (generation_enabled=true) plus gates + build + commit + Pages build + live verify');
      return store.jobById(job.id);
    }
    store.transition(job.id, 'publishing');
  }

  if (job.state === 'publishing') {
    if (dryRun) return store.jobById(job.id);
    // ---------------- MILESTONE-DRIVEN PUBLISHING (resumable) -----------
    // Recorded milestones, in order:
    //   file_write_planned : target path chosen (before any copy — survives a
    //                        crash between planning and copying)
    //   file_written       : post file copied into _posts and identical to draft
    //   committed_sha      : CONTENT commit sha (post file ONLY — engine-state
    //                        and reports are never part of the content commit,
    //                        so the content revision of a publication stays
    //                        addressable even after later state commits)
    //   pushed             : content commit pushed to the remote branch
    // Resume derives the next action from these + repository state; ambiguous
    // evidence blocks with E_RESUME_AMBIGUOUS instead of guessing.
    const draftPath = path.join(ROOT, 'drafts', job.slug + '.md');
    if (!fs.existsSync(draftPath) && !job.committed_sha) {
      // Pre-commit the draft is the reference content. After the content
      // commit exists it is the durable record — a fresh checkout (which
      // has no drafts/) must still be able to resume from the milestones.
      const e = new Error('draft missing at ' + draftPath + ' — cannot publish/resume');
      e.code = 'E_NO_DRAFT';
      throw e;
    }

    // M1: choose the target path exactly once (stable across restarts, so a
    // resume never writes a second, differently-dated copy).
    if (!job.file_write_planned) {
      const existing = listPosts(ROOT).filter(f => slugOf(f) === job.slug);
      if (existing.length && !job.file_written) {
        const e = new Error('post file for ' + job.slug + ' already exists in _posts without a recorded file_written milestone — refusing to overwrite or duplicate; inspect _posts and the job history, then record/rollback explicitly');
        e.code = 'E_DUPLICATE_POST';
        throw e;
      }
      const today = new Date().toISOString().slice(0, 10);
      store.recordArtifact(job.id, 'file_write_planned', path.join(ROOT, '_posts', today + '-' + job.slug + '.md'));
    }
    const postPath = job.file_write_planned;

    // M2: copy the draft — exactly once, verified against the draft.
    if (!job.file_written) {
      assertNotHalted(); // pause/stop BEFORE the irreversible copy
      if (fs.existsSync(postPath)) {
        // File present without the milestone: only acceptable as a crash
        // between copy and record, and ONLY when identical to the draft.
        const same = fs.readFileSync(postPath, 'utf8') === fs.readFileSync(draftPath, 'utf8');
        if (!same) {
          const e = new Error('post file ' + postPath + ' exists but DIFFERS from the draft — ambiguous interruption state; resolve manually (compare, then either delete the file or update the draft) and re-run');
          e.code = 'E_RESUME_AMBIGUOUS';
          throw e;
        }
      } else {
        // Content gates on the tree BEFORE the file lands.
        runGateSuite(ROOT);
        fs.mkdirSync(path.dirname(postPath), { recursive: true });
        fs.copyFileSync(draftPath, postPath);
      }
      store.recordArtifact(job.id, 'file_written', postPath);
    } else if (!fs.existsSync(job.file_written)) {
      const e = new Error('file_written milestone records ' + job.file_written + ' but that file no longer exists — ambiguous state; restore or clear the milestone explicitly');
      e.code = 'E_RESUME_AMBIGUOUS';
      throw e;
    } else if (!job.committed_sha && fs.readFileSync(job.file_written, 'utf8') !== fs.readFileSync(draftPath, 'utf8')) {
      // Pre-commit crash recovery: the draft is the reference. Once the
      // content commit exists it is the durable record (a fresh checkout has
      // no drafts/ — it must still be able to resume from the milestones),
      // and the draft may legitimately diverge afterwards.
      const e = new Error('post file ' + job.file_written + ' differs from the draft — the draft was modified after publication copying started; resolve manually (E_RESUME_AMBIGUOUS)');
      e.code = 'E_RESUME_AMBIGUOUS';
      throw e;
    }

    // M3: full gates + real build + rendered-output validation on the tree
    // WITH the post. Skipped only when the content commit already exists
    // (those gates passed before that commit; the commit is the record).
    if (!job.committed_sha) {
      assertNotHalted(); // pause/stop BEFORE gates that may take minutes
      runGateSuite(ROOT);
      runBuildGates(ROOT);
    }

    // M4: content commit — post file ONLY, via a pathspec commit so no
    // unrelated staged file (another session's work) can ride along, and so
    // the content revision stays separate from later state commits.
    let sha = null;
    let stateCommitted = false;
    if (!job.committed_sha) {
      assertNotHalted(); // pause/stop BEFORE the commit
      try {
        const rel = path.relative(ROOT, postPath);
        // Intent-to-add marks ONLY this path (unlike a full `git add`, it
        // never stages another session's files). The pathspec commit below
        // then commits exactly this file.
        execFileSync('git', ['add', '-N', '--', rel], { cwd: ROOT });
        // Pathspec commit: commits exactly this path even if other files are
        // staged. The post file does not need a full `git add` first.
        execFileSync('git', ['commit', '-m', 'content(engine): publish ' + job.slug + ' (controlled; gates + build green)', '--', rel], { cwd: ROOT });
        sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();
        // Integrity check: the content commit must contain the post file and
        // NOTHING else — a stray staged file caught here means the commit is
        // not a pure content identity, so refuse to trust it.
        const committedFiles = execFileSync('git', ['show', '--pretty=format:', '--name-only', sha], { cwd: ROOT, encoding: 'utf8' })
          .split('\n').map(s => s.trim()).filter(Boolean);
        if (committedFiles.length !== 1 || committedFiles[0] !== rel) {
          const err = new Error('content commit ' + sha.slice(0, 8) + ' contains [' + committedFiles.join(', ') + '] instead of exactly [' + rel + '] — refusing to record an impure content identity; reset and retry the commit manually');
          err.code = 'E_COMMIT_FAILED';
          store.recordError(job.id, err.message);
          throw err;
        }
      } catch (e) {
        if (e.code === 'E_COMMIT_FAILED') throw e;
        const err = new Error('commit failed: ' + (e.message || e) + ' — file written but NOT committed; commit/push manually (post file only), then run `verify ' + job.slug + ' --sha <content-commit-sha>`');
        err.code = 'E_COMMIT_FAILED';
        store.recordError(job.id, err.message);
        throw err;
      }
      store.recordArtifact(job.id, 'committed_sha', sha);
      // Persist the recorded milestone (and any regenerated artifacts) as a
      // SEPARATE state commit so a fresh checkout can recover the job.
      stateCommitted = persistState(ROOT, 'record committed_sha for ' + job.slug);
    } else {
      sha = job.committed_sha;
      // Durable-state consistency: the recorded content commit must still
      // exist in the repository (fresh checkouts must be able to trust it).
      try {
        execFileSync('git', ['cat-file', '-e', sha + '^{commit}'], { cwd: ROOT, stdio: 'ignore' });
      } catch (e) {
        const err = new Error('recorded committed_sha ' + sha + ' does not exist in this repository/checkout — pull the branch that contains it, or clear the milestone explicitly after review (E_RESUME_AMBIGUOUS)');
        err.code = 'E_RESUME_AMBIGUOUS';
        throw err;
      }
    }

    // M5: push (only with --push, only once).
    if (wantPush && !job.pushed) {
      assertNotHalted(); // pause/stop BEFORE the push
      try {
        execFileSync('git', ['push'], { cwd: ROOT });
        store.recordArtifact(job.id, 'pushed', { at: new Date().toISOString(), sha });
      } catch (e) {
        const err = new Error('push failed: ' + (e.message || e) + ' — content commit ' + sha + ' exists locally; push manually, wait for the Pages build, then verify');
        err.code = 'E_COMMIT_FAILED';
        store.recordError(job.id, err.message);
        throw err;
      }
      // The state commit (committed_sha etc.) is only remote-durable once it
      // is pushed too. If the content push just succeeded, push the state
      // commit as well; if that fails, say so honestly instead of claiming
      // remote durability.
      if (stateCommitted) {
        try {
          execFileSync('git', ['push'], { cwd: ROOT });
          log(job.slug + ': engine state commit pushed (job state is remote-durable)');
        } catch (e) {
          log('WARNING: state commit NOT pushed (' + (e.message || e) + ') — job state is committed locally only; push manually or it will not survive a fresh clone');
        }
      }
      log(job.slug + ': content commit ' + sha.slice(0, 8) + ' pushed — wait for the Pages build, then run: node scripts/engine/runner.mjs verify ' + job.slug + ' --sha ' + sha);
    } else if (!wantPush && !job.pushed) {
      log(job.slug + ': content commit ' + sha.slice(0, 8) + ' created (NOT pushed). Push, wait for the Pages build, then run: node scripts/engine/runner.mjs verify ' + job.slug + ' --sha ' + sha);
    } else if (job.pushed) {
      log(job.slug + ': content commit ' + sha.slice(0, 8) + ' already pushed — wait for the Pages build, then run: node scripts/engine/runner.mjs verify ' + job.slug + ' --sha ' + sha);
    }
    log(job.slug + ': published ONLY after `verify ' + job.slug + ' --sha ' + sha + '` confirms the live article and that the deployed revision contains the content commit');
    return store.jobById(job.id);
  }

  return store.jobById(job.id);
}
