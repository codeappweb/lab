#!/usr/bin/env node
// director-watchdog.mjs — DIRECTOR/WATCHDOG (agent thu 6). MÔT job duy nhat:
// wake production neu KHONG co tien tri hop le lien tuc 2 gio.
// Tien tri hop le = writer staging that (run Staging signal SUCCESS), publish/
// integration tien tri (run Production SUCCESS). Heartbeat, log, check, poll,
// that bai KHONG bao gio tinh la tien tri.
// Truoc khi trigger bat buoc: #4 idle, #5 idle, KHONG maintenance lock,
// production KHONG pause chu dong, KHONG writer cycle active, KHONG
// publisher/integration/build/deploy dang chay. Neu bat ky dieu nao active ->
// khong lam gi, cho tiep.
// Sau 2h im lang that su: trigger DUNG MÔT production entrypoint (commit
// data/.coordinator-trigger tren main) — he thong production tu allocate va
// fan out 3 writer. KHONG tay writer rieng le, KHONG duplicate cycle, KHONG
// cancel run active, KHONG override failure, KHONG repair, KHONG sua
// content/queue/manifest/SQLite/workflow.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = process.env.LAB_ROOT ? resolve(process.env.LAB_ROOT) : resolve(join(dirname(fileURLToPath(import.meta.url)), '..'));
const STATE_PATH = join(ROOT, 'data', 'production-state.json');
const AGENT_PATH = join(ROOT, 'data', 'agent-state.json');
const TRIGGER_PATH = join(ROOT, 'data', '.coordinator-trigger');
const CYCLE_PATH = join(ROOT, 'data', 'factory-cycle.json');
export const PROGRESS_IDLE_MS = 2 * 3600 * 1000;

function readState() { try { return JSON.parse(readFileSync(STATE_PATH, 'utf8')); } catch (e) { return {}; } }
function readAgent() {
  try { return JSON.parse(readFileSync(AGENT_PATH, 'utf8')); }
  catch (e) { return { director: {} }; }
}
function writeAgent(patch) {
  const st = readAgent();
  for (const k of Object.keys(patch)) st[k] = Object.assign({}, st[k] || {}, patch[k]);
  mkdirSync(join(ROOT, 'data'), { recursive: true });
  writeFileSync(AGENT_PATH, JSON.stringify(st, null, 2) + '
');
  return st;
}
function gitCommitPush(msg) {
  const g = (a) => spawnSync('git', a, { cwd: ROOT, encoding: 'utf8' });
  g(['config', 'user.name', 'lab-director-watchdog']);
  g(['config', 'user.email', 'codeappweb@users.noreply.github.com']);
  g(['add', '-A']);
  g(['commit', '-m', msg]);
  const p = g(['push', 'origin', 'HEAD:main']);
  if (p.status !== 0) { console.log('::error::director: push main that bai — ' + (p.stderr || '') + ' — KHONG lam gi them.'); process.exit(1); }
}
async function ghJson(url, headers) {
  const r = await fetch(url, { headers });
  if (r.status === 403 || r.status === 429) {
    console.log('::warning::GitHub API rate limit — watchdog cho chu ky poll sau, khong lam gi.');
    process.exit(0);
  }
  if (r.status !== 200) { console.log('::error::GitHub API HTTP ' + r.status + ' cho ' + url); process.exit(1); }
  return r.json();
}

// ---------- pure logic (unit-tested trong agents-guard.test.mjs) ----------
export function validProgressFromRuns(runs) {
  // Chi SUCCESS cua Production (publish chu ky) hoac Staging signal (writer
  // staging that) la tien tri hop le. Heartbeat/log/check/poll/cac workflow
  // khac/that bai KHONG tinh.
  let t = 0;
  for (const r of (runs || [])) {
    if (r && r.conclusion === 'success' && (r.workflow === 'production.yml' || r.workflow === 'staging-signal.yml')) {
      const ms = Date.parse(r.updated_at || '') || 0;
      if (ms > t) t = ms;
    }
  }
  return t;
}
export function writerCycleActive(cycle) {
  if (!cycle || !cycle.phase) return false;
  return ['complete', 'failed'].indexOf(cycle.phase) === -1;
}
export function directorShouldTrigger(ctx) {
  if (!ctx) return false;
  if (ctx.lockHeld) return false;                // maintenance lock hoac pause chu dong
  if (ctx.repairActive) return false;            // #4 dang chay
  if (ctx.supervisorActive) return false;        // #5 dang chay
  if (ctx.productionActive) return false;        // publisher/integration/build/deploy dang chay
  if (ctx.writerCycleActive) return false;      // writer cycle dang active
  if (!ctx.lastValidProgressMs) return false;   // khong biet trang thai — khong doan
  if (ctx.nowMs - ctx.lastValidProgressMs < PROGRESS_IDLE_MS) return false; // chua du 2h im lang
  if (ctx.lastTriggerMs && ctx.nowMs - ctx.lastTriggerMs < PROGRESS_IDLE_MS) return false; // khong duplicate
  return true;
}

async function cmdCheck() {
  const headers = { Authorization: 'Bearer ' + (process.env.GITHUB_TOKEN || ''), Accept: 'application/vnd.github+json' };
  const state = readState();
  const agent = readAgent();
  if (state.paused === true) {
    console.log('director: production PAUSED' + (state.paused_by ? ' boi ' + state.paused_by : '') + ' — khong lam gi, cho tiep.');
    process.exit(0);
  }
  const d = await ghJson('https://api.github.com/repos/codeappweb/lab/actions/runs?per_page=100', headers);
  const list = (d.workflow_runs || []).map((r) => ({
    workflow: String(r.path || '').replace('.github/workflows/', ''),
    status: r.status,
    conclusion: r.conclusion,
    updated_at: r.updated_at,
  }));
  const active = (wf) => list.some((r) => r.status === 'in_progress' && r.workflow === wf);
  const repairActive = active('repair-agent.yml');
  const supervisorActive = active('supervisor-recovery.yml');
  const productionActive = active('production.yml') || active('staging-signal.yml');
  let cycle = null;
  try { cycle = JSON.parse(readFileSync(CYCLE_PATH, 'utf8')); } catch (e) {}
  const cycleActive = writerCycleActive(cycle);
  const progressMs = validProgressFromRuns(list);
  const prevMs = agent.director && agent.director.last_valid_progress_at ? Date.parse(agent.director.last_valid_progress_at) || 0 : 0;
  const lastValid = Math.max(prevMs, progressMs);
  const lastTriggerMs = agent.director && agent.director.last_trigger_at ? Date.parse(agent.director.last_trigger_at) || 0 : 0;
  const nowMs = Date.now();
  const should = directorShouldTrigger({
    nowMs, lastValidProgressMs: lastValid, lastTriggerMs,
    lockHeld: state.paused === true, repairActive, supervisorActive,
    productionActive, writerCycleActive: cycleActive,
  });
  console.log('director: lastProgress=' + (lastValid ? new Date(lastValid).toISOString() : 'none') +
    ' idleMin=' + (lastValid ? Math.round((nowMs - lastValid) / 60000) : '?') +
    ' repair=' + repairActive + ' supervisor=' + supervisorActive +
    ' production=' + productionActive + ' cycle=' + cycleActive +
    ' -> ' + (should ? 'WAKE production' : 'wait'));
  if (!should) {
    if (progressMs > prevMs) {
      writeAgent({ director: { last_valid_progress_at: new Date(progressMs).toISOString() } });
      gitCommitPush('director(track): cap nhat last_valid_progress_at — KHONG trigger production');
    }
    process.exit(0);
  }
  // Reset timer + trigger DUNG MÔT production entrypoint — he thong tu fan out 3 writer.
  writeAgent({ director: { last_valid_progress_at: new Date(nowMs).toISOString(), last_trigger_at: new Date(nowMs).toISOString(), last_trigger_note: '2h khong tien tri hop le' } });
  mkdirSync(dirname(TRIGGER_PATH), { recursive: true });
  writeFileSync(TRIGGER_PATH, new Date(nowMs).toISOString() + '
');
  gitCommitPush('director(wake): 2h khong tien tri hop le — trigger MOT production entrypoint (data/.coordinator-trigger)');
  console.log('director: production entrypoint triggered — quay lai idle, timer reset.');
}

async function main() {
  const args = process.argv.slice(2);
  if (args[0] === '--check') return cmdCheck();
  console.log('director-watchdog: thieu lenh (--check)');
  process.exit(1);
}
const INVOKED = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (INVOKED) main();
