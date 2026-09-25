#!/usr/bin/env node
// QA manifest + bài viết. Usage: node validate-content.mjs
import { readFileSync, existsSync, readdirSync } from 'node:fs';
const ROOT = new URL('..', import.meta.url).pathname;
const errs = [], warns = [];
const lines = readFileSync(ROOT + 'data/article-manifest.jsonl', 'utf8').split('\n').filter(Boolean);
const seen = new Set();
const STATUS = ['planned','researching','drafted','qa','published','merge','skip','update_needed'];
const recs = [];
lines.forEach((l, i) => {
  let r; try { r = JSON.parse(l); } catch { errs.push(`line ${i+1}: invalid JSON`); return; }
  recs.push(r);
  for (const k of ['id','cluster','status','primary_topic','slug','search_intent']) if (!r[k]) errs.push(`${r.id || 'line '+(i+1)}: missing ${k}`);
  if (r.status && !STATUS.includes(r.status)) errs.push(`${r.id}: bad status ${r.status}`);
  if (r.id) { if (seen.has(r.id)) errs.push(`duplicate id ${r.id}`); seen.add(r.id); }
  if (r.published_url && r.status !== 'published') errs.push(`${r.id}: published_url set but status=${r.status}`);
  if (r.needs_official_source && (!r.source_plan || !r.source_plan.length)) warns.push(`${r.id}: needs official source but source_plan empty`);
});
const posts = existsSync(ROOT + '_posts') ? readdirSync(ROOT + '_posts').filter(f => f.endsWith('.md')) : [];
for (const r of recs) {
  if (['drafted','qa','published'].includes(r.status)) {
    const f = posts.find(p => p.includes(r.slug));
    if (!f) errs.push(`${r.id}: status=${r.status} but no post file for slug "${r.slug}"`);
  }
}
for (const f of posts) {
  const md = readFileSync(ROOT + '_posts/' + f, 'utf8');
  for (const k of ['title:','date:','cluster:','manifest_id:']) if (!md.includes(k)) errs.push(`${f}: front matter thiếu ${k}`);
  if ((md.match(/^# /m) || []).length) errs.push(`${f}: có H1 trong body (layout đã render H1 từ title)`);
}
console.log(`manifest: ${lines.length} records, posts: ${posts.length}`);
if (warns.length) console.log('WARN:\n' + warns.join('\n'));
if (errs
.length) { console.error('FAIL:\n' + errs.join('\n')); process.exit(1); }
console.log('OK');
