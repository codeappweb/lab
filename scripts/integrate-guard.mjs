#!/usr/bin/env node
// integrate-guard.mjs — validate scope truoc khi staging duoc tich hop vao main.
// Fail closed: moi vi phan DIE truoc khi bat ky file nao duoc dua vao main.
// Doc /tmp/scope.json (collect-staging). Kiem tra:
//   1. moi file khop _posts/YYYY-MM-DD-<slug>.md
//   2. moi writer <= writer_chunk_size bai (added + repaired)
//   3. tong bai moi <= integration_max_new_posts
//   4. khong trung slug giua cac writer; khong trung manifest_id giua cac bai
//   5. slug da published trong manifest: file giong het tren main -> SKIP
//      (da tich hop — idempotent, phuc hoi crash sau commit); khac noi dung
//      -> REFUSE (published row khong bao gio bi reassign)
//   6. CYCLE VERIFICATION (khi co cycle dang mo trong data/factory-cycle.json):
//      moi bai moi phai kem front matter factory_writer / factory_cycle /
//      factory_base_sha / manifest_id, va:
//        factory_writer  == nhanh staging day bai do
//        factory_cycle   == cycle_id cua cycle dang mo
//        factory_base_sha== base_sha cua cycle dang mo
//        manifest_id     thuoc slice cua CHINH writer do trong cycle plan
//      Sai bat ky truong nao, hoac thieu metadata -> bai bi dan ve REVIEW
//      (ghi /tmp/review.json, KHONG publish, khong chet run khi con bai
//      hop le khac); output cycle cu khong bao gio len main silent.
// Ghi /tmp/integrate.json {noop, added, repaired, apply:[{name, sha, files}], review:[]}.
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
const rows = readFileSync(manifestPath, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
const bySlug = new Map(rows.map(r => [r.slug, r]));

// ---- cycle state -------------------------------------------------------------
const cyclePath = join(ROOT, 'data', 'factory-cycle.json');
let cycle = null;
if (existsSync(cyclePath)) {
  try { cycle = JSON.parse(readFileSync(cyclePath, 'utf8')); } catch (e) { die('data/factory-cycle.json hong: ' + e.message); }
}
const cycleActive = cycle && cycle.cycle_id && !["idle", "complete"].includes(cycle.phase);
if (cycleActive && !cycle.cycle_id) die('cycle dang mo nhung thieu cycle_id — cycle state khong nhat quan');

// doc front matter factory_* tu blob tren nhanh staging
function factoryMeta(sha, file) {
  const text = gitOk(['show', sha + ':' + file]);
  const fm = (text.split('---')[1] || '');
  const get = k => {
    const m = fm.match(new RegExp('^' + k + ':\\s*(.+)$', 'm'));
    return m ? m[1].trim().replace(/^["\']|["\']$/g, '') : null;
  };
  return { factory_writer: get('factory_writer'), factory_cycle: get('factory_cycle'), factory_base_sha: get('factory_base_sha'), manifest_id: get('manifest_id') };
}

const added = [];
const repaired = [];
const apply = [];
const skip = [];
const review = [];
const seenSlugs = new Map();
const seenManifestIds = new Map();

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
    // CYCLE VERIFICATION — sai origin -> REVIEW (stale output khong len main).
    if (cycleActive) {
      const meta = factoryMeta(b.sha, f);
      const writer = 'writer-' + (b.name.split('writer-')[1] || '?');
      const sliceIds = (cycle.assignments && cycle.assignments[writer]) || [];
      let reason = null;
      if (!meta.factory_cycle || !meta.factory_base_sha || !meta.factory_writer) {
        reason = 'thieu factory metadata (factory_writer/factory_cycle/factory_base_sha) — bai chu ky cu hoac viet tay ngoi cycle';
      } else if (meta.factory_writer !== writer) {
        reason = 'factory_writer=' + meta.factory_writer + ' khac nhanh day bai (' + writer + ')';
      } else if (meta.factory_cycle !== cycle.cycle_id) {
        reason = 'factory_cycle=' + meta.factory_cycle + ' khac cycle dang mo (' + cycle.cycle_id + ')';
      } else if (meta.factory_base_sha !== cycle.base_sha) {
        reason = 'factory_base_sha=' + meta.factory_base_sha + ' khac base_sha cycle (' + cycle.base_sha + ')';
      } else if (!meta.manifest_id || !sliceIds.includes(meta.manifest_id)) {
        reason = 'manifest_id=' + meta.manifest_id + ' khong thuoc slice cua ' + writer + ' trong cycle ' + cycle.cycle_id;
      }
      if (reason) {
        console.log('::warning::REVIEW ' + f + ' (' + b.name + '): ' + reason + ' — KHONG publish, giu lai de sua/lai cycle.');
        review.push({ file: f, writer: b.name, slug, id: meta.manifest_id || null, reason, cycle: cycle.cycle_id, at: new Date().toISOString() });
        continue;
      }
      if (meta.manifest_id) {
        if (seenManifestIds.has(meta.manifest_id)) die('trung manifest_id ' + meta.manifest_id + ' giua ' + seenManifestIds.get(meta.manifest_id) + ' va ' + b.name + ' — REFUSED (bai trung lap cung ID)');
        seenManifestIds.set(meta.manifest_id, b.name);
      }
    }
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
  const keep = files.filter(f => !skip.includes(f) && !review.some(r => r.file === f));
  if (keep.length) apply.push({ name: b.name, sha: b.sha, files: keep });
}

if (added.length > cap) die(added.length + ' bai moi vuot integration_max_new_posts=' + cap + ' — REFUSED (tach chu ky nho hon)');
const noop = added.length === 0 && repaired.length === 0;

writeFileSync('/tmp/integrate.json', JSON.stringify({ noop, added, repaired, apply, skipped: skip, review }, null, 2) + '\n');
if (process.env.GITHUB_OUTPUT) {
  appendFileSync(process.env.GITHUB_OUTPUT, 'noop=' + (noop ? 'true' : 'false') + '\n');
  appendFileSync(process.env.GITHUB_OUTPUT, 'added=' + added.join(',') + '\n');
  appendFileSync(process.env.GITHUB_OUTPUT, 'repaired=' + repaired.join(',') + '\n');
}
console.log('integrate-guard: OK — added=' + added.length + ', repaired=' + repaired.length + ', skip(already-integrated)=' + skip.length + ', review=' + review.length + (noop ? ' — NOOP.' : ''));
if (skip.length) console.log('integrate-guard: skip: ' + skip.join(', '));
if (review.length) console.log('integrate-guard: review: ' + review.map(r => r.file).join(', '));
