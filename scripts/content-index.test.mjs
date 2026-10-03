#!/usr/bin/env node
// content-index.test.mjs — regression tests cho chỉ mục nội dung nhẹ
// (node --test scripts/*.test.mjs). Fixture trong temp dir qua LAB_ROOT;
// KHÔNG chạm state production.
//   CI1 --build tạo index hợp lệ: đủ post + trang tĩnh, mọi row pending
//   CI2 --qa-pass rồi --update không đổi → không ghi lại, không pending (idempotent)
//   CI3 sửa 1 bài → chỉ row đó pending; --qa-pass đánh passed + qa_at
//   CI4 --verify bắt file mới chưa có index (fail-closed)
//   CI5 --verify bắt index hỏng (JSON sai)
//   CI6 --verify cấu trúc OK nhưng --hashes bắt nội dung đã đổi
//   CI7 validate-content --only: tin bài qa passed, lỗi khi thiếu index,
//        lỗi khi row pending ngoài scope, deep-check đúng bài trong scope
//   CI8 xóa file → --update bỏ row (không ghost row)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, copyFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'content-index.mjs');
const SCRIPTS_DIR = dirname(SCRIPT);

function post(date, slug, title, manifestId) {
  return [
    '---',
    'layout: post',
    'title: "' + title + '"',
    'date: ' + date,
    'description: "Mô tả hợp lệ dùng để kiểm tra regression của fixture."',
    'cluster: C01',
    'id: ' + slug,
    'manifest_id: ' + (manifestId || 'C01-0001'),
    'search_intent: informational',
    'entities:',
    '  - "xe máy"',
    '  - "Hà Nội"',
    '---',
    '',
    'Đoạn giới thiệu ngắn, đủ dài để không trống.',
    '',
  ].join('\n');
}

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'cidx-'));
  mkdirSync(join(dir, '_posts'), { recursive: true });
  mkdirSync(join(dir, 'data'), { recursive: true });
  writeFileSync(join(dir, '_posts', '2026-01-01-bai-a.md'), post('2026-01-01', 'bai-a', 'Bài A hợp lệ', 'C01-0001'));
  writeFileSync(join(dir, 'faq.md'), '---\ntitle: "Hỏi đáp"\npermalink: /faq/\n---\n\nNội dung FAQ hợp lệ.\n');
  return dir;
}

function run(root, args) {
  const r = spawnSync('node', [SCRIPT, ...args], { encoding: 'utf8', env: { ...process.env, LAB_ROOT: root } });
  return r;
}
const json = r => JSON.parse((r.stdout || '').trim().split('\n').pop());
const idxRows = root => readFileSync(join(root, 'data', 'content-index.jsonl'), 'utf8')
  .split('\n').filter(Boolean).map(l => JSON.parse(l));

test('CI1: --build tạo index hợp lệ (post + trang tĩnh, pending)', () => {
  const root = fixture();
  const r = run(root, ['--build']);
  assert.equal(r.status, 0, 'exit 0\nstdout:\n' + r.stdout + '\nstderr:\n' + r.stderr);
  const rows = idxRows(root);
  assert.equal(rows.length, 2, '1 post + 1 trang tĩnh');
  assert.ok(rows.every(x => x.qa_status === 'pending'), 'mọi row pending sau build');
  assert.ok(rows.every(x => /^[0-9a-f]{64}$/.test(x.sha256)), 'sha256 hex hợp lệ');
  const a = rows.find(x => x.slug === 'bai-a');
  assert.equal(a.kind, 'post');
  assert.equal(a.id, 'C01-0001');
  assert.equal(a.cluster, 'C01');
  assert.equal(a.intent, 'informational');
  assert.deepEqual(a.entities.slice(0, 2), ['xe máy', 'Hà Nội']);
  assert.equal(a.eligible, true);
  assert.equal(a.norm_title, 'bai a hop le'); // normalized, không dấu
  const faq = rows.find(x => x.slug === 'faq');
  assert.equal(faq.kind, 'page');
  const j = json(r);
  assert.equal(j.fresh, true);
  assert.equal(j.pending.length, 2);
});

test('CI2: qa-pass rồi update không đổi → idempotent, không pending', () => {
  const root = fixture();
  assert.equal(run(root, ['--build']).status, 0);
  assert.equal(run(root, ['--qa-pass']).status, 0);
  const before = readFileSync(join(root, 'data', 'content-index.jsonl'), 'utf8');
  const r = run(root, ['--update']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(readFileSync(join(root, 'data', 'content-index.jsonl'), 'utf8'), before, 'không ghi lại index');
  const j = json(r);
  assert.equal(j.fresh, false);
  assert.equal(j.updated, 0);
  assert.equal(j.pending.length, 0);
});

test('CI3: sửa 1 bài → chỉ row đó pending; qa-pass đánh passed', () => {
  const root = fixture();
  run(root, ['--build']);
  run(root, ['--qa-pass']);
  writeFileSync(join(root, '_posts', '2026-01-01-bai-a.md'), post('2026-01-01', 'bai-a', 'Bài A sửa lại lần hai', 'C01-0001'));
  const r = run(root, ['--update']);
  assert.equal(r.status, 0);
  const j = json(r);
  assert.equal(j.updated, 1);
  assert.deepEqual(j.pending, ['_posts/2026-01-01-bai-a.md']);
  const rowsBefore = idxRows(root);
  assert.equal(rowsBefore.find(x => x.slug === 'bai-a').qa_status, 'pending');
  assert.equal(rowsBefore.find(x => x.slug === 'faq').qa_status, 'passed', 'trang tĩnh không bị đánh pending lại');
  assert.equal(run(root, ['--qa-pass']).status, 0);
  const rowsAfter = idxRows(root);
  const a = rowsAfter.find(x => x.slug === 'bai-a');
  assert.equal(a.qa_status, 'passed');
  assert.ok(a.qa_at, 'qa_at được ghi');
});

test('CI4: --verify bắt file mới chưa có trong index (fail-closed)', () => {
  const root = fixture();
  run(root, ['--build']);
  writeFileSync(join(root, '_posts', '2026-01-02-bai-b.md'), post('2026-01-02', 'bai-b', 'Bài B mới', 'C01-0002'));
  const bad = run(root, ['--verify']);
  assert.notEqual(bad.status, 0, 'verify phải fail khi index lệch đĩa');
  assert.match(bad.stderr, /không có trong index/);
  assert.equal(run(root, ['--update']).status, 0);
  assert.equal(run(root, ['--verify']).status, 0, 'update sửa lệch — verify xanh lại');
});

test('CI5: --verify bắt index hỏng (JSON sai)', () => {
  const root = fixture();
  run(root, ['--build']);
  writeFileSync(join(root, 'data', 'content-index.jsonl'), '{not json\n');
  assert.notEqual(run(root, ['--verify']).status, 0, 'JSON hỏng phải fail');
  // --update cũng từ chối trên index hỏng (fail-closed, không tự doctor)
  assert.notEqual(run(root, ['--update']).status, 0, 'update từ chối index hỏng — phải --build');
  assert.equal(run(root, ['--build']).status, 0, '--build phục hồi được');
});

test('CI6: verify cấu trúc OK nhưng --hashes bắt nội dung đã đổi', () => {
  const root = fixture();
  run(root, ['--build']);
  run(root, ['--qa-pass']);
  const f = join(root, 'faq.md');
  const orig = readFileSync(f, 'utf8');
  writeFileSync(f, orig + '\nĐoạn thêm mới.\n');
  assert.equal(run(root, ['--verify']).status, 0, 'cấu trúc vẫn khớp (tên file không đổi)');
  const h = run(root, ['--verify', '--hashes']);
  assert.notEqual(h.status, 0, '--hashes phải bắt nội dung đã đổi');
  assert.match(h.stderr, /hash lệch/);
  const u = run(root, ['--update']);
  assert.equal(u.status, 0);
  assert.deepEqual(json(u).pending, ['faq.md'], 'file cũ bị sửa → chỉ QA lại đúng file đó');
});

test('CI7: validate-content --only — tin index, fail-closed khi thiếu/pending', () => {
  const root = fixture();
  // manifest fixture: row published cho bai-a
  writeFileSync(join(root, 'data', 'article-manifest.jsonl'), JSON.stringify({
    id: 'C01-0001', cluster: 'C01', status: 'published',
    primary_topic: 'Bài A hợp lệ', title: 'Bài A hợp lệ', slug: 'bai-a',
    search_intent: 'informational', published_url: '/bai-a/',
  }) + '\n');
  // copy gate script vào fixture (script tự suy ROOT từ vị trí file của nó)
  mkdirSync(join(root, 'scripts'), { recursive: true });
  copyFileSync(join(SCRIPTS_DIR, 'validate-content.mjs'), join(root, 'scripts', 'validate-content.mjs'));
  const vc = args => spawnSync('node', [join(root, 'scripts', 'validate-content.mjs'), ...args], { encoding: 'utf8' });

  run(root, ['--build']);
  run(root, ['--qa-pass']);
  const okNone = vc(['--only', 'none']);
  assert.equal(okNone.status, 0, 'coverage-only xanh khi index phủ đủ\n' + okNone.stdout + okNone.stderr);
  assert.match(okNone.stdout, /OK/);

  const okScoped = vc(['--only', '_posts/2026-01-01-bai-a.md']);
  assert.equal(okScoped.status, 0, 'deep-check đúng bài trong scope\n' + okScoped.stdout + okScoped.stderr);

  rmSync(join(root, 'data', 'content-index.jsonl'));
  const noIdx = vc(['--only', 'none']);
  assert.notEqual(noIdx.status, 0, 'thiếu index → fail-closed');
  assert.match(noIdx.stdout + noIdx.stderr, /content-index/);

  run(root, ['--build']); // mọi row pending lại
  const pendingOutside = vc(['--only', '']);
  assert.notEqual(pendingOutside.status, 0, 'row pending ngoài scope → lỗi, không tin mù');
  assert.match(pendingOutside.stdout + pendingOutside.stderr, /pending/);
  const inScope = vc(['--only', '_posts/2026-01-01-bai-a.md']);
  assert.equal(inScope.status, 0, 'bài pending trong scope được deep-check → xanh');
});

test('CI8: xóa file → update bỏ row, không ghost', () => {
  const root = fixture();
  run(root, ['--build']);
  run(root, ['--qa-pass']);
  rmSync(join(root, '_posts', '2026-01-01-bai-a.md'));
  const r = run(root, ['--update']);
  assert.equal(r.status, 0);
  const j = json(r);
  assert.ok(j.removed >= 1, 'row bị bỏ');
  const rows = idxRows(root);
  assert.ok(!rows.some(x => x.slug === 'bai-a'), 'không còn ghost row');
  assert.equal(run(root, ['--verify']).status, 0);
});

test('CI9: validate-content-quality --only bỏ qua file cũ passed, bắt file trong scope hỏng', () => {
  const root = fixture();
  mkdirSync(join(root, 'scripts'), { recursive: true });
  copyFileSync(join(SCRIPTS_DIR, 'validate-content-quality.mjs'), join(root, 'scripts', 'validate-content-quality.mjs'));
  // ROOT của validate-content-quality là process.cwd() → spawn với cwd: root
  const vcq = args => spawnSync('node', [join(root, 'scripts', 'validate-content-quality.mjs'), ...args], { encoding: 'utf8', cwd: root });

  run(root, ['--build']);
  run(root, ['--qa-pass']);
  // file cũ đã passed + file mới hỏng trong scope (CJK + thiếu front matter)
  writeFileSync(join(root, '_posts', '2026-01-02-bai-hong.md'), 'văn rác：这里是中文文本。\n');
  const scoped = vcq(['--only', '_posts/2026-01-02-bai-hong.md']);
  assert.notEqual(scoped.status, 0, 'bài hỏng trong scope phải fail');
  assert.match(scoped.stdout, /missing or malformed front matter/);
  assert.equal(scoped.stdout.includes('Bài A'), false, 'không deep-check lại bài cũ');

  // thiếu index → fail-closed
  rmSync(join(root, 'data', 'content-index.jsonl'));
  const noIdx = vcq(['--only', '_posts/2026-01-02-bai-hong.md']);
  assert.notEqual(noIdx.status, 0, 'thiếu index → lỗi');
  assert.match(noIdx.stdout, /content-index/);
});
