#!/usr/bin/env node
// Deterministic sitemap generation from the ACTUAL canonical output URLs.
// Honors: permalink overrides, noindex, sitemap:false, published:false,
// future-dated posts. Removes obsolete shards safely. ~1000 URLs/shard.
// Usage: node scripts/gen-sitemap-shards.mjs [--root <dir>]
import { writeFileSync, mkdirSync, readdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { findRoot, canonicalIndex, SITE, writeReport } from './lib/lab.mjs';

const ROOT = findRoot(process.argv);
const now = new Date();
const index = canonicalIndex(ROOT, now);
const posts = [], categories = [], statics = [];
for (const [url, meta] of index) {
  if (meta.kind === 'post') posts.push({ url, lastmod: meta.lastmod });
  else if (meta.kind === 'category') categories.push({ url });
  else statics.push({ url });
}
posts.sort((a, b) => a.url.localeCompare(b.url));
categories.sort((a, b) => a.url.localeCompare(b.url));
statics.sort((a, b) => a.url.localeCompare(b.url));

const dir = join(ROOT, 'sitemaps');
mkdirSync(dir, { recursive: true });

function esc(u) { return u.replace(/&/g, '&amp;'); }
function shardXml(urls, withLastmod) {
  let x = '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n';
  for (const u of urls) {
    x += '  <url>\n    <loc>' + SITE + esc(u.url) + '</loc>\n';
    if (withLastmod && u.lastmod) x += '    <lastmod>' + u.lastmod + '</lastmod>\n';
    x += '  </url>\n';
  }
  return x + '</urlset>\n';
}

const SHARD = 1000;
const shardNames = [];
let i = 0, n = 1;
while (i < posts.length) {
  const name = 'articles-' + String(n).padStart(3, '0') + '.xml';
  writeFileSync(join(dir, name), shardXml(posts.slice(i, i + SHARD), true));
  shardNames.push(name);
  i += SHARD; n++;
}
writeFileSync(join(dir, 'categories.xml'), shardXml(categories, false));
writeFileSync(join(dir, 'static.xml'), shardXml(statics, false));

// remove obsolete shards
for (const f of readdirSync(dir).filter(f => /^articles-\d+\.xml$/.test(f))) {
  if (!shardNames.includes(f)) rmSync(join(dir, f));
}

writeReport(ROOT, 'sitemap-shards.json', {
  generated_at: now.toISOString(),
  posts: posts.length, categories: categories.length, statics: statics.length,
  shards: shardNames
});
console.log(`gen-sitemap-shards: posts=${posts.length} categories=${categories.length} statics=${statics.length} shards=${shardNames.length}`);
