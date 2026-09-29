#!/usr/bin/env node
// gen-sitemap-shards.mjs — deterministic sitemap regeneration for codeappweb/lab.
// Produces: sitemap.xml (index), sitemaps/articles-NNN.xml (~1000 URLs/shard),
// sitemaps/categories.xml, sitemaps/static.xml, data/sitemap-shards.json.
// Zero dependencies. Output is byte-deterministic for identical repo content,
// so CI can commit only when content actually changes.
// Excludes: noindex pages (hub pages, child-category stubs) and sitemap:false pages.
import { readFileSync, readdirSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const SITE = 'https://codeappweb.github.io/lab';
const SHARD_SIZE = 1000;

function parseFrontMatter(text) {
  if (!text.startsWith('---')) return null;
  const end = text.indexOf('\n---', 3);
  if (end === -1) return null;
  return text.slice(3, end);
}

function fmValue(fm, key) {
  const m = fm.match(new RegExp('^' + key + ':\\s*"?([^"\\n]*)"?', 'm'));
  return m ? m[1].trim() : null;
}

function isNoIndex(fm) {
  return /(^|\n)\s*noindex:\s*true/.test(fm) || /(^|\n)\s*sitemap:\s*false/.test(fm);
}

function xmlEsc(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function urlset(urls) {
  // urls: [{loc (site-relative), lastmod|null}]
  let out = '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n';
  for (const u of urls) {
    out += '  <url>\n    <loc>' + xmlEsc(SITE + u.loc) + '</loc>\n';
    if (u.lastmod) out += '    <lastmod>' + u.lastmod + '</lastmod>\n';
    out += '  </url>\n';
  }
  return out + '</urlset>\n';
}

// ---- Articles (posts) -------------------------------------------------------
const postsDir = join(ROOT, '_posts');
const articles = [];
if (existsSync(postsDir)) {
  for (const f of readdirSync(postsDir).filter(f => f.endsWith('.md')).sort()) {
    const m = f.match(/^(\d{4}-\d{2}-\d{2})-(.+)\.md$/);
    if (!m) continue;
    const text = readFileSync(join(postsDir, f), 'utf8');
    const fm = parseFrontMatter(text) || '';
    const date = fmValue(fm, 'date') || m[1];
    articles.push({ loc: '/' + m[2] + '/', lastmod: date });
  }
}
articles.sort((a, b) => (a.lastmod + a.loc).localeCompare(b.lastmod + b.loc));

// ---- Categories --------------------------------------------------------------
const catDir = join(ROOT, 'danh-muc');
const categories = [];
if (existsSync(catDir)) {
  const entries = readdirSync(catDir);
  for (const e of entries.sort()) {
    const full = join(catDir, e);
    if (e === 'index.md') {
      const fm = parseFrontMatter(readFileSync(full, 'utf8')) || '';
      if (!isNoIndex(fm)) categories.push({ loc: '/danh-muc/', lastmod: null });
      continue;
    }
    if (e.endsWith('.md')) {
      const fm = parseFrontMatter(readFileSync(full, 'utf8')) || '';
      if (isNoIndex(fm)) continue;
      const permalink = fmValue(fm, 'permalink');
      categories.push({ loc: permalink || '/danh-muc/' + e.replace(/\.md$/, '') + '/', lastmod: null });
      continue;
    }
    // child directory
    try {
      const stat = readdirSync(full);
      for (const c of stat.filter(x => x.endsWith('.md')).sort()) {
        const fm = parseFrontMatter(readFileSync(join(full, c), 'utf8')) || '';
        if (isNoIndex(fm)) continue;
        const permalink = fmValue(fm, 'permalink');
        categories.push({ loc: permalink || '/danh-muc/' + e + '/' + c.replace(/\.md$/, '') + '/', lastmod: null });
      }
    } catch { /* not a dir */ }
  }
}
categories.sort((a, b) => a.loc.localeCompare(b.loc));

// ---- Static pages (from data/navigation.yml main section) ---------------------
const statics = [];
const navPath = join(ROOT, 'data/navigation.yml');
if (existsSync(navPath)) {
  const nav = readFileSync(navPath, 'utf8');
  const main = nav.split('utility:')[0].split('main:')[1] || '';
  const seen = new Set();
  for (const m of main.matchAll(/url:\s*"([^"]+)"/g)) {
    const loc = m[1];
    if (loc.endsWith('.xml')) continue; // utility files, not HTML pages
    if (seen.has(loc)) continue;
    seen.add(loc);
    statics.push({ loc, lastmod: null });
  }
}

// ---- Write shards ------------------------------------------------------------
const shardDir = join(ROOT, 'sitemaps');
mkdirSync(shardDir, { recursive: true });

const shards = [];
for (let i = 0; i < articles.length; i += SHARD_SIZE) {
  const chunk = articles.slice(i, i + SHARD_SIZE);
  const n = String(Math.floor(i / SHARD_SIZE) + 1).padStart(3, '0');
  const file = 'sitemaps/articles-' + n + '.xml';
  writeFileSync(join(ROOT, file), urlset(chunk));
  shards.push({ file, count: chunk.length, lastmod: chunk.reduce((mx, a) => a.lastmod > mx ? a.lastmod : mx, '') || null });
}

writeFileSync(join(shardDir, 'categories.xml'), urlset(categories));
writeFileSync(join(shardDir, 'static.xml'), urlset(statics));

// ---- Sitemap index -------------------------------------------------------------
const indexLastmod = shards.reduce((mx, s) => (s.lastmod && s.lastmod > mx ? s.lastmod : mx), '');
let idx = '<?xml version="1.0" encoding="UTF-8"?>\n<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n';
for (const s of shards) {
  idx += '  <sitemap>\n    <loc>' + xmlEsc(SITE + '/' + s.file) + '</loc>\n';
  if (s.lastmod) idx += '    <lastmod>' + s.lastmod + '</lastmod>\n';
  idx += '  </sitemap>\n';
}
idx += '  <sitemap>\n    <loc>' + xmlEsc(SITE + '/sitemaps/categories.xml') + '</loc>\n  </sitemap>\n';
idx += '  <sitemap>\n    <loc>' + xmlEsc(SITE + '/sitemaps/static.xml') + '</loc>\n  </sitemap>\n';
idx += '</sitemapindex>\n';
writeFileSync(join(ROOT, 'sitemap.xml'), idx);

// ---- Shard metadata (deterministic) ---------------------------------------------
const meta = {
  site: SITE,
  shard_size: SHARD_SIZE,
  shards,
  counts: { articles: articles.length, categories: categories.length, static: statics.length }
};
writeFileSync(join(ROOT, 'data/sitemap-shards.json'), JSON.stringify(meta, null, 2) + '\n');

console.log('sitemap: ' + articles.length + ' articles in ' + shards.length + ' shard(s), '
  + categories.length + ' categories, ' + statics.length + ' static pages');
