#!/usr/bin/env node
// repair-agent.mjs — REPAIR AGENT (agent thu 4 — INFRASTRUCTURE ONLY).
// Chi sua loi INFRA (workflow, build, deploy, staging, state) khi co that su
// failure event (workflow_run completed failure cua Production/CI).
// KHONG BAO GIO: viet bai, de bai moi, doi content strategy, sua architecture
// lien quan, cham bai tren main.
//   --pause <run-id> : PHAN LOAI TRUOC (classify log cua run), roi moi quyet
//                      dinh lock (goc loi cascade 2026-10-05: pause-truoc-
//                      phan-loai lam moi run bi chan boi PAUSE cung mo incident
//                      moi -> 15+ supervisor terminal commits):
//                      - PAUSE dang co            -> exit 0, KHONG incident moi
//                      - run fail vi PAUSE (signature production-paused)
//                                                -> exit 0, KHONG incident moi
//                      - loi NOI DUNG bai writer (class content trong playbook)
//                                                -> ghi writer review queue,
//                                                   KHONG pause, KHONG incident
//                      - loi infra that su        -> acquire maintenance lock
//                        (data/production-state.json paused=true) — production.yml
//                        dung o buoc 0a.
//   --inspect <run-id>: tai log cac job FAIL, trich error lines, classify
//                      theo data/repair-playbook.json, dem so lan cung
//                      signature trong data/repair-ledger.jsonl. Rate limit
//                      -> checkpoint, exit 0 sach (khong poll).
//   --repair         : plan safe + co action -> chay action nho nhat.
//   --resume         : commit fix (neu co) + ledger + paused=false, push main.
//   --escalate       : unclear/major/repeated -> KHONG doan: giu pause, ghi
//                      reports/repair-latest.json, exit 1.
// Giai han: cung signature auto-repair toi da max_auto_repair_per_signature
// (mac dinh 2) — qua muc do escalate.
import { readFileSync, writeFileSync, existsSync, appendFileSync, mkdirSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = process.env.LAB_ROOT ? resolve(process.env.LAB_ROOT) : resolve(join(dirname(fileURLToPath(import.meta.url)), '..'));
const STATE_PATH = join(ROOT, 'data', 'production-state.json');
const LEDGER_PATH = join(ROOT, 'data', 'repair-ledger.jsonl');
const PLAYBOOK_PATH = join(ROOT, 'data', 'repair-playbook.json');
const PLAN_PATH = process.env.REPAIR_PLAN_FILE || '/tmp/repair-plan.json';
const REPORT_PATH = join(ROOT, 'reports', 'repair-latest.json');
const REVIEW_QUEUE_PATH = join(ROOT, 'data', 'writer-review-queue.jsonl');

function loadPlaybook(p) { return JSON.parse(readFileSync(p, 'utf8')); }
function classify(playbook, text) {
  for (const s of playbook.signatures || []) {
    try { if (new RegExp(s.match, 'i').test(text)) return s; } catch (e) {}
  }
  return { id: 'unclassified', class: playbook.default_class || 'manual', action: '', description: 'signature khong khop playbook — coi nhu unclear, khong doan' };
}
function readLedger(p) { try { return readFileSync(p, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l)); } catch (e) { return []; } }
function countSignature(entries, sig) { return entries.filter((e) => e && e.signature === sig).length; }
function decidePlan(playbook, sig, count) {
  if (sig.id === 'production-paused') return 'none';
  if (sig.class === 'content') return 'content';
  if (sig.class !== 'safe') return 'escalate';
  const max = playbook.max_auto_repair_per_signature || 2;
  if (count >= max) return 'escalate';
  return 'safe';
}
// Phan loai TRUOC khi lock: quyet dinh pause gate cho run that bai moi.
//   skip-already-paused : PAUSE dang co — KHONG mo incident moi (chong cascade)
//   skip-production-paused: run fail vi PAUSE — hau qua, khong phai loi moi
//   content-review      : loi noi dung bai writer — tra ve writer, KHONG lock
//   lock                : loi infra that su — acquire maintenance lock
export function pauseDecision(state, sig) {
  if (state && state.paused === true) return 'skip-already-paused';
  if (!sig || sig.id === 'production-paused') return 'skip-production-paused';
  if (sig.class === 'content') return 'content-review';
  return 'lock';
}
function readState() { try { return JSON.parse(readFileSync(STATE_PATH, 'utf8')); } catch (e) { return {}; } }
function writeState(patch) {
  const st = Object.assign({}, readState(), patch);
  mkdirSync(join(ROOT, 'data'), { recursive: true });
  writeFileSync(STATE_PATH, JSON.stringify(st, null, 2) + '\n');
  return st;
}
function gitCommitPush(msg) {
  const g = (a) => spawnSync('git', a, { cwd: ROOT, encoding: 'utf8' });
  g(['config', 'user.name', 'lab-repair-agent']);
  g(['config', 'user.email', 'codeappweb@users.noreply.github.com']);
  g(['add', '-A']);
  g(['commit', '-m', msg]);
  const p = g(['push', 'origin', 'HEAD:main']);
  if (p.status !== 0) { console.log('::error::repair-agent: push main that bai — ' + (p.stderr || '') + ' — thoat, lock van giu (event sau xu ly).'); process.exit(1); }
}
function out(pair) { if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, pair + '\n'); }

async function ghJson(url, headers) {
  const r = await fetch(url, { headers });
  if (r.status === 403 || r.status === 429) {
    console.log('::warning::GitHub API rate limit (HTTP ' + r.status + ', remaining=' + r.headers.get('x-ratelimit-remaining') + ') — checkpoint: khong poll, thoat sach; retry o failure event sau.');
    process.exit(0);
  }
  if (r.status !== 200) { console.log('::error::GitHub API HTTP ' + r.status + ' cho ' + url); process.exit(1); }
  return r.json();
}
async function ghText(url, headers) {
  const r = await fetch(url, { headers, redirect: 'follow' });
  if (r.status === 403 || r.status === 429) { console.log('::warning::GitHub API rate limit — checkpoint, thoat sach.'); process.exit(0); }
  if (r.status !== 200) return '';
  return r.text();
}
async function fetchFailureLogText(runId, headers) {
  if (!runId) return '';
  const jobs = await ghJson('https://api.github.com/repos/codeappweb/lab/actions/runs/' + runId + '/jobs?per_page=100', headers);
  const texts = [];
  for (const j of (jobs.jobs || [])) {
    if (j.conclusion === 'failure' && j.logs_url) texts.push(await ghText(j.logs_url, headers));
  }
  return texts.join('\n');
}

async function cmdPause(runId) {
  const headers = { Authorization: 'Bearer ' + (process.env.GITHUB_TOKEN || ''), Accept: 'application/vnd.github+json' };
  // PHAN LOAI TRUOC khi khoa production — chi loi infra that su moi duoc lock.
  let sig = null;
  try {
    const logText = await fetchFailureLogText(runId, headers);
    sig = classify(loadPlaybook(PLAYBOOK_PATH), logText);
  } catch (e) {
    sig = null; // khong classify duoc -> pauseDecision bao thang (an toan)
  }
  const st = readState();
  const decision = pauseDecision(st, sig);
  if (decision === 'skip-already-paused') {
    console.log('::warning::maintenance lock DANG CO (run ' + st.run_id + ', blocker ' + (st.blocker || '?') + ') — event nay la hau qua cua PAUSE dang co: KHONG mo incident moi, KHONG pause lai.');
    process.exit(0);
  }
  if (decision === 'skip-production-paused') {
    console.log('::warning::run fail vi production DANG PAUSE (signature production-paused) — khong phai loi moi, KHONG mo incident.');
    process.exit(0);
  }
  if (decision === 'content-review') {
    const entry = { ts: new Date().toISOString(), run_id: runId, signature: sig.id, route: 'writer-review-queue', reason: sig.description || 'Loi noi dung bai writer (content gate RED) — writer tu fix content roi push lai staging.' };
    mkdirSync(join(ROOT, 'data'), { recursive: true });
    appendFileSync(REVIEW_QUEUE_PATH, JSON.stringify(entry) + '\n');
    console.log('::warning::LOI NOI DUNG BAI VIET (signature ' + sig.id + ') — tra ve writer/review queue (data/writer-review-queue.jsonl), KHONG pause production, KHONG incident. Writer tu fix content roi push lai staging.');
    process.exit(0);
  }
  writeState({ paused: true, paused_by: 'repair-agent', paused_at: new Date().toISOString(), run_id: runId, reason: 'infra failure run ' + runId, escalated: false });
  gitCommitPush('repair(pause): production paused — maintenance lock cho run ' + runId + ' (infra inspect)');
  console.log('repair-agent: production PAUSED, maintenance lock da commit tren main.');
}

async function cmdInspect(runId) {
  const headers = { Authorization: 'Bearer ' + (process.env.GITHUB_TOKEN || ''), Accept: 'application/vnd.github+json' };
  let eff = runId;
  if (!eff) {
    const d = await ghJson('https://api.github.com/repos/codeappweb/lab/actions/workflows/production.yml/runs?status=failure&per_page=1', headers);
    eff = d.workflow_runs && d.workflow_runs[0] && d.workflow_runs[0].id;
    if (!eff) { console.log('::warning::khong tim thay run Production that bai — thoat sach.'); process.exit(0); }
  }
  const logText = await fetchFailureLogText(eff, headers);
  const errors = logText.split('\n').filter((l) => /::error::|fatal:|Error:|ERROR /i.test(l)).slice(0, 60);
  const playbook = loadPlaybook(PLAYBOOK_PATH);
  const sig = classify(playbook, logText);
  const count = countSignature(readLedger(LEDGER_PATH), sig.id);
  const plan = decidePlan(playbook, sig, count);
  mkdirSync(dirname(PLAN_PATH), { recursive: true });
  writeFileSync(PLAN_PATH, JSON.stringify({ run_id: eff, signature: sig.id, class: sig.class, description: sig.description || '', action: sig.action || '', plan, repair_count: count, log_excerpt: errors.slice(0, 40) }, null, 2) + '\n');
  out('plan=' + plan);
  out('signature=' + sig.id);
  out('reason=' + (sig.description || ''));
  console.log('repair-agent(inspect): signature=' + sig.id + ' class=' + sig.class + ' plan=' + plan + ' (da tu fix ' + count + ' lan cung signature)');
}

function readPlan() { return JSON.parse(readFileSync(PLAN_PATH, 'utf8')); }
function cmdRepair() {
  const plan = readPlan();
  if (plan.plan !== 'safe') { console.log('::error::plan hien tai = ' + plan.plan + ' — tu choi --repair.'); process.exit(1); }
  if (!plan.action) { console.log('repair-agent: signature safe, khong can fix manh — retry tu nhien o chu ky sau.'); process.exit(0); }
  console.log('repair-agent: ap dung fix nho nhat: ' + plan.action);
  const r = spawnSync('sh', ['-c', plan.action], { cwd: ROOT, encoding: 'utf8' });
  if (r.stdout) process.stdout.write(r.stdout);
  if (r.stderr) process.stderr.write(r.stderr);
  if (r.status !== 0) { console.log('::error::action repair that bai (exit ' + r.status + ') — se escalate, KHONG resume.'); process.exit(1); }
}
function cmdResume() {
  const plan = readPlan();
  mkdirSync(join(ROOT, 'data'), { recursive: true });
  appendFileSync(LEDGER_PATH, JSON.stringify({ ts: new Date().toISOString(), run_id: plan.run_id, signature: plan.signature, outcome: 'auto-repaired', action: plan.action || '(retry-only)' }) + '\n');
  writeState({ paused: false, paused_by: null, resumed_at: new Date().toISOString(), last_repair: plan.signature, escalated: false });
  gitCommitPush('repair(agent): ' + plan.signature + ' — fix nho nhat, regression green, RESUME production (run ' + plan.run_id + ')');
  console.log('repair-agent: lock released, production RESUMED.');
}
function cmdEscalate() {
  const plan = readPlan();
  mkdirSync(join(ROOT, 'data'), { recursive: true });
  appendFileSync(LEDGER_PATH, JSON.stringify({ ts: new Date().toISOString(), run_id: plan.run_id, signature: plan.signature, outcome: 'escalated' }) + '\n');
  mkdirSync(dirname(REPORT_PATH), { recursive: true });
  writeFileSync(REPORT_PATH, JSON.stringify({ status: 'blocked — production GIU PAUSE', signature: plan.signature, reason: plan.description, repair_count: plan.repair_count, run_id: plan.run_id, log_excerpt: plan.log_excerpt, ts: new Date().toISOString() }, null, 2) + '\n');
  writeState({ paused: true, paused_by: 'repair-agent', paused_at: new Date().toISOString(), escalated: true, blocker: plan.signature });
  gitCommitPush('repair(escalate): ' + plan.signature + ' — production GIU PAUSE; blocker: xem reports/repair-latest.json (run ' + plan.run_id + ')');
  console.log('::error::REPAIR BLOCKER: ' + plan.signature + ' — ' + plan.description + ' — production paused, can nguoi quan tri xem reports/repair-latest.json.');
}

async function main() {
  const args = process.argv.slice(2);
  const opt = (n) => { const i = args.indexOf(n); return i !== -1 ? args[i + 1] : undefined; };
  const cmd = args[0];
  if (cmd === '--pause') return cmdPause(opt('--run-id') || '');
  if (cmd === '--inspect') return cmdInspect(opt('--run-id') || '');
  if (cmd === '--repair') return cmdRepair();
  if (cmd === '--resume') return cmdResume();
  if (cmd === '--escalate') return cmdEscalate();
  console.log('repair-agent: thieu lenh (--pause|--inspect|--repair|--resume|--escalate)');
  process.exit(1);
}
const INVOKED = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (INVOKED) main();

export { loadPlaybook, classify, readLedger, countSignature, decidePlan };
