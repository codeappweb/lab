#!/usr/bin/env node
// sync-manifest.mjs — reconciles data/article-manifest.jsonl with repository
// truth. Never fabricates entries:
//   1. marks manifest rows published when their post file exists
//   2. RECONCILES posts that are absent from the manifest by creating rows
//      from the post's own front matter (stable id = slug, reconciled: true)
//   3. refreshes data/progress.json counts from repository truth
// Corrupt manifest rows are a hard error, never silently dropped.
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const POSTS = join(ROOT, '_posts');
const MANIFEST_PATH = join(ROOT, 'data', 'article-manifest.jsonl');
const PROGRESS_PATH = join(ROOT, 'data', 'progress.json');

function fm(text) {
  if (!text.startsWith('---')) return {};
  const end = text.indexOf('\n---', 3);
  if (end === -1) return {};
  const o = {};
  for (const line of text.slice(3, end).split('\n')) {
    const m = line.match(/^([a-z_]+):\s*"?([^"\n]*)"?\s*$/);
    if (m) o[m[1]] = m[2];
  }
  return o;
}

const postFiles = existsSync(POSTS) ? readdirSync(POSTS).filter(f => f.endsWith('.md')) : [];
const postInfo = new Map(); // slug -> { file, date, fm }
for (const f of postFiles) {
  const slug = f.replace(/^\d{4}-\d{2}-\d{2}-/, '').replace(/\.md$/, '');
  let meta = {};
  try { meta = fm(readFileSync(join(POSTS, f), 'utf8')); }
  catch (e) { console.error('::error::unreadable post ' + f + ': ' + e.message); process.exit(1); }
  postInfo.set(slug, { file: f, date: (f.match(/^(\d{4}-\d{2}-\d{2})-/) || [])[1] || '', fm: meta });
}

// existing manifest: corrupt rows are a hard error
const rows = [];
const rawLines = readFileSync(MANIFEST_PATH, 'utf8').split('\n').filter(Boolean);
for (const [i, line] of rawLines.entries()) {
  let r;
  try { r = JSON.parse(line); }
  catch (e) { console.error('::error::manifest line ' + (i + 1) + ' is not valid JSON: ' + e.message); process.exit(1); }
  if (!r.id || !r.slug || !r.status) { console.error('::error::manifest line ' + (i + 1) + ' missing id/slug/status'); process.exit(1); }
  rows.push(r);
}

let flipped = 0;
for (const r of rows) {
  if (postInfo.has(r.slug) && r.status !== 'published') {
    r.status = 'published';
    r.published_at = r.published_at || postInfo.get(r.slug).date || new Date().toISOString().slice(0, 10);
    flipped++;
  }
}

// reconcile posts absent from the manifest, from their own front matter
let reconciled = 0;
for (const [slug, info] of postInfo) {
  if (rows.some(r => r.slug === slug)) continue;
  const f = info.fm;
  rows.push({
    id: slug,
    slug: slug,
    primary_topic: f.title || slug,
    search_intent: f.search_intent || 'informational',
    cluster: f.cluster || '',
    parent_hub: f.parent_category || '',
    entities: [],
    freshness: f.freshness_status || 'evergreen',
    needs_official_source: /legal_sensitivity:\s*true/.test(f.legal_sensitivity || '') || false,
    similarity_group: null,
    status: 'published',
    published_at: info.date || new Date().toISOString().slice(0, 10),
    reconciled: true,
    source: 'post-front-matter'
  });
  reconciled++;
  console.log('reconciled post into manifest: ' + slug);
}

writeFileSync(MANIFEST_PATH, rows.map(r => JSON.stringify(r)).join('\n') + '\n');
console.log('sync-manifest: ' + flipped + ' row(s) marked published, ' + reconciled + ' post(s) reconciled from front matter, ' + rows.length + ' total rows');

// progress.json counts from repository truth
if (existsSync(PROGRESS_PATH)) {
  const p = JSON.parse(readFileSync(PROGRESS_PATH, 'utf8'));
  const published = postInfo.size;
  const planned = rows.filter(r => r.status === 'planned').length;
  if (p.articles) {
    p.articles.published = published;
    p.articles.planned = planned;
    p.articles.manifest_rows = rows.length;
  }
  p.manifest_rows = rows.length;
  p.posts_on_disk = postFiles.length;
  p.last_updated = new Date().toISOString().slice(0, 10);
  writeFileSync(PROGRESS_PATH, JSON.stringify(p, null, 2) + '\n');
  console.log('sync-manifest: progress.json updated from repository truth');
}
