#!/usr/bin/env node
// integrate-guard.mjs — validate scope truoc khi staging duoc tich hop vao main.
// Fail closed: moi vi phan DIE truoc khi bat ky file nao duoc dua vao main.
// Doc /tmp/scope.json (collect-staging). Kiem tra:
//   1. moi file khop _posts/YYYY-MM-DD-<slug>.md
//   2. moi writer <= writer_chunk_size bai (added + repaired)
//   3. tong bai moi <= integration_max_new_posts
//   4. khong trung slug giua cac writer
//   5. slug da published trong manifest: file giong het tren main -> SKIP
//      (da tich hop — idempotent, phuc hoi crash sau commit); khac noi dung
//      -> REFUSE (published row khong bao gio bi reassign).
// Ghi /tmp/integrate.json {noop, added, repaired, apply:[{name, sha, files}]}.
// Xuat GITHUB_OUTPUT: noop, added (comma), repaired (comma).
import { readFileSync, writeFileSync, appendFileSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = process.env.LAB_ROOT
  ? resolve(process.env.LAB_ROOT)
  : resolve(join(dirname(fileURLToPath(import.meta.url)), '..'));
const POST_RE = /^_posts\/\d{4}-\d{2}-\d{2}-[a-z0-9-]+\.md$/;

function die(msg) {
  console.error('::error::' + msg);
  console.error('integrate-guard: REFUSED — khong tich hop gi ca.');
  process.exit(1);
}
function gitOk(args) {
  const r = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8' });
  if (r.status !== 0) die('git that bai: ' + args.join(' '));
  return (r.stdout || '').trim();
}

let CFG = {};
const cfgPath = join(ROOT, 'data', 'factory-config.json');
if (existsSync(cfgPath)) {
  try {
    CFG = JSON.parse(readFileSync(cfgPath, 'utf8'));
  } catch (e) {
    die('data/factory-config.json khong hop le: ' + e.message);
  }
}
const writerChunk = Number.isInteger(CFG.writer_chunk_size) && CFG.writer_chunk_size > 0 ? CFG.writer_chunk_size : 2;
const cap = Number.isInteger(CFG.integration_max_new_posts) && CFG.integration_max_new_posts > 0 ? CFG.integration_max_new_posts : 6;

const scope = JSON.parse(readFileSync('/tmp/scope.json', 'utf8'));
const manifestPath = join(ROOT, 'data', 'article-manifest.jsonl');
const rows = readFileSync(manifestPath, 'utf8').split('\\n').filter(Boolean).map(l => JSON.parse(l));
const bySlug = new Map(rows.map(r => [r.slug, r]));

const added = [];
const repaired = [];
const apply = [];
const skip = [];
const seenSlugs = new Map();

for (const b of scope.branches) {
  const files = b.added.concat(b.repaired);
  for (const f of files) {
    if (!POST_RE.test(f)) die('writer ' + b.name + ' day file ngoai _posts/YYYY-MM-DD-<slug>.md: "' + f + '" — REFUSED');
  }
  if (files.length > writerChunk) die(b.name + ' day ' + files.length + ' bai, vuot writer_chunk_size=' + writerChunk + ' — REFUSED');
  for (const f of b.added) {
    const slug = f.replace(/^_posts\/\d{4}-\d{2}-\d{2}-/, '').replace(/\.md$/, '');
    if (seenSlugs.has(slug)) die('trung slug "' + slug + '" giua ' + seenSlugs.get(slug) + ' va ' + b.name + ' — REFUSED');
    seenSlugs.set(slug, b.name);
    const row = bySlug.get(slug);
    if (row && row.status === 'published') {
      const has = spawnSync('git', ['cat-file', '-e', 'origin/main:' + f], { cwd: ROOT }).status === 0;
      if (!has) die('slug "' + slug + '" da published (row ' + row.id + ') nhung file khong co tren main — trang thai khong nhat quan, REFUSED');
      const onMain = gitOk(['show', 'origin/main:' + f]);
      const onBranch = gitOk(['show', b.sha + ':' + f]);
      if (onMain === onBranch) {
        skip.push(f); // da tich hop y het — idempotent (phuc hoi crash sau commit)
        continue;
      }
      die('slug "' + slug + '" da published (row ' + row.id + ') va noi dung khac main — published row khong bao gio bi reassign; REPAIR phai dung dung file goc, khong tao slug moi');
    }
    added.push(f);
  }
  for (const f of b.repaired) {
    repaired.push(f);
  }
  const keep = files.filter(f => !skip.includes(f));
  if (keep.length) apply.push({ name: b.name, sha: b.sha, files: keep });
}

if (added.length > cap) die(added.length + ' bai moi vuot integration_max_new_posts=' + cap + ' — REFUSED (tach chu ky nho hon)');
const noop = added.length === 0 && repaired.length === 0;

writeFileSync('/tmp/integrate.json', JSON.stringify({ noop, added, repaired, apply, skipped: skip }, null, 2) + '\\n');
if (process.env.GITHUB_OUTPUT) {
  appendFileSync(process.env.GITHUB_OUTPUT, 'noop=' + (noop ? 'true' : 'false') + '\\n');
  appendFileSync(process.env.GITHUB_OUTPUT, 'added=' + added.join(',') + '\\n');
  appendFileSync(process.env.GITHUB_OUTPUT, 'repaired=' + repaired.join(',') + '\\n');
}
console.log('integrate-guard: OK — added=' + added.length + ', repaired=' + repaired.length + ', skip(already-integrated)=' + skip.length + (noop ? ' — NOOP.' : ''));
if (skip.length) console.log('integrate-guard: skip: ' + skip.join(', '));