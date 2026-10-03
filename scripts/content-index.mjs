#!/usr/bin/env node
// content-index.mjs — CHỈ MỤC NỘI DUNG NHẸ, LIÊN TỤC (data/content-index.jsonl).
//
// Mục đích: writer/QA không phải đọc lại hàng nghìn bài cũ mỗi chu kỳ. Mỗi dòng
// index mô tả MỘT file nội dung (_posts/**, danh-muc/**, hub/**, trang tĩnh gốc):
//   {kind,id,slug,path,norm_title,intent,entities,cluster,sha256,permalink,eligible,qa_status,qa_at}
//   - sha256: phát hiện file cũ bị sửa → chỉ QA lại đúng file đó.
//   - qa_status: pending (file mới/sửa, chờ gate) → passed (TẤT CẢ gate xanh).
// Gate scoped (--only) tin bài cũ theo row qa_status=passed; thiếu/hỏng index =
// LỖI (fail-closed), KHÔNG đọc từng bài cũ để suy đoán.
//
// Chế độ:
//   --update            : upsert file thay đổi (git status; không có git → full
//                         scan hash), row mới/sửa → qa_status=pending. Không đổi
//                         → không ghi (idempotent). In MỘT dòng JSON tóm tắt.
//   --build             : rebuild toàn bộ (index mới/hỏng) — mọi row pending,
//                         buộc chu kỳ hiện tại chạy FULL QA (fail-closed).
//   --qa-pass           : pending → passed (chỉ gọi sau khi tất cả gate xanh).
//   --verify [--hashes] : kiểm tra tính toàn vẹn: JSONL hợp lệ, slug/path duy
//                         nhất, tập file trên đĩa == tập row index. --hashes =
//                         đối chiếu sha256 từng file (đọc toàn bộ — cho audit).
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync, mkdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = process.env.LAB_ROOT
  ? resolve(process.env.LAB_ROOT)
  : resolve(join(dirname(fileURLToPath(import.meta.url)), '..'));
const IDX_PATH = join(ROOT, 'data', 'content-index.jsonl');
const POSTS_DIR = join(ROOT, '_posts');
const TECH_DOC = new Set(['README.md', 'AGENTS.md', 'CONTRIBUTING.md']);

function die(msg) {
  console.error('::error::content-index: ' + msg);
  process.exit(1);
}

const MODE = (process.argv.find(a => a === '--update' || a === '--build' || a === '--qa-pass' || a === '--verify') || '--update');
const WITH_HASHES = process.argv.includes('--hashes');

// ---- tập file nội dung site (posts + danh-muc + hub + trang tĩnh gốc) ----
function walkMd(dir, out) {
  if (!existsSync(dir)) return out;
  for (const n of readdirSync(dir)) {
    const full = join(dir, n);
    if (statSync(full).isDirectory()) walkMd(full, out);
    else if (n.endsWith('.md')) out.push(full);
  }
  return out;
}
function siteFiles() {
  const files = [];
  for (const f of walkMd(POSTS_DIR, [])) {
    files.push({ full: f, rel: f.slice(ROOT.length + 1).replace(/\\/g, '/'), kind: 'post' });
  }
  for (const d of ['danh-muc', 'hub']) {
    for (const f of walkMd(join(ROOT, d), [])) {
      files.push({ full: f, rel: f.slice(ROOT.length + 1).replace(/\\/g, '/'), kind: 'page' });
    }
  }
  if (existsSync(ROOT)) {
    for (const n of readdirSync(ROOT)) {
      if (!n.endsWith('.md') || TECH_DOC.has(n)) continue;
      files.push({ full: join(ROOT, n), rel: n, kind: 'page' });
    }
  }
  return files;
}

// ---- front matter tối giản (kv + list item) ----
function fmParse(text) {
  if (!text.startsWith('---')) return { fm: {}, raw: '' };
  const end = text.indexOf('\n---', 3);
  if (end === -1) return { fm: {}, raw: '' };
  const raw = text.slice(3, end);
  const fm = {};
  let lastKey = null;
  for (const line of raw.split('\n')) {
    const m = line.match(/^([a-z_]+):\s*"?(.*?)"?\s*$/);
    if (m) { fm[m[1]] = m[2]; lastKey = m[1]; continue; }
    const li = line.match(/^\s*-\s*"?(.*?)"?\s*$/);
    if (li && lastKey) {
      if (!Array.isArray(fm[lastKey])) fm[lastKey] = [];
      fm[lastKey].push(li[1]);
    }
  }
  return { fm, raw };
}

const norm = (s) => String(s || '').toLowerCase()
  .replace(/đ/g, 'd').replace(/Đ/g, 'd')
  .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .replace(/[^a-z0-9]+/g, ' ').trim();

function rowFor(f) {
  const text = readFileSync(f.full, 'utf8');
  const { fm, raw } = fmParse(text);
  const sha = createHash('sha256').update(text).digest('hex');
  const noindex = /noindex:\s*true/.test(raw) || /sitemap:\s*false/.test(raw);
  let slug, id, permalink;
  if (f.kind === 'post') {
    slug = f.rel.replace(/^_posts\/\d{4}-\d{2}-\d{2}-/, '').replace(/\.md$/, '');
    id = String(fm.manifest_id || slug).trim();
    permalink = fm.permalink || ('/' + slug);
  } else {
    permalink = fm.permalink || ('/' + f.rel.replace(/\.md$/, ''));
    slug = permalink.replace(/^\//, '').replace(/\/+$/, '') || 'index';
    id = slug;
  }
  return {
    kind: f.kind,
    id: id,
    slug: slug,
    path: f.rel,
    norm_title: norm(fm.title || fm.primary_topic || slug),
    intent: fm.search_intent || 'informational',
    entities: Array.isArray(fm.entities) ? fm.entities.slice(0, 6) : [],
    cluster: fm.cluster || '',
    sha256: sha,
    size: text.length,
    permalink: permalink,
    eligible: !noindex,
    qa_status: 'pending',
    qa_at: null,
  };
}

// ---- load index (fail-closed) ----
function loadIndex() {
  if (!existsSync(IDX_PATH)) return { fresh: true, rows: new Map() };
  const raw = readFileSync(IDX_PATH, 'utf8');
  if (raw && !raw.endsWith('\n')) die('data/content-index.jsonl không kết thúc bằng newline — chạy --build lại (fail-closed)');
  const rows = new Map();
  const lines = raw.split('\n').filter(Boolean);
  for (let i = 0; i < lines.length; i++) {
    let r;
    try { r = JSON.parse(lines[i]); }
    catch (e) { die('index dòng ' + (i + 1) + ' không phải JSON (' + e.message + ') — chạy node scripts/content-index.mjs --build'); }
    for (const k of ['slug', 'path', 'sha256', 'qa_status']) {
      if (!r[k]) die('index dòng ' + (i + 1) + ' thiếu ' + k);
    }
    if (r.qa_status !== 'passed' && r.qa_status !== 'pending') {
      die('index dòng ' + (i + 1) + ' qa_status không hợp lệ: ' + r.qa_status);
    }
    if (rows.has(r.path)) die('index trùng path: ' + r.path);
    rows.set(r.path, r);
  }
  return { fresh: false, rows };
}

function save(rowsMap) {
  const rows = [...rowsMap.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const content = rows.map(r => JSON.stringify(r)).join('\n') + '\n';
  const back = content.split('\n').filter(Boolean);
  if (back.length !== rows.length) die('transaction verify: sai số dòng');
  for (let i = 0; i < back.length; i++) {
    try { JSON.parse(back[i]); }
    catch (e) { die('transaction verify: dòng ' + (i + 1) + ' không parse được — KHÔNG ghi index'); }
  }
  mkdirSync(join(ROOT, 'data'), { recursive: true });
  writeFileSync(IDX_PATH, content);
}

// ---- --update / --build ----
if (MODE === '--update' || MODE === '--build') {
  const loaded = MODE === '--build' ? { fresh: true, rows: new Map() } : loadIndex();
  const rows = loaded.rows;
  const files = siteFiles();
  let changedSet = null;
  if (MODE === '--update') {
    const st = spawnSync('git', ['status', '--porcelain'], { cwd: ROOT, encoding: 'utf8' });
    if (st.status === 0) {
      changedSet = new Set(
        (st.stdout || '').split('\n')
          .filter(l => l.trim())
          .map(l => l.slice(3).trim().split(' -> ').pop())
          .filter(p => p.endsWith('.md'))
      );
    } // git không chạy được (fixture/tests) → full scan hash
  }
  let updated = 0, removed = 0;
  const diskPaths = new Set(files.map(f => f.rel));
  for (const p of [...rows.keys()]) {
    if (!diskPaths.has(p)) { rows.delete(p); removed++; }
  }
  for (const f of files) {
    const old = rows.get(f.rel);
    const mustRead = MODE === '--build' || !old || changedSet === null || changedSet.has(f.rel);
    if (!mustRead) continue;
    let newRow;
    try { newRow = rowFor(f); }
    catch (e) { die('không đọc/parse được ' + f.rel + ': ' + e.message); }
    if (old && old.sha256 === newRow.sha256 && old.qa_status === 'passed') {
      // nội dung không đổi (git status nhắc nhưng hash trùng) — giữ qa passed
      rows.set(f.rel, { ...newRow, qa_status: 'passed', qa_at: old.qa_at });
    } else {
      rows.set(f.rel, newRow);
      updated++;
    }
  }
  if (updated || removed || loaded.fresh) save(rows);
  const pending = [...rows.values()].filter(r => r.qa_status === 'pending').map(r => r.path).sort();
  console.log(JSON.stringify({ mode: MODE, fresh: loaded.fresh, updated, removed, total: rows.size, pending }));
  process.exit(0);
}

// ---- --qa-pass ----
if (MODE === '--qa-pass') {
  const { fresh, rows } = loadIndex();
  if (fresh) die('không có index để đánh dấu qa-pass — chạy --update và đầy đủ gate trước');
  let n = 0;
  for (const r of rows.values()) {
    if (r.qa_status === 'pending') { r.qa_status = 'passed'; r.qa_at = new Date().toISOString(); n++; }
  }
  if (n) save(rows);
  console.log(JSON.stringify({ mode: MODE, passed: n, total: rows.size }));
  process.exit(0);
}

// ---- --verify ----
if (MODE === '--verify') {
  const { fresh, rows } = loadIndex();
  if (fresh) die('data/content-index.jsonl thiếu — chạy node scripts/content-index.mjs --build');
  const files = siteFiles();
  const disk = new Map(files.map(f => [f.rel, f]));
  const errs = [];
  const seenSlug = new Set();
  for (const [p, r] of rows) {
    if (!disk.has(p)) errs.push('index có row cho file không tồn tại: ' + p);
    if (seenSlug.has(r.slug)) errs.push('trùng slug trong index: ' + r.slug);
    seenSlug.add(r.slug);
    if (WITH_HASHES && disk.has(p)) {
      const sha = createHash('sha256').update(readFileSync(disk.get(p).full, 'utf8')).digest('hex');
      if (sha !== r.sha256) errs.push('hash lệch (file đã đổi sau khi index): ' + p);
    }
  }
  for (const p of disk.keys()) {
    if (!rows.has(p)) errs.push('file trên đĩa không có trong index: ' + p);
  }
  if (errs.length) {
    for (const e of errs) console.error('::error::' + e);
    process.exit(1);
  }
  console.log('content-index verify OK: ' + rows.size + ' row' + (WITH_HASHES ? ' (hashes verified)' : ' (structural)'));
  process.exit(0);
}
