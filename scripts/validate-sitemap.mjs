#!/usr/bin/env node
// Sitemap gate: XML validity, exact membership vs the canonical index,
// uniqueness, shard index references, correct URL counts (document URLs are
// never counted as articles), no excluded URL leaks.
// Usage: node scripts/validate-sitemap.mjs [--root <dir>]
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { findRoot, canonicalIndex, SITE, fail } from './lib/lab.mjs';

const ROOT = findRoot(process.argv);
const errors = [];
const index = canonicalIndex(ROOT, new Date());
const expected = { post: new Set(), category: new Set(), static: new Set() };
for (const [url, meta] of index) expected[meta.kind].add(SITE + url);

function parseShard(file, kind) {
  if (!existsSync(file)) { errors.push('missing shard: ' + file); return []; }
  const xml = readFileSync(file, 'utf8');
  if (!xml.startsWith('<?xml') || !xml.includes('</urlset>')) errors.push(file + ': not a well-formed urlset');
  const open = (xml.match(/<url>/g) || []).length, close = (xml.match(/<\/url>/g) || []).length;
  if (open !== close) errors.push(file + ': unbalanced <url> tags');
  const urls = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map(m => m[1]);
  const seen = new Set();
  for (const u of urls) {
    if (seen.has(u)) errors.push(file + ': duplicate URL ' + u);
    seen.add(u);
    if (!expected[kind].has(u)) errors.push(file + ': URL not a real ' + kind + ' page: ' + u);
  }
  for (const u of expected[kind]) if (!seen.has(u)) errors.push(file + ': missing expected ' + kind + ' URL: ' + u);
  return urls;
}

const dir = join(ROOT, 'sitemaps');
if (!existsSync(dir)) {
  console.error('validate-sitemap: FAIL: no sitemaps/ directory (run gen-sitemap-shards first)');
  process.exit(1);
}
const shards = readdirSync(dir).filter(f => /^articles-\d+\.xml$/.test(f)).sort();
let articleCount = 0;
for (const s of shards) articleCount += parseShard(join(dir, s), 'post').length;
const catCount = parseShard(join(dir, 'categories.xml'), 'category').length;
const statCount = parseShard(join(dir, 'static.xml'), 'static').length;

// index references
const idxFile = join(ROOT, 'sitemap.xml');
if (!existsSync(idxFile)) errors.push('missing sitemap.xml index');
else {
  const idx = readFileSync(idxFile, 'utf8');
  for (const s of [...shards, 'categories.xml', 'static.xml']) {
    if (!idx.includes('/sitemaps/' + s)) errors.push('sitemap.xml index missing reference to sitemaps/' + s);
  }
  const refd = [...idx.matchAll(/<loc>([^<]+)<\/loc>/g)].map(m => m[1]);
  for (const r of refd) {
    if (!r.startsWith(SITE)) errors.push('sitemap.xml: non-absolute reference ' + r);
  }
}

if (articleCount !== expected.post.size) errors.push(`article count mismatch: shards have ${articleCount}, canonical index has ${expected.post.size} (sitemap document URLs must never count as articles)`);
if (catCount !== expected.category.size) errors.push(`category count mismatch: ${catCount} vs ${expected.category.size}`);
if (statCount !== expected.static.size) errors.push(`static count mismatch: ${statCount} vs ${expected.static.size}`);

fail(errors, 'validate-sitemap');
console.log(`validate-sitemap: OK articles=${articleCount} categories=${catCount} statics=${statCount} shards=${shards.length}`);
