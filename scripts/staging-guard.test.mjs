import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyStrayFiles, nonPostPaths } from './staging-guard.mjs';

// Goc loi incident 37466641605 (run 37466077247): commit reconcile sync
// derived state tren staging lam guard ba-cham bao contamination trai voi
// file ma content DA GIONG HET main — production bi PAUSE chuoi dai.

test('file staging tu commit nhung content trung main: KHONG contamination', () => {
  const blobOf = () => 'aaa111';
  assert.deepEqual(classifyStrayFiles(['data/progress.json'], blobOf), []);
});

test('file ngoai _posts khac content main: contamination', () => {
  const blobOf = (_p, side) => (side === 'staging' ? 'aaa111' : 'bbb222');
  assert.deepEqual(classifyStrayFiles(['data/progress.json'], blobOf), ['data/progress.json']);
});

test('file ngoai _posts moi tren staging (khong co tren main): contamination', () => {
  const blobOf = (_p, side) => (side === 'staging' ? 'aaa111' : null);
  assert.deepEqual(classifyStrayFiles(['scripts/x.mjs'], blobOf), ['scripts/x.mjs']);
});

test('file ton tai tren main bi xoa tren staging: contamination', () => {
  const blobOf = (_p, side) => (side === 'main' ? 'bbb222' : null);
  assert.deepEqual(classifyStrayFiles(['data/agent-state.json'], blobOf), ['data/agent-state.json']);
});

test('blob khac nhau o hai van de doc lap deu tra ve ket qua dung', () => {
  const blobOf = (p, side) => (p === 'same.md' ? 'x' : side === 'staging' ? 'a' : 'b');
  assert.deepEqual(classifyStrayFiles(['same.md', 'diff.md'], blobOf), ['diff.md']);
});

test('nonPostPaths bo qua dung _posts/*.md va trim khoang trang', () => {
  const paths = ['_posts/2026-10-06-bai-a.md', 'data/progress.json', ' scripts/x.mjs '];
  assert.deepEqual(nonPostPaths(paths), ['data/progress.json', 'scripts/x.mjs']);
});

test('blobOf khong phai ham: throw TypeError', () => {
  assert.throws(() => classifyStrayFiles(['a'], null), TypeError);
});
