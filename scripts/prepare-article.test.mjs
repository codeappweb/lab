#!/usr/bin/env node
// prepare-article.test.mjs — regression tests cho LỆNH CHUẨN BỊ BÀI DUY NHẤT
// (scripts/prepare-article.mjs). Fixture qua LAB_ROOT; KHÔNG bao giờ chạm
// production state, KHÔNG tạo bài thử trên site.
//   P1 unknown id / post file without manifest row are refused
//   P2 valid row: derive + gates green, prints the exact commit list
//   P3 already-published row without its file is never claimed again
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, copyFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'prepare-article.mjs');

function post(title, date, slug, linkTo) {
  return [
    '---',
    'layout: post',
    'title: "' + title + '"',
    'date: ' + date,
    'description: "Mô tả hợp lệ dùng để kiểm tra regression của fixture."',
    'cluster: C01',
    'id: ' + slug,
    '---',
    '',
    'Đoạn giới thiệu ngắn, đủ dài để không trống.',
    '',
    'Xem thêm [bài liên quan]({{ \'/' + linkTo + '/\' | relative_url }}).',
    '',
  ].join('\n');
}

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'prepare-article-'));
  mkdirSync(join(dir, '_posts'), { recursive: true });
  mkdirSync(join(dir, 'data'), { recursive: true });
  mkdirSync(join(dir, 'sitemaps'), { recursive: true });
  const SCRIPTS = dirname(SCRIPT);
  mkdirSync(join(dir, 'scripts'), { recursive: true });
  for (const f of readdirSync(SCRIPTS)) {
    if (f.endsWith('.mjs')) copyFileSync(join(SCRIPTS, f), join(dir, 'scripts', f));
  }
  writeFileSync(join(dir, 'data', 'factory-config.json'),
    JSON.stringify({ chunk_size: 1, chunk_size_max: 2, hard_max_new_posts_per_push: 50 }, null, 2) + '\n');
  writeFileSync(join(dir, 'data', 'taxonomy.yml'), '# minimal taxonomy fixture\n');
  writeFileSync(join(dir, 'data', 'article-manifest.jsonl'), [
    JSON.stringify({ id: 'T1-0001', cluster: 'C01', status: 'published', primary_topic: 'Bài cũ đã đăng', title: 'Bài cũ đã đăng', slug: 'bai-cu', search_intent: 'informational', published_url: '/bai-cu/' }),
    JSON.stringify({ id: 'T1-0002', cluster: 'C01', status: 'planned', primary_topic: 'Bài mới về thuê xe máy', title: '', slug: 'bai-moi', search_intent: 'informational', published_url: null }),
  ].join('\n') + '\n');
  writeFileSync(join(dir, '_posts', '2026-01-01-bai-cu.md'), post('Bài cũ đã đăng', '2026-01-01', 'bai-cu', 'bai-moi'));
  writeFileSync(join(dir, '_posts', '2026-01-02-bai-moi.md'), post('Bài mới về thuê xe máy', '2026-01-02', 'bai-moi', 'bai-cu'));
  return dir;
}

function run(root, arg) {
  return spawnSync('node', [SCRIPT, arg], { cwd: root, encoding: 'utf8', stdio: 'pipe', env: { ...process.env, LAB_ROOT: root } });
}

test('P1: unknown id and row-less post file are refused', () => {
  const root = fixture();
  const unknown = run(root, 'NOPE-9999');
  assert.notEqual(unknown.status, 0, 'unknown id refused');
  assert.ok((unknown.stdout + unknown.stderr).includes('no manifest row'), 'message names the missing row');

  writeFileSync(join(root, '_posts', '2026-01-09-bai-khong-co-row.md'), post('Bài không có row', '2026-01-09', 'bai-khong-co-row', 'bai-cu'));
  const noRow = run(root, '_posts/2026-01-09-bai-khong-co-row.md');
  assert.notEqual(noRow.status, 0, 'file without manifest row refused');
  assert.ok((noRow.stdout + noRow.stderr).includes('NEVER creates rows'), 'command never fabricates rows');
});

test('P2: valid row prepares, gates green, prints the exact commit list', () => {
  const root = fixture();
  const r = run(root, 'T1-0002');
  assert.equal(r.status, 0, 'prepare succeeds\nstdout:\n' + r.stdout + '\nstderr:\n' + r.stderr);
  assert.ok(r.stdout.includes('git add _posts/2026-01-02-bai-moi.md'), 'commit list includes the post file');
  assert.ok(r.stdout.includes('git add data/article-manifest.jsonl'), 'commit list includes derived manifest');
  const row = readFileSync(join(root, 'data', 'article-manifest.jsonl'), 'utf8')
    .split('\n').filter(Boolean).map(JSON.parse).find(x => x.id === 'T1-0002');
  assert.equal(row.status, 'published', 'row flipped by derivation');
  const again = run(root, 'T1-0002');
  assert.equal(again.status, 0, 're-run is idempotent');
});

test('P3: a published row without its file is never claimed again', () => {
  const root = fixture();
  rmSync(join(root, '_posts', '2026-01-01-bai-cu.md'));
  const r = run(root, 'T1-0001');
  assert.notEqual(r.status, 0, 'claiming a published row is refused');
  assert.ok((r.stdout + r.stderr).includes('never claimed again'), 'message names the invariant');
});
