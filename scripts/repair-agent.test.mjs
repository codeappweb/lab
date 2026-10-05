import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPlaybook, classify, countSignature, decidePlan, pauseDecision } from './repair-agent.mjs';

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

// ---- 2026-10-05: phan loai TRUOC khi lock (goc loi cascade run 37318644251) ----

test('repair-agent classify: loi noi dung writer (validator RED / front matter) -> class content, KHONG phai infra', () => {
  const s = classify(pb, '::error::_posts/2026-10-05-x.md: front matter dong khong parse duoc: - "mua sắm"');
  assert.equal(s.id, 'writer-content-invalid');
  assert.equal(s.class, 'content');
  assert.equal(decidePlan(pb, s, 0), 'content');
});
test('repair-agent classify: loi noi dung khac cua writer gate cung ve content queue', () => {
  const s = classify(pb, '::error::_posts/x.md: it hon 2 link noi boi liquid relative_url (co 1)');
  assert.equal(s.id, 'writer-content-invalid');
});
test('repair-agent pauseDecision: PAUSE dang co -> KHONG mo incident moi (chong cascade)', () => {
  assert.equal(pauseDecision({ paused: true, run_id: 1, blocker: 'unclassified' }, { id: 'x', class: 'manual' }), 'skip-already-paused');
  assert.equal(pauseDecision({ paused: true }, null), 'skip-already-paused');
});
test('repair-agent pauseDecision: run fail vi PAUSE dang co -> skip, khong incident', () => {
  assert.equal(pauseDecision({ paused: false }, { id: 'production-paused', class: 'manual' }), 'skip-production-paused');
  assert.equal(pauseDecision({ paused: false }, null), 'skip-production-paused');
});
test('repair-agent pauseDecision: loi content -> writer review queue, KHONG lock; chi infra that su moi lock', () => {
  assert.equal(pauseDecision({ paused: false }, { id: 'writer-content-invalid', class: 'content' }), 'content-review');
  assert.equal(pauseDecision({ paused: false }, { id: 'pages-build-transient', class: 'safe' }), 'lock');
  assert.equal(pauseDecision({ paused: false }, { id: 'unclassified', class: 'manual' }), 'lock');
});
test('repair-agent decidePlan: content -> plan content (khong repair, khong escalate, khong incident)', () => {
  assert.equal(decidePlan(pb, { id: 'writer-content-invalid', class: 'content' }, 0), 'content');
  assert.equal(decidePlan(pb, { id: 'production-paused', class: 'manual' }, 0), 'none');
});
