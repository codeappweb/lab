#!/usr/bin/env node
// content-index.test.mjs — regression tests cho SQLITE content index
// (node --test scripts/*.test.mjs). Fixture trong temp dir qua LAB_ROOT;
// KHÔNG chạm state production. Node >= 22.13 (node:sqlite).
//   CI1  --build tạo DB hợp lệ: đủ post + trang tĩnh; post chưa publish
//         (không có manifest) → pending; page → passed; published_at từ tên file
//   CI2  --qa-pass rồi --update không đổi → dump không đổi, không pending
//   CI3  sửa 1 bài → chỉ row đó pending; --qa-pass đánh passed + qa_at
//   CI4  --verify bắt file mới chưa có index (fail-closed); --update sửa
//   CI5  DB hỏng (không phải SQLite) → --update TỪ CHỐI (fail-closed);
//         --ensure rebuild an toàn từ source of truth
//   CI6  --verify --hashes bắt nội dung đã đổi; --update → chỉ file đó pending
//   CI7  validate-content --only: tin bài qa passed, fail-closed khi thiếu DB,
//         lỗi khi row pending NGOÀI scope, deep-check đúng bài trong scope
//   CI8  xóa file → --update bỏ row (không ghost)
//   CI9  validate-content-quality --only: bỏ qua file cũ passed, bắt file
//         trong scope hỏng; thiếu DB → fail-closed
//   CI10 --ensure trên DB thiếu → rebuilt:true; lần 2 → rebuilt:false
//   CI11 --ensure: bài published mới (fetch từ main) → derive passed,
//         không chặn scoped QA của writer
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'content-index.mjs');
const SCRIPTS_DIR = dirname(SCRIPT);
const DB = (root) => join(root, 'data', 'content-index.sqlite');

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
  return spawnSync('node', [SCRIPT, ...args], { encoding: 'utf8', env: { ...process.env, LAB_ROOT: root } });
}
const json = (r) => JSON.parse((r.stdout || '').trim().split('\n').pop());
const dumpRows = (root) => {
  const r = run(root, ['--dump']);
  if (r.status !== 0) throw new Error('dump failed: ' + r.stderr + r.stdout);
  return (r.stdout || '').split('\n').filter(Boolean).map((l) => JSON.parse(l));
};

test('CI1: --build tạo DB hợp lệ (post pending khi chưa publish, page passed)', () => {
  const root = fixture();
  const r = run(root, ['--build']);
  assert.equal(r.status, 0, 'exit 0\nstdout:\n' + r.stdout + '\nstderr:\n' + r.stderr);
  const j = json(r);
  assert.equal(j.total, 2, '1 post + 1 trang tĩnh');
  assert.equal(j.fresh, true);
  const rows = dumpRows(root);
  const a = rows.find((x) => x.slug === 'bai-a');
  assert.equal(a.kind, 'post');
  assert.equal(a.id, 'C01-0001');
  assert.equal(a.cluster, 'C01');
  assert.equal(a.intent, 'informational');
  assert.deepEqual(a.entities.slice(0, 2), ['xe máy', 'Hà Nội']);
  assert.equal(a.eligible, true);
  assert.equal(a.norm_title, 'bai a hop le'); // normalized, không dấu
  assert.equal(a.qa_status, 'pending', 'post chưa publish (không có manifest) → pending');
  assert.equal(a.published_at, '2026-01-01');
  assert.match(a.content_hash, /^[0-9a-f]{64}$/);
  const faq = rows.find((x) => x.slug === 'faq');
  assert.equal(faq.kind, 'page');
  assert.equal(faq.qa_status, 'passed', 'page tĩnh derive passed');
  assert.equal(faq.published_at, null);
  assert.equal(j.pending.length, 1);
});

test('CI2: qa-pass rồi update không đổi → idempotent, không pending', () => {
  const root = fixture();
  assert.equal(run(root, ['--build']).status, 0);
  assert.equal(run(root, ['--qa-pass']).status, 0);
  const dumpBefore = run(root, ['--dump']).stdout;
  const r = run(root, ['--update']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const j = json(r);
  assert.equal(j.fresh, false);
  assert.equal(j.updated, 0, 'không có file đổi');
  assert.equal(j.pending.length, 0, 'không còn pending');
  assert.equal(run(root, ['--dump']).stdout, dumpBefore, 'dump không đổi (idempotent)');
});

test('CI3: sửa 1 bài → chỉ row đó pending; qa-pass đánh passed + qa_at', () => {
  const root = fixture();
  run(root, ['--build']);
  run(root, ['--qa-pass']);
  writeFileSync(join(root, '_posts', '2026-01-01-bai-a.md'), post('2026-01-01', 'bai-a', 'Bài A sửa lại lần hai', 'C01-0001'));
  const r = run(root, ['--update']);
  assert.equal(r.status, 0);
  const j = json(r);
  assert.equal(j.updated, 1);
  assert.deepEqual(j.pending, ['_posts/2026-01-01-bai-a.md']);
  const rowsBefore = dumpRows(root);
  assert.equal(rowsBefore.find((x) => x.slug === 'bai-a').qa_status, 'pending');
  assert.equal(rowsBefore.find((x) => x.slug === 'faq').qa_status, 'passed', 'trang tĩnh không bị đánh pending lại');
  assert.equal(run(root, ['--qa-pass']).status, 0);
  const rowsAfter = dumpRows(root);
  const a = rowsAfter.find((x) => x.slug === 'bai-a');
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

test('CI5: DB hỏng → --update từ chối (fail-closed); --ensure rebuild an toàn', () => {
  const root = fixture();
  run(root, ['--build']);
  run(root, ['--qa-pass']);
  writeFileSync(DB(root), 'day khong phai file sqlite - junk bytes 0123456789\n');
  const bad = run(root, ['--update']);
  assert.notEqual(bad.status, 0, 'update phải từ chối DB hỏng (fail-closed)');
  assert.match(bad.stderr + bad.stdout, /content-index/);
  const ens = run(root, ['--ensure']);
  assert.equal(ens.status, 0, '--ensure rebuild từ source of truth\n' + ens.stdout + ens.stderr);
  assert.equal(json(ens).rebuilt, true);
  const rows = dumpRows(root);
  assert.equal(rows.length, 2, 'rebuild đủ 2 row');
  assert.equal(run(root, ['--verify']).status, 0);
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

test('CI7: validate-content --only — tin index, fail-closed khi thiếu/pending ngoài scope', () => {
  const root = fixture();
  // manifest fixture: row published cho bai-a
  writeFileSync(join(root, 'data', 'article-manifest.jsonl'), JSON.stringify({
    id: 'C01-0001', cluster: 'C01', status: 'published',
    primary_topic: 'Bài A hợp lệ', title: 'Bài A hợp lệ', slug: 'bai-a',
    search_intent: 'informational', published_url: '/bai-a/',
  }) + '\n');
  // copy gate script + index script vào fixture (script tự suy ROOT từ vị trí file)
  mkdirSync(join(root, 'scripts'), { recursive: true });
  copyFileSync(join(SCRIPTS_DIR, 'validate-content.mjs'), join(root, 'scripts', 'validate-content.mjs'));
  copyFileSync(SCRIPT, join(root, 'scripts', 'content-index.mjs'));
  const vc = (args) => spawnSync('node', [join(root, 'scripts', 'validate-content.mjs'), ...args], { encoding: 'utf8' });

  run(root, ['--build']); // derive: bai-a published → passed; faq page → passed
  const okNone = vc(['--only', 'none']);
  assert.equal(okNone.status, 0, 'coverage-only xanh khi index phủ đủ\n' + okNone.stdout + okNone.stderr);
  assert.match(okNone.stdout, /OK/);

  const okScoped = vc(['--only', '_posts/2026-01-01-bai-a.md']);
  assert.equal(okScoped.status, 0, 'deep-check đúng bài trong scope\n' + okScoped.stdout + okScoped.stderr);

  rmSync(DB(root));
  const noIdx = vc(['--only', 'none']);
  assert.notEqual(noIdx.status, 0, 'thiếu DB → fail-closed');
  assert.match(noIdx.stdout + noIdx.stderr, /content-index/);

  run(root, ['--update']); // bai-a derive passed; faq passed
  // row pending NGOÀI scope: bài planned mới (chưa publish) → lỗi, không tin mù
  writeFileSync(join(root, '_posts', '2026-01-02-bai-b.md'), post('2026-01-02', 'bai-b', 'Bài B mới hợp lệ', 'C01-0002'));
  assert.equal(run(root, ['--update']).status, 0);
  const pendingOutside = vc(['--only', '']);
  assert.notEqual(pendingOutside.status, 0, 'row pending ngoài scope → lỗi, không tin mù');
  assert.match(pendingOutside.stdout + pendingOutside.stderr, /pending/);
  const inScope = vc(['--only', '_posts/2026-01-02-bai-b.md']);
  assert.equal(inScope.status, 0, 'bài pending trong scope được deep-check → xanh\n' + inScope.stdout + inScope.stderr);
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
  const rows = dumpRows(root);
  assert.ok(!rows.some((x) => x.slug === 'bai-a'), 'không còn ghost row');
  assert.equal(run(root, ['--verify']).status, 0);
});

test('CI9: validate-content-quality --only bỏ qua file cũ passed, bắt file trong scope hỏng', () => {
  const root = fixture();
  mkdirSync(join(root, 'scripts'), { recursive: true });
  copyFileSync(join(SCRIPTS_DIR, 'validate-content-quality.mjs'), join(root, 'scripts', 'validate-content-quality.mjs'));
  copyFileSync(SCRIPT, join(root, 'scripts', 'content-index.mjs'));
  // ROOT của validate-content-quality là process.cwd() → spawn với cwd: root
  const vcq = (args) => spawnSync('node', [join(root, 'scripts', 'validate-content-quality.mjs'), ...args], { encoding: 'utf8', cwd: root });

  run(root, ['--build']);
  run(root, ['--qa-pass']);
  // file cũ đã passed + file mới hỏng trong scope (CJK + thiếu front matter)
  writeFileSync(join(root, '_posts', '2026-01-02-bai-hong.md'), 'văn rác：这里是中文文本。\n');
  const scoped = vcq(['--only', '_posts/2026-01-02-bai-hong.md']);
  assert.notEqual(scoped.status, 0, 'bài hỏng trong scope phải fail');
  assert.match(scoped.stdout, /missing or malformed front matter/);
  assert.equal(scoped.stdout.includes('Bài A'), false, 'không deep-check lại bài cũ');

  // thiếu DB → fail-closed
  rmSync(DB(root));
  const noIdx = vcq(['--only', '_posts/2026-01-02-bai-hong.md']);
  assert.notEqual(noIdx.status, 0, 'thiếu DB → lỗi');
  assert.match(noIdx.stdout, /content-index/);
});

test('CI10: --ensure trên DB thiếu → rebuilt:true; lần 2 → rebuilt:false, không pending mới', () => {
  const root = fixture();
  const first = run(root, ['--ensure']);
  assert.equal(first.status, 0, first.stdout + first.stderr);
  const j1 = json(first);
  assert.equal(j1.rebuilt, true, 'DB thiếu → rebuild');
  assert.equal(j1.total, 2);
  const dump1 = run(root, ['--dump']).stdout;
  const second = run(root, ['--ensure']);
  assert.equal(second.status, 0);
  const j2 = json(second);
  assert.equal(j2.rebuilt, false, 'DB khỏe → không rebuild');
  assert.equal(j2.updated, 0, 'không có thay đổi');
  assert.equal(run(root, ['--dump']).stdout, dump1, 'dump không đổi');
});

test('CI11: --ensure — bài published mới (fetch từ main) derive passed, không chặn scoped QA', () => {
  const root = fixture();
  // manifest: bai-a published; writer build + qa-pass lần đầu
  writeFileSync(join(root, 'data', 'article-manifest.jsonl'), [
    JSON.stringify({ id: 'C01-0001', cluster: 'C01', status: 'published', primary_topic: 'Bài A hợp lệ', title: 'Bài A hợp lệ', slug: 'bai-a', search_intent: 'informational', published_url: '/bai-a/' }),
    JSON.stringify({ id: 'C01-0002', cluster: 'C01', status: 'published', primary_topic: 'Bài B của writer khác', title: 'Bài B', slug: 'bai-b', search_intent: 'informational', published_url: '/bai-b/' }),
  ].join('\n') + '\n');
  run(root, ['--ensure']);
  // writer fetch main: bài published mới xuất hiện trên đĩa (không có trong DB cũ)
  writeFileSync(join(root, '_posts', '2026-01-02-bai-b.md'), post('2026-01-02', 'bai-b', 'Bài B của writer khác', 'C01-0002'));
  const r = run(root, ['--ensure']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const j = json(r);
  assert.equal(j.rebuilt, false, 'DB khỏe → incremental');
  assert.equal(j.updated, 1, 'row mới cho bài fetched');
  assert.equal(j.pending.length, 0, 'bài published mới derive passed — scoped QA không bị chặn');
  const rows = dumpRows(root);
  assert.equal(rows.find((x) => x.slug === 'bai-b').qa_status, 'passed');
});
