#!/usr/bin/env node
// prepare-article.mjs — LỆNH CHUẨN BỊ BÀI DUY NHẤT của writer (micro-loop).
// Usage:
//   node scripts/prepare-article.mjs C01-0005
//   node scripts/prepare-article.mjs _posts/2026-10-01-slug.md
//   LAB_ROOT=path node scripts/prepare-article.mjs <id-or-file>   (fixtures)
//
// Deterministic, NO AI, NO prose generation, NEVER starts the next article,
// NEVER creates manifest rows. Thứ tự:
//   0. resolve ID hoặc file bài:
//      - row phải tồn tại trong data/article-manifest.jsonl (không tự tạo)
//      - slug/URL không bị hàng đợi hay bài khác dùng (đối chiếu toàn repo)
//      - row đã published mà thiếu file = không bao giờ claim lại
//   1. derive: sinh lại sitemap shards + sync manifest/progress (ghi file)
//   2. gates: validate-content, validate-content-quality,
//      detect-duplicates, check-links, validate-sitemap, sync-manifest --dry-run
//   3. in ra ĐÚNG danh sách file writer phải commit trong MỘT push:
//      file bài + derived allowlist đã đổi + data/writer-checkpoint.json.
// Writer commit toàn bộ danh sách TRƯỚC khi mở PR; publish.yml chỉ CHECK
// (publish-loop --check) — CI không bao giờ commit lại vào PR, và không cần
// push checkpoint riêng để kích hoạt CI.
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { changedPaths } from './porcelain.mjs';

const ROOT = process.env.LAB_ROOT
  ? resolve(process.env.LAB_ROOT)
  : resolve(join(dirname(fileURLToPath(import.meta.url)), '..'));

const DERIVED_ALLOWLIST = [
  'data/article-manifest.jsonl',
  'data/progress.json',
  'data/sitemap-shards.json',
  'sitemap.xml',
  'sitemaps/articles-001.xml',
  'sitemaps/categories.xml',
  'sitemaps/static.xml',
];
const CHECKPOINT = 'data/writer-checkpoint.json';

function die(msg) {
  console.error('::error::' + msg);
  console.error('prepare-article: REFUSED — nothing prepared.');
  process.exit(1);
}
function run(cmd, args, label) {
  const r = spawnSync(cmd, args, { cwd: ROOT, stdio: 'inherit' });
  if (r.status !== 0) die('STEP FAILED: ' + label);
}

// ---- 0. resolve & verify ------------------------------------------------------
const arg = process.argv.slice(2).find(a => !a.startsWith('--'));
if (!arg) die('usage: prepare-article.mjs <manifest-id | _posts/YYYY-MM-DD-slug.md>');

const manifestPath = join(ROOT, 'data', 'article-manifest.jsonl');
if (!existsSync(manifestPath)) die('data/article-manifest.jsonl is missing');
let rows;
try {
  rows = readFileSync(manifestPath, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
} catch (e) { die('manifest is not valid JSONL: ' + e.message); }

const postDir = join(ROOT, '_posts');
const postFiles = existsSync(postDir) ? readdirSync(postDir).filter(f => f.endsWith('.md')) : [];
const fileBySlug = new Map();
for (const f of postFiles) {
  const m = f.match(/^\d{4}-\d{2}-\d{2}-(.+)\.md$/);
  if (!m) continue;
  if (fileBySlug.has(m[1])) die('two post files share the slug "' + m[1] + '" — published URLs must be unique');
  fileBySlug.set(m[1], f);
}

let slug, file, row;
if (/^_posts\/.+\.md$/.test(arg)) {
  file = arg.replace(/^_posts\//, '');
  const m = file.match(/^\d{4}-\d{2}-\d{2}-(.+)\.md$/);
  if (!m) die('not a post filename: ' + arg);
  slug = m[1];
  row = rows.find(r => r.slug === slug);
  if (!row) die('no manifest row for slug "' + slug + '" — this command NEVER creates rows; the row must come from the matrix process');
  if (!postFiles.includes(file)) die('post file not on disk: _posts/' + file + ' — WRITE the article first (this command never writes prose)');
} else {
  row = rows.find(r => String(r.id) === arg.trim());
  if (!row) die('no manifest row with id "' + arg + '"');
  slug = row.slug;
}
if (row.status === 'published' && !fileBySlug.has(slug)) {
  die('row ' + row.id + ' is already published but its file is missing — a published article is never claimed again');
}
const dup = rows.filter(r => r.slug === slug);
if (dup.length > 1) die('slug "' + slug + '" is used by ' + dup.length + ' manifest rows — fix the manifest first');
if (!file) {
  file = fileBySlug.get(slug);
  if (!file) die('row ' + row.id + ' (slug "' + slug + '") has no post file under _posts/ — WRITE the article first (this command never writes prose)');
}
console.log('prepare-article: row ' + row.id + ' | slug ' + slug + ' | row status ' + row.status + ' | URL /' + slug + '/ verified unique');

// ---- 1. derive -----------------------------------------------------------------
run('node', ['scripts/gen-sitemap-shards.mjs'], 'regenerate sitemap shards');
run('node', ['scripts/sync-manifest.mjs'], 'sync manifest + progress with repository truth');

// ---- 2. gates ------------------------------------------------------------------
run('node', ['scripts/validate-content.mjs'], 'manifest + posts validation');
run('node', ['scripts/validate-content-quality.mjs'], 'content quality gate');
run('node', ['scripts/detect-duplicates.mjs'], 'duplicate detection gate');
run('node', ['scripts/check-links.mjs'], 'internal link gate');
run('node', ['scripts/validate-sitemap.mjs'], 'sitemap integrity gate');
run('node', ['scripts/sync-manifest.mjs', '--dry-run'], 'manifest dry-run (in-sync proof)');

// ---- 3. exact commit list --------------------------------------------------------
const status = spawnSync('git', ['status', '--porcelain'], { cwd: ROOT, encoding: 'utf8' });
const changed = status.status === 0 ? changedPaths(status.stdout) : null;
if (changed !== null) {
  const outOfScope = changed.filter(p =>
    p !== '_posts/' + file &&
    !DERIVED_ALLOWLIST.includes(p) &&
    !p.startsWith('sitemaps/') &&
    p !== CHECKPOINT);
  if (outOfScope.length) {
    die('unexpected working-tree changes — commit ONLY the article + derived allowlist + checkpoint (other work goes to its own branch): ' + outOfScope.join(', '));
  }
}
const commitList = ['_posts/' + file]
  .concat(changed !== null ? changed : DERIVED_ALLOWLIST)
  .concat([CHECKPOINT]);
console.log('');
console.log('prepare-article: COMMIT EXACTLY THIS LIST (ONE push, ONE commit):');
for (const p of [...new Set(commitList)]) console.log('  git add ' + p);
console.log('');
console.log('prepare-article: update ' + CHECKPOINT + ' (active_article/current_step), commit, push branch article/' + row.id + ', open the PR.');
console.log('prepare-article: CI verifies (publish.yml --check, ci.yml); it never commits. VERIFY URL live only after merge + deploy.');
