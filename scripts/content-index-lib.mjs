#!/usr/bin/env node
// content-index-lib.mjs — READ-ONLY access tới SQLite derived cache
// (data/content-index.sqlite) cho các gate/writer. CHỈ coordinator ghi cache
// (content-index.mjs --build/--update/--qa-pass); lib này luôn mở readOnly
// nên writer KHÔNG THỂ mutate cache. Import node:sqlite là DYNAMIC (lazy)
// để full-mode của các gate vẫn chạy trên Node chưa có node:sqlite.
import { join } from 'node:path';
import { existsSync } from 'node:fs';

export const IDX_SCHEMA_VERSION = '2';
export const IDX_FILENAME = 'content-index.sqlite';
export function idxPath(root) { return join(root, 'data', IDX_FILENAME); }

export async function openReadOnly(root) {
  const { DatabaseSync } = await import('node:sqlite');
  const p = idxPath(root);
  if (!existsSync(p)) {
    throw new Error('data/' + IDX_FILENAME + ' thiếu — chạy node scripts/content-index.mjs --build (fail-closed)');
  }
  let db;
  try { db = new DatabaseSync(p, { readOnly: true }); }
  catch (e) { throw new Error('data/' + IDX_FILENAME + ' hỏng (' + e.message + ') — rebuild index (fail-closed)'); }
  let v;
  try { v = db.prepare('SELECT value FROM meta WHERE key = ?').get('schema_version'); }
  catch (e) {
    try { db.close(); } catch {}
    throw new Error('data/' + IDX_FILENAME + ' hỏng (' + e.message + ') — rebuild index (fail-closed)');
  }
  if (!v || v.value !== IDX_SCHEMA_VERSION) {
    try { db.close(); } catch {}
    throw new Error('data/' + IDX_FILENAME + ' schema_version lệch — rebuild index (fail-closed)');
  }
  return db;
}

export function rowsMap(db) {
  const out = new Map();
  const stmt = db.prepare('SELECT path, kind, id, slug, norm_title, intent, entities, cluster, content_hash, permalink, eligible, qa_status, qa_at, published_at FROM articles');
  for (const raw of stmt.all()) {
    const r = {};
    for (const [k, v] of Object.entries(raw)) r[k] = typeof v === 'bigint' ? Number(v) : v;
    r.entities = JSON.parse(r.entities || '[]');
    r.eligible = !!r.eligible;
    out.set(r.path, r);
  }
  return out;
}
