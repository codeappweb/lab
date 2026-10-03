#!/usr/bin/env node
// content-index.mjs — SQLITE DERIVED CONTENT CACHE (data/content-index.sqlite).
//
// Mục đích: writer/QA không phải đọc lại hàng nghìn bài cũ mỗi chu kỳ. Thiết kế
// quy mô 10k–100k bài (node:sqlite builtin — cần Node >= 22.13).
// SQLite là DERIVED CACHE ONLY: repository truth vẫn là data/article-manifest.jsonl
// + file nội dung trên đĩa. Cache KHÔNG bao giờ commit vào repo (gitignored,
// persist qua actions/cache của coordinator).
//
// Mỗi row cache mô tả MỘT file nội dung (_posts/**, danh-muc/**, hub/**, trang
// tĩnh gốc): id, slug, path, norm_title, intent, entities (JSON), cluster,
// content_hash (sha256), size, permalink, eligible, qa_status, qa_at, published_at.
//   - content_hash: phát hiện file cũ bị sửa → chỉ QA lại đúng file đó.
//   - qa_status: pending (file mới/sửa, chờ gate) → passed (TẤT CẢ gate xanh).
//   - published_at: derive từ manifest (slug published) + ngày bài.
//
// Quyền ghi: CHỈ coordinator (production.yml) chạy --build/--update/--qa-pass.
// Writer và mọi gate chỉ ĐỌC (readOnly qua scripts/content-index-lib.mjs, hoặc
// --dump/--verify) — writer KHÔNG THỂ mutate cache.
//
// Chế độ:
//   --update            : incremental — upsert file mới/thay đổi (git status;
//                         không có git → full scan hash), row mới/sửa →
//                         qa_status=pending. Không đổi → không ghi (idempotent,
//                         file byte-identical). Cache THIẾU/HỎNG (không mở được,
//                         sai schema) → REBUILD an toàn từ manifest + content;
//                         mọi row pending → chu kỳ chạy FULL QA (fail-closed).
//                         In MỘT dòng JSON {mode,fresh,updated,removed,total,pending}.
//   --build             : rebuild toàn bộ (atomic qua file .tmp rồi rename) —
//                         mọi row pending.
//   --qa-pass           : pending → passed (chỉ gọi sau khi tất cả gate xanh).
//   --verify [--hashes] : audit toàn vẹn (read-only): mọi file đĩa có row, mọi
//                         row có file trên đĩa; --hashes đối chiếu content_hash
//                         từng file (đọc toàn bộ — cho audit).
//   --dump              : in JSON array mọi row (read-only — cho writer/tools).
import { createHash } from 'node:crypto';
import { readFileSync, existsSync, readdirSync, statSync, mkdirSync, rmSync, renameSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { IDX_SCHEMA_VERSION, idxPath } from './content-index-lib.mjs';

let DatabaseSync;
try { ({ DatabaseSync } = await import('node:sqlite')); }
catch (e) { console.error('::error::content-index: node:sqlite không khả dụng (cần Node >= 22.13): ' + e.message); process.exit(1); }

const ROOT = process.env.LAB_ROOT
  ? resolve(process.env.LAB_ROOT)
  : resolve(join(dirname(fileURLToPath(import.meta.url)), '..'));
const IDX_PATH = idxPath(ROOT);
const IDX_TMP = IDX_PATH + '.tmp';
const POSTS_DIR = join(ROOT, '_posts');
const TECH_DOC = new Set(['README.md', 'AGENTS.md', 'CONTRIBUTING.md']);

function die(msg) {
  console.error('::error::content-index: ' + msg);
  process.exit(1);
}

const MODE = (process.argv.find(a => a === '--update' || a === '--build' || a === '--qa-pass' || a === '--verify' || a === '--dump') || '--update');
const WITH_HASHES = process.argv.includes('--hashes');

const COLS = 'path,kind,id,slug,norm_title,intent,entities,topic_cluster,content_hash,size,permalink,eligible,qa_status,qa_at,published_at';
const COLS_PH = '?,?,?,?,?,?,?,?,?,?,?,?,?,?,?';
const DDL = [
  'CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);',
  'CREATE TABLE IF NOT EXISTS articles (',
  '  path TEXT PRIMARY KEY,',
  '  kind TEXT NOT NULL,',
  '  id TEXT NOT NULL,',
  '  slug TEXT NOT NULL UNIQUE,',
  '  norm_title TEXT NOT NULL,',
  "  intent TEXT NOT NULL DEFAULT 'informational',",
  '  entities TEXT NOT NULL DEFAULT \'[]\'',
  '  topic_cluster TEXT NOT NULL DEFAULT \'\'',
  '  content_hash TEXT NOT NULL,',
  '  size INTEGER NOT NULL DEFAULT 0,',
  '  permalink TEXT NOT NULL,',
  '  eligible INTEGER NOT NULL DEFAULT 1,',
  "  qa_status TEXT NOT NULL DEFAULT 'pending' CHECK (qa_status IN ('pending','passed')),",
  '  qa_at TEXT,',
  '  published_at TEXT',
  ');',
  'CREATE INDEX IF NOT EXISTS idx_articles_id ON articles(id);',
].join('\n');
const N = (v) => (typeof v === 'bigint' ? Number(v) : v);

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
    const m = line.match(/^([a-z_]+):\s*\"?(.*?)\"?\s*$/);
    if (m) { fm[m[1]] = m[2]; lastKey = m[1]; continue; }
    const li = line.match(/^\s*-\s*\"?(.*?)\"?\s*$/);
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

function manifestPublished() {
  const out = new Set();
  try {
    const raw = readFileSync(join(ROOT, 'data', 'article-manifest.jsonl'), 'utf8');
    for (const l of raw.split('\n').filter(Boolean)) {
      try { const r = JSON.parse(l); if (r.status === 'published' && r.slug) out.add(String(r.slug)); }
      catch { /* manifest hỏng sẽ bị validate-content bắt — đây chỉ là derive cache */ }
    }
  } catch { /* fixture chưa có manifest */ }
  return out;
}

function rowFor(f, pub) {
  const text = readFileSync(f.full, 'utf8');
  const { fm, raw } = fmParse(text);
  const sha = createHash('sha256').update(text).digest('hex');
  const noindex = /noindex:\s*true/.test(raw) || /sitemap:\s*false/.test(raw);
  let slug, id, permalink, publishedAt = null;
  if (f.kind === 'post') {
    slug = f.rel.replace(/^_posts\/\d{4}-\d{2}-\d{2}-/, '').replace(/\.md$/, '');
    id = String(fm.manifest_id || slug).trim();
    permalink = fm.permalink || ('/' + slug);
    const dm = /^_posts\/(\d{4}-\d{2}-\d{2})-/.exec(f.rel);
    if (dm && pub.has(slug)) publishedAt = dm[1];
  } else {
    permalink = fm.permalink || ('/' + f.rel.replace(/\.md$/, ''));
    slug = permalink.replace(/^\//, '').replace(/\/+$/, '') || 'index';
    id = slug;
  }
  return {
    kind: f.kind, id: id, slug: slug, path: f.rel,
    norm_title: norm(fm.title || fm.primary_topic || slug),
    intent: fm.search_intent || 'informational',
    entities: JSON.stringify(Array.isArray(fm.entities) ? fm.entities.slice(0, 6) : []),
    cluster: fm.cluster || '',
    content_hash: sha,
    size: text.length,
    permalink: permalink,
    eligible: noindex ? 0 : 1,
    qa_status: 'pending',
    qa_at: null,
    published_at: publishedAt,
  };
}

function bindRow(r) {
  return [r.path, r.kind, r.id, r.slug, r.norm_title, r.intent, r.entities, r.cluster,
    r.content_hash, r.size, r.permalink, r.eligible, r.qa_status, r.qa_at, r.published_at];
}

// ---- build atomic (tmp → rename) ----
function buildAll() {
  const pub = manifestPublished();
  const files = siteFiles();
  mkdirSync(join(ROOT, 'data'), { recursive: true });
  rmSync(IDX_TMP, { force: true });
  let db;
  try {
    db = new DatabaseSync(IDX_TMP);
    db.exec(DDL);
    db.exec('BEGIN');
    const ins = db.prepare('INSERT INTO articles (' + COLS + ') VALUES (' + COLS_PH + ')');
    for (const f of files) ins.run(...bindRow(rowFor(f, pub)));
    db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run('schema_version', IDX_SCHEMA_VERSION);
    db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run('built_at', new Date().toISOString());
    db.exec('COMMIT');
  } catch (e) {
    if (db) { try { db.close(); } catch {} }
    rmSync(IDX_TMP, { force: true });
    die('build thất bại — KHÔNG thay thế cache cũ: ' + e.message);
  }
  db.close();
  try { renameSync(IDX_TMP, IDX_PATH); }
  catch (e) { rmSync(IDX_PATH, { force: true }); renameSync(IDX_TMP, IDX_PATH); }
  return files.length;
}

function summary() {
  let db;
  try { db = new DatabaseSync(IDX_PATH, { readOnly: true }); }
  catch (e) { die('sau update không mở được cache: ' + e.message); }
  const total = N(db.prepare('SELECT COUNT(*) AS c FROM articles').get().c);
  const pending = db.prepare('SELECT path FROM articles WHERE qa_status = ? ORDER BY path').all('pending').map(r => r.path);
  db.close();
  return { total, pending };
}

// ---- --update / --build ----
if (MODE === '--update' || MODE === '--build') {
  let fresh = false;
  let db = null;
  let updated = 0, removed = 0;
  if (MODE === '--build') {
    buildAll();
    fresh = true;
  } else {
    try {
      if (!existsSync(IDX_PATH)) throw new Error('cache thiếu');
      db = new DatabaseSync(IDX_PATH);
      const v = db.prepare('SELECT value FROM meta WHERE key = ?').get('schema_version');
      if (!v || v.value !== IDX_SCHEMA_VERSION) throw new Error('schema_version lệch hoặc thiếu');
    } catch (e) {
      if (db) { try { db.close(); } catch {} db = null; }
      console.error('::warning::content-index sqlite thiếu/hỏng (' + e.message + ') — REBUILD an toàn từ manifest + content; mọi row pending → chu kỳ này FULL QA.');
      rmSync(IDX_PATH, { force: true });
      buildAll();
      fresh = true;
    }
    if (!fresh) {
      const pub = manifestPublished();
      const files = siteFiles();
      let changedSet = null;
      const st = spawnSync('git', ['status', '--porcelain'], { cwd: ROOT, encoding: 'utf8' });
      if (st.status === 0) {
        changedSet = new Set(
          (st.stdout || '').split('\n')
            .filter(l => l.trim())
            .map(l => l.slice(3).trim().split(' -> ').pop())
            .filter(p => p.endsWith('.md'))
        );
      } // git không chạy được (fixture/tests) → full scan hash
      db.exec('BEGIN');
      try {
        const diskPaths = new Set(files.map(f => f.rel));
        const listPaths = db.prepare('SELECT path FROM articles').all().map(r => r.path);
        const del = db.prepare('DELETE FROM articles WHERE path = ?');
        for (const p of listPaths) {
          if (!diskPaths.has(p)) { del.run(p); removed++; }
        }
        const sel = db.prepare('SELECT * FROM articles WHERE path = ?');
        const ins = db.prepare('INSERT INTO articles (' + COLS + ') VALUES (' + COLS_PH + ')');
        const upd = db.prepare('UPDATE articles SET kind=?,id=?,slug=?,norm_title=?,intent=?,entities=?,topic_cluster=?,content_hash=?,size=?,permalink=?,eligible=?,qa_status=?,qa_at=?,published_at=? WHERE path=?');
        const updPub = db.prepare('UPDATE articles SET published_at=? WHERE path=?');
        for (const f of files) {
          const old = sel.get(f.rel);
          const mustRead = !old || changedSet === null || changedSet.has(f.rel);
          if (!mustRead) continue;
          const nw = rowFor(f, pub);
          if (old && old.content_hash === nw.content_hash) {
            // nội dung không đổi (git status nhắc nhưng hash trùng) — giữ qa_status/qa_at;
            // chỉ sync published_at khi manifest đổi (planned → published).
            if ((old.published_at || null) !== nw.published_at) updPub.run(nw.published_at, f.rel);
          } else {
            if (nw.slug) {
              const conflict = db.prepare('SELECT path FROM articles WHERE slug = ? AND path <> ?').get(nw.slug, f.rel);
              if (conflict) throw new Error('trùng slug "' + nw.slug + '" giữa ' + f.rel + ' và ' + conflict.path + ' — REFUSED (fail-closed)');
            }
            if (old) upd.run(nw.kind, nw.id, nw.slug, nw.norm_title, nw.intent, nw.entities, nw.cluster, nw.content_hash, nw.size, nw.permalink, nw.eligible, 'pending', null, nw.published_at, f.rel);
            else ins.run(...bindRow(nw));
            updated++;
          }
        }
      } catch (e) {
        try { db.exec('ROLLBACK'); } catch {}
        db.close();
        die('--update thất bại (transaction ROLLBACK, cache giữ nguyên): ' + e.message);
      }
      db.exec('COMMIT');
      db.close();
    }
  }
  const s = summary();
  console.log(JSON.stringify({ mode: MODE, fresh, updated, removed, total: s.total, pending: s.pending }));
  process.exit(0);
}

// ---- --qa-pass ----
if (MODE === '--qa-pass') {
  if (!existsSync(IDX_PATH)) die('không có cache để đánh dấu qa-pass — chạy --update và đầy đủ gate trước');
  let db;
  try { db = new DatabaseSync(IDX_PATH); }
  catch (e) { die('cache hỏng (' + e.message + ') — chạy node scripts/content-index.mjs --build'); }
  db.exec('BEGIN');
  const r = db.prepare("UPDATE articles SET qa_status = 'passed', qa_at = ? WHERE qa_status = 'pending'").run(new Date().toISOString());
  db.exec('COMMIT');
  const total = N(db.prepare('SELECT COUNT(*) AS c FROM articles').get().c);
  db.close();
  console.log(JSON.stringify({ mode: MODE, passed: N(r.changes), total }));
  process.exit(0);
}

// ---- --verify [--hashes] (read-only) ----
if (MODE === '--verify') {
  if (!existsSync(IDX_PATH)) die('data/content-index.sqlite thiếu — chạy node scripts/content-index.mjs --build (fail-closed)');
  let db;
  try { db = new DatabaseSync(IDX_PATH, { readOnly: true }); }
  catch (e) { die('data/content-index.sqlite không mở được (' + e.message + ') — rebuild index (fail-closed)'); }
  const files = siteFiles();
  const disk = new Map(files.map(f => [f.rel, f]));
  const errs = [];
  for (const r of db.prepare('SELECT path, slug, content_hash FROM articles').all()) {
    if (!disk.has(r.path)) errs.push('index có row cho file không tồn tại: ' + r.path);
    if (WITH_HASHES && disk.has(r.path)) {
      const sha = createHash('sha256').update(readFileSync(disk.get(r.path).full, 'utf8')).digest('hex');
      if (sha !== r.content_hash) errs.push('hash lệch (file đã đổi sau khi index): ' + r.path);
    }
  }
  const rowsSet = new Set(db.prepare('SELECT path FROM articles').all().map(r => r.path));
  db.close();
  for (const p of disk.keys()) if (!rowsSet.has(p)) errs.push('file trên đĩa không có trong index: ' + p);
  if (errs.length) {
    for (const e of errs) console.error('::error::' + e);
    process.exit(1);
  }
  console.log('content-index verify OK: sqlite, ' + rowsSet.size + ' row' + (WITH_HASHES ? ' (hashes verified)' : ' (structural)'));
  process.exit(0);
}

// ---- --dump (read-only) ----
if (MODE === '--dump') {
  if (!existsSync(IDX_PATH)) die('data/content-index.sqlite thiếu — chạy node scripts/content-index.mjs --build (fail-closed)');
  let db;
  try { db = new DatabaseSync(IDX_PATH, { readOnly: true }); }
  catch (e) { die('data/content-index.sqlite không mở được (' + e.message + ') — rebuild index (fail-closed)'); }
  const rows = db.prepare('SELECT * FROM articles ORDER BY path').all().map(r => {
    const o = {};
    for (const [k, v] of Object.entries(r)) o[k] = typeof v === 'bigint' ? Number(v) : v;
    o.cluster = o.topic_cluster; // "cluster" là keyword của SQLite → cột đặt tên topic_cluster
    delete o.topic_cluster;
    o.entities = JSON.parse(o.entities || '[]');
    o.eligible = !!o.eligible;
    return o;
  });
  db.close();
  console.log(JSON.stringify(rows));
  process.exit(0);
}
