#!/usr/bin/env node
// sync-manifest.mjs — marks manifest entries as published when their slug matches
// a post, and updates data/progress.json article counts.
// Runs in CI only (clean checkout). Never fabricates entries.
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;

const postSlugs = new Set();
for (const f of readdirSync(join(ROOT, '_posts')).filter(f => f.endsWith('.md'))) {
  postSlugs.add(f.replace(/^\d{4}-\d{2}-\d{2}-/, '').replace(/\.md$/, ''));
}

const manifestPath = join(ROOT, 'data/article-manifest.jsonl');
const lines = readFileSync(manifestPath, 'utf8').split('\n').filter(Boolean);
let changed = 0;
const out = lines.map(l => {
  const r = JSON.parse(l);
  if (postSlugs.has(r.slug) && r.status !== 'published') {
    r.status = 'published';
    r.published_at = r.published_at || new Date().toISOString().slice(0, 10);
    changed++;
    return JSON.stringify(r);
  }
  return l;
});
if (changed) writeFileSync(manifestPath, out.join('\n') + '\n');
console.log('sync-manifest: ' + changed + ' entry(ies) marked published');

// progress.json counts
const progPath = join(ROOT, 'data/progress.json');
if (existsSync(progPath)) {
  const p = JSON.parse(readFileSync(progPath, 'utf8'));
  const published = [...postSlugs].length;
  if (p.articles) {
    if (p.articles.published !== published) { p.articles.published = published; changed++; }
  }
  if (changed) {
    p.last_updated = new Date().toISOString().slice(0, 10);
    writeFileSync(progPath, JSON.stringify(p, null, 2) + '\n');
  }
}
