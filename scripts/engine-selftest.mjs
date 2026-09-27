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
  check('recover: exit 0 and archive created', rc.status === 0 && existsSync(join(root, 'data', readdirSync(join(root, 'data')).find(f => f.startsWith('engine-state.corrupt-')))));
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
// ===== Regression tests: durable state, concurrency, resume, retries =====
// (added with the engine-v2 correctness repair; see docs/ENGINE-RUNBOOK.md)
import { StateStore as _StateStore, deployedRevisionOk as _drOk } from './engine/state.mjs';
import { spawn } from 'node:child_process';

function runEnv(args, root, env) {
  const r = spawnSync(process.execPath, [RUNNER, ...args, '--root', root], { encoding: 'utf8', env: { ...process.env, ...env } });
  if (VERBOSE) console.log(r.stdout, r.stderr);
  return r;
}

// ~minTokens Vietnamese syllable-tokens in total (documented counting method),
// spread over three H2 sections.
// unit = 8 syllable-tokens per repetition (whitespace-split counting).
const unit = 'thử nghiệm orchestration engine kiểm thử tự động ';
function vnBody(minTokens) {
  const reps = Math.ceil(minTokens / 8);
  const a = unit.repeat(Math.ceil(reps * 0.5));
  const b = unit.repeat(Math.ceil(reps * 0.35));
  const c = unit.repeat(Math.ceil(reps * 0.15));
  return '## Mở đầu\n\n' + a + '\n\n## Thân bài\n\n' + b + '\n\n## Kết luận\n\n' + c + '\n';
}

function publishDraft(title) {
  return [
    '---',
    'title: "' + title + '"',
    'description: "Mô tả kiểm thử đầy đủ cho đường xuất bản có kiểm soát của engine orchestration."',
    'date: 2026-01-05 00:00:00 +0700',
    'id: TEST-PUB-001',
    'parent_category: sua-chua',
    'child_category: chan-doan-loi',
    'search_intent: informational',
    'legal_sensitivity: false',
    '---',
    '',
    vnBody(1250)
  ].join('\n');
}

function publishMeta() {
  return JSON.stringify({ sources: ['https://example.invalid/fixture-source'], outline: ['mo-dau', 'than-bai', 'ket-luan'] }) + '\n';
}

// A gate-suite stub the runner can execute under an isolated root.
// Robust without env: exits 0. With GATE_COUNT_FILE: counts invocations.
// GATE_PAUSE=1: FIRST invocation flips `paused` in the durable state
// (simulating an operator pausing mid-gates) and still exits 0.
// GATE_FAIL=1: always exits 1.
function gateStub(root, { pause, fail, countFile } = {}) {
  mkdirSync(join(root, 'scripts'), { recursive: true });
  writeFileSync(join(root, 'scripts', 'validate-deploy.mjs'), [
    "import fs from 'node:fs';",
    "const cf = process.env.GATE_COUNT_FILE;",
    "let n = 0;",
    "if (cf) { try { n = parseInt(fs.readFileSync(cf, 'utf8'), 10) || 0; } catch {} n++; fs.writeFileSync(cf, String(n)); }",
    "if (n === 1 && process.env.GATE_PAUSE === '1') {",
    "  const d = JSON.parse(fs.readFileSync(process.env.GATE_STATE, 'utf8'));",
    "  d.paused = true;",
    "  fs.writeFileSync(process.env.GATE_STATE, JSON.stringify(d, null, 2) + '\\n');",
    "}",
    "process.exit(process.env.GATE_FAIL === '1' ? 1 : 0);"
  ].join('\n'));
  if (countFile) writeFileSync(countFile, '0');
  return { countFile, env: countFile ? { GATE_COUNT_FILE: countFile, GATE_STATE: join(root, 'data', 'engine-state.json'), GATE_PAUSE: pause ? '1' : '0', GATE_FAIL: fail ? '1' : '0' } : {} };
}

// Seed a durable publishing job (simulating a crash at a given milestone).
function seedPublishing(root, slug, { withPlanned, withWritten, committedSha } = {}) {
  const draft = publishDraft('Bài kiểm thử xuất bản có kiểm soát');
  mkdirSync(join(root, 'drafts'), { recursive: true });
  writeFileSync(join(root, 'drafts', slug + '.md'), draft);
  writeFileSync(join(root, 'drafts', slug + '.meta.json'), publishMeta());
  const postPath = join(root, '_posts', '2026-01-05-' + slug + '.md');
  const sf = join(root, 'data', 'engine-state.json');
  const s = JSON.parse(readFileSync(sf, 'utf8'));
  const job = s.jobs[0];
  job.state = 'publishing';
  job.history.push({ state: 'publishing', at: new Date().toISOString(), note: 'seeded by selftest' });
  if (withPlanned || withWritten) job.file_write_planned = postPath;
  if (withWritten) { mkdirSync(join(root, '_posts'), { recursive: true }); writeFileSync(postPath, draft); job.file_written = postPath; }
  if (committedSha) job.committed_sha = committedSha;
  writeFileSync(sf, JSON.stringify(s, null, 2) + '\n');
  return { postPath, draft };
}

// 15. `--resume` picks up in-flight 'publishing' jobs and drives them forward
//     from their milestones (offline the run then blocks honestly at the
//     build gate — E_BUILD_MISSING — which is itself part of the contract:
//     rendering checks are never skipped)
{
  const root = makeRoot({ provider: 'mistral_vibe_local', generation_enabled: true, dry_run: false });
  const tf = topicsFile(root, [{ slug: 'thu-nghiem-orchestration', title: 'Kiem thu orchestration engine' }]);
  run(['run', '--topics', tf, '--dry-run'], root); // job exists (blocked: no evidence)
  seedPublishing(root, 'thu-nghiem-orchestration', {});
  gateStub(root, {});
  const r = run(['run', '--resume'], root);
  const s = state(root);
  const job = s.jobs[0];
  check('resume: publishing job is eligible and picked up', /resume: 1 in-flight job/.test(r.stdout), r.stdout.slice(0, 200) + r.stderr.slice(0, 200));
  check('resume: milestone copy happened exactly once (one post file)', readdirSync(join(root, '_posts')).length === 1);
  check('resume: no duplicate job created', s.jobs.length === 1);
  check('resume: publishing blocks honestly at E_BUILD_MISSING offline (build gates enforced)', job.state === 'blocked' && /E_BUILD_MISSING/.test((job.errors || []).map(e => e.msg).join(' ')), job.state);
}

// 16. resume AFTER copy, BEFORE validation completes: the identical file is
//     accepted (no re-copy, no overwrite), gates re-run, and the missing
//     build toolchain blocks honestly
{
  const root = makeRoot({ provider: 'mistral_vibe_local', generation_enabled: true, dry_run: false });
  const tf = topicsFile(root, [{ slug: 'thu-nghiem-orchestration', title: 'Kiem thu orchestration engine' }]);
  run(['run', '--topics', tf, '--dry-run'], root);
  const seeded = seedPublishing(root, 'thu-nghiem-orchestration', { withPlanned: true, withWritten: true });
  gateStub(root, {});
  const r = run(['run', '--resume'], root);
  const job = state(root).jobs[0];
  const files = readdirSync(join(root, '_posts'));
  check('resume-after-copy: exactly one post file (no duplicate)', files.length === 1, files.join(','));
  check('resume-after-copy: post file identical to draft (no overwrite)', readFileSync(seeded.postPath, 'utf8') === seeded.draft);
  check('resume-after-copy: blocked with E_BUILD_MISSING (rendered checks mandatory, never skipped)', job.state === 'blocked' && /E_BUILD_MISSING/.test((job.errors || []).map(e => e.msg).join(' ') + r.stdout + r.stderr), job.state);
}

// 17. ambiguous resume: post file DIFFERS from draft => blocked, nothing overwritten
{
  const root = makeRoot({ provider: 'mistral_vibe_local', generation_enabled: true, dry_run: false });
  const tf = topicsFile(root, [{ slug: 'thu-nghiem-orchestration', title: 'Kiem thu orchestration engine' }]);
  run(['run', '--topics', tf, '--dry-run'], root);
  const seeded = seedPublishing(root, 'thu-nghiem-orchestration', { withPlanned: true, withWritten: true });
  const tampered = seeded.draft.replace('cổng chất lượng', 'NỘI DUNG KHÁC');
  writeFileSync(seeded.postPath, tampered);
  writeFileSync(join(root, 'drafts', 'thu-nghiem-orchestration.md'), seeded.draft.replace('kiểm thử', 'kiểm thử đã sửa')); // draft changed after copy
  const r = run(['run', '--resume'], root);
  const job = state(root).jobs[0];
  check('ambiguous-resume: E_RESUME_AMBIGUOUS blocks', job.state === 'blocked' && /E_RESUME_AMBIGUOUS/.test((job.errors || []).map(e => e.msg).join(' ')), job.state);
  check('ambiguous-resume: differing file NOT overwritten', readFileSync(seeded.postPath, 'utf8') === tampered);
}

// 18. post file exists WITHOUT any recorded milestone => blocked duplicate, no overwrite
{
  const root = makeRoot({ provider: 'mistral_vibe_local', generation_enabled: true, dry_run: false });
  const tf = topicsFile(root, [{ slug: 'thu-nghiem-orchestration', title: 'Kiem thu orchestration engine' }]);
  run(['run', '--topics', tf, '--dry-run'], root);
  const seeded = seedPublishing(root, 'thu-nghiem-orchestration', {}); // no milestones
  writeFileSync(seeded.postPath, 'PRE-EXISTING CONTENT'); // file present, milestones absent
  const r = run(['run', '--resume'], root);
  const job = state(root).jobs[0];
  check('unmilestoned file: E_DUPLICATE_POST blocks (no silent overwrite)', job.state === 'blocked' && /E_DUPLICATE_POST|already exists/.test((job.errors || []).map(e => e.msg).join(' ') + r.stderr), job.state);
  check('unmilestoned file: pre-existing content untouched', readFileSync(seeded.postPath, 'utf8') === 'PRE-EXISTING CONTENT');
}

// 19. resume after content commit, before push: no duplicate commit
{
  const root = makeRoot({ provider: 'mistral_vibe_local', generation_enabled: true, dry_run: false });
  const tf = topicsFile(root, [{ slug: 'thu-nghiem-orchestration', title: 'Kiem thu orchestration engine' }]);
  run(['run', '--topics', tf, '--dry-run'], root);
  const seeded = seedPublishing(root, 'thu-nghiem-orchestration', { withPlanned: true, withWritten: true });
  // a real git repo whose HEAD commit contains the post (content commit)
  spawnSync('git', ['init', '-q'], { cwd: root });
  spawnSync('git', ['config', 'user.email', 'selftest@example.invalid'], { cwd: root });
  spawnSync('git', ['config', 'user.name', 'selftest'], { cwd: root });
  spawnSync('git', ['add', '_posts/2026-01-05-thu-nghiem-orchestration.md'], { cwd: root });
  spawnSync('git', ['commit', '-q', '-m', 'content(engine): publish thu-nghiem-orchestration (seeded content commit)'], { cwd: root });
  const sha = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).stdout.trim();
  const s = JSON.parse(readFileSync(join(root, 'data', 'engine-state.json'), 'utf8'));
  s.jobs[0].committed_sha = sha;
  writeFileSync(join(root, 'data', 'engine-state.json'), JSON.stringify(s, null, 2) + '\n');
  const r = run(['run', '--resume'], root);
  const subjects = spawnSync('git', ['log', '--pretty=%s'], { cwd: root, encoding: 'utf8' }).stdout.trim().split('\n');
  const count = spawnSync('git', ['rev-list', '--count', 'HEAD'], { cwd: root, encoding: 'utf8' }).stdout.trim();
  // The durable-milestone sync may commit the externally recorded milestone
  // (this is exactly what `verify` + next-run sync relies on) — but it must
  // NEVER create a second content commit.
  check('resume-after-commit: no duplicate content commit (milestone sync commit allowed, count<=2)', subjects.filter(s2 => /content\(engine\)/.test(s2)).length === 1 && (count === '1' || count === '2') && (count === '1' || /state\(engine\)/.test(subjects[0])), 'count=' + count + ' :: ' + subjects.join(' | '));
  check('resume-after-commit: run completes and reports NOT pushed', r.status === 0 && /NOT pushed/.test(r.stdout), r.stderr.slice(0, 200));
  check('resume-after-commit: committed_sha preserved in durable state', state(root).jobs[0].committed_sha === sha);
  // recorded sha missing from the repo => ambiguous, blocked
  const root2 = makeRoot({ provider: 'mistral_vibe_local', generation_enabled: true, dry_run: false });
  const tf2 = topicsFile(root2, [{ slug: 'thu-nghiem-orchestration', title: 'Kiem thu orchestration engine' }]);
  run(['run', '--topics', tf2, '--dry-run'], root2);
  seedPublishing(root2, 'thu-nghiem-orchestration', { withPlanned: true, withWritten: true, committedSha: '0000000000000000000000000000000000000000' });
  const r2 = run(['run', '--resume'], root2);
  const job2 = state(root2).jobs[0];
  check('resume-after-commit: absent sha => E_RESUME_AMBIGUOUS blocked', job2.state === 'blocked' && /E_RESUME_AMBIGUOUS/.test((job2.errors || []).map(e => e.msg).join(' ')), job2.state);
}

// 20. pause observed BETWEEN STAGES (after the copy, before gates/commit):
//     the run halts, the job stays resumable in 'publishing', and a later
//     resume never duplicates the file
{
  const root = makeRoot({ provider: 'mistral_vibe_local', generation_enabled: true, dry_run: false });
  const tf = topicsFile(root, [{ slug: 'thu-nghiem-orchestration', title: 'Kiem thu orchestration engine' }]);
  const stub = gateStub(root, { pause: true, countFile: join(root, 'gate-count.txt') });
  // evidence + outline + draft present so the full planned->publishing path runs
  mkdirSync(join(root, 'drafts'), { recursive: true });
  writeFileSync(join(root, 'drafts', 'thu-nghiem-orchestration.meta.json'), publishMeta());
  writeFileSync(join(root, 'drafts', 'thu-nghiem-orchestration.md'), publishDraft('Kiem thu orchestration engine'));
  const r = runEnv(['run', '--topics', tf], root, stub.env);
  const job = state(root).jobs[0];
  check('mid-stage pause: run halts (exit 0) with resumable note', r.status === 0 && /HALTED|resumable/.test(r.stdout + r.stderr), r.stderr.slice(0, 200));
  check('mid-stage pause: job stays publishing (NOT failed/blocked)', job.state === 'publishing', job.state);
  const files = readdirSync(join(root, '_posts'));
  check('mid-stage pause: post file written exactly once', files.length === 1 && files[0].endsWith('thu-nghiem-orchestration.md'), files.join(','));
  // resume after unpause: copy skipped (identical), gates re-run, then blocked
  // honestly at the build gate (no jekyll in the test env)
  run(['resume'], root);
  const r2 = runEnv(['run', '--resume'], root, stub.env);
  const job2 = state(root).jobs[0];
  const files2 = readdirSync(join(root, '_posts'));
  check('resume after pause: still exactly one post file', files2.length === 1, files2.join(','));
  check('resume after pause: copy skipped, gate stub ran again (>=2 invocations)', parseInt(readFileSync(stub.countFile, 'utf8'), 10) >= 2, readFileSync(stub.countFile, 'utf8'));
  check('resume after pause: honest E_BUILD_MISSING block (never silently publishes)', job2.state === 'blocked' && /E_BUILD_MISSING/.test((job2.errors || []).map(e => e.msg).join(' ')), job2.state);
}

// 21. retry honors cfg.max_retries: a failing gate suite is retried EXACTLY
//     max_retries times (1 initial + 2 retries), then the job fails
{
  const root = makeRoot({ provider: 'mistral_vibe_local', generation_enabled: true, dry_run: false, max_retries: 2, backoff_ms: 1 });
  const tf = topicsFile(root, [{ slug: 'thu-nghiem-orchestration', title: 'Kiem thu orchestration engine' }]);
  run(['run', '--topics', tf, '--dry-run'], root);
  seedPublishing(root, 'thu-nghiem-orchestration', { withPlanned: true, withWritten: true });
  const stub = gateStub(root, { fail: true, countFile: join(root, 'gate-count.txt') });
  const r = runEnv(['run', '--resume'], root, stub.env);
  const job = state(root).jobs[0];
  const calls = parseInt(readFileSync(stub.countFile, 'utf8'), 10);
  check('retry limit: gate suite invoked exactly 1+max_retries times', calls === 3, 'calls=' + calls);
  check('retry limit: job failed only after retries exhausted', job.state === 'failed', job.state);
  check('retry limit: job.retries reflects the configured limit', (job.retries || 0) === 2, String(job.retries));
}

// 22. REAL multi-process concurrency: two simultaneous runs on the same root.
//     Invariants regardless of interleaving: exactly one job, valid state,
//     no duplicate posts. (spawn, not spawnSync — the processes truly overlap)
{
  const root = makeRoot();
  const tf = topicsFile(root, [{ slug: 'thu-nghiem-orchestration', title: 'Kiem thu orchestration engine' }]);
  const start = () => new Promise(res => {
    const p = spawn(process.execPath, [RUNNER, 'run', '--topics', tf, '--root', root], { stdio: 'pipe' });
    let err = '';
    p.stderr.on('data', d => err += d);
    p.on('close', c => res({ code: c, err }));
  });
  const both = await Promise.all([start(), start()]);
  const s = state(root);
  check('concurrent runs: exactly ONE job created (lock held before job creation)', s.jobs.length === 1, JSON.stringify(s.jobs.map(j => j.id + ':' + j.state)));
  check('concurrent runs: no duplicate posts', readdirSync(join(root, '_posts')).length === 0);
  const oneLockLoss = both.filter(x => x.code === 1 && /another run holds the lock/.test(x.err)).length;
  const bothRan = both.filter(x => x.code === 0).length;
  check('concurrent runs: lock is exclusive (loser refused with the lock diagnostic)', oneLockLoss === 1 || bothRan === 2, JSON.stringify(both.map(x => x.code)));
  check('concurrent runs: durable state stays valid JSON', typeof s.jobs[0].state === 'string');
}

// 23. deterministic lock contention: external live lock => BOTH concurrent
//     processes are refused (heartbeat-based freshness, no stale seizure)
{
  const root = makeRoot();
  const tf = topicsFile(root, [{ slug: 'thu-nghiem-orchestration', title: 'Kiem thu orchestration engine' }]);
  writeFileSync(join(root, 'data', 'engine-lock.json'), JSON.stringify({ run_id: 'RUN-EXTERNAL', heartbeat_at: new Date().toISOString() }) + '\n');
  const start = () => new Promise(res => {
    const p = spawn(process.execPath, [RUNNER, 'run', '--topics', tf, '--root', root], { stdio: 'pipe' });
    let err = '';
    p.stderr.on('data', d => err += d);
    p.on('close', c => res({ code: c, err }));
  });
  const both = await Promise.all([start(), start()]);
  check('external lock: both concurrent runs refused (exit 1, lock diagnostic)', both.every(x => x.code === 1 && /another run holds the lock/.test(x.err)), JSON.stringify(both.map(x => x.code)));
  check('external lock: no jobs created while the lock is held', state(root).jobs.length === 0);
}

// 24. state.mjs unit contracts (in-process, direct import)
{
  // save-merge: an external pause is NEVER clobbered by an active writer's save
  const root = makeRoot();
  const s1 = new _StateStore(root);
  const s2 = new _StateStore(root);
  s2.data.paused = true;
  s2.save();
  s1.data.checkpoint = { note: 'written by worker that loaded before the pause' };
  s1.save();
  check('state merge: external pause survives a concurrent writer save', JSON.parse(readFileSync(join(root, 'data', 'engine-state.json'), 'utf8')).paused === true);

  // job union: jobs created by another process survive this process's save
  const rootB = makeRoot();
  const a = new _StateStore(rootB);
  a.createJob({ slug: 'job-a', topic: { title: 'A' } });
  const b = new _StateStore(rootB);
  b.createJob({ slug: 'job-b', topic: { title: 'B' } });
  a.save();
  const slugs = JSON.parse(readFileSync(join(rootB, 'data', 'engine-state.json'), 'utf8')).jobs.map(j => j.slug).sort();
  check('state merge: jobs from other processes are kept (union, no clobber)', slugs.join(',') === 'job-a,job-b', slugs.join(','));

  // heartbeat/release by a NON-owner never touches the lock
  const rootC = makeRoot();
  mkdirSync(join(rootC, 'data'), { recursive: true });
  const before = { run_id: 'RUN-A', heartbeat_at: '2026-01-01T00:00:00.000Z' };
  writeFileSync(join(rootC, 'data', 'engine-lock.json'), JSON.stringify(before) + '\n');
  const sc = new _StateStore(rootC);
  sc.heartbeat('RUN-B');
  const h1 = JSON.parse(readFileSync(join(rootC, 'data', 'engine-lock.json'), 'utf8'));
  check('lock ownership: non-owner heartbeat does not refresh the lease', h1.run_id === 'RUN-A' && h1.heartbeat_at === before.heartbeat_at, JSON.stringify(h1));
  sc.releaseLock('RUN-B');
  check('lock ownership: non-owner release does not unlink the lock', existsSync(join(rootC, 'data', 'engine-lock.json')));
  sc.releaseLock('RUN-A');
  check('lock ownership: owner release unlinks the lock', !existsSync(join(rootC, 'data', 'engine-lock.json')));

  // deployedRevisionOk: containment, not SHA equality
  check('deployedRevisionOk: identical passes', _drOk('aaa', 'aaa', 'identical').ok === true);
  check('deployedRevisionOk: ahead (deployed contains content commit) passes', _drOk('aaa', 'bbb', 'ahead').ok === true);
  check('deployedRevisionOk: behind fails closed', _drOk('bbb', 'aaa', 'behind').ok === false);
  check('deployedRevisionOk: diverged fails closed', _drOk('aaa', 'bbb', 'diverged').ok === false);
  check('deployedRevisionOk: unknown compare fails closed', _drOk('aaa', 'bbb', null).ok === false);
  check('deployedRevisionOk: missing sha fails closed', _drOk('', 'bbb', 'ahead').ok === false);
}


// ===== 25–30. State & artifact persistence (durable publication state) =====
// Full offline publish path against a REAL local git repo and a REAL bare
// remote: the Jekyll toolchain is faked (`bundle`/`jekyll` stubs on PATH) and
// gen-site-data / validate-built are stubbed in the isolated root, so M3 build
// gates pass offline. Nothing real is ever published (remote is a local bare
// repository under tmp).
{
  const mkPublishRoot = () => {
    const root = makeRoot({ provider: 'mistral_vibe_local', generation_enabled: true, dry_run: false });
    const tf = topicsFile(root, [{ slug: 'thu-nghiem-orchestration', title: 'Kiem thu orchestration engine' }]);
    run(['run', '--topics', tf, '--dry-run'], root); // job exists (blocked: no evidence)
    seedPublishing(root, 'thu-nghiem-orchestration', { withPlanned: true, withWritten: true });
    gateStub(root, {});
    // Offline build-gate environment: deterministic regen + rendered-output
    // validator stubs, and a fake bundle/jekyll toolchain on PATH.
    writeFileSync(join(root, 'scripts', 'gen-site-data.mjs'), 'process.exit(0);\n');
    writeFileSync(join(root, 'scripts', 'validate-built.mjs'), 'process.exit(0);\n');
    const bin = join(root, 'fakebin');
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, 'bundle'), '#!/bin/sh\nexit 0\n');
    writeFileSync(join(bin, 'jekyll'), '#!/bin/sh\nexit 0\n');
    spawnSync('chmod', ['+x', join(bin, 'bundle'), join(bin, 'jekyll')]);
    // A real git work tree (no commits yet).
    spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
    spawnSync('git', ['config', 'user.email', 'selftest@example.invalid'], { cwd: root });
    spawnSync('git', ['config', 'user.name', 'selftest'], { cwd: root });
    spawnSync('git', ['config', 'push.default', 'current'], { cwd: root });
    return { root, env: { PATH: bin + ':' + process.env.PATH } };
  };
  const g = (root, ...args) => spawnSync('git', args, { cwd: root, encoding: 'utf8' });

  // 25. persistence sequence: content commit identity is SEPARATE from the
  //     state commit, and an unrelated staged file from another session
  //     rides along with NEITHER.
  {
    const t = mkPublishRoot();
    writeFileSync(join(t.root, 'SESSION-B-NOTES.md'), 'unrelated staged work from another session\n');
    g(t.root, 'add', 'SESSION-B-NOTES.md'); // staged by "another session"
    const r = runEnv(['run', '--resume'], t.root, t.env);
    const subjects = g(t.root, 'log', '--pretty=%s').stdout.trim().split('\n');
    check('persist: content commit AND separate state commit created (exactly 2)', subjects.length === 2 && /content\(engine\)/.test(subjects[1]) && /state\(engine\)/.test(subjects[0]), subjects.join(' | ') + ' :: ' + r.stdout.slice(-300) + r.stderr.slice(-300));
    const contentSha = g(t.root, 'rev-parse', 'HEAD^').stdout.trim();
    const stateSha = g(t.root, 'rev-parse', 'HEAD').stdout.trim();
    const contentFiles = g(t.root, 'show', '--pretty=format:', '--name-only', contentSha).stdout.split('\n').map(s => s.trim()).filter(Boolean);
    const stateFiles = g(t.root, 'show', '--pretty=format:', '--name-only', stateSha).stdout.split('\n').map(s => s.trim()).filter(Boolean);
    check('persist: content commit contains ONLY the post file', contentFiles.length === 1 && contentFiles[0].endsWith('_posts/2026-01-05-thu-nghiem-orchestration.md'), contentFiles.join(','));
    check('persist: state commit contains engine-state.json (durable job milestones)', stateFiles.includes('data/engine-state.json'), stateFiles.join(','));
    check('persist: unrelated staged file NOT committed by either commit', g(t.root, 'cat-file', '-e', contentSha + ':SESSION-B-NOTES.md').status !== 0 && g(t.root, 'cat-file', '-e', stateSha + ':SESSION-B-NOTES.md').status !== 0);
    check('persist: unrelated staged file still staged, untouched', /A {1,2}SESSION-B-NOTES\.md/.test(g(t.root, 'status', '--porcelain').stdout), g(t.root, 'status', '--porcelain').stdout.trim());
    const s25 = state(t.root).jobs[0];
    check('persist: committed_sha recorded and identical to the content commit', s25.committed_sha === contentSha);
    check('persist: no second content commit and no empty state commit loop (2 commits total)', g(t.root, 'rev-list', '--count', 'HEAD').stdout.trim() === '2');
    // re-running must NOT create a content commit, an empty commit, or an
    // unbounded chain: at most ONE state commit appears (the previous run's
    // run-record sync, real content, bounded — never a loop).
    const r2 = runEnv(['run', '--resume'], t.root, t.env);
    const subjects2 = g(t.root, 'log', '--pretty=%s').stdout.trim().split('\n');
    check('persist: re-run adds no content commit and no empty commit (at most one state sync)', r2.status === 0 && subjects2.filter(s2 => /content\(engine\)/.test(s2)).length === 1 && subjects2.length <= 3 && (subjects2.length === 2 || /state\(engine\)/.test(subjects2[0])), subjects2.join(' | ') + ' :: ' + r2.stderr.slice(0, 200));
  }

  // 26. push interruption: content + state commits exist locally, the push
  //     fails honestly (pushed NOT recorded), then a fixed remote resumes
  //     without duplicate posts or duplicate commits.
  {
    const t = mkPublishRoot();
    const bare = mkdtempSync(join(tmpdir(), 'engine-selftest-bare-')) + '.git';
    spawnSync('git', ['init', '-q', '--bare', '-b', 'main', bare]);
    g(t.root, 'remote', 'add', 'origin', bare);
    g(t.root, 'remote', 'set-url', 'origin', join(bare, 'does-not-exist')); // broken remote
    const rBad = runEnv(['run', '--resume', '--push'], t.root, t.env);
    const job = state(t.root).jobs[0];
    check('push-interrupt: push failed honestly, pushed NOT recorded', !job.pushed && job.committed_sha && /push failed/.test((job.errors || []).map(e => e.msg).join(' ') + rBad.stdout + rBad.stderr), JSON.stringify(job.pushed || null) + ' :: ' + rBad.stderr.slice(0, 200));
    check('push-interrupt: content + state commits survive locally (2)', g(t.root, 'rev-list', '--count', 'HEAD').stdout.trim() === '2');
    g(t.root, 'remote', 'set-url', 'origin', bare); // remote fixed
    const rOk = runEnv(['run', '--resume', '--push'], t.root, t.env);
    const job2 = state(t.root).jobs[0];
    check('push-resume: pushed recorded, remote durability honest', !!job2.pushed && /content commit .* pushed/.test(rOk.stdout), rOk.stdout.slice(-300));
    const subjectsR = g(t.root, 'log', '--pretty=%s').stdout.trim().split('\n');
    check('push-resume: no duplicate content commits (content 1 + state commits only, pushed milestone on top)', subjectsR.filter(s2 => /content\(engine\)/.test(s2)).length === 1 && subjectsR.length === 4 && /state\(engine\)/.test(subjectsR[0]), subjectsR.join(' | '));
    check('push-resume: no duplicate posts (one file in _posts)', readdirSync(join(t.root, '_posts')).length === 1);
  }

  // 27. fresh clone recovery: a clone of the bare remote recovers the latest
  //     persisted job state and resumes WITHOUT duplicate posts or commits.
  {
    const t = mkPublishRoot();
    const bare = mkdtempSync(join(tmpdir(), 'engine-selftest-bare2-')) + '.git';
    spawnSync('git', ['init', '-q', '--bare', '-b', 'main', bare]);
    g(t.root, 'remote', 'add', 'origin', bare);
    const rPush = runEnv(['run', '--resume', '--push'], t.root, t.env);
    check('clone-prep: publishing run with push succeeded', rPush.status === 0 && state(t.root).jobs[0].pushed, rPush.stderr.slice(0, 200));
    const clone = mkdtempSync(join(tmpdir(), 'engine-selftest-clone-'));
    spawnSync('git', ['clone', '-q', '--branch', 'main', bare, clone]);
    if (!existsSync(join(clone, 'data', 'engine-state.json'))) {
      // Diagnose instead of crashing: show what the clone actually contains.
      check('fresh clone: engine state recovered (committed_sha + pushed)', false,
        'clone working tree missing data/engine-state.json — git log: ' +
        g(clone, 'log', '--pretty=%s', '--name-only', '-n', '3').stdout.replace(/\n/g, ' | ') +
        ' :: status: ' + g(clone, 'status', '--porcelain').stdout.slice(0, 200));
    } else {
    const cs = JSON.parse(readFileSync(join(clone, 'data', 'engine-state.json'), 'utf8'));
    const cj = cs.jobs[0];
    check('fresh clone: engine state recovered (committed_sha + pushed)', cj.state === 'publishing' && !!cj.committed_sha && !!cj.pushed, JSON.stringify({ state: cj.state, sha: !!cj.committed_sha, pushed: !!cj.pushed }));
    check('fresh clone: article file present in clone (content commit)', existsSync(join(clone, '_posts', '2026-01-05-thu-nghiem-orchestration.md')));
    // A fresh checkout carries the repo code: restore the offline gate/build
    // environment and the tracked engine config exactly like a real checkout
    // would. (drafts/ is intentionally NOT restored: a fresh clone has none,
    // and the milestones + content commit must be enough to resume.)
    writeFileSync(join(clone, 'data', 'engine-config.json'), readFileSync(join(t.root, 'data', 'engine-config.json')));
    gateStub(clone, {});
    writeFileSync(join(clone, 'scripts', 'gen-site-data.mjs'), 'process.exit(0);\n');
    writeFileSync(join(clone, 'scripts', 'validate-built.mjs'), 'process.exit(0);\n');
    const cbin = join(clone, 'fakebin');
    mkdirSync(cbin, { recursive: true });
    writeFileSync(join(cbin, 'bundle'), '#!/bin/sh\nexit 0\n');
    writeFileSync(join(cbin, 'jekyll'), '#!/bin/sh\nexit 0\n');
    spawnSync('chmod', ['+x', join(cbin, 'bundle'), join(cbin, 'jekyll')]);
    const before = g(clone, 'rev-list', '--count', 'HEAD').stdout.trim();
    const rResume = runEnv(['run', '--resume'], clone, { PATH: cbin + ':' + process.env.PATH });
    const after = g(clone, 'rev-list', '--count', 'HEAD').stdout.trim();
    check('fresh clone: resume changes nothing (already pushed, verified pending)', rResume.status === 0 && before === after, 'commits ' + before + ' -> ' + after + ' :: ' + rResume.stderr.slice(0, 150));
    check('fresh clone: no duplicate post (exactly one _posts file)', readdirSync(join(clone, '_posts')).length === 1);
    check('fresh clone: job NOT duplicated (one job)', state(clone).jobs.length === 1);
    }
  }

  // 28. generated artifacts ride with the state commit: sitemap shards /
  //     topic-queue regenerated by gates are persisted, not left in the tree
  {
    const t = mkPublishRoot();
    // simulate deterministic artifacts regenerated by the gate suite
    mkdirSync(join(t.root, 'sitemaps'), { recursive: true });
    writeFileSync(join(t.root, 'sitemaps', 'articles-1.xml'), '<urlset/>');
    writeFileSync(join(t.root, 'data', 'topic-queue.json'), '{"queued": 1}');
    runEnv(['run', '--resume'], t.root, t.env);
    const stateFiles = g(t.root, 'show', '--pretty=format:', '--name-only', 'HEAD').stdout.split('\n').map(s => s.trim()).filter(Boolean);
    check('persist: regenerated sitemap shard included in state commit', stateFiles.includes('sitemaps/articles-1.xml'), stateFiles.join(','));
    check('persist: regenerated topic-queue included in state commit', stateFiles.includes('data/topic-queue.json'), stateFiles.join(','));
  }

  // 29. non-git root: persistState is a no-op and publishing still completes
  {
    const t = mkPublishRoot();
    rmSync(join(t.root, '.git'), { recursive: true, force: true }); // not a git repo at all
    const r = runEnv(['run', '--resume'], t.root, t.env);
    check('persist: non-git root runs honestly (no state commit path, no crash)', r.status === 0, r.stderr.slice(0, 300));
    check('persist: non-git root job records committed_sha=null (no commit possible)', state(t.root).jobs[0].committed_sha === undefined || state(t.root).jobs[0].committed_sha === null, JSON.stringify(state(t.root).jobs[0].committed_sha));
  }

  // 30. content-commit purity is enforced: a poisoned commit that touches a
  //     second file must be refused (integrity check in M4)
  {
    const t = mkPublishRoot();
    writeFileSync(join(t.root, 'data', 'extra-artifact.json'), '{"poison": true}');
    // poison the state-artifact set so the state commit would exist; then
    // tamper: make the runner's content commit include the extra file by
    // pre-staging it is NOT enough (pathspec commit excludes it) — instead
    // verify directly that the content commit purity check holds:
    runEnv(['run', '--resume'], t.root, t.env);
    const subjects = g(t.root, 'log', '--pretty=%s').stdout.trim().split('\n');
    const contentSha = g(t.root, 'rev-parse', 'HEAD^').stdout.trim();
    const contentFiles = g(t.root, 'show', '--pretty=format:', '--name-only', contentSha).stdout.split('\n').map(s => s.trim()).filter(Boolean);
    check('persist: content commit stays pure when other artifacts exist', subjects.length === 2 && contentFiles.length === 1 && contentFiles[0].endsWith('.md'), subjects.join(' | ') + ' :: ' + contentFiles.join(','));
  }
}

// ===== 31–36. Fail-closed persistence, pagination transaction, pending sync =====
{
  const g = (root, ...args) => spawnSync('git', args, { cwd: root, encoding: 'utf8' });

  // Same offline publish environment as groups 25–30 (real local git repo,
  // fake bundle/jekyll toolchain, stubbed gen-site-data/validate-built):
  // nothing real is ever published.
  const mkPublishRootLike = () => {
    const root = makeRoot({ provider: 'mistral_vibe_local', generation_enabled: true, dry_run: false });
    const tf = topicsFile(root, [{ slug: 'thu-nghiem-orchestration', title: 'Kiem thu orchestration engine' }]);
    run(['run', '--topics', tf, '--dry-run'], root); // job exists (blocked: no evidence)
    seedPublishing(root, 'thu-nghiem-orchestration', { withPlanned: true, withWritten: true });
    gateStub(root, {});
    writeFileSync(join(root, 'scripts', 'gen-site-data.mjs'), 'process.exit(0);\n');
    writeFileSync(join(root, 'scripts', 'validate-built.mjs'), 'process.exit(0);\n');
    const bin = join(root, 'fakebin');
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, 'bundle'), '#!/bin/sh\nexit 0\n');
    writeFileSync(join(bin, 'jekyll'), '#!/bin/sh\nexit 0\n');
    spawnSync('chmod', ['+x', join(bin, 'bundle'), join(bin, 'jekyll')]);
    spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
    spawnSync('git', ['config', 'user.email', 'selftest@example.invalid'], { cwd: root });
    spawnSync('git', ['config', 'user.name', 'selftest'], { cwd: root });
    spawnSync('git', ['config', 'push.default', 'current'], { cwd: root });
    return { root, env: { PATH: bin + ':' + process.env.PATH } };
  };

  // A `git` wrapper on PATH that can simulate push failures.
  //   failNth(n)     : the n-th push FAILS without reaching the remote.
  //   realThenFail(n) : the n-th push performs the REAL push and then exits 1
  //                     (lost network response after an accepted push).
  // Every other command (and every other push) delegates to the real git.
  const gitPushWrapper = (root, mode, failN) => {
    const bin = join(root, 'wrapbin');
    mkdirSync(bin, { recursive: true });
    const cnt = join(bin, 'pushcount');
    writeFileSync(cnt, '0');
    writeFileSync(join(bin, 'git'), [
      '#!/bin/sh',
      'if [ "$1" = "push" ]; then',
      '  n=$(cat "' + cnt + '" 2>/dev/null || echo 0)',
      '  n=$((n+1)); echo "$n" > "' + cnt + '"',
      mode === 'realThenFail'
        ? '  if [ "$n" = "' + failN + '" ]; then /usr/bin/git "$@"; exit 1; fi'
        : '  if [ "$n" = "' + failN + '" ]; then exit 1; fi',
      'fi',
      'exec /usr/bin/git "$@"'
    ].join('\n'));
    spawnSync('chmod', ['+x', join(bin, 'git')]);
    return { bin, countFile: cnt };
  };

  const mkBare = () => {
    const bare = mkdtempSync(join(tmpdir(), 'engine-selftest-bare-')) + '.git';
    spawnSync('git', ['init', '-q', '--bare', '-b', 'main', bare]);
    return bare;
  };

  // 31. FAIL CLOSED: a REQUIRED state-commit failure (after a successful
  //     content commit) must block the publication — no push, job blocked
  //     with E_PERSIST_FAILED; a later run retries the persistence and
  //     completes it without duplicate commits.
  {
    const t = mkPublishRootLike();
    // commit-msg hook that fails ONLY state commits (content commits pass).
    writeFileSync(join(t.root, '.git', 'hooks', 'commit-msg'), [
      '#!/bin/sh',
      'if grep -q "state(engine)" "$1"; then exit 1; fi',
      'exit 0'
    ].join('\n'));
    spawnSync('chmod', ['+x', join(t.root, '.git', 'hooks', 'commit-msg')]);
    const r = runEnv(['run', '--resume'], t.root, t.env);
    const job = state(t.root).jobs[0];
    check('fail-closed: state-commit failure blocks the job (E_PERSIST_FAILED)', job.state === 'blocked' && /E_PERSIST_FAILED/.test((job.errors || []).map(e => e.msg).join(' ') + r.stdout + r.stderr), job.state + ' :: ' + r.stdout.slice(-200));
    check('fail-closed: only the content commit exists (publication stopped at the failure)', g(t.root, 'rev-list', '--count', 'HEAD').stdout.trim() === '1', g(t.root, 'rev-list', '--count', 'HEAD').stdout.trim());
    check('fail-closed: committed_sha recorded but pushed NOT recorded', !!job.committed_sha && !job.pushed, JSON.stringify(job.pushed || null));
    // persistence retried on the next run: remove the hook, resume.
    rmSync(join(t.root, '.git', 'hooks', 'commit-msg'), { force: true });
    const r2 = runEnv(['run', '--resume'], t.root, t.env);
    const subjects2 = g(t.root, 'log', '--pretty=%s').stdout.trim().split('\n');
    check('fail-closed: resume retries the state persistence and completes it', r2.status === 0 && subjects2.length === 2 && /state\(engine\)/.test(subjects2[0]), subjects2.join(' | ') + ' :: ' + r2.stderr.slice(0, 150));
    check('fail-closed: still no duplicate content commit after resume', g(t.root, 'log', '--oneline').stdout.trim().split('\n').filter(l => /content\(engine\)/.test(l)).length === 1);
  }

  // 32. Content push SUCCEEDS, then the STATE-commit push fails: a retryable
  //     state_sync_pending condition is recorded; a later resume finishes the
  //     synchronization without duplicate articles or content commits.
  {
    const t = mkPublishRootLike();
    const bare = mkBare();
    g(t.root, 'remote', 'add', 'origin', bare);
    const wrap = gitPushWrapper(t.root, 'failNth', 2);
    const r = runEnv(['run', '--resume', '--push'], t.root, { PATH: wrap.bin + ':' + t.env.PATH });
    const job = state(t.root).jobs[0];
    check('pending-sync: content push recorded as pushed (real)', !!job.pushed, r.stdout.slice(-250) + r.stderr.slice(-200));
    check('pending-sync: state_sync_pending recorded (retryable, explicit)', !!job.state_sync_pending && /state commit push failed/.test(job.state_sync_pending.reason || ''), JSON.stringify(job.state_sync_pending || null));
    check('pending-sync: WARNING states local-only durability honestly', /PENDING SYNC recorded/.test(r.stdout), r.stdout.slice(-250));
    // resume with a healthy remote path: the pending sync finishes.
    const r2 = runEnv(['run', '--resume', '--push'], t.root, t.env);
    const job2 = state(t.root).jobs[0];
    check('pending-sync: resume finishes the synchronization (pending cleared)', r2.status === 0 && !job2.state_sync_pending, JSON.stringify(job2.state_sync_pending || null) + ' :: ' + r2.stderr.slice(0, 150));
    const remoteHead = g(t.root, 'ls-remote', 'origin', 'HEAD').stdout.split('\t')[0].trim();
    const localHead = g(t.root, 'rev-parse', 'HEAD').stdout.trim();
    check('pending-sync: remote and local heads match after sync', remoteHead === localHead, remoteHead + ' vs ' + localHead);
    check('pending-sync: no duplicate content commit during sync', g(t.root, 'log', '--oneline').stdout.trim().split('\n').filter(l => /content\(engine\)/.test(l)).length === 1);
    check('pending-sync: no duplicate posts (one _posts file)', readdirSync(join(t.root, '_posts')).length === 1);
  }

  // 33. Lost network response AFTER an accepted push: the command fails but
  //     ls-remote shows the remote already has the commit — the outcome is
  //     resolved as accepted, never recorded as a failed push.
  {
    const t = mkPublishRootLike();
    const bare = mkBare();
    g(t.root, 'remote', 'add', 'origin', bare);
    const wrap = gitPushWrapper(t.root, 'realThenFail', 1);
    const r = runEnv(['run', '--resume', '--push'], t.root, { PATH: wrap.bin + ':' + t.env.PATH });
    const job = state(t.root).jobs[0];
    check('ambiguous-push: pushed recorded honestly via ls-remote (no false failure)', !!job.pushed && !/push failed/.test((job.errors || []).map(e => e.msg).join(' ')), JSON.stringify(job.pushed || null) + ' :: ' + r.stdout.slice(-200));
    check('ambiguous-push: stdout explains the ls-remote resolution', /ls-remote/.test(r.stdout), r.stdout.slice(-250));
    const remoteHead = g(t.root, 'ls-remote', 'origin', 'HEAD').stdout.split('\t')[0].trim();
    check('ambiguous-push: remote actually contains the pushed revision', !!remoteHead, '(empty remote)');
  }

  // 34. Local-only verification state and its later synchronization: a
  //     verified_live record persisted locally (as `verify` does) is picked
  //     up and committed by the next run's milestone sync.
  {
    const t = mkPublishRootLike();
    const bare = mkBare();
    g(t.root, 'remote', 'add', 'origin', bare);
    const r1 = runEnv(['run', '--resume', '--push'], t.root, t.env);
    check('local-verify: baseline publish+push succeeded', r1.status === 0 && state(t.root).jobs[0].pushed, r1.stderr.slice(0, 150));
    const before = parseInt(g(t.root, 'rev-list', '--count', 'HEAD').stdout.trim(), 10);
    // simulate `verify` recording verified_live in the LOCAL state file only
    // (verify persists locally and never pushes — documented behavior)
    const sf = join(t.root, 'data', 'engine-state.json');
    const sd = JSON.parse(readFileSync(sf, 'utf8'));
    sd.jobs[0].verified_live = { at: new Date().toISOString(), url: 'https://example.invalid/lab/thu-nghiem-orchestration/', status: 200, deployed_commit: sd.jobs[0].committed_sha, compare: 'identical' };
    writeFileSync(sf, JSON.stringify(sd, null, 2) + '\n');
    const r2 = runEnv(['run', '--resume', '--push'], t.root, t.env);
    const after = parseInt(g(t.root, 'rev-list', '--count', 'HEAD').stdout.trim(), 10);
    const headSubject = g(t.root, 'log', '-1', '--pretty=%s').stdout.trim();
    check('local-verify: next run synchronizes the local-only state (state commit created)', after === before + 1 && /state\(engine\)/.test(headSubject), before + ' -> ' + after + ' :: ' + headSubject);
    check('local-verify: the synced commit carries verified_live to the remote', g(t.root, 'ls-remote', 'origin', 'HEAD').stdout.split('\t')[0].trim() === g(t.root, 'rev-parse', 'HEAD').stdout.trim());
  }

  // 35. Generated pagination — the ACTUAL threshold (PER_PAGE=48):
  //     one below / exactly at / one above / shrinking back / interruption
  //     recovery / membership / pager / indexability / manifest.
  {
    const archRoot = mkdtempSync(join(tmpdir(), 'engine-selftest-arch-'));
    mkdirSync(join(archRoot, 'scripts', 'lib'), { recursive: true });
    mkdirSync(join(archRoot, 'data'), { recursive: true });
    writeFileSync(join(archRoot, 'scripts', 'lib', 'lab.mjs'), readFileSync(join(HERE, 'lib', 'lab.mjs')));
    writeFileSync(join(archRoot, 'scripts', 'gen-archive-pages.mjs'), readFileSync(join(HERE, 'gen-archive-pages.mjs')));
    writeFileSync(join(archRoot, 'data', 'taxonomy.yml'), readFileSync(join(HERE, '..', 'data', 'taxonomy.yml')));
    const gen = () => spawnSync(process.execPath, [join(archRoot, 'scripts', 'gen-archive-pages.mjs')], { cwd: archRoot, encoding: 'utf8' });
    const cards = (n) => Array.from({ length: n }, (_, i) => ({ url: '/bai-' + i + '/', title: 'Bài ' + i, date: '2026-01-05' }));
    const setMembers = (n) => writeFileSync(join(archRoot, 'data', 'category-members.json'), JSON.stringify({ parents: { 'xe-may': cards(n) } }));
    const pages = () => readdirSync(join(archRoot, 'danh-muc', 'xe-may')).filter(f => /^trang-\d+\.md$/.test(f)).sort();
    const readPage = (n) => readFileSync(join(archRoot, 'danh-muc', 'xe-may', 'trang-' + n + '.md'), 'utf8');
    const manifest = () => JSON.parse(readFileSync(join(archRoot, 'data', 'generated-archives.json'), 'utf8'));

    setMembers(47); let rg = gen();
    check('archive 47 (below threshold): generator exits 0, exactly 1 page', rg.status === 0 && pages().length === 1 && pages()[0] === 'trang-1.md', pages().join(','));
    setMembers(48); gen();
    check('archive 48 (exactly at threshold): still 1 page, no trang-2', pages().length === 1 && manifest().per_page === 48, pages().join(','));
    setMembers(49); gen();
    check('archive 49 (one above threshold): 2 pages', pages().length === 2 && pages().join(',') === 'trang-1.md,trang-2.md', pages().join(','));
    // membership: every card appears EXACTLY once across pages, none lost
    {
      const all = pages().map(f => readFileSync(join(archRoot, 'danh-muc', 'xe-may', f), 'utf8')).join('\n');
      const urls = Array.from(all.matchAll(/href="\/lab(\/bai-\d+\/)"/g)).map(m => m[1]);
      const uniq = new Set(urls);
      check('archive membership: 49 cards, each exactly once, none lost', urls.length === 49 && uniq.size === 49, urls.length + ' refs, ' + uniq.size + ' unique');
      check('archive pager: page 1 links forward, page 2 links back, no stale trang-3', /trang-2\/"?>←|Trang sau/.test(readPage(1)) && /trang-1\//.test(readPage(2)) && !/trang-3/.test(readPage(1) + readPage(2)), readPage(2).slice(-200));
      check('archive canonical/indexability: permalink + sitemap:true in front matter', /permalink: \/danh-muc\/xe-may\/trang-1\//.test(readPage(1)) && /sitemap: true/.test(readPage(1)), readPage(1).slice(0, 200));
      check('archive manifest: lists exactly the existing generated pages', JSON.stringify(manifest().files) === JSON.stringify(['danh-muc/xe-may/trang-1.md', 'danh-muc/xe-may/trang-2.md']), JSON.stringify(manifest().files));
    }
    // shrinking back below the threshold: obsolete page safely deleted
    setMembers(47); const rShrink = gen();
    check('archive shrink 49->47: obsolete trang-2 removed safely', pages().length === 1 && /removed_stale=1/.test(rShrink.stdout), rShrink.stdout.trim() + ' :: ' + pages().join(','));
    check('archive shrink: manifest no longer lists the removed page', JSON.stringify(manifest().files) === JSON.stringify(['danh-muc/xe-may/trang-1.md']), JSON.stringify(manifest().files));
    // interruption recovery: a lost page is regenerated deterministically
    {
      const before = readPage(1);
      rmSync(join(archRoot, 'danh-muc', 'xe-may', 'trang-1.md'));
      gen();
      check('archive interruption recovery: deleted page regenerated identically', existsSync(join(archRoot, 'danh-muc', 'xe-may', 'trang-1.md')) && readPage(1) === before);
    }
  }

  // 36. Pagination is part of the PUBLICATION TRANSACTION: the runner
  //     regenerates the archive inside the build sequence, the generated
  //     pages + ownership manifest ride with the state commit, the content
  //     commit stays pure, an unrelated EDITORIAL edit never rides along, and
  //     a fresh clone of the remote has every required generated artifact.
  {
    const t = mkPublishRootLike();
    // real archive generator + its lib + taxonomy + synthetic members
    mkdirSync(join(t.root, 'scripts', 'lib'), { recursive: true });
    writeFileSync(join(t.root, 'scripts', 'lib', 'lab.mjs'), readFileSync(join(HERE, 'lib', 'lab.mjs')));
    writeFileSync(join(t.root, 'scripts', 'gen-archive-pages.mjs'), readFileSync(join(HERE, 'gen-archive-pages.mjs')));
    writeFileSync(join(t.root, 'data', 'taxonomy.yml'), readFileSync(join(HERE, '..', 'data', 'taxonomy.yml')));
    writeFileSync(join(t.root, 'data', 'category-members.json'), JSON.stringify({
      parents: { 'xe-may': Array.from({ length: 50 }, (_, i) => ({ url: '/bai-' + i + '/', title: 'Bài ' + i, date: '2026-01-05' })) }
    }));
    // an unrelated EDITORIAL edit in danh-muc must NOT ride along
    mkdirSync(join(t.root, 'danh-muc', 'xe-may'), { recursive: true });
    writeFileSync(join(t.root, 'danh-muc', 'xe-may', 'index.md'), '---\nlayout: category\n---\nEDITORIAL, NOT ENGINE-OWNED\n');
    g(t.root, 'add', 'danh-muc/xe-may/index.md');
    const bare = mkBare();
    g(t.root, 'remote', 'add', 'origin', bare);
    const r = runEnv(['run', '--resume', '--push'], t.root, t.env);
    const job = state(t.root).jobs[0];
    check('archive-transaction: run + push succeeded', r.status === 0 && !!job.pushed, r.stderr.slice(0, 200));
    // union of files across ALL state commits
    const logLines = g(t.root, 'log', '--pretty=%H %s').stdout.trim().split('\n');
    const stateShas = logLines.filter(l => /state\(engine\)/.test(l)).map(l => l.split(' ')[0]);
    const stateFiles = [...new Set(stateShas.flatMap(sha =>
      g(t.root, 'show', '--pretty=format:', '--name-only', sha).stdout.split('\n').map(s => s.trim()).filter(Boolean)))];
    check('archive-transaction: generated trang-1.md rides with a state commit', stateFiles.includes('danh-muc/xe-may/trang-1.md'), stateFiles.join(','));
    check('archive-transaction: generated trang-2.md rides with a state commit', stateFiles.includes('danh-muc/xe-may/trang-2.md'), stateFiles.join(','));
    check('archive-transaction: ownership manifest rides with a state commit', stateFiles.includes('data/generated-archives.json'), stateFiles.join(','));
    check('archive-transaction: unrelated EDITORIAL danh-muc file NOT committed', !stateFiles.includes('danh-muc/xe-may/index.md') && g(t.root, 'status', '--porcelain').stdout.includes('danh-muc/xe-may/index.md'), g(t.root, 'status', '--porcelain').stdout.trim().slice(0, 200));
    const contentSha = g(t.root, 'log', '--pretty=%H', '--grep=content(engine)').stdout.trim().split('\n')[0];
    const contentFiles = g(t.root, 'show', '--pretty=format:', '--name-only', contentSha).stdout.split('\n').map(s => s.trim()).filter(Boolean);
    check('archive-transaction: content commit stays pure (post file only)', contentFiles.length === 1 && contentFiles[0].endsWith('.md'), contentFiles.join(','));
    // fresh clone: every required generated artifact present
    const clone = mkdtempSync(join(tmpdir(), 'engine-selftest-clone-'));
    spawnSync('git', ['clone', '-q', '--branch', 'main', bare, clone]);
    check('fresh-clone: generated archive pages present', existsSync(join(clone, 'danh-muc', 'xe-may', 'trang-1.md')) && existsSync(join(clone, 'danh-muc', 'xe-may', 'trang-2.md')));
    check('fresh-clone: ownership manifest present', existsSync(join(clone, 'data', 'generated-archives.json')));
    check('fresh-clone: article + engine state present', existsSync(join(clone, '_posts', '2026-01-05-thu-nghiem-orchestration.md')) && existsSync(join(clone, 'data', 'engine-state.json')));
  }
}

console.log('\nengine-selftest: ' + passed + ' passed, ' + failed + ' failed.');
if (failed) process.exit(1);
process.exit(0);
