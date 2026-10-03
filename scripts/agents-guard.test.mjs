import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPlaybook } from './repair-agent.mjs';
import { supervisorCanStart, repairOutcomeFromState, secondLinePlan, verificationVerdict } from './supervisor-recovery.mjs';
import { directorShouldTrigger, validProgressFromRuns, writerCycleActive, PROGRESS_IDLE_MS } from './director-watchdog.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pb = loadPlaybook(join(ROOT, 'data', 'repair-playbook.json'));
const NOW = 1900000000000;
const base = { incidentId: 'X', repairAgentRunning: false, supervisorRunning: false, repairOutcome: 'SUCCESS', terminalIncidents: [] };
const okDir = { nowMs: NOW, lastValidProgressMs: NOW - 3 * 3600 * 1000, lastTriggerMs: 0, lockHeld: false, repairActive: false, supervisorActive: false, productionActive: false, writerCycleActive: false };

test('#4 va #5 khong overlap — #5 tu choi khi #4 (hoac #5 khac) dang chay', () => {
  assert.equal(supervisorCanStart(Object.assign({}, base, { repairAgentRunning: true })), false);
  assert.equal(supervisorCanStart(Object.assign({}, base, { supervisorRunning: true })), false);
  assert.equal(supervisorCanStart(base), true);
});

test('#5 khong chay khi #4 chua co ket qua hoan tat (SUCCESS hoac ESCALATE)', () => {
  assert.equal(supervisorCanStart(Object.assign({}, base, { repairOutcome: null })), false);
  assert.equal(supervisorCanStart(Object.assign({}, base, { repairOutcome: 'RUNNING' })), false);
  assert.equal(supervisorCanStart(Object.assign({}, base, { incidentId: '' })), false);
  assert.equal(supervisorCanStart(Object.assign({}, base, { repairOutcome: 'ESCALATE' })), true);
});

test('repair escalation stops after #5 — incident da terminal khong duoc chay lai (chain #4 -> #5 -> human)', () => {
  assert.equal(supervisorCanStart(Object.assign({}, base, { terminalIncidents: ['X'] })), false);
  assert.equal(supervisorCanStart(Object.assign({}, base, { terminalIncidents: ['OTHER'] })), true);
});

test('repairOutcomeFromState: doc dung ket qua #4 tu production-state', () => {
  assert.equal(repairOutcomeFromState({ paused: true, paused_by: 'repair-agent', run_id: 1 }), 'ESCALATE');
  assert.equal(repairOutcomeFromState({ paused: false, last_repair: 'sig', resumed_at: 'x', run_id: 1 }), 'SUCCESS');
  assert.equal(repairOutcomeFromState({ paused: true, paused_by: 'human-admin' }), null);
  assert.equal(repairOutcomeFromState({}), null);
});

test('secondLinePlan: chi attempt khi signature safe + chua qua limit + co action; con lai terminal', () => {
  const safe = { id: 's1', class: 'safe', action: 'echo fix' };
  assert.equal(secondLinePlan(pb, safe, 0).plan, 'attempt');
  assert.equal(secondLinePlan(pb, safe, (pb.max_auto_repair_per_signature || 2)).plan, 'terminal');
  assert.equal(secondLinePlan(pb, { id: 'm1', class: 'manual' }, 0).plan, 'terminal');
  assert.equal(secondLinePlan(pb, { id: 's2', class: 'safe', action: '' }, 0).plan, 'terminal');
  assert.equal(verificationVerdict([{ ok: true }, { ok: true }]), true);
  assert.equal(verificationVerdict([{ ok: true }, { ok: false }]), false);
});

test('#6 khong trigger khi maintenance lock / repair / supervisor / publishing-deploy / writer cycle active', () => {
  for (const flag of ['lockHeld', 'repairActive', 'supervisorActive', 'productionActive', 'writerCycleActive']) {
    assert.equal(directorShouldTrigger(Object.assign({}, okDir, { [flag]: true })), false, flag + ' phai chan trigger');
  }
  assert.equal(directorShouldTrigger(okDir), true);
  assert.equal(directorShouldTrigger(Object.assign({}, okDir, { lastValidProgressMs: NOW - 30 * 60000 })), false);
});

test('#6 khong tao duplicate cycle — trigger gan day bi chan, 2h+ duoc phep', () => {
  assert.equal(directorShouldTrigger(Object.assign({}, okDir, { lastTriggerMs: NOW - 30 * 60000 })), false);
  assert.equ
al(directorShouldTrigger(Object.assign({}, okDir, { lastTriggerMs: NOW - PROGRESS_IDLE_MS - 60000 })), true);
  assert.equal(directorShouldTrigger(Object.assign({}, okDir, { lastValidProgressMs: 0 })), false);
});

test('heartbeat/log/check/that bai KHONG reset timer — chi SUCCESS Production/staging la tien tri', () => {
  const good = '2026-10-03T09:00:00Z';
  const bad = '2026-10-03T09:30:00Z';
  assert.equal(validProgressFromRuns([{ workflow: 'ci.yml', conclusion: 'success', updated_at: bad }]), 0);
  assert.equal(validProgressFromRuns([{ workflow: 'director-watchdog.yml', conclusion: 'success', updated_at: bad }]), 0);
  assert.equal(validProgressFromRuns([{ workflow: 'production.yml', conclusion: 'failure', updated_at: bad }]), 0);
  assert.equal(validProgressFromRuns([{ workflow: 'staging-signal.yml', conclusion: 'success', updated_at: bad }]), Date.parse(bad));
  assert.equal(validProgressFromRuns([
    { workflow: 'production.yml', conclusion: 'success', updated_at: good },
    { workflow: 'director-watchdog.yml', conclusion: 'success', updated_at: bad },
  ]), Date.parse(good));
});

test('writerCycleActive: chi phase dang mo (khong complete/failed) la active', () => {
  assert.equal(writerCycleActive({ phase: 'writing' }), true);
  assert.equal(writerCycleActive({ phase: 'complete' }), false);
  assert.equal(writerCycleActive({ phase: 'failed' }), false);
  assert.equal(writerCycleActive(null), false);
});

test('#6 chi trigger MÔT production entrypoint — khong dispatch writer/repair, khong sua workflow khac', () => {
  const src = readFileSync(join(ROOT, 'scripts', 'director-watchdog.mjs'), 'utf8');
  assert.ok(src.includes("'.coordinator-trigger'"), 'phai commit data/.coordinator-trigger (entrypoint duy nhat)');
  assert.ok(!src.includes('/dispatches'), 'khong duoc dispatch workflow nao qua API');
  assert.ok(!src.includes('refs/heads/staging'), 'khong duoc push nhanh staging writer');
  const y = readFileSync(join(ROOT, '.github', 'workfl
ows', 'director-watchdog.yml'), 'utf8');
  assert.ok(y.includes('director-watchdog.mjs --check'));
  assert.ok(!y.includes('staging/writer-1') && !y.includes('staging/writer-2') && !y.includes('staging/writer-3'), 'khong chay writer rieng le');
});

test('#5 workflow: khong schedule, chi trigger sau repair-agent run completed', () => {
  const y = readFileSync(join(ROOT, '.github', 'workflows', 'supervisor-recovery.yml'), 'utf8');
  assert.ok(!/^\s*schedule:/m.test(y), '#5 khong duoc poll');
  assert.match(y, /workflow_run/);
  assert.match(y, /Repair agent \(infrastructure only\)/);
  assert.ok(y.includes('supervisor-recovery.mjs --run'));
});
