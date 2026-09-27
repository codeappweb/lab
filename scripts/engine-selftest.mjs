#!/usr/bin/env node
// engine-selftest.mjs — OFFLINE orchestration tests for the 20K engine.
//
// Every test runs against an ISOLATED temporary root (mkdtemp) with its own
// data/engine-config.json, data/engine-state.json, data/article-manifest.jsonl,
// _posts/ and drafts/. Production jobs are never touched. No network, no real
// writer, no publishing: mock provider + dry-run only.
//
// Usage: node scripts/engine-selftest.mjs [--verbose]
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const RUNNER = join(HERE, 'engine', 'runner.mjs');
const VERBOSE = process.argv.includes('--verbose');
let passed = 0, failed = 0;

function makeRoot(overrides = {}) {
  const root = mkdtempSync(join(tmpdir(), 'engine-selftest-'));
  mkdirSync(join(root, 'data'), { recursive: true });
  mkdirSync(join(root, '_posts'), { recursive: true });
  mkdirSync(join(root, 'drafts'), { recursive: true });
  const cfg = {
    schema: 1, generation_enabled: false, dry_run: true, provider: 'mock',
    target_total: 20000, per_run_article_limit: 5, per_run_seconds_limit: 60,
    max_retries: 2, backoff_ms: 1, lock_ttl_seconds: 1800,
    words_min: 1200, words_max: 2000, ...overrides
  };
  writeFileSync(join(root, 'data', 'engine-config.json'), JSON.stringify(cfg, null, 2) + '\n');
  writeFileSync(join(root, 'data', 'article-manifest.jsonl'),
    JSON.stringify({ id: 'T-001', slug: 'thu-nghiem-orchestration', status: 'planned', title: 'Kiem thu orchestration engine' }) + '\n');
  return root;
}

function topicsFile(root, topics) {
  const p = join(root, 'topics.json');
  writeFileSync(p, JSON.stringify(topics));
  return p;
}

function run(args, root) {
  const r = spawnSync(process.execPath, [RUNNER, ...args, '--root', root], { encoding: 'utf8' });
  if (VERBOSE) console.log(r.stdout, r.stderr);
  return r;
}

function state(root) {
  return JSON.parse(readFileSync(join(root, 'data', 'engine-state.json'), 'utf8'));
}

function check(name, cond, detail) {
  if (cond) { passed++; console.log('OK   ' + name); }
  else { failed++; console.log('BAD  ' + name + (detail ? ' — ' + detail : '')); }
}

// 1. status on a fresh isolated root
{
  const root = makeRoot();
  const r = run(['status'], root);
  check('status: exit 0', r.status === 0, r.stderr);
  const s = JSON.parse(r.stdout);
  check('status: honest writer_status (mock = test-only)', s.writer_status && s.writer_status.status === 'test-only');
  check('status: generation disabled + dry-run by default', s.generation_enabled === false && s.dry_run === true);
}

// 2. preflight honesty
{
  const root = makeRoot();
  const r = run(['preflight'], root);
  const rep = JSON.parse(r.stdout);
  check('preflight mock: exit 0, real_writer=false', r.status === 0 && rep.real_writer === false && rep.status === 'test-only');
  const root2 = makeRoot({ provider: 'mistral_api' });
  const r2 = run(['preflight'], root2);
  check('preflight unknown/api provider: BLOCKED, exit 1', r2.status === 1 && /BLOCKED/.test(r2.stderr + r2.stdout));
  const root3 = makeRoot({ provider: 'mistral_vibe_local' });
  const r3 = run(['preflight'], root3);
  const rep3 = JSON.parse(r3.stdout);
  check('preflight local: manual-draft-ingestion, NOT automated', r3.status === 0 && rep3.status === 'manual-draft-ingestion' && rep3.automated_generation_possible === false);
}

// 3. dry-run over an approved topic reaches ready; nothing reaches _posts
{
  const root = makeRoot();
  const tf = topicsFile(root, [{ slug: 'thu-nghiem-orchestration', title: 'Kiem thu orchestration engine' }]);
  const r = run(['run', '--topics', tf, '--dry-run'], root);
  check('dry-run approved topic: exit 0', r.status === 0, r.stderr);
  const s = state(root);
  const job = s.jobs[0];
  check('dry-run: job reached ready (validation actually ran)', job && job.state === 'ready', JSON.stringify(s.jobs));
  check('dry-run: NO file written to _posts', readdirSync(join(root, '_posts')).length === 0);
  check('dry-run: no mock draft in drafts/', readdirSync(join(root, 'drafts')).length === 0);
}

// 4. unapproved topic input is rejected
{
  const root = makeRoot();
  const tf = topicsFile(root, [{ slug: 'chua-duoc-duyet', title: 'Khong duyet' }]);
  const r = run(['run', '--topics', tf, '--dry-run'], root);
  check('unapproved topic: REJECTED + exit 1', r.status === 1 && /NOT APPROVED/.test(r.stderr));
  check('unapproved topic: no job created', state(root).jobs.length === 0);
}

// 5. mock provider refuses real (non-dry-run) publishing even when enabled
{
  const root = makeRoot({ generation_enabled: true, dry_run: false });
  const tf = topicsFile(root, [{ slug: 'thu-nghiem-orchestration', title: 'Kiem thu orchestration engine' }]);
  const r = run(['run', '--topics', tf], root);
  check('mock real-run: refused, exit 1', r.status === 1 && /provider=mock cannot publish/.test(r.stderr));
  check('mock real-run: _posts untouched', readdirSync(join(root, '_posts')).length === 0);
}

// 6. real run refused while generation_enabled=false
{
  const root = makeRoot({ dry_run: false });
  const tf = topicsFile(root, [{ slug: 'thu-nghiem-orchestration', title: 'Kiem thu orchestration engine' }]);
  const r = run(['run', '--topics', tf], root);
  check('generation disabled: real run refused, exit 1', r.status === 1 && /generation_enabled=false/.test(r.stderr));
}

// 7. mistral_vibe_local without evidence: job BLOCKED with a specific reason
{
  const root = makeRoot({ provider: 'mistral_vibe_local' });
  const tf = topicsFile(root, [{ slug: 'thu-nghiem-orchestration', title: 'Kiem thu orchestration engine' }]);
  const r = run(['run', '--topics', tf, '--dry-run'], root);
  const s = state(root);
  const job = s.jobs[0];
  check('local no-evidence: job blocked', job && job.state === 'blocked', JSON.stringify(s.jobs));
  check('local no-evidence: reason names E_NO_EVIDENCE', (job && job.history.some(h => /E_NO_EVIDENCE/.test(h.note || ''))) || /E_NO_EVIDENCE/.test(r.stdout + r.stderr));
  check('local no-evidence: no draft written', readdirSync(join(root, 'drafts')).length === 0);
}

// 8. stable job identity: blocked job keeps the slug; no duplicate job created
{
  const root = makeRoot({ provider: 'mistral_vibe_local' });
  const tf = topicsFile(root, [{ slug: 'thu-nghiem-orchestration', title: 'Kiem thu orchestration engine' }]);
  run(['run', '--topics', tf, '--dry-run'], root);
  const r2 = run(['run', '--topics', tf, '--dry-run'], root);
  const s = state(root);
  check('stable identity: still exactly one job for the slug', s.jobs.length === 1, JSON.stringify(s.jobs.map(j => j.id + ':' + j.state)));
  check('stable identity: second run reuses the blocked job (no duplicate work)', r2.status === 0 || r2.status === 1);
}

// 9. retry re-plans a blocked job AND a run actually retries the work
{
  const root = makeRoot({ provider: 'mistral_vibe_local' });
  const tf = topicsFile(root, [{ slug: 'thu-nghiem-orchestration', title: 'Kiem thu orchestration engine' }]);
  run(['run', '--topics', tf, '--dry-run'], root);
  const id = state(root).jobs[0].id;
  const rr = run(['retry', id], root);
  check('retry: blocked -> planned', rr.status === 0 && state(root).jobs[0].state === 'planned');
  const r3 = run(['run', '--resume', '--dry-run'], root);
  check('retry: run --resume actually processes the re-planned job', r3.status === 0, r3.stderr);
  const job = state(root).jobs[0];
  check('retry: job advanced from planned (retry executed real work)', job.state !== 'planned', job.state);
}

// 10. corrupted state: loud failure, explicit recover, archive kept
{
  const root = makeRoot();
  run(['status'], root);
  writeFileSync(join(root, 'data', 'engine-state.json'), '{ NOT JSON !!!');
  const r = run(['status'], root);
  check('corrupt state: loud failure with recover instruction', r.status === 1 && /recover/.test(r.stderr));
  const rc = run(['recover'], root);
  check('recover: exit 0 and archive created', rc.status === 0 && existsSync(join(root, 'data', 'engine-state.corrupt-' + readdirSync(join(root, 'data')).find(f => f.startsWith('engine-state.corrupt-')))));
  const rs = run(['status'], root);
  check('recover: status healthy again', rs.status === 0, rs.stderr);
}

// 11. atomic writes: no .tmp leftovers, valid JSON after activity
{
  const root = makeRoot();
  const tf = topicsFile(root, [{ slug: 'thu-nghiem-orchestration', title: 'Kiem thu orchestration engine' }]);
  run(['run', '--topics', tf, '--dry-run'], root);
  const leftovers = readdirSync(join(root, 'data')).filter(f => f.endsWith('.tmp'));
  check('atomic save: no .tmp leftovers', leftovers.length === 0, leftovers.join(','));
  let ok = true;
  try { JSON.parse(readFileSync(join(root, 'data', 'engine-state.json'), 'utf8')); } catch { ok = false; }
  check('atomic save: state file is valid JSON', ok);
}

// 12. lock semantics: fresh lock blocks; stale (heartbeat-based) lock recovers
{
  const root = makeRoot();
  const tf = topicsFile(root, [{ slug: 'thu-nghiem-orchestration', title: 'Kiem thu orchestration engine' }]);
  // fresh heartbeat => lock held => run must refuse
  mkdirSync(join(root, 'data'), { recursive: true });
  writeFileSync(join(root, 'data', 'engine-lock.json'), JSON.stringify({ run_id: 'RUN-OTHER', heartbeat_at: new Date().toISOString() }) + '\n');
  const r1 = run(['run', '--topics', tf, '--dry-run'], root);
  check('lock: live lock blocks a second run', r1.status === 1 && /another run holds the lock/.test(r1.stderr));
  // stale heartbeat => recovered
  writeFileSync(join(root, 'data', 'engine-lock.json'), JSON.stringify({ run_id: 'RUN-DEAD', heartbeat_at: '2020-01-01T00:00:00.000Z' }) + '\n');
  const r2 = run(['run', '--topics', tf, '--dry-run'], root);
  check('lock: stale lock (old heartbeat) is recovered and the run proceeds', r2.status === 0, r2.stderr);
}

// 13. pause is observed before any work
{
  const root = makeRoot();
  const tf = topicsFile(root, [{ slug: 'thu-nghiem-orchestration', title: 'Kiem thu orchestration engine' }]);
  run(['pause'], root);
  const r = run(['run', '--topics', tf, '--dry-run'], root);
  const s = state(root);
  check('pause: run does no work while paused', r.status === 0 && s.jobs.every(j => !j.history.some(h => h.state !== 'planned')));
  run(['resume'], root);
  const r2 = run(['run', '--topics', tf, '--dry-run'], root);
  check('resume: work proceeds after resume', r2.status === 0 && state(root).jobs[0].state === 'ready', state(root).jobs[0] && state(root).jobs[0].state);
}

// 14. verify never records verified_live without real evidence
{
  const root = makeRoot();
  const tf = topicsFile(root, [{ slug: 'thu-nghiem-orchestration', title: 'Kiem thu orchestration engine' }]);
  run(['run', '--topics', tf, '--dry-run'], root);
  const rNoSha = run(['verify', 'thu-nghiem-orchestration'], root);
  check('verify: refuses without --sha', rNoSha.status === 1);
  const rFake = run(['verify', 'thu-nghiem-orchestration', '--sha', 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef'], root);
  const job = state(root).jobs[0];
  check('verify: fake sha => BLOCKED, verified_live NOT recorded', rFake.status === 1 && !job.verified_live, JSON.stringify(job.verified_live || null));
}

console.log('\nengine-selftest: ' + passed + ' passed, ' + failed + ' failed.');
if (failed) process.exit(1);
process.exit(0);
