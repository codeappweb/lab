import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPlaybook, classify, countSignature, decidePlan } from './repair-agent.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pb = loadPlaybook(join(ROOT, 'data', 'repair-playbook.json'));

test('repair-agent classify: pages transient -> safe (retry, khong sua gi)', () => {
  const s = classify(pb, 'pages build trigger HTTP 502');
  assert.equal(s.id, 'pages-build-transient');
  assert.equal(s.class, 'safe');
});
test('repair-agent classify: rate limit -> safe (checkpoint, khong poll)', () => {
  const s = classify(pb, 'API rate limit exceeded for this token');
  assert.equal(s.class, 'safe');
});
test('repair-agent classify: loi la -> default manual (KHONG doan, escalate)', () => {
  const s = classify(pb, 'hoan toan loi lac khong ai tung thay');
  assert.equal(s.class, 'manual');
  assert.equal(s.id, 'unclassified');
});
test('repair-agent classify: run fail vi production dang pause -> khong phai loi moi', () => {
  const s = classify(pb, '::error::Production DANG PAUSED boi repair-agent — maintenance lock');
  assert.equal(s.id, 'production-paused');
});
test('repair-agent decidePlan: safe toi da 2 lan; lan thu 3 cung signature -> escalate', () => {
  assert.equal(decidePlan(pb, { id: 'x', class: 'safe' }, 0), 'safe');
  assert.equal(decidePlan(pb, { id: 'x', class: 'safe' }, 1), 'safe');
  assert.equal(decidePlan(pb, { id: 'x', class: 'safe' }, 2), 'escalate');
  assert.equal(decidePlan(pb, { id: 'x', class: 'manual' }, 0), 'escalate');
});
test('repair-agent countSignature: dem dung so lan cung signature trong ledger', () => {
  const entries = [{ signature: 'a' }, { signature: 'b' }, { signature: 'a' }, {}];
  assert.equal(countSignature(entries, 'a'), 2);
  assert.equal(countSignature(entries, 'c'), 0);
});
test('repair-agent workflow: KHONG poll — chi trigger tu failure event', () => {
  const y = readFileSync(join(ROOT, '.github', 'workflows', 'repair-agent.yml'), 'utf8');
  assert.ok(!/^\s*schedule:/m.test(y));
  assert.match(y, /workflow_run/);
  assert.ok(!/while true|sleep [0-9]/.test(y), 'khong duoc co vong poll trong workflow');
});
