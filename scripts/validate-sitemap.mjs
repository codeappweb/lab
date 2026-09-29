#!/usr/bin/env node
// validate-sitemap.mjs — sitemap integrity gate (repair 2026-09-29).
// Previously it counted "article-looking" URLs and compared COUNTS, which
// counted sitemap document URLs as article URLs. Now it parses the sitemap
// index and every URL set separately and compares actual URL SETS with the
// set of eligible posts.
// Checks: index lists exactly the existing shards; every URL absolute, unique,
// on-site; article URL set == eligible post URL set (missing AND extra both
// fail); no noindex page listed; no hub page listed.
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const SITE = 'https://codeappweb.github.io/lab';
const errs = [];

function read(p) { return readFileSync(join(ROOT, p), 'utf8'); }
function exists(p) { return existsSync(join(ROOT, p)); }
function locs(xml) { return [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map(m => m[1].trim()); }

// 1. index + shards exist
if (!exists('sitemap.xml')) errs.push('missing sitemap.xml (run gen-sitemap-shards.mjs)');
const shardFiles = existsSync(join(ROOT, 'sitemaps')) ? readdirSync(join(ROOT, 'sitemaps')).filter(f => f.endsWith('.xml')).sort() : [];
if (shardFiles.length === 0) errs.push('no sitemap shards found');

// 2. parse index (sitemapindex) and shards (urlset) separately
const indexLocs = exists('sitemap.xml') ? locs(read('sitemap.xml')) : [];
const indexUrls = new Set();     // <sitemap> documents listed in the index
const urlsetUrls = new Set();    // article/category/static URLs inside shards
const dupUrls = new Map();

if (exists('sitemap.xml')) {
  const xml = read('sitemap.xml');
  if (!/<sitemapindex[\s>]/.test(xml)) errs.push('sitemap.xml is not a <sitemapindex> document');
  for (const loc of indexLocs) {
    if (!loc.startsWith(SITE + '/sitemaps/') || !loc.endsWith('.xml')) {
      errs.push('sitemap.xml: index entry is not a shard URL: ' + loc);
      continue;
    }
    if (indexUrls.has(loc)) errs.push('sitemap.xml: shard listed twice: ' + loc);
    indexUrls.add(loc);
  }
}

for (const s of shardFiles) {
  const xml = read('sitemaps/' + s);
  if (!/<urlset[\s>]/.test(xml)) errs.push('sitemaps/' + s + ' is not a <urlset> document');
  for (const loc of locs(xml)) {
    if (!loc.startsWith(SITE + '/')) errs.push('sitemaps/' + s + ': non-absolute or wrong-base URL: ' + loc);
    if (loc.includes('//') && loc.replace(SITE, '').includes('//')) errs.push('sitemaps/' + s + ': double slash: ' + loc);
    dupUrls.set(loc, (dupUrls.get(loc) || 0) + 1);
    urlsetUrls.add(loc);
  }
}
for (const [loc, n] of dupUrls) if (n > 1) errs.push('duplicate sitemap URL: ' + loc + ' (' + n + 'x)');

// 3. index must reference every shard file, and every index entry must exist
for (const s of shardFiles) {
  if (!indexUrls.has(SITE + '/sitemaps/' + s)) errs.push('sitemap.xml: shard not listed: ' + s);
}
for (const loc of indexUrls) {
  const file = 'sitemaps/' + loc.split('/').pop();
  if (!exists(file)) errs.push('sitemap.xml: listed shard missing on disk: ' + file);
}

// 4. article URL SET must equal the eligible post URL set (not counts)
function postSlug(f) { return f.replace(/^\d{4}-\d{2}-\d{2}-/, '').replace(/\.md$/, ''); }
const posts = existsSync(join(ROOT, '_posts')) ? readdirSync(join(ROOT, '_posts')).filter(f => f.endsWith('.md')) : [];
const eligible = new Set();
for (const f of posts) {
  const text = readFileSync(join(ROOT, '_posts', f), 'utf8');
  const fmRaw = text.split('\n---')[0] || '';
  if (/noindex:\s*true/.test(fmRaw) || /sitemap:\s*false/.test(fmRaw)) continue; // not eligible
  eligible.add(SITE + '/' + postSlug(f) + '/');
}
const sitemapArticles = new Set([...urlsetUrls].filter(u => {
  const rel = u.slice(SITE.length);
  if (rel === '/' || rel === '') return false;
  if (rel.startsWith('/danh-muc/')) return false;
  if (rel.startsWith('/sitemaps/')) return false;
  if (/^\/(gioi-thieu|lien-he|faq|dich-vu|bao-mat|dieu-khoan)\/$/.test(rel)) return false;
  return true; // everything else in the urlsets is an article URL (posts have /:title/ permalinks)
}));
for (const u of eligible) if (!sitemapArticles.has(u)) errs.push('eligible post missing from sitemap: ' + u);
for (const u of sitemapArticles) if (!eligible.has(u)) errs.push('sitemap lists non-article or removed URL: ' + u);

// 5. no noindex page in sitemaps (category pages)
function walkCats(dir) {
  const out = [];
  if (!existsSync(join(ROOT, dir))) return out;
  for (const e of readdirSync(join(ROOT, dir))) {
    const p = join(dir, e);
    if (e.endsWith('.md')) out.push(p);
    else { try { out.push(...walkCats(p)); } catch {} }
  }
  return out;
}
const noindexSlugs = new Set();
for (const f of walkCats('danh-muc')) {
  const text = read(f);
  if (/noindex:\s*true/.test(text) || /sitemap:\s*false/.test(text.split('\n---')[0] || '')) {
    const m = text.match(/permalink:\s*(\/[^\s]+)\s*$/m);
    if (m) noindexSlugs.add(m[1]);
  }
}
for (const loc of urlsetUrls) {
  const rel = loc.slice(SITE.length);
  for (const n of noindexSlugs) if (rel === n) errs.push('noindex page listed in sitemap: ' + loc);
}

// 6. hub pages must never appear
for (const loc of urlsetUrls) if (loc.includes('/hub/')) errs.push('hub page listed in sitemap: ' + loc);

if (errs.length) {
  for (const e of errs) console.error('FAIL: ' + e);
  console.error(errs.length + ' sitemap error(s). DO NOT PUSH.');
  process.exit(1);
}
console.log('sitemap OK: index lists ' + indexUrls.size + ' shard(s), urlsets contain ' + urlsetUrls.size +
  ' unique URLs, article set matches ' + eligible.size + ' eligible post(s) exactly.');
