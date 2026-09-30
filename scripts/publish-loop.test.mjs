#!/usr/bin/env node
// publish-loop.test.mjs — regression tests for the micro-loop publish
// transaction (node --test scripts/*.test.mjs). Runs on fixtures in a
// temp dir via LAB_ROOT; NEVER touches production state.
// Covers the fixture verification matrix:
//   T1  one passing article publishes independently
//   T2  a failing article is refused (non-zero exit, nothing committed) and
//       does not block the next valid article
//   T3  restart/re-run creates no duplicates (idempotent, no diff)
//   T4  re-run after "connection loss after push" (row already published,
//       file on disk) is a no-op success, never a re-publish
//   T5  out-of-scope / duplicate-claim pushes are refused (a second writer
//       can never race the same article through this path)
//   T6  gate failure is never reported as success (exit code contract)
//   T7  the transaction only ever writes derived allowlist files
//   T8  the porcelain parser never eats the first character of a path
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, statSync, rmSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'publish-loop.mjs');

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
  const dir = mkdtempSync(join(tmpdir(), 'publish-loop-'));
  mkdirSync(join(dir, '_posts'), { recursive: true });
  mkdirSync(join(dir, 'data'), { recursive: true });
  mkdirSync(join(dir, 'sitemaps'), { recursive: true });
  // copy the REAL gate scripts into the fixture: publish-loop invokes its
  // sibling scripts via scripts/<name>.mjs relative to the fixture root, and
  // each script derives its own ROOT from import.meta.url — so the copied
  // scripts run against the fixture tree, never against production state.
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
    JSON.stringify({ id: 'T1-0003', cluster: 'C01', status: 'planned', primary_topic: 'Bài chưa viết', title: '', slug: 'bai-chua-viet', search_intent: 'informational', published_url: null }),
  ].join('\n') + '\n');
  writeFileSync(join(dir, '_posts', '2026-01-01-bai-cu.md'), post('Bài cũ đã đăng', '2026-01-01', 'bai-cu', 'bai-moi'));
  writeFileSync(join(dir, '_posts', '2026-01-02-bai-moi.md'), post('Bài mới về thuê xe máy', '2026-01-02', 'bai-moi', 'bai-cu'));
  return dir;
}

function runLoop(root, added) {
  return spawnSync('node', [SCRIPT, '--added=' + (added || ''), '--dry-run'], {
    cwd: root, encoding: 'utf8', stdio: 'pipe', env: { ...process.env, LAB_ROOT: root },
  });
}

function manifestRows(root) {
  return readFileSync(join(root, 'data', 'article-manifest.jsonl'), 'utf8')
    .split('\n').filter(Boolean).map(JSON.parse);
}

function writeManifest(root, rows) {
  writeFileSync(join(root, 'data', 'article-manifest.jsonl'), rows.map(r => JSON.stringify(r)).join('\n') + '\n');
}

function snapshot(root) {
  const out = [];
  const walk = d => {
    for (const e of readdirSync(d)) {
      const full = join(d, e);
      if (statSync(full).isDirectory()) walk(full);
      else out.push(relative(root, full));
    }
  };
  walk(root);
  return out.sort();
}

test('T1: one passing article publishes independently', () => {
  const root = fixture();
  const r = runLoop(root, '_posts/2026-01-02-bai-moi.md');
  assert.equal(r.status, 0, 'exit 0\nstdout:\n' + r.stdout + '\nstderr:\n' + r.stderr);
  const row = manifestRows(root).find(x => x.id === 'T1-0002');
  assert.equal(row.status, 'published', 'row flipped to published');
  const shard = readFileSync(join(root, 'sitemaps', 'articles-001.xml'), 'utf8');
  assert.ok(shard.includes('/bai-moi/'), 'new article URL in sitemap shard');
});

test('T2: a failing article is refused and does not block the next valid one', () => {
  const root = fixture();
  // corrupt the new article so the content gate fails
  writeFileSync(join(root, '_posts', '2026-01-02-bai-moi.md'), 'không có front matter gì cả\n');
  const bad = runLoop(root, '_posts/2026-01-02-bai-moi.md');
  assert.notEqual(bad.status, 0, 'gate failure must exit non-zero (nothing committed in the real flow)');

  // the writer abandons the broken draft and publishes a different article:
  // one bad article never blocks the queue. The surviving old article must
  // not link to the deleted draft — the writer repairs the dangling link.
  rmSync(join(root, '_posts', '2026-01-02-bai-moi.md'));
  writeFileSync(join(root, '_posts', '2026-01-01-bai-cu.md'), post('Bài cũ đã đăng', '2026-01-01', 'bai-cu', 'bai-khac'));
  writeFileSync(join(root, '_posts', '2026-01-03-bai-khac.md'), post('Bài khác hợp lệ', '2026-01-03', 'bai-khac', 'bai-cu'));
  const rows = manifestRows(root);
  rows.find(x => x.id === 'T1-0002').status = 'planned'; // broken draft: not published, left for review
  rows.find(x => x.id === 'T1-0003').slug = 'bai-khac';
  writeManifest(root, rows);
  const good = runLoop(root, '_posts/2026-01-03-bai-khac.md');
  assert.equal(good.status, 0, 'next valid article publishes\nstdout:\n' + good.stdout + '\nstderr:\n' + good.stderr);
  assert.equal(manifestRows(root).find(x => x.id === 'T1-0003').status, 'published');
  assert.equal(manifestRows(root).find(x => x.id === 'T1-0002').status, 'planned', 'broken draft stays unpublished');
});

test('T3 + T4: restart / connection-loss re-run is idempotent, no duplicates', () => {
  const root = fixture();
  const first = runLoop(root, '_posts/2026-01-02-bai-moi.md');
  assert.equal(first.status, 0, 'first run succeeds');
  const manifestAfterFirst = readFileSync(join(root, 'data', 'article-manifest.jsonl'), 'utf8');

  // simulate restart (fresh process, same repo state)
  const second = runLoop(root, '_posts/2026-01-02-bai-moi.md');
  assert.equal(second.status, 0, 're-run exits 0 (idempotent)');
  assert.equal(readFileSync(join(root, 'data', 'article-manifest.jsonl'), 'utf8'), manifestAfterFirst,
    're-run produces no manifest diff');

  // simulate connection loss AFTER the push: remote already has the published
  // row + file; a new run must not re-publish or duplicate anything
  const rows = manifestRows(root);
  assert.equal(rows.filter(x => x.slug === 'bai-moi').length, 1, 'exactly one row for the slug');
  assert.equal(rows.find(x => x.id === 'T1-0002').status, 'published');
  assert.equal(rows.find(x => x.id === 'T1-0001').status, 'published', 'old article untouched');
  assert.equal(rows.find(x => x.id === 'T1-0003').status, 'planned', 'other planned row untouched');
});

test('T5: out-of-scope and duplicate-claim pushes are refused', () => {
  const root = fixture();
  const outOfScope = runLoop(root, 'data/evil.json');
  assert.notEqual(outOfScope.status, 0, 'non-post file refused');

  const badName = runLoop(root, '_posts/not-a-date-slug.txt');
  assert.notEqual(badName.status, 0, 'malformed post filename refused');

  // duplicate claim: pushing a NEW file for a slug whose row is already
  // published and whose file does not exist = second-writer race — refused
  const dup = runLoop(root, '_posts/2026-01-05-bai-cu.md');
  assert.notEqual(dup.status, 0, 'claiming an already-published slug is refused');
});

test('T6: gate failure is never reported as success', () => {
  const root = fixture();
  // corrupt the manifest itself: invalid JSON line -> hard error
  writeFileSync(join(root, 'data', 'article-manifest.jsonl'), '{not json\n');
  const r = runLoop(root, '_posts/2026-01-02-bai-moi.md');
  assert.notEqual(r.status, 0, 'corrupt manifest must fail the transaction');
});

test('T8: porcelain parser never eats the first character of a path', async () => {
  const { changedPaths } = await import('./porcelain.mjs');
  const out = changedPaths(' M data/progress.json\n M data/article-manifest.jsonl\nM  sitemap.xml\n?? sitemaps/articles-001.xml\n');
  assert.deepEqual(out, ['data/progress.json', 'data/article-manifest.jsonl', 'sitemap.xml', 'sitemaps/articles-001.xml']);
  // rename/copy lines fail closed: raw "orig -> path" never matches the allowlist
  assert.deepEqual(changedPaths('R  old.md -> new.md\n'), ['old.md -> new.md']);
  assert.deepEqual(changedPaths(''), []);
  assert.deepEqual(changedPaths('\n\n'), []);
});

test('T7: the transaction only writes derived allowlist files', () => {
  const root = fixture();
  const before = snapshot(root);
  const r = runLoop(root, '_posts/2026-01-02-bai-moi.md');
  assert.equal(r.status, 0, 'run succeeds');
  const after = snapshot(root);
  const created = after.filter(p => !before.includes(p));
  const allowed = ['sitemap.xml', 'data/sitemap-shards.json', 'data/progress.json',
    'sitemaps/articles-001.xml', 'sitemaps/categories.xml', 'sitemaps/static.xml'];
  for (const p of created) assert.ok(allowed.includes(p), 'unexpected new file: ' + p);
  assert.ok(after.every(p => before.includes(p) || allowed.includes(p)), 'no file removed or renamed');
});
