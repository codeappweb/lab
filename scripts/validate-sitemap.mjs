#!/usr/bin/env node
// validate-sitemap.mjs — sitemap integrity gate.
// Checks: index lists existing shards; all URLs absolute, /lab/-prefixed, unique,
// on-site; URL counts match source content; no noindex page is listed.
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const SITE = 'https://codeappweb.github.io/lab';
const errs = [];

function read(p) { return readFileSync(join(ROOT, p), 'utf8'); }
function exists(p) { return existsSync(join(ROOT, p)); }

// 1. index + shards exist
if (!exists('sitemap.xml')) errs.push('missing sitemap.xml (run gen-sitemap-shards.mjs)');
const shardFiles = existsSync(join(ROOT, 'sitemaps')) ? readdirSync(join(ROOT, 'sitemaps')).filter(f => f.endsWith('.xml')) : [];
if (shardFiles.length === 0) errs.push('no sitemap shards found');

// 2. parse all URLs from index + shards
const urls = new Map();
for (const f of ['sitemap.xml', ...shardFiles.map(s => 'sitemaps/' + s)]) {
  const xml = read(f);
  for (const m of xml.matchAll(/<loc>([^<]+)<\/loc>/g)) {
    const loc = m[1];
    urls.set(loc, (urls.get(loc) || 0) + 1);
    if (!loc.startsWith(SITE + '/')) errs.push(f + ': non-absolute or wrong-base URL: ' + loc);
    if (loc.includes('//') && loc.replace(SITE, '').includes('//')) errs.push(f + ': double slash: ' + loc);
  }
}
for (const [loc, n] of urls) if (n > 1) errs.push('duplicate sitemap URL: ' + loc + ' (' + n + 'x)');

// 3. index must reference every shard file
const idx = exists('sitemap.xml') ? read('sitemap.xml') : '';
for (const s of shardFiles) {
  if (!idx.includes('/sitemaps/' + s)) errs.push('sitemap.xml: shard not listed: ' + s);
}

// 4. counts must match source content
const posts = existsSync(join(ROOT, '_posts')) ? readdirSync(join(ROOT, '_posts')).filter(f => f.endsWith('.md')).length : 0;
const articleUrls = [...urls.keys()].filter(u => !u.includes('/danh-muc/') && u !== SITE + '/' && !/(gioi-thieu|lien-he|faq|dich-vu|bao-mat|dieu-khoan)\/$/.test(u));
if (articleUrls.length !== posts) errs.push('article URL count ' + articleUrls.length + ' != post count ' + posts);

// 5. no noindex page in sitemaps (check front matter of every listed category URL)
function walkCats(dir, base) {
  const out = [];
  if (!existsSync(join(ROOT, dir))) return out;
  for (const e of readdirSync(join(ROOT, dir))) {
    const p = join(dir, e);
    if (e.endsWith('.md')) out.push(p);
    else { try { out.push(...walkCats(p, base)); } catch {} }
  }
  return out;
}
const noindexSlugs = new Set();
for (const f of walkCats('danh-muc')) {
  const text = read(f);
  if (/noindex:\s*true/.test(text) || /sitemap:\s*false/.test(text.split('\n---')[0] || '')) {
    const m = read(f).match(/permalink:\s*(\/[^\s]+)\s*$/m);
    if (m) noindexSlugs.add(m[1]);
  }
}
for (const loc of urls.keys()) {
  const rel = loc.slice(SITE.length);
  for (const n of noindexSlugs) if (rel === n) errs.push('noindex page listed in sitemap: ' + loc);
}

// 6. hub pages must never appear
for (const loc of urls.keys()) if (loc.includes('/hub/')) errs.push('hub page listed in sitemap: ' + loc);

if (errs.length) {
  for (const e of errs) console.error('FAIL: ' + e);
  console.error(errs.length + ' sitemap error(s). DO NOT PUSH.');
  process.exit(1);
}
console.log('sitemap OK: ' + urls.size + ' unique URLs, ' + shardFiles.length + ' shard(s), ' + posts + ' articles.');
