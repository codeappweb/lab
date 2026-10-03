#!/usr/bin/env node
// supervisor-recovery.mjs — SUPERVISOR/RECOVERY (agent thu 5, INFRA ONLY).
// Chay SAU khi Repair Agent (#4) ket thuc (SUCCESS hoac ESCALATE) — khong bao
// gio chay dong thoi voi #4 (trigger = workflow_run completed cua #4 + guard
// kiem tra khong co run repair-agent in-progress).
// Chain toi da moi incident: #4 mot lan -> #5 mot lan -> human report.
//   #4 SUCCESS : #5 doc lap verify (syntax, regression, manifest, sitemap,
//                content, CI green, state/queue/assignments/checkpoint). Green
//                -> release lock + resume production QUA production entrypoint
//                duy nhat (data/.coordinator-trigger). Khong green -> pause lai,
//                report, terminal.
//   #4 ESCALATE: #5 MÔT second-line diagnosis (classify lai log that bai) +
//                MÔT repair attempt nho nhat (chi khi playbook class = safe);
//                regression green -> release lock + resume. Nguoc lai -> GIU
//                pause, reports/supervisor-latest.json, STOP (terminal).
// KHONG viet bai, KHONG de bai, KHONG doi content strategy, KHONG sua queue.
import { readFileSync, writeFileSync, appendFileSync, mkdirSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadPlaybook, classify, readLedger, countSignature } from './repair-agent.mjs';

const ROOT = process.env.LAB_ROOT ? resolve(process.env.LAB_ROOT) : resolve(join(dirname(fileURLToPath(import.meta.url)), '..'));
const STATE_PATH = join(ROOT, 'data', 'production-state.json');
const AGENT_PATH = join(ROOT, 'data', 'agent-state.json');
const LEDGER_PATH = join(ROOT, 'data', 'repair-ledger.jsonl');
const PLAYBOOK_PATH = join(ROOT, 'data', 'repair-playbook.json');
const REPORT_PATH = join(ROOT, 'reports', 'supervisor-latest.json');
const TRIGGER_PATH = join(ROOT, 'data', '.coordinator-trigger');

function readState() { try { return JSON.parse(readFileSync(STATE_PATH, 'utf8')); } catch (e) { return {}; } }
function readAgent() {
  try { return JSON.parse(readFileSync(AGENT_PATH, 'utf8')); }
  catch (e) { return { repair: {}, supervisor: { terminal_incidents: [] }, director: {} }; }
}
function writeState(patch) {
  const st = Object.assign({}, readState(), patch);
  mkdirSync(join(ROOT, 'data'), { recursive: true });
  writeFileSync(STATE_PATH, JSON.stringify(st, null, 2) + '\n');
  return st;
}
function writeAgent(patch) {
  const st = readAgent();
  for (const k of Object.keys(patch)) st[k] = Object.assign({}, st[k] || {}, patch[k]);
  mkdirSync(join(ROOT, 'data'), { recursive: true });
  writeFileSync(AGENT_PATH, JSON.stringify(st, null, 2) + '\n');
  return st;
}
function gitCommitPush(msg) {
  const g = (a) => spawnSync('git', a, { cwd: ROOT, encoding: 'utf8' });
  g(['config', 'user.name', 'lab-supervisor-recovery']);
  g(['config', 'user.email', 'codeappweb@users.noreply.github.com']);
  g(['add', '-A']);
  g(['commit', '-m', msg]);
  const p = g(['push', 'origin', 'HEAD:main']);
  if (p.status !== 0) { console.log('::error::supervisor: push main that bai — ' + (p.stderr || '') + ' — thoat, KHONG tiep tuc.'); process.exit(1); }
}
function run(cmd) {
  const r = spawnSync('sh', ['-c', cmd], { cwd: ROOT, encoding: 'utf8' });
  if (r.stdout) process.stdout.write(r.stdout);
  if (r.stderr) process.stderr.write(r.stderr);
  return r.status;
}
async function ghJson(url, headers) {
  const r = await fetch(url, { headers });
  if (r.status === 403 || r.status === 429) {
    console.log('::warning::GitHub API rate limit — checkpoint, thoat sach (khong thay doi gi).');
    process.exit(0);
  }
  if (r.status !== 200) { console.log('::error::GitHub API HTTP ' + r.status + ' cho ' + url); process.exit(1); }
  return r.json();
}
async function ghText(url, headers) {
  const r = await fetch(url, { headers, redirect: 'follow' });
  if (r.status !== 200) return '';
  return r.text();
}

// ---------- pure guards (unit-tested trong agents-guard.test.mjs) ----------
export function repairOutcomeFromState(state) {
  if (!state || !state.run_id) return null;
  if (state.paused === true && state.paused_by === 'repair-agent') return 'ESCALATE';
  if (state.paused === true) return null; // pause boi ben khac — khong phai ket qua #4
  if (state.last_repair || state.resumed_at) return 'SUCCESS';
  return null;
}
export function supervisorCanStart(ctx) {
  if (!ctx || !ctx.incidentId) return false;
  if (ctx.repairAgentRunning || ctx.supervisorRunning) return false; // #4/#5 khong overlap
  if (ctx.repairOutcome !== 'SUCCESS' && ctx.repairOutcome !== 'ESCALATE') return false; // phai co ket qua #4 hoan tat
  if ((ctx.terminalIncidents || []).indexOf(ctx.incidentId) !== -1) return false; // chain #4 -> #5 -> human: STOP
  return true;
}
export function secondLinePlan(playbook, sig, count) {
  const max = playbook.max_auto_repair_per_signature || 2;
  if (sig && sig.class === 'safe' && count < max && sig.action) return { plan: 'attempt', signature: sig.id, action: sig.action };
  return { plan: 'terminal', signature: sig ? sig.id : 'unknown', action: '' };
}
export function verificationVerdict(checks) { return (checks || []).every((c) => c && c.ok); }

// ---------- helpers ----------
async function workflowActive(headers, wfFile) {
  const d = await ghJson('https://api.github.com/repos/codeappweb/lab/actions/workflows/' + wfFile + '/runs?status=in_progress&per_page=5', headers);
  return ((d.workflow_runs || []).length > 0);
}
async function fetchFailureLogs(headers, runId) {
  if (!runId) return '';
  const jobs = await ghJson('https://api.github.com/repos/codeappweb/lab/actions/runs/' + runId + '/jobs?per_page=100', headers);
  const texts = [];
  for (const j of (jobs.jobs || [])) if (j.conclusion === 'failure' && j.logs_url) texts.push(await ghText(j.logs_url, headers));
  return texts.join('\n');
}
function dataIntegrity() {
  const files = ['data/production-state.json', 'data/agent-state.json', 'data/factory-cycle.json', 'data/writer-assignments.json'];
  for (const f of files) {
    try { JSON.parse(readFileSync(join(ROOT, f), 'utf8')); }
    catch (e) { return { ok: false, detail: f + ' khong parse duoc: ' + e.message }; }
  }
  try {
    readFileSync(join(ROOT, 'data', 'article-manifest.jsonl'), 'utf8').split('\n').filter((l) => l.trim()).forEach((l) => JSON.parse(l));
  } catch (e) { return { ok: false, detail: 'article-manifest.jsonl co dong hong: ' + e.message }; }
  return { ok: true, detail: 'state/queue/assignments/checkpoint parse OK' };
}
async function ciGreen(headers) {
  const d = await ghJson('https://api.github.com/repos/codeappweb/lab/actions/workflows/ci.yml/runs?branch=main&per_page=5', headers);
  const runs = d.workflow_runs || [];
  if (!runs.length) return { ok: false, detail: 'khong tim thay run CI tren main' };
  const r = runs[0];
  if (r.status !== 'completed') return { ok: false, detail: 'CI run moi nhat chua ket thuc' };
  return { ok: r.conclusion === 'success', detail: 'CI run ' + r.id + ' = ' + r.conclusion };
}
async function verifySuite(headers) {
  const checks = [];
  const push = (name, ok, detail) => checks.push({ name, ok, detail: detail || '' });
  push('syntax', run('for f in scripts/*.mjs; do node --check "$f" || exit 1; done') === 0);
  push('regression', run('node --test scripts/*.test.mjs') === 0);
  push('manifest-sync', run('node scripts/sync-manifest.mjs --dry-run') === 0);
  push('sitemap', run('node scripts/validate-sitemap.mjs') === 0);
  push('content', run('node scripts/validate-content.mjs') === 0);
  const di = dataIntegrity(); push('data-integrity', di.ok, di.detail);
  const ci = await ciGreen(headers); push('ci-green', ci.ok, ci.detail);
  return checks;
}
function resumeProduction(incidentId, note) {
  writeState({ paused: false, paused_by: null, resumed_at: new Date().toISOString(), resumed_by: 'supervisor-recovery', escalated: false, blocker: null });
  writeAgent({ supervisor: { status: 'resumed', last_incident_id: incidentId, last_action: note }, repair: { status: 'idle', outcome: 'SUCCESS' } });
  mkdirSync(dirname(TRIGGER_PATH), { recursive: true });
  writeFileSync(TRIGGER_PATH, new Date().toISOString() + '\n'); // production entrypoint duy nhat
  gitCommitPush('supervisor(' + note + '): release lock + resume production qua entrypoint duy nhat (incident ' + incidentId + ')');
  console.log('supervisor: verification/repair GREEN — lock released, production RESUMED (incident ' + incidentId + ').');
}
function terminal(incidentId, reason, attempts) {
  const a = readAgent();
  a.supervisor = Object.assign({}, a.supervisor || {}, { status: 'terminal', last_incident_id: incidentId });
  a.supervisor.terminal_incidents = (a.supervisor.terminal_incidents || []).concat([incidentId]);
  mkdirSync(join(ROOT, 'data'), { recursive: true });
  writeFileSync(AGENT_PATH, JSON.stringify(a, null, 2) + '\n');
  mkdirSync(dirname(LEDGER_PATH), { recursive: true });
  appendFileSync(LEDGER_PATH, JSON.stringify({ ts: new Date().toISOString(), incident_id: incidentId, outcome: 'supervisor-terminal', reason, attempts }) + '\n');
  mkdirSync(dirname(REPORT_PATH), { recursive: true });
  writeFileSync(REPORT_PATH, JSON.stringify({ status: 'blocked — production GIU PAUSE sau chain #4 -> #5', incident_id: incidentId, reason, attempts, ts: new Date().toISOString() }, null, 2) + '\n');
  gitCommitPush('supervisor(terminal): incident ' + incidentId + ' — GIU PAUSE, blocker xem reports/supervisor-latest.json (chain #4 -> #5 -> human DONE)');
  console.log('::error::SUPERVISOR BLOCKER: ' + reason + ' — production paused, can nguoi quan tri xem reports/supervisor-latest.json. STOP.');
  process.exit(1);
}

async function cmdRun(incidentArg) {
  const headers = { Authorization: 'Bearer ' + (process.env.GITHUB_TOKEN || ''), Accept: 'application/vnd.github+json' };
  const repairAgentRunning = await workflowActive(headers, 'repair-agent.yml');
  const state = readState();
  const agent = readAgent();
  const incidentId = String(incidentArg || state.run_id || '');
  const outcome = repairOutcomeFromState(state);
  const terminalIncidents = (agent.supervisor && agent.supervisor.terminal_incidents) || [];
  const can = supervisorCanStart({ incidentId, repairAgentRunning, supervisorRunning: false, repairOutcome: outcome, terminalIncidents });
  if (!can) {
    console.log('supervisor: khong du dieu kien chay (incident=' + incidentId + ', outcome=' + outcome + ', #4-running=' + repairAgentRunning + ', terminal=' + (terminalIncidents.indexOf(incidentId) !== -1) + ') — thoat sach, KHONG repair loop.');
    process.exit(0);
  }
  writeAgent({ supervisor: { status: 'running', last_incident_id: incidentId } });
  if (outcome === 'SUCCESS') {
    const checks = await verifySuite(headers);
    console.log(checks.map((c) => '  ' + c.name + ': ' + (c.ok ? 'OK' : 'FAIL ' + c.detail)).join('\n'));
    if (verificationVerdict(checks)) { resumeProduction(incidentId, 'verify-green'); return; }
    writeState({ paused: true, paused_by: 'supervisor-recovery', paused_at: new Date().toISOString(), escalated: true, blocker: 'supervisor-verify-failed' });
    terminal(incidentId, 'verification KHONG green sau #4 SUCCESS: ' + checks.filter((c) => !c.ok).map((c) => c.name).join(', '), ['verify-only']);
    return;
  }
  // outcome === 'ESCALATE' — MÔT second-line diagnosis + MÔT repair attempt nho nhat
  const logText = await fetchFailureLogs(headers, state.run_id);
  const playbook = loadPlaybook(PLAYBOOK_PATH);
  const sig = classify(playbook, logText);
  const plan = secondLinePlan(playbook, sig, countSignature(readLedger(LEDGER_PATH), sig.id));
  if (plan.plan !== 'attempt') {
    terminal(incidentId, 'second-line: signature ' + sig.id + ' (class ' + sig.class + ') khong co safe action nho nhat — khong doan', ['diagnose:' + sig.id]);
    return;
  }
  const st = run(plan.action);
  if (st !== 0) { terminal(incidentId, 'second-line repair attempt FAIL (exit ' + st + ') — signature ' + sig.id, ['attempt:' + sig.id]); return; }
  const checks = await verifySuite(headers);
  if (verificationVerdict(checks)) {
    mkdirSync(dirname(LEDGER_PATH), { recursive: true });
    appendFileSync(LEDGER_PATH, JSON.stringify({ ts: new Date().toISOString(), incident_id: incidentId, outcome: 'supervisor-repaired', signature: sig.id, action: plan.action }) + '\n');
    resumeProduction(incidentId, 'second-line-repair-green');
    return;
  }
  writeState({ paused: true, paused_by: 'supervisor-recovery', paused_at: new Date().toISOString(), escalated: true, blocker: 'supervisor-repair-not-green' });
  terminal(incidentId, 'regression KHONG green sau second-line repair (signature ' + sig.id + ')', ['attempt:' + sig.id, 'regression-failed']);
}

async function main() {
  const args = process.argv.slice(2);
  const opt = (n) => { const i = args.indexOf(n); return i !== -1 ? args[i + 1] : undefined; };
  if (args[0] === '--run') return cmdRun(opt('--incident'));
  console.log('supervisor-recovery: thieu lenh (--run --incident <id>)');
  process.exit(1);
}
const INVOKED = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (INVOKED) main();
