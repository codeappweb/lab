#!/usr/bin/env node
// validate-content.mjs — QA nhẹ manifest + bài viết. Usage: node validate-content.mjs
// Trạng thái đơn giản: planned -> drafting -> review -> published (skip để bỏ bài).
import { readFileSync, existsSync, readdirSync } from 'node:fs';
const ROOT = new URL('..', import.meta.url).pathname;
const errs = [], warns = [];
// Scoped QA qua content-index (data/content-index.sqlite — derived cache, read-only):
//   --only a,b     : deep-check ĐÚNG các file liệt kê; post khác chỉ được tin
//                    khi index có row qa_status=passed (KHÔNG đọc lại bài cũ).
//   --only none    : chỉ kiểm manifest + index PHỦ mọi post (refill path).
// Fail-closed: scoped mà index thiếu/hỏng → LỖI, không suy đoán.
const onlyIdx = process.argv.indexOf('--only');
const ONLY_RAW = onlyIdx !== -1 ? (process.argv[onlyIdx + 1] ?? '') : null;
const SCOPED = onlyIdx !== -1 && ONLY_RAW !== 'none';
const NONE_MODE = onlyIdx !== -1 && ONLY_RAW === 'none';
const ONLY = SCOPED ? ONLY_RAW.split(',').map(s => s.trim()).filter(Boolean) : null;
const lines = readFileSync(ROOT + 'data/article-manifest.jsonl', 'utf8').split('\n').filter(Boolean);
const seen = new Set();
const STATUS = ['planned','drafting','review','published','skip'];
const recs = [];
lines.forEach((l, i) => {
  let r; try { r = JSON.parse(l); } catch { errs.push(`line ${i+1}: invalid JSON`); return; }
  recs.push(r);
  for (const k of ['id','cluster','status','primary_topic','slug','search_intent']) if (!r[k]) errs.push(`${r.id || 'line '+(i+1)}: missing ${k}`);
  if (r.status && !STATUS.includes(r.status)) errs.push(`${r.id}: bad status ${r.status} (allowed: ${STATUS.join(', ')})`);
  if (r.id) { if (seen.has(r.id)) errs.push(`duplicate id ${r.id}`); seen.add(r.id); }
  if (r.published_url && r.status !== 'published') errs.push(`${r.id}: published_url set but status=${r.status}`);
  if (r.needs_official_source && (!r.source_plan || !r.source_plan.length)) warns.push(`${r.id}: needs official source but source_plan empty`);
});
const posts = existsSync(ROOT + '_posts') ? readdirSync(ROOT + '_posts').filter(f => f.endsWith('.md')) : [];
// Chỉ dòng published bắt buộc có file post; drafting/review có thể chưa có file.
for (const r of recs) {
  if (r.status === 'published') {
    const f = posts.find(p => p.includes(r.slug));
    if (!f) errs.push(`${r.id}: status=published but no post file for slug "${r.slug}"`);
  }
}
// content-index cho scoped/none mode (fail-closed khi thiếu/hỏng)
let idxRows = null;
if (SCOPED || NONE_MODE) {
  try {
    // SQLite derived cache (read-only): bài cũ tin theo row qa_status=passed.
    const { openReadOnly, rowsMap } = await import('./content-index-lib.mjs');
    idxRows = rowsMap(await openReadOnly(ROOT));
  } catch (e) {
    errs.push('data/content-index.sqlite thiếu/hỏng (' + e.message + ') — chạy node scripts/content-index.mjs --build (fail-closed)');
    idxRows = new Map();
  }
}
for (const f of posts) {
  const rel = '_posts/' + f;
  const inScope = SCOPED && ONLY.includes(rel);
  if ((SCOPED && !inScope) || NONE_MODE) {
    // bài cũ không đổi trong chu kỳ này: tin content-index (fail-closed)
    const r = idxRows.get(rel);
    if (!r) errs.push(`${rel}: không có trong content-index — rebuild index (fail-closed)`);
    else if (SCOPED && r.qa_status !== 'passed') errs.push(`${rel}: qa_status=${r.qa_status} trong content-index — bài thay đổi chưa qua QA`);
    continue;
  }
  const md = readFileSync(ROOT + '_posts/' + f, 'utf8');
  for (const k of ['title:','date:','cluster:']) if (!md.includes(k)) errs.push(`${f}: front matter thiếu ${k}`);
  // manifest_id liên kết bài với manifest; sync-manifest tự reconciled theo slug
  // khi thiếu — đây là cảnh báo biên tập, không chặn publish.
  if (!md.includes('manifest_id:')) warns.push(`${f}: thiếu manifest_id (sync-manifest sẽ reconcile theo slug)`);
  if ((md.match(/^# /m) || []).length) errs.push(`${f}: có H1 trong body (layout đã render H1 từ title)`);
}
console.log(`manifest: ${lines.length} records, posts: ${posts.length}`);
if (warns.length) console.log('WARN:\n' + warns.join('\n'));
if (errs.length) { console.error('FAIL:\n' + errs.join('\n')); process.exit(1); }
console.log('OK');
