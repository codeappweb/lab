#!/usr/bin/env node
// sync-manifest.mjs — reconciles data/article-manifest.jsonl with repository
// truth. Never fabricates entries:
//   1. marks manifest rows published when their post file exists
//   2. RECONCILES posts that are absent from the manifest by creating rows
//      from the post's own front matter (stable id = slug, reconciled: true)
//   3. refreshes data/progress.json counts from repository truth
// Corrupt manifest rows are a hard error, never silently dropped.
// A manifest row already marked published whose post file is MISSING is a
// hard data error (it is never silently downgraded or dropped).
//
// Audit fixes 2026-09-29 (round 2):
//   - needs_official_source previously regex-tested the PARSED VALUE of
//     legal_sensitivity (which is just "true"), so the flag was never set
//     for reconciled rows. Fixed to compare the parsed value directly.
//   - Added --dry-run: compute everything, write nothing, exit 1 if the
//     manifest/progress would change (usable as a CI gate), exit 0 when
//     already in sync.
//   - Writes are skipped when content is unchanged, so a second run
//     produces no diff (idempotent).
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const DRY_RUN = process.argv.includes('--dry-run');
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
    const m = line.match(/^([a-z_]+):\s*\"?([^\"\n]*)\"?\s*$/);
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

// Repair stale slugs BEFORE the ghost check: a row whose id matches a post's
// manifest_id but whose slug differs from that post's real filename slug is
// a stale slug (e.g. a renamed post). The post file is repository truth;
// the repair is logged, never silent.
const postByManifestId = new Map();
for (const [slug, info] of postInfo) {
  const mid = (info.fm.manifest_id || '').trim().replace(/^\"|\"$/g, '');
  if (mid) postByManifestId.set(mid, slug);
}
let slugFixed = 0;
for (const r of rows) {
  const real = postByManifestId.get(String(r.id).trim());
  if (real && real !== r.slug) {
    if (rows.some(x => x !== r && x.slug === real)) {
      console.error('::error::cannot fix stale slug for row ' + r.id + ': slug ' + real + ' is already used by another row');
      process.exit(1);
    }
    console.log('fixed stale slug for row ' + r.id + ': ' + r.slug + ' -> ' + real + ' (post file is repository truth)');
    r.slug = real;
    slugFixed++;
  }
}

// published rows without a post file are hard data errors
const ghostPublished = rows.filter(r => r.status === 'published' && !postInfo.has(r.slug));
if (ghostPublished.length) {
  for (const r of ghostPublished) console.error('::error::manifest row ' + r.id + ' is published but no post file exists for slug "' + r.slug + '"');
  process.exit(1);
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
    needs_official_source: f.legal_sensitivity === 'true',
    similarity_group: null,
    status: 'published',
    published_at: info.date || new Date().toISOString().slice(0, 10),
    reconciled: true,
    source: 'post-front-matter'
  });
  reconciled++;
  console.log('reconciled post into manifest: ' + slug);
}

// progress.json counts from repository truth
let progressChanged = null;
if (existsSync(PROGRESS_PATH)) {
  const p = JSON.parse(readFileSync(PROGRESS_PATH, 'utf8'));
  if (p.articles) {
    p.articles.published = postInfo.size;
    p.articles.planned = rows.filter(r => r.status === 'planned').length;
    p.articles.manifest_rows = rows.length;
  }
  p.manifest_rows = rows.length;
  p.posts_on_disk = postFiles.length;
  p.last_updated = new Date().toISOString().slice(0, 10);
  progressChanged = JSON.stringify(p, null, 2) + '\n';
}

const newManifest = rows.map(r => JSON.stringify(r)).join('\n') + '\n';
const oldManifest = readFileSync(MANIFEST_PATH, 'utf8');
const oldProgress = existsSync(PROGRESS_PATH) ? readFileSync(PROGRESS_PATH, 'utf8') : null;
const manifestDiff = newManifest !== oldManifest;
const progressDiff = progressChanged !== null && progressChanged !== oldProgress;

const summary = 'sync-manifest: ' + flipped + ' row(s) marked published, ' + reconciled + ' post(s) reconciled from front matter, ' + slugFixed + ' stale slug(s) fixed, ' + rows.length + ' total rows';

if (DRY_RUN) {
  if (manifestDiff || progressDiff) {
    console.error('::error::manifest/progress out of sync with repository truth (dry-run). Run: node scripts/sync-manifest.mjs');
    console.error(summary);
    process.exit(1);
  }
  console.log(summary);
  console.log('sync-manifest dry-run: manifest and progress already in sync.');
  process.exit(0);
}

if (manifestDiff) writeFileSync(MANIFEST_PATH, newManifest);
if (progressDiff) writeFileSync(PROGRESS_PATH, progressChanged);
console.log(summary);
console.log('sync-manifest: manifest ' + (manifestDiff ? 'updated' : 'unchanged') + ', progress ' + (progressDiff ? 'updated' : 'unchanged'));
