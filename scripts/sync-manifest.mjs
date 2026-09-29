#!/usr/bin/env node
// sync-manifest.mjs — keeps data/article-manifest.jsonl consistent with the
// repository truth (repair 2026-09-29):
//   - marks manifest entries as published when their slug matches a post
//   - RECONCILES posts that are missing from the manifest: rows are added
//     from the post's own front matter (stable identity = front-matter id,
//     which must equal the slug), never fabricated
//   - updates data/progress.json article counts from repository truth
// Corrupt manifest rows are a HARD failure (exit 1) — never silently skipped.
// Runs in CI only (clean checkout). Never fabricates entries.
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;

function fm(text) {
  if (!text.startsWith('---')) return {};
  const end = text.indexOf('\n---', 3);
  if (end === -1) return {};
  const o = {};
  const lists = {};
  let listKey = null;
  for (const line of text.slice(3, end).split('\n')) {
    const lm = line.match(/^\s*-\s*"?(.*?)"?\s*$/);
    if (lm && listKey) { lists[listKey].push(lm[1]); continue; }
    const m = line.match(/^([a-z_]+):\s*"?(.*?)"?\s*$/);
    if (m) { o[m[1]] = m[2]; listKey = (m[1] === 'entities' || m[1] === 'related_articles') ? m[1] : null; if (listKey) lists[listKey] = []; }
  }
  return { ...o, entities: lists.entities || [], related_articles: lists.related_articles || [] };
}

const posts = new Map(); // slug -> parsed front matter
if (existsSync(join(ROOT, '_posts'))) {
  for (const f of readdirSync(join(ROOT, '_posts')).filter(f => f.endsWith('.md'))) {
    const slug = f.replace(/^\d{4}-\d{2}-\d{2}-/, '').replace(/\.md$/, '');
    posts.set(slug, fm(readFileSync(join(ROOT, '_posts', f), 'utf8')));
  }
}

const manifestPath = join(ROOT, 'data', 'article-manifest.jsonl');
const rawLines = readFileSync(manifestPath, 'utf8').split('\n').filter(Boolean);
const rows = [];
const corrupt = [];
for (let i = 0; i < rawLines.length; i++) {
  try { rows.push(JSON.parse(rawLines[i])); }
  catch (e) { corrupt.push('line ' + (i + 1) + ': ' + e.message); }
}
if (corrupt.length) {
  console.error('sync-manifest: CORRUPT manifest rows — refusing to continue:');
  for (const c of corrupt) console.error('  ' + c);
  process.exit(1);
}

let flipped = 0;
const bySlug = new Map(rows.map(r => [r.slug, r]));
for (const r of rows) {
  if (posts.has(r.slug) && r.status !== 'published') {
    r.status = 'published';
    r.published_at = r.published_at || new Date().toISOString().slice(0, 10);
    r.published_url = r.published_url || ('/' + r.slug + '/');
    flipped++;
  }
}

// Reconcile posts missing from the manifest, using actual content and the
// stable identity (front-matter id = slug). Never fabricate topics.
let added = 0;
for (const [slug, o] of posts) {
  if (bySlug.has(slug)) continue;
  if (o.id && o.id !== slug) {
    console.error('sync-manifest: post ' + slug + ' has front-matter id "' + o.id + '" != slug — reconcile manually');
    process.exit(1);
  }
  const rec = {
    id: o.id || slug,
    cluster: o.cluster || null,
    status: 'published',
    primary_topic: o.title || o.primary_keyword || slug,
    search_intent: o.search_intent || 'informational',
    title: o.title || '',
    slug,
    parent_hub: o.cluster ? ('/hub/' + o.cluster.toLowerCase() + '/') : null,
    entities: (o.entities || []).map(e => String(e)),
    freshness: 'low',
    needs_official_source: o.legal_sensitivity === 'true',
    similarity_group: null,
    source_plan: [],
    internal_links: (o.related_articles || []).map(e => String(e)),
    published_url: '/' + slug + '/',
    reconciled: true,
    published_at: o.date || new Date().toISOString().slice(0, 10)
  };
  rows.push(rec);
  added++;
  console.log('reconciled: added missing manifest row ' + rec.id + ' from post front matter');
}

if (flipped || added) {
  writeFileSync(manifestPath, rows.map(r => JSON.stringify(r)).join('\n') + '\n');
}
console.log('sync-manifest: ' + flipped + ' entry(ies) marked published, ' + added + ' missing post(s) reconciled, ' + rows.length + ' total rows');

// progress.json counts — from repository truth, never invented
const progPath = join(ROOT, 'data', 'progress.json');
if (existsSync(progPath)) {
  const p = JSON.parse(readFileSync(progPath, 'utf8'));
  const publishedPosts = posts.size;
  const publishedManifest = rows.filter(r => r.status === 'published').length;
  const planned = rows.filter(r => r.status === 'planned').length;
  if (p.articles) {
    if (p.articles.published !== publishedPosts) { p.articles.published = publishedPosts; }
  }
  p.manifest = { published: publishedManifest, planned, total: rows.length };
  p.last_updated = new Date().toISOString().slice(0, 10);
  writeFileSync(progPath, JSON.stringify(p, null, 2) + '\n');
  console.log('sync-manifest: progress.json updated from repository truth (posts=' + publishedPosts + ', manifest published=' + publishedManifest + ', planned=' + planned + ')');
}
