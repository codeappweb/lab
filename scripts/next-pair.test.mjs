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
//   W10 --allocate (coordinator) tao factory-cycle.json + writer-assignments.json
//       18 row / 3 writer, chia slice deterministic, row du lieu day du
//   W11 writer cycle mode KHONG doc manifest (xoa manifest sau allocate → van OK)
//   W12 assignment file thieu / lech cycle_id → fail-closed (exit 1)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
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

// ---- fixture cho che do --allocate (W10–W12) -------------------------------

function fixtureAlloc(cfg, rows, review) {
  const root = fixture(cfg, rows, review);
  // allocate chay sync-manifest --dry-run (spawnSync, cwd=LAB_ROOT) — stub exit 0
  mkdirSync(join(root, 'scripts'), { recursive: true });
  writeFileSync(join(root, 'scripts', 'sync-manifest.mjs'), 'process.exit(0);\n');
  return root;
}

function allocRows() {
  const rows = [row('C05-0000', 'published')];
  for (let i = 1; i <= 20; i++) rows.push(row('C05-' + String(i).padStart(4, '0'), 'planned'));
  return rows;
}

const CFG18 = { chunk_size: 2, chunk_size_max: 6, writers: 3, writer_chunk_size: 6 };

test('W10: --allocate tao cycle + writer-assignments 18 row / 3 writer, chia deterministic', () => {
  const root = fixtureAlloc(CFG18, allocRows(), []);
  try {
    const r = run(root, ['--allocate', '--base-sha', 'deadbeef']);
    assert.equal(r.status, 0, r.err);
    assert.match(r.out, /ALLOCATED cycle cyc-c050001/);
    const cyc = JSON.parse(readFileSync(join(root, 'data', 'factory-cycle.json'), 'utf8'));
    assert.equal(cyc.phase, 'allocated');
    assert.equal(cyc.cycle_id, 'cyc-c050001');
    assert.equal(cyc.base_sha, 'deadbeef');
    const assign = JSON.parse(readFileSync(join(root, 'data', 'writer-assignments.json'), 'utf8'));
    assert.equal(assign.cycle_id, 'cyc-c050001');
    assert.equal(assign.base_sha, 'deadbeef');
    assert.equal(assign.rows_total, 18);
    assert.deepEqual(Object.keys(assign.writers).sort(), ['writer-1', 'writer-2', 'writer-3']);
    const a1 = assign.writers['writer-1'], a2 = assign.writers['writer-2'], a3 = assign.writers['writer-3'];
    assert.deepEqual(a1.map(x => x.id), ['C05-0001', 'C05-0004', 'C05-0007', 'C05-0010', 'C05-0013', 'C05-0016']);
    assert.deepEqual(a2.map(x => x.id), ['C05-0002', 'C05-0005', 'C05-0008', 'C05-0011', 'C05-0014', 'C05-0017']);
    assert.deepEqual(a3.map(x => x.id), ['C05-0003', 'C05-0006', 'C05-0009', 'C05-0012', 'C05-0015', 'C05-0018']);
    // row du lieu DAY DU — writer khong can doc manifest
    for (const arr of [a1, a2, a3]) {
      for (const x of arr) {
        assert.equal(x.slug, 'slug-' + x.id.toLowerCase());
        assert.equal(x.cluster, 'C05');
        assert.ok(x.primary_topic);
        assert.equal(x.status, 'planned');
      }
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('W11: writer cycle mode KHONG doc manifest (xoa manifest sau allocate van OK)', () => {
  const root = fixtureAlloc(CFG18, allocRows(), []);
  try {
    const a = run(root, ['--allocate', '--base-sha', 'deadbeef']);
    assert.equal(a.status, 0, a.err);
    // writer chi duoc doc factory-cycle.json + writer-assignments.json
    rmSync(join(root, 'data', 'article-manifest.jsonl'));
    rmSync(join(root, 'data', 'writer-checkpoint.json'));
    const w = run(root, ['--writer', 'writer-2']);
    assert.equal(w.status, 0, w.err);
    assert.match(w.out, /RESERVED \(cycle plan\)/);
    assert.deepEqual(ids(w.out), ['C05-0002', 'C05-0005', 'C05-0008', 'C05-0011', 'C05-0014', 'C05-0017']);
    assert.match(w.out, /factory_cycle: cyc-c050001/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('W12: assignment file thieu hoac lech cycle_id → fail-closed', () => {
  const root = fixtureAlloc(CFG18, allocRows(), []);
  try {
    const a = run(root, ['--allocate', '--base-sha', 'deadbeef']);
    assert.equal(a.status, 0, a.err);
    const assignPath = join(root, 'data', 'writer-assignments.json');
    const assign = JSON.parse(readFileSync(assignPath, 'utf8'));
    // (a) file thieu
    rmSync(assignPath);
    const m1 = run(root, ['--writer', 'writer-1']);
    assert.equal(m1.status, 1);
    assert.match(m1.err, /writer-assignments\.json thieu/);
    // (b) sai cycle_id
    assign.cycle_id = 'cyc-sai';
    writeFileSync(assignPath, JSON.stringify(assign));
    const m2 = run(root, ['--writer', 'writer-1']);
    assert.equal(m2.status, 1);
    assert.match(m2.err, /KHONG khop cycle/);
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
