#!/usr/bin/env node
// validate-built.mjs — validates the BUILT output in _site/ (rendered HTML):
//   1. every sitemap URL exists as a built page
//   2. every internal href in every built HTML page resolves to a built file
//   3. malformed hrefs (whitespace / encoded newlines) are errors
// Usage: node scripts/validate-built.mjs [--root <dir>] [--site _site]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findRoot, walkFiles, SITE } from './lib/lab.mjs';

const ROOT = findRoot(process.argv, path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'));
const sIdx = process.argv.indexOf('--site');
const siteDir = path.join(ROOT, sIdx >= 0 ? process.argv[sIdx + 1] : '_site');

const errors = [];
if (!fs.existsSync(siteDir)) {
  console.error('validate-built: no _site directory — run jekyll build first');
  process.exit(1);
}

const builtFiles = new Set(walkFiles(siteDir).map(f => f.slice(siteDir.length + 1)));
function urlToFile(u) {
  let p = u.replace(/^https?:\/\/[^/]+/, '');
  p = p.replace(/^\/lab/, '').split('?')[0].split('#')[0];
  if (!p.startsWith('/')) p = '/' + p;
  if (p.endsWith('/')) p = p.slice(0, -1);
  if (p === '') return 'index.html';
  return p.replace(/^\//, '') + '/index.html';
}

for (const shard of ['articles-001', 'categories', 'static']) {
  const f = path.join(siteDir, 'sitemaps', shard + '.xml');
  if (!fs.existsSync(f)) { errors.push('missing built shard sitemaps/' + shard + '.xml'); continue; }
  const xml = fs.readFileSync(f, 'utf8');
  for (const m of xml.matchAll(/<loc>([^<]+)<\/loc>/g)) {
    const file = urlToFile(m[1]);
    if (!builtFiles.has(file)) errors.push('sitemap URL not built: ' + m[1] + ' (expected ' + file + ')');
  }
}

let checkedPages = 0, checkedLinks = 0;
for (const f of walkFiles(siteDir).filter(f => f.endsWith('.html'))) {
  checkedPages++;
  const html = fs.readFileSync(f, 'utf8');
  for (const m of html.matchAll(/href="([^"]*)"/g)) {
    const href = m[1];
    if (!href || href.startsWith('#') || /^(mailto:|tel:|javascript:)/.test(href)) continue;
    checkedLinks++;
    if (/^https?:\/\//.test(href)) {
      if (href.startsWith(SITE)) {
        const file = urlToFile(href);
        if (!builtFiles.has(file)) errors.push('broken absolute internal link ' + href + ' in ' + f);
      }
      continue; // external
    }
    if (href.includes('%0A') || href.includes('%0D') || /[ \t\n]/.test(href)) {
      errors.push('malformed href (whitespace/newline) "' + href.slice(0, 80) + '" in ' + f);
      continue;
    }
    const pageUrl = '/' + f.slice(siteDir.length + 1).replace(/index\.html$/, '');
    const abs = new URL(href, 'https://x' + pageUrl).pathname;
    const file = urlToFile(abs);
    if (!builtFiles.has(file)) errors.push('broken link "' + href + '" in ' + f + ' (expected ' + file + ')');
  }
}

console.log('[validate-built] pages=' + checkedPages + ' links=' + checkedLinks + ' errors=' + errors.length);
for (const e of errors.slice(0, 50)) console.error('FAIL: ' + e);
if (errors.length) process.exit(1);
console.log('[validate-built] built output OK');
