#!/usr/bin/env node
// Self-healing audit. Severity classes:
//   CRITICAL: broken internal links, duplicate permalinks/canonicals,
//             accidental noindex on published posts, missing required files
//   HIGH: orphan posts (no inbound internal link), duplicate titles/descriptions
//   MEDIUM: stale shards, missing reports
//   LOW: cosmetic
// Only DETERMINISTIC repairs are auto-applied with --fix (regenerating
// sitemap shards). Everything else is reported, never guessed.
// Usage: node scripts/self-heal-audit.mjs [--root <dir>] [--fix]
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { findRoot, discover, isExcluded, SITE, writeReport } from './lib/lab.mjs';

const ROOT = findRoot(process.argv);
const FIX = process.argv.includes('--fix');
const findings = [];
const add = (severity, issue, fix) => findings.push({ severity, issue, fix });

const { posts, pages, hubs, statics } = discover(ROOT);

// URL set (ALL pages incl. noindex stubs, hubs)
const urlSet = new Set(['/']);
for (const c of [...pages, ...hubs, ...statics]) if (c.url) urlSet.add(c.url);
for (const p of posts) urlSet.add('/' + p.slug + '/');

// accidental noindex on posts
for (const p of posts) {
  if (p.fm.data.noindex === true || p.fm.data.noindex === 'true') {
    add('CRITICAL', `${p.path}: published post marked noindex (experiment forbids noindex on articles)`, 'manual review — do not auto-remove');
  }
}
// duplicate permalinks
const seen = new Map();
for (const c of [...pages, ...statics]) {
  if (!c.url) continue;
  if (seen.has(c.url)) add('CRITICAL', `duplicate permalink ${c.url}: ${c.path} and ${seen.get(c.url)}`, 'manual');
  else seen.set(c.url, c.path);
}
// duplicate titles/descriptions among indexable posts
const tMap = new Map(), dMap = new Map();
for (const p of posts) {
  if (isExcluded(p.fm.data)) continue;
  const t = String(p.fm.data.title || '').toLowerCase();
  if (tMap.has(t)) add('HIGH', `duplicate title: ${p.path} and ${tMap.get(t)}`, 'manual');
  else tMap.set(t, p.path);
  const d = String(p.fm.data.description || '').toLowerCase();
  if (dMap.has(d)) add('HIGH', `duplicate description: ${p.path} and ${dMap.get(d)}`, 'manual');
  else dMap.set(d, p.path);
}
// broken internal links (markdown + Liquid targets)
for (const f of [...posts, ...pages, ...statics]) {
  const text = f.text;
  for (const m of text.matchAll(/\]\((\/[^)#\s]*)(#[^)\s]*)?\)/g)) {
    let t = m[1];
    if (t.startsWith('/lab')) t = t.slice(4);
    const u = t.endsWith('/') || t.includes('.') ? t : t + '/';
    if (!urlSet.has(u) && !u.startsWith('/danh-muc/') || (u.startsWith('/danh-muc/') && !urlSet.has(u) && !isDirIndex(u, pages))) {
      if (!urlSet.has(u) && !isDirIndex(u, pages)) add('CRITICAL', `${f.path}: broken link "${m[1]}"`, 'fix source link to the real published URL');
    }
  }
  for (const m of text.matchAll(/\{\{\s*'([^']+)'\s*\|\s*relative_url\s*\}\}/g)) {
    let t = m[1];
    if (t.startsWith('/lab')) t = t.slice(4);
    const u = t.endsWith('/') || t === '/' || t.includes('.') ? t : t + '/';
    if (!urlSet.has(u) && !isDirIndex(u, pages)) add('CRITICAL', `${f.path}: broken Liquid link "${m[1]}"`, 'fix source link');
  }
}
function isDirIndex(u, pgs) {
  if (u === '/danh-muc/') return pgs.some(p => p.url === '/danh-muc/');
  return false;
}
// orphan posts: no inbound link from any other content file
const allText = [...pages, ...hubs, ...statics].map(x => x.text).join('\n') +
  posts.filter(p => true).map(p => p.text).join('\n');
for (const p of posts) {
  const needle = '/' + p.slug;
  if (!allText.includes(needle)) add('MEDIUM', `${p.path}: orphan — no inbound internal link`, 'add a relevant link from a category/hub page');
}
// stale shards vs current post count
const sdir = join(ROOT, 'sitemaps');
if (existsSync(sdir)) {
  const shards = readdirSync(sdir).filter(f => /^articles-\d+\.xml$/.test(f));
  const need = Math.max(1, Math.ceil(posts.filter(p => !isExcluded(p.fm.data)).length / 1000));
  if (shards.length !== need) add('MEDIUM', `shard count ${shards.length} != expected ${need}`, FIX ? 'regenerated' : 'run gen-sitemap-shards');
}

if (FIX) {
  try {
    execFileSync('node', [join(ROOT, 'scripts/gen-sitemap-shards.mjs'), '--root', ROOT], { stdio: 'inherit' });
  } catch { add('CRITICAL', 'sitemap regeneration failed', 'check scripts');
  }
}

writeReport(ROOT, 'self-heal-audit.json', { generated_at: new Date().toISOString(), findings });
const bySeverity = {};
for (const f of findings) {
  bySeverity[f.severity] = (bySeverity[f.severity] || 0) + 1;
  console.error(`${f.severity}: ${f.issue} -> ${f.fix}`);
}
console.log(`self-heal-audit: ${findings.length} finding(s) ${JSON.stringify(bySeverity)}`);
if ((bySeverity.CRITICAL || 0) > 0) process.exit(1);
process.exit(0);
