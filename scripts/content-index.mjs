#!/usr/bin/env node
// content-index.mjs — SQLITE CONTENT INDEX (data/content-index.sqlite).
//
// Derived cache ONLY (gitignored, KHÔNG commit mỗi chu kỳ). Source of truth:
// data/article-manifest.jsonl + file nội dung (_posts/**, danh-muc/**, hub/**,
// trang tĩnh gốc). Mục đích scale 10k–100k bài: gate QA scoped KHÔNG đọc lại
// hàng nghìn bài cũ mỗi chu kỳ — tin row qa_status=passed + content_hash.
//
// Row: {path,kind,id,slug,norm_title,intent,entities,cluster,content_hash,
//       size,permalink,eligible,qa_status,qa_at,published_at}
//   - content_hash (sha256): file cũ bị sửa → chỉ QA lại đúng file đó.
//   - qa_status: pending (file mới/sửa, chờ gate) → passed (TẤT CẢ gate xanh).
//   - published_at: ngày từ tên file post (YYYY-MM-DD); page → null.
//
// QUYỀN GHI: CHỈ COORDINATOR (production.yml / publish-loop.mjs) được
// --build / --update / --qa-pass. 3 WRITER READ-ONLY với index dùng chung:
// chỉ --ensure (rebuild cục bộ khi thiếu/hỏng/schema lệch — derived hoàn toàn
// từ source of truth, KHÔNG BAO GIỜ tự đánh qa-pass) và --dump (đọc).
// Writer KHÔNG commit SQLite (gitignored).
//
// Modes:
//   --build   : full rebuild (coordinator). qa derive từ manifest: row
//               published → passed (đã qua gate khi publish); còn lại
//               pending. Page tĩnh → passed.
//   --update  : incremental (coordinator, publish-loop). git status (không
//               có git → quét hash toàn bộ). File mới → derive theo manifest;
//               file đổi → pending; hash không đổi + passed → giữ passed.
//               DB thiếu → fresh build; DB hỏng → die (fail-closed → --build).
//               --force-pending=p1,p2 ép các path về pending (scope chu kỳ).
//   --ensure  : writer-safe. DB thiếu/hỏng/schema lệch → rebuild từ source
//               of truth; khỏe → incremental (KHÔNG qa-pass).
//   --qa-pass : pending → passed (coordinator, sau TẤT CẢ gate + build xanh).
//   --verify [--hashes] : kiểm toàn vẹn (cấu trúc [+ sha256 từng file]).
//   --dump    : in mọi row JSONL (gate scoped đọc qua mode này).
//
// Fail-closed: SQLite thiếu/hỏng/stale mà không rebuild được từ source of
// truth → LỖI, không suy đoán. Cần Node >= 22.13 (node:sqlite, không flag).
import { createHash } from 'node:crypto';
import { readFileSync, existsSync, readdirSync, statSync, mkdirSync, unlinkSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = process.env.LAB_ROOT
  ? resolve(process.env.LAB_ROOT)
  : resolve(join(dirname(fileURLToPath(import.meta.url)), '..'));
const DB_PATH = join(ROOT, 'data', 'content-index.sqlite');
const DB_SIDECARS = [DB_PATH + '-wal', DB_PATH + '-shm'];
const POSTS_DIR = join(ROOT, '_posts');
const TECH_DOC = new Set(['README.md', 'AGENTS.md', 'CONTRIBUTING.md']);
const SCHEMA_VERSION = '1';

function die(msg) {
  console.error('::error::content-index: ' + msg);
  process.exit(1);
}

let DatabaseSync;
try {
  ({ DatabaseSync } = await import('node:sqlite'));
} catch (e) {
  die('node:sqlite không khả dụng — cần Node >= 22.13 (mặc định) hoặc >= 22.5 với --experimental-sqlite: ' + e.message);
}

const MODE = (process.argv.find(a => a === '--build' || a === '--update' || a === '--ensure'
  || a === '--qa-pass' || a === '--verify' || a === '--dump') || '--update');
const WITH_HASHES = process.argv.includes('--hashes');
const fpArg = process.argv.find(a => a.startsWith('--force-pending='));
const FORCE_PENDING = fpArg
  ? fpArg.slice('--force-pending='.length).split(',').map(s => s.trim()).filter(Boolean)
  : [];

// ---- manifest (source of truth cho qa derivation) ---------------------------
function manifestStatusBySlug() {
  const p = join(ROOT, 'data', 'article-manifest.jsonl');
  const map = new Map();
  if (!existsSync(p)) return map; // fixture không có manifest: mọi post pending
  const raw = readFileSync(p, 'utf8');
  raw.split('\n').filter(Boolean).forEach((l, i) => {
    let r;
    try { r = JSON.parse(l); } catch (e) { die('manifest dòng ' + (i + 1) + ' không phải JSON — source of truth hỏng'); }
    if (r && r.slug) map.set(r.slug, r.status || '');
  });
  return map;
}

// ---- tập file nội dung site --------------------------------------------------
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

// ---- front matter tối giản (kv + list item) ----------------------------------
function fmParse(text) {
  if (!text.startsWith('---')) return { fm: {}, raw: '' };
  const end = text.indexOf('\n---', 3);
  if (end === -1) return { fm: {}, raw: '' };
  const raw = text.slice(3, end);
  const fm = {};
  let lastKey = null;
  for (const line of raw.split('\n')) {
    const mv = line.match(/^([a-z_]+):\s*"?([^"\n]*)"?\s*$/);
    if (mv) { fm[mv[1]] = mv[2]; lastKey = mv[1]; continue; }
    const li = line.match(/^\s*-\s*"?([^"\n]*)"?\s*$/);
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
  let slug, id, permalink, publishedAt;
  if (f.kind === 'post') {
    slug = f.rel.replace(/^_posts\/\d{4}-\d{2}-\d{2}-/, '').replace(/\.md$/, '');
    id = String(fm.manifest_id || slug).trim();
    permalink = fm.permalink || ('/' + slug);
    publishedAt = (f.rel.match(/^_posts\/(\d{4}-\d{2}-\d{2})-/) || [])[1] || null;
  } else {
    permalink = fm.permalink || ('/' + f.rel.replace(/\.md$/, ''));
    slug = permalink.replace(/^\//, '').replace(/\/+$/, '') || 'index';
    id = slug;
    publishedAt = null;
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
    content_hash: sha,
    size: text.length,
    permalink: permalink,
    eligible: !noindex,
    qa_status: 'pending',
    qa_at: null,
    published_at: publishedAt,
  };
}

// ---- sqlite helpers ----------------------------------------------------------
function openDb({ readOnly = false } = {}) {
  const db = new DatabaseSync(DB_PATH, readOnly ? { readOnly: true } : undefined);
  const meta = db.prepare("SELECT value FROM idx_meta WHERE key = 'schema_version'").get();
  if (!meta || meta.value !== SCHEMA_VERSION) {
    try { db.close(); } catch { /* ignore */ }
    throw new Error('schema lệch/thiếu (schema_version != ' + SCHEMA_VERSION + ')');
  }
  return db;
}
function tryOpenDb(opts) {
  try { return { db: openDb(opts) }; } catch (e) { return { err: e }; }
}
function createSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS idx_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS articles (
      path TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      id TEXT NOT NULL,
      slug TEXT NOT NULL UNIQUE,
      norm_title TEXT NOT NULL,
      intent TEXT NOT NULL,
      entities TEXT NOT NULL,
      cluster TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      size INTEGER NOT NULL,
      permalink TEXT NOT NULL,
      eligible INTEGER NOT NULL,
      qa_status TEXT NOT NULL CHECK (qa_status IN ('pending','passed')),
      qa_at TEXT,
      published_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_articles_slug ON articles(slug);
  `);
  db.prepare("INSERT OR REPLACE INTO idx_meta (key, value) VALUES ('schema_version', ?)").run(SCHEMA_VERSION);
}
function removeDbFiles() {
  for (const p of [DB_PATH, ...DB_SIDECARS]) {
    try { if (existsSync(p)) unlinkSync(p); } catch { /* ignore */ }
  }
}
function dbRowToObj(r) {
  return { ...r, entities: JSON.parse(r.entities), eligible: !!r.eligible };
}
function upsertRow(db, row) {
  db.prepare(`INSERT INTO articles
      (path, kind, id, slug, norm_title, intent, entities, cluster, content_hash, size, permalink, eligible, qa_status, qa_at, published_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(path) DO UPDATE SET
      kind = excluded.kind, id = excluded.id, slug = excluded.slug, norm_title = excluded.norm_title,
      intent = excluded.intent, entities = excluded.entities, cluster = excluded.cluster,
      content_hash = excluded.content_hash, size = excluded.size, permalink = excluded.permalink,
      eligible = excluded.eligible, qa_status = excluded.qa_status, qa_at = excluded.qa_at,
      published_at = excluded.published_at`)
    .run(row.path, row.kind, row.id, row.slug, row.norm_title, row.intent,
      JSON.stringify(row.entities), row.cluster, row.content_hash, row.size,
      row.permalink, row.eligible ? 1 : 0, row.qa_status, row.qa_at, row.published_at);
}
function pendingPaths(db) {
  return db.prepare("SELECT path FROM articles WHERE qa_status = 'pending' ORDER BY path").all().map(r => r.path);
}
function totalRows(db) {
  return db.prepare('SELECT COUNT(*) AS c FROM articles').get().c;
}

// ---- full rebuild (derive qa từ manifest — sound trên checkout sạch) --------
function buildAll(db) {
  const manifestStatus = manifestStatusBySlug();
  const files = siteFiles();
  const now = new Date().toISOString();
  const rows = files.map((f) => {
    const row = rowFor(f);
    if (f.kind === 'post') {
      if (manifestStatus.get(row.slug) === 'published') {
        row.qa_status = 'passed';
        row.qa_at = now;
      }
    } else {
      row.qa_status = 'passed'; // page tĩnh infra; thay đổi bị ép pending ở --update
      row.qa_at = now;
    }
    return row;
  });
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec('DELETE FROM articles');
    for (const r of rows) upsertRow(db, r);
    db.exec('COMMIT');
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch { /* ignore */ }
    die('build transaction fail: ' + e.message);
  }
  return rows;
}

// ---- incremental (update/ensure) ---------------------------------------------
function incremental(db) {
  const manifestStatus = manifestStatusBySlug();
  const files = siteFiles();
  const diskPaths = new Set(files.map((f) => f.rel));
  let updated = 0, removed = 0;
  // changed set (git) — null → full hash scan (không có git / fixture)
  let changedSet = null;
  const st = spawnSync('git', ['status', '--porcelain'], { cwd: ROOT, encoding: 'utf8' });
  if (st.status === 0) {
    changedSet = new Set(
      (st.stdout || '').split('\n').filter((l) => l.trim())
        .map((l) => l.slice(3).trim().split(' -> ').pop())
        .filter((p) => p.endsWith('.md'))
    );
  }
  const getByPath = db.prepare('SELECT * FROM articles WHERE path = ?');
  db.exec('BEGIN IMMEDIATE');
  try {
    const existing = new Set(db.prepare('SELECT path FROM articles').all().map((r) => r.path));
    for (const p of existing) {
      if (!diskPaths.has(p)) {
        db.prepare('DELETE FROM articles WHERE path = ?').run(p);
        removed++;
      }
    }
    for (const f of files) {
      const old = getByPath.get(f.rel);
      const mustRead = !old || changedSet === null || changedSet.has(f.rel);
      if (!mustRead) continue;
      const row = rowFor(f);
      if (old && old.content_hash === row.content_hash) {
        upsertRow(db, { ...row, qa_status: old.qa_status, qa_at: old.qa_at }); // hash không đổi — giữ qa cũ
        continue;
      }
      if (!old) {
        // file mới: derive theo manifest — bài vừa publish trên main → passed
        // (đã qua gate trong chu kỳ publish của nó); bài mới local/chưa
        // publish → pending (deep-check ở gate scoped).
        if (f.kind !== 'post' || manifestStatus.get(row.slug) === 'published') {
          upsertRow(db, { ...row, qa_status: 'passed', qa_at: new Date().toISOString() });
        } else {
          upsertRow(db, row);
        }
      } else {
        upsertRow(db, row); // nội dung đổi → pending (QA lại đúng file này)
      }
      updated++;
    }
    db.exec('COMMIT');
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch { /* ignore */ }
    die('incremental transaction fail: ' + e.message);
  }
  return { updated, removed, total: totalRows(db), pending: pendingPaths(db) };
}

function forcePending(db, paths) {
  const list = (paths || []).filter(Boolean);
  if (!list.length) return;
  db.exec('BEGIN IMMEDIATE');
  try {
    const upd = db.prepare("UPDATE articles SET qa_status = 'pending', qa_at = NULL WHERE path = ?");
    for (const p of list) upd.run(p);
    db.exec('COMMIT');
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch { /* ignore */ }
    die('force-pending fail: ' + e.message);
  }
}

// ---- --build -------------------------------------------------------------------
if (MODE === '--build') {
  mkdirSync(join(ROOT, 'data'), { recursive: true });
  removeDbFiles(); // rebuild từ đầu — file cũ có thể hỏng/schema lệch
  const db = new DatabaseSync(DB_PATH);
  createSchema(db);
  const rows = buildAll(db);
  const pending = rows.filter((r) => r.qa_status === 'pending').map((r) => r.path).sort();
  db.close();
  console.log(JSON.stringify({ mode: MODE, fresh: true, updated: rows.length, removed: 0, total: rows.length, pending }));
  process.exit(0);
}

// ---- --update -----------------------------------------------------------------
if (MODE === '--update') {
  mkdirSync(join(ROOT, 'data'), { recursive: true });
  let fresh = false;
  let db;
  if (!existsSync(DB_PATH)) {
    fresh = true;
    db = new DatabaseSync(DB_PATH);
    createSchema(db);
    buildAll(db);
  } else {
    const o = tryOpenDb({});
    if (o.err) die('data/content-index.sqlite hỏng/schema lệch (' + o.err.message + ') — fail-closed; chạy node scripts/content-index.mjs --build');
    db = o.db;
  }
  let updated = 0, removed = 0;
  if (!fresh) {
    const res = incremental(db);
    updated = res.updated;
    removed = res.removed;
  } else {
    updated = totalRows(db);
  }
  forcePending(db, FORCE_PENDING);
  const pending = pendingPaths(db);
  const total = totalRows(db);
  db.close();
  console.log(JSON.stringify({ mode: MODE, fresh, updated, removed, total, pending }));
  process.exit(0);
}

// ---- --ensure (writer-safe) ------------------------------------------------------
if (MODE === '--ensure') {
  mkdirSync(join(ROOT, 'data'), { recursive: true });
  if (existsSync(DB_PATH)) {
    const o = tryOpenDb({});
    if (o.err) {
      console.log('::warning::content-index sqlite hỏng/schema lệch (' + o.err.message + ') — rebuild an toàn từ source of truth.');
      removeDbFiles();
    } else {
      const res = incremental(o.db);
      o.db.close();
      console.log(JSON.stringify({ mode: MODE, rebuilt: false, fresh: false, ...res }));
      process.exit(0);
    }
  }
  const db = new DatabaseSync(DB_PATH);
  createSchema(db);
  const rows = buildAll(db);
  const pending = rows.filter((r) => r.qa_status === 'pending').map((r) => r.path).sort();
  db.close();
  console.log(JSON.stringify({ mode: MODE, rebuilt: true, fresh: true, updated: rows.length, removed: 0, total: rows.length, pending }));
  process.exit(0);
}

// ---- --qa-pass (coordinator only — sau TẤT CẢ gate xanh) -----------------------
if (MODE === '--qa-pass') {
  if (!existsSync(DB_PATH)) die('không có index để đánh dấu qa-pass — chạy --update/--build và đầy đủ gate trước');
  const o = tryOpenDb({});
  if (o.err) die('data/content-index.sqlite hỏng (' + o.err.message + ') — fail-closed');
  const r = o.db.prepare("UPDATE articles SET qa_status = 'passed', qa_at = ? WHERE qa_status = 'pending'")
    .run(new Date().toISOString());
  const total = totalRows(o.db);
  o.db.close();
  console.log(JSON.stringify({ mode: MODE, passed: r.changes, total }));
  process.exit(0);
}

// ---- --verify -----------------------------------------------------------------
if (MODE === '--verify') {
  if (!existsSync(DB_PATH)) die('data/content-index.sqlite thiếu — chạy node scripts/content-index.mjs --ensure (writer) / --build (coordinator)');
  const o = tryOpenDb({ readOnly: true });
  if (o.err) die('data/content-index.sqlite hỏng/schema lệch (' + o.err.message + ') — rebuild fail-closed (--build / --ensure)');
  const files = siteFiles();
  const disk = new Map(files.map((f) => [f.rel, f]));
  const rows = o.db.prepare('SELECT * FROM articles').all();
  const errs = [];
  const seenSlug = new Set();
  const rowPaths = new Set(rows.map((r) => r.path));
  for (const r of rows) {
    if (!disk.has(r.path)) errs.push('index có row cho file không tồn tại: ' + r.path);
    if (seenSlug.has(r.slug)) errs.push('trùng slug trong index: ' + r.slug);
    seenSlug.add(r.slug);
    if (WITH_HASHES && disk.has(r.path)) {
      const sha = createHash('sha256').update(readFileSync(disk.get(r.path).full, 'utf8')).digest('hex');
      if (sha !== r.content_hash) errs.push('hash lệch (file đã đổi sau khi index): ' + r.path);
    }
  }
  for (const p of disk.keys()) {
    if (!rowPaths.has(p)) errs.push('file trên đĩa không có trong index: ' + p);
  }
  try { o.db.close(); } catch { /* ignore */ }
  if (errs.length) {
    for (const e of errs) console.error('::error::' + e);
    process.exit(1);
  }
  console.log('content-index verify OK: ' + rows.length + ' row' + (WITH_HASHES ? ' (hashes verified)' : ' (structural)'));
  process.exit(0);
}

// ---- --dump (gate scoped đọc mode này) ------------------------------------------
if (MODE === '--dump') {
  if (!existsSync(DB_PATH)) die('data/content-index.sqlite thiếu — chạy node scripts/content-index.mjs --ensure (writer) / --build (coordinator) — fail-closed');
  const o = tryOpenDb({ readOnly: true });
  if (o.err) die('data/content-index.sqlite hỏng (' + o.err.message + ') — chạy --ensure / --build (fail-closed)');
  for (const r of o.db.prepare('SELECT * FROM articles ORDER BY path').all()) {
    console.log(JSON.stringify(dbRowToObj(r)));
  }
  try { o.db.close(); } catch { /* ignore */ }
  process.exit(0);
}

die('mode không hợp lệ: ' + MODE);
