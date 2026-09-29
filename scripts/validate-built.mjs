#!/usr/bin/env node
// validate-built.mjs — post-build integrity gate for the generated _site.
// Run AFTER `bundle exec jekyll build`: node scripts/validate-built.mjs
// Audit 2026-09-29: previously no post-build verification existed, so broken
// hrefs or sitemap URLs that only appear in rendered HTML went unnoticed.
// Against the REAL generated tree this gate checks:
//   1. every internal href/src in built HTML resolves to a file on disk
//   2. every URL in sitemap.xml / sitemaps/*.xml exists in _site
//   3. sitemap <loc> entries are unique (duplicates are an error)
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const SITE = join(ROOT, '_site');
if (!existsSync(SITE)) {
  console.error('validate-built: _site not found — run jekyll build first');
  process.exit(1);
}

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === '.git' || name === '.jekyll-cache') continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

const files = walk(SITE);
const htmlFiles = files.filter(f => f.endsWith('.html'));

function resolves(p) {
  if (p === '' || p === '/') return existsSync(join(SITE, 'index.html'));
  const clean = p.replace(/^\/+/, '').replace(/\/+$/, '');
  return existsSync(join(SITE, clean)) ||
    existsSync(join(SITE, clean + '.html')) ||
    existsSync(join(SITE, clean, 'index.html'));
}

// ---- 1. internal href/src in built HTML ----
const errs = [];
let checked = 0;
for (const f of htmlFiles) {
  const rel = relative(SITE, f);
  const text = readFileSync(f, 'utf8');
  for (const m of text.matchAll(/(?:href|src)=\"([^\"]+)\"/g)) {
    const raw = m[1];
    if (/^(https?:)?\/\/|^mailto:|^tel:|^data:|^#/.test(raw)) continue;
    const p = raw.replace(/^\/lab(?=\/)/, '').split('#')[0].split('?')[0];
    if (p === '') continue;
    checked++;
    if (!resolves(p)) errs.push(rel + ': broken internal link "' + raw + '"');
  }
}

// ---- 2 + 3. sitemap URLs exist in _site and are unique ----
const seenLoc = new Map();
const sitemapFiles = [join(SITE, 'sitemap.xml')];
const shardsDir = join(SITE, 'sitemaps');
if (existsSync(shardsDir)) {
  for (const f of readdirSync(shardsDir)) if (f.endsWith('.xml')) sitemapFiles.push(join(shardsDir, f));
}
let locCount = 0;
for (const sf of sitemapFiles) {
  if (!existsSync(sf)) { errs.push('sitemap missing: ' + relative(SITE, sf)); continue; }
  const text = readFileSync(sf, 'utf8');
  for (const m of text.matchAll(/<loc>([^<]+)<\/loc>/g)) {
    locCount++;
    let p;
    try { p = new URL(m[1]).pathname; }
    catch { p = m[1]; }
    p = p.replace(/^\/lab(?=\/)/, '').replace(/\/+$/, '');
    if (!resolves(p)) errs.push(relative(SITE, sf) + ': sitemap URL does not exist in _site: ' + m[1]);
    if (seenLoc.has(p)) errs.push('duplicate sitemap URL: ' + m[1] + ' (also in ' + seenLoc.get(p) + ')');
    else seenLoc.set(p, relative(SITE, sf));
  }
}

if (errs.length) {
  console.error(errs.slice(0, 100).join('\n'));
  if (errs.length > 100) console.error('... and ' + (errs.length - 100) + ' more');
  console.error('validate-built: ' + errs.length + ' error(s) in the generated site. DO NOT DEPLOY.');
  process.exit(1);
}
console.log('validate-built: OK — ' + htmlFiles.length + ' HTML files, ' + checked + ' internal links, ' + locCount + ' sitemap URLs verified in _site.');
