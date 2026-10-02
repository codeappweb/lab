#!/usr/bin/env node
// next-pair.test.mjs — regression tests cho 3-writer deterministic slicing
// (node --test scripts/*.test.mjs). Chay tren fixture trong temp dir qua
// LAB_ROOT; KHONG BAO GIO cham state production.
// Fixture matrix:
//   W1  legacy mode giu nguyen hanh vi cu (chunk_size ID dau)
//   W2  ba slice writer-1/2/3 roi rac hai hai (pairwise disjoint)
//   W3  union cua ba slice = dung cac row eligible dau tien, khong thua sot
//   W4  row published va row trong review_queue khong bao gio duoc cap
//   W5  --count vuot chunk_size_max bi tu choi (exit != 0)
//   W6  ten writer sai dinh dang bi tu choi (exit != 0)
//   W7  writer-K ngoai pham vi 1..N bi tu choi (exit != 0)
//   W8  --count override hoat dong
//   W9  slice rong → exit 0 voi thong bao, khong loi
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'next-pair.mjs');

function fixture(cfg, rows, review) {
  const root = mkdtempSync(join(tmpdir(), 'nextpair-'));
  mkdirSync(join(root, 'data'), { recursive: true });
  writeFileSync(join(root, 'data', 'factory-config.json'), JSON.stringify(cfg));
  writeFileSync(join(root, 'data', 'article-manifest.jsonl'), rows.map(r => JSON.stringify(r)).join('\n') + '\n');
  writeFileSync(join(root, 'data', 'writer-checkpoint.json'), JSON.stringify({ review_queue: review }));
  return root;
}

function run(root, cli) {
  const r = spawnSync('node', [SCRIPT, ...cli], {
    env: { ...process.env, LAB_ROOT: root },
    encoding: 'utf8',
  });
  return { status: r.status, out: r.stdout, err: r.stderr };
}

function ids(out) {
  return [...out.matchAll(/^  (C\d+-\d+) /gm)].map(m => m[1]);
}

function row(id, status) {
  return { id, slug: 'slug-' + id.toLowerCase(), cluster: 'C05', primary_topic: 'topic ' + id, status };
}

const CFG = { chunk_size: 2, chunk_size_max: 2, writers: 3, writer_chunk_size: 2 };

function stdRows() {
  const rows = [row('C05-0000', 'published')];
  for (let i = 1; i <= 9; i++) rows.push(row('C05-000' + i, 'planned'));
  return rows;
}

test('W1: legacy mode giu nguyen hanh vi cu — chunk_size ID dau tien', () => {
  const root = fixture(CFG, stdRows(), []);
  try {
    const r = run(root, []);
    assert.equal(r.status, 0);
    assert.deepEqual(ids(r.out), ['C05-0001', 'C05-0002']);
    assert.match(r.out, /ID ke tiep \(repository truth, chua claim\)/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('W1b: legacy positional count va gioi han chunk_size_max', () => {
  const root = fixture(CFG, stdRows(), []);
  try {
    const ok = run(root, ['3']);
    assert.equal(ok.status, 1);
    assert.match(ok.err, /vuot chunk_size_max=2/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('W2 + W3: ba slice roi sac hai hai va union = dung cac row eligible dau', () => {
  const root = fixture(CFG, stdRows(), [{ id: 'C05-0009' }]);
  try {
    const s1 = run(root, ['--writer', 'writer-1']);
    const s2 = run(root, ['--writer', 'writer-2']);
    const s3 = run(root, ['--writer', 'writer-3']);
    assert.equal(s1.status, 0);
    assert.equal(s2.status, 0);
    assert.equal(s3.status, 0);
    const a = ids(s1.out), b = ids(s2.out), c = ids(s3.out);
    // eligible = C05-0001..C05-0008 (0000 published, 0009 trong review_queue)
    assert.deepEqual(a, ['C05-0001', 'C05-0004']);
    assert.deepEqual(b, ['C05-0002', 'C05-0005']);
    assert.deepEqual(c, ['C05-0003', 'C05-0006']);
    const union = [...a, ...b, ...c].sort();
    assert.equal(new Set(union).size, union.length, 'slice phan tu phai duy nhat');
    assert.deepEqual(union, ['C05-0001', 'C05-0002', 'C05-0003', 'C05-0004', 'C05-0005', 'C05-0006']);
    for (const s of [s1, s2, s3]) assert.match(s.out, /RESERVED \(deterministic slice\)/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('W4: row published va review_queue khong bao gio duoc cap', () => {
  const root = fixture(CFG, stdRows(), [{ id: 'C05-0009' }]);
  try {
    for (const w of ['writer-1', 'writer-2', 'writer-3']) {
      const s = run(root, ['--writer', w, '--count', '2']);
      assert.equal(s.status, 0);
      const got = ids(s.out);
      assert.equal(got.length, 2);
      assert.ok(!got.includes('C05-0000'), 'row published phai bi loai');
      assert.ok(!got.includes('C05-0009'), 'row review_queue phai bi loai');
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('W5: --count vuot chunk_size_max bi tu choi', () => {
  const root = fixture(CFG, stdRows(), []);
  try {
    const r = run(root, ['--writer', 'writer-1', '--count', '5']);
    assert.equal(r.status, 1);
    assert.match(r.err, /vuot chunk_size_max=2/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('W6: ten writer sai dinh dang bi tu choi', () => {
  const root = fixture(CFG, stdRows(), []);
  try {
    const r = run(root, ['--writer', 'writerX']);
    assert.equal(r.status, 1);
    assert.match(r.err, /--writer phai co dang writer-K/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('W7: writer-K ngoai pham vi 1..N bi tu choi', () => {
  const root = fixture(CFG, stdRows(), []);
  try {
    const r = run(root, ['--writer', 'writer-4', '--writers', '3']);
    assert.equal(r.status, 1);
    assert.match(r.err, /ngoai pham vi 1\.\.3/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('W8: --count override hoat dong', () => {
  const root = fixture(CFG, stdRows(), []);
  try {
    const r = run(root, ['--writer', 'writer-1', '--count', '1']);
    assert.equal(r.status, 0);
    assert.deepEqual(ids(r.out), ['C05-0001']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('W9: slice rong thoat 0 voi thong bao, khong loi', () => {
  const rows = [row('C05-0000', 'published')];
  const root = fixture(CFG, rows, []);
  try {
    const r = run(root, ['--writer', 'writer-1']);
    assert.equal(r.status, 0);
    assert.match(r.out, /khong con row planned trong slice/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
