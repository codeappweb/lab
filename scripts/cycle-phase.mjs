#!/usr/bin/env node
// cycle-phase.mjs — durable cycle state machine + failure ledger for the
// 3-writer coordinator. Single source of truth: data/factory-cycle.json
// (cycle_id, base_sha, phase, assignments, staging snapshot, publication,
// pages deployment) and data/coordinator-state.json (consecutive failures).
// All state written here is DERIVED from actual repository state by the
// caller (coordinator steps); this script never fabricates progress:
//   - publication.main_sha is only written with a sha the caller PROVES
//     exists on origin/main
//   - pages.deployment_id only from the deploy-pages step output
//   - phase never jumps backwards (linear machine, fail-closed)
// Usage (all modes read/write only the two state files):
//   node scripts/cycle-phase.mjs --check-stop          # exit 1 if consecutive_failures >= stop
//   node scripts/cycle-phase.mjs --show                # print cycle + coordinator state
//   node scripts/cycle-phase.mjs --resume              # print resume plan for an incomplete cycle
//   node scripts/cycle-phase.mjs <phase>               # advance phase (linear only)
//   node scripts/cycle-phase.mjs --publishing --publication-sha <sha>   # phase=publishing + proven sha
//   node scripts/cycle-phase.mjs --complete --publication-sha <sha> --deployment-id <id> \
//        [--live-verified] [--run-id <id>]              # finalize; moves cycle into history
//   node scripts/cycle-phase.mjs --fail-run [--run-id <id>] # increment failure ledger; phase=failed
// Phases: idle -> allocated -> collecting -> guarded -> integrating ->
//          building -> publishing -> deploying -> resetting -> complete
// Terminal/recoverable: complete | failed. A failed cycle may be retried by
// the coordinator if its staged output is still intact (phase=failed keeps
// the record; a NEW allocate refuses to run while phase not in {idle, complete, failed}).
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const ROOT = process.env.LAB_ROOT
  ? resolve(process.env.LAB_ROOT)
  : resolve(join(dirname(fileURLToPath(import.meta.url)), '..'));
const CYCLE_PATH = join(ROOT, 'data', 'factory-cycle.json');
const COORD_PATH = join(ROOT, 'data', 'coordinator-state.json');
const CFG_PATH = join(ROOT, 'data', 'factory-config.json');
const CP_PATH = join(ROOT, 'data', 'writer-checkpoint.json');

const LINEAR = ['idle', 'allocated', 'collecting', 'guarded', 'integrating',
  'building', 'publishing', 'deploying', 'resetting', 'complete'];

function die(msg) {
  console.error('::error::' + msg);
  process.exit(1);
}
function loadJson(path, fallback) {
  if (!existsSync(path)) return fallback;
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch (e) { die(path + ' khong hop le: ' + e.message); }
}
function gitOk(args) {
  const r = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8' });
  if (r.status !== 0) return null;
  return (r.stdout || '').trim();
}
const nowIso = () => new Date().toISOString();

const cycle = loadJson(CYCLE_PATH, null);
if (cycle === null) die('data/factory-cycle.json thieu — chua co factory cycle state');
const coord = loadJson(COORD_PATH, { schema_version: 1, consecutive_failures: 0 });
const cfg = loadJson(CFG_PATH, {});
const stopAt = Number.isInteger(cfg?.safety?.consecutive_failure_stop)
  ? cfg.safety.consecutive_failure_stop : 2;

const args = process.argv.slice(2);
function opt(name) {
  const i = args.indexOf(name);
  return i !== -1 ? args[i + 1] : undefined;
}

function save() {
  cycle.updated_at = nowIso();
  writeFileSync(CYCLE_PATH, JSON.stringify(cycle, null, 2) + '\n');
  coord.updated_at = nowIso();
  writeFileSync(COORD_PATH, JSON.stringify(coord, null, 2) + '\n');
}

// Keep the checkpoint's cycle fields consistent with cycle state (derived).
function syncCheckpoint() {
  if (!existsSync(CP_PATH)) return;
  let cp;
  try { cp = JSON.parse(readFileSync(CP_PATH, 'utf8')); } catch (e) { return; }
  cp.cycle_id = cycle.cycle_id;
  cp.base_sha = cycle.base_sha;
  cp.status = cycle.phase;
  cp.updated_at = nowIso();
  writeFileSync(CP_PATH, JSON.stringify(cp, null, 2) + '\n');
}

const activeCycle = cycle.phase !== "idle" && cycle.phase !== "complete";

if (args.includes('--check-stop')) {
  if ((coord.consecutive_failures || 0) >= stopAt) {
    die('PRODUCTION STOP: ' + coord.consecutive_failures + ' coordinator run fail lien tiep (>= consecutive_failure_stop=' + stopAt +
      '). Dung sinh state moi; kiem tra nguyen goc (workflow log, cycle ' + cycle.cycle_id + ', staging) roi reset data/coordinator-state.json.consecutive_failures = 0 sau khi da sua.');
  }
  console.log('cycle-phase: failure ledger OK — consecutive_failures=' + (coord.consecutive_failures || 0) + '/' + stopAt);
  process.exit(0);
}

if (args.includes('--show')) {
  console.log(JSON.stringify({ cycle, coordinator: coord }, null, 2));
  process.exit(0);
}

if (args.includes('--resume')) {
  if (!activeCycle) {
    console.log('cycle-phase: khong co cycle dang mo (phase=' + cycle.phase + ') — bat dau chu ky moi bang next-pair.mjs --allocate.');
    process.exit(0);
  }
  const plan = {
    cycle_id: cycle.cycle_id,
    base_sha: cycle.base_sha,
    phase: cycle.phase,
    resume_hint:
      cycle.phase === 'allocated' || cycle.phase === 'collecting' || cycle.phase === 'guarded'
        ? 're-collect + guard lai (idempotent) roi tich hop binh thuong'
        : cycle.phase === 'integrating' || cycle.phase === 'building'
          ? 're-run guard (skip bai da integrate giong het) roi publish lai transaction'
          : cycle.phase === 'publishing'
            ? 'kiem tra publication.main_sha tren origin/main: co thi sang deploy, khong thi re-publish (idempotent)'
            : cycle.phase === 'deploying' || cycle.phase === 'resetting'
              ? 'deploy-pages lai (idempotent) roi reset staging force-with-lease theo snapshot'
              : 'phase khong xac dinh — xem tay'
  };
  console.log('cycle-phase: RESUME cycle dang mo: ' + JSON.stringify(plan));
  process.exit(0);
}

if (args.includes('--fail-run')) {
  const runId = opt('--run-id') || null;
  coord.consecutive_failures = (coord.consecutive_failures || 0) + 1;
  coord.last_run_id = runId;
  coord.last_run_status = 'failed';
  if (activeCycle) cycle.phase = 'failed';
  save();
  syncCheckpoint();
  console.log('cycle-phase: run FAIL da ghi — consecutive_failures=' + coord.consecutive_failures +
    (activeCycle ? ' ; cycle ' + cycle.cycle_id + ' -> failed (staging giu nguyen de retry).' : ''));
  process.exit(0);
}

const phaseArg = args.find(a => LINEAR.includes(a));
if (args.includes('--publishing')) {
  const sha = opt('--publication-sha');
  if (!sha) die('--publishing can --publication-sha (sha commit vua push, phai ton tai tren origin/main)');
  const have = gitOk(['merge-base', '--is-ancestor', sha, 'origin/main']);
  if (have === null && sha !== gitOk(['rev-parse', 'origin/main'])) {
    die('publication sha ' + sha + ' khong ton tai tren origin/main — khong duoc ghi vao cycle state');
  }
  cycle.phase = 'publishing';
  cycle.publication = { main_sha: sha, ids: cycle.publication?.ids || null };
  coord.last_run_status = 'publishing';
  save(); syncCheckpoint();
  console.log('cycle-phase: publishing — main_sha=' + sha.slice(0, 10));
  process.exit(0);
}

if (args.includes('--complete')) {
  const sha = opt('--publication-sha');
  const depId = opt('--deployment-id');
  if (!sha) die('--complete can --publication-sha');
  cycle.phase = 'complete';
  cycle.publication = { ...(cycle.publication || {}), main_sha: sha };
  cycle.pages = {
    deployment_id: depId || null,
    status: 'success',
    live_verified: args.includes('--live-verified'),
    verified_at: nowIso(),
  };
  cycle.history.push({
    cycle_id: cycle.cycle_id, base_sha: cycle.base_sha, phase: 'complete',
    publication: cycle.publication, pages: cycle.pages, completed_at: nowIso(),
  });
  coord.consecutive_failures = 0;
  coord.last_run_status = 'success';
  coord.last_run_id = opt('--run-id') || coord.last_run_id;
  save(); syncCheckpoint();
  console.log('cycle-phase: cycle ' + cycle.cycle_id + ' COMPLETE — main=' + sha.slice(0, 10) +
    ', pages deployment=' + (depId || 'n/a') + ', failure ledger reset 0.');
  process.exit(0);
}

if (phaseArg) {
  const from = cycle.phase;
  if (from === 'complete') {
    die('cycle ' + cycle.cycle_id + ' da complete — khong tien phase; chu ky moi can next-pair.mjs --allocate');
  }
  if (from === 'idle') {
    console.log('cycle-phase: khong co cycle dang mo — khong gi de tien phase ' + phaseArg + ' (noop).');
    process.exit(0);
  }
  if (from === 'failed') {
    // retry mot cycle fail: staging con nguyen; chi cho phep nhay sang phase
    // thuc thi lai (khong duoc nhay sang complete/publishing ma khong co bang chung).
    if (!['collecting', 'guarded', 'integrating', 'building'].includes(phaseArg)) {
      die('cycle ' + cycle.cycle_id + ' o phase failed — retry chi duoc qua collecting/guarded/integrating/building; complete phai qua --complete voi sha + deployment that');
    }
  } else if (LINEAR.indexOf(phaseArg) <= LINEAR.indexOf(from)) {
    die('khong lui phase: ' + from + ' -> ' + phaseArg + ' (may trang thai tuyet doi, chi tien ve phia truoc)');
  }
  cycle.phase = phaseArg;
  const snap = opt('--snapshot');
  if (phaseArg === 'collecting' && snap) cycle.staging_snapshot = JSON.parse(snap);
  save(); syncCheckpoint();
  console.log('cycle-phase: ' + from + ' -> ' + phaseArg);
  process.exit(0);
}

die('usage: cycle-phase.mjs --check-stop | --show | --resume | <phase> | --publishing --publication-sha <sha> | --complete --publication-sha <sha> [--deployment-id <id>] [--live-verified] | --fail-run [--run-id <id>]');
