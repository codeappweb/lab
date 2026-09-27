#!/usr/bin/env node
// Internal link checker over ALL content sources (_posts, danh-muc, hub, root
// pages, _layouts, _includes): markdown links, Liquid {{ '/x' | relative_url }}
// targets, fragments, whitespace/encoded newlines. Validated against the FULL
// URL set (indexable + noindex + hubs), so category targets are covered.
// Usage: node scripts/check-links.mjs [--root <dir>]
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { findRoot, discover, fail, writeReport } from './lib/lab.mjs';

const ROOT = findRoot(process.argv);
const errors = [];
const { posts, pages, hubs, statics } = discover(ROOT);

const urlSet = new Set(['/']);
const fragSource = new Map(); // url -> headings text
function addSource(item) {
  let url = item.url || ('/' + (item.slug || '') + '/');
  if (url === null) return;
  urlSet.add(url.replace(/\/+$/, '') + (url.endsWith('/') ? '/' : '/'));
  urlSet.add(url);
  const heads = [];
  for (const m of (item.fm.body || '').matchAll(/^#{1,4}\s+(.*)$/gm)) {
    heads.push(m[1].toLowerCase()
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9\s-]/g, '').trim().replace(/\s+/g, '-'));
  }
  fragSource.set(url, heads);
}
posts.forEach(addSource);
pages.forEach(p => { if (p.url) addSource(p); });
hubs.forEach(addSource);
statics.forEach(addSource);

function normUrl(u) {
  if (!u.startsWith('/')) return u;
  return u.endsWith('/') || u.includes('.') || u.startsWith('#') ? u : u + '/';
}

const files = [...posts, ...pages, ...hubs, ...statics];
for (const f of files) {
  const text = f.text;
  // whitespace or encoded newline inside any link target — malformed URL.
  // Liquid targets ({{ ... }}) legitimately contain spaces/pipes and are
  // validated separately below.
  for (const m of text.matchAll(/\]\(([^)]*)\)/g)) {
    const t = m[1];
    if (t.trimStart().startsWith('{{')) continue;
    if (/[ \t\n]/.test(t) || t.includes('%0A') || t.includes('%0D')) {
      errors.push
(`${f.path}: link target contains whitespace/newline: "${t.slice(0, 60)}"`);
    }
  }
  // markdown relative links
  for (const m of text.matchAll(/\]\((\/[^)#\s]*)(#[^)\s]*)?\)/g)) {
    check(f, m[1], m[2]);
  }
  // Liquid hrefs: {{ '/x' | relative_url }}
  for (const m of text.matchAll(/\{\{\s*'([^']+)'\s*\|\s*relative_url\s*\}\}/g)) {
    check(f, m[1], null);
  }
  // raw href="/..." in embedded HTML
  for (const m of text.matchAll(/href="(\/[^"]*)"/g)) {
    check(f, m[1].split('#')[0], m[1].includes('#') ? '#' + m[1].split('#')[1] : null);
  }
}

function check(f, target, frag) {
  if (!target || !target.startsWith('/')) return; // external/relative handled by validate-built
  if (target.startsWith('/lab')) target = target.slice(4); // strip baseurl prefix
  const u = normUrl(target.split('?')[0]);
  if (!urlSet.has(u)) {
    // category index /danh-muc/ and archive pages are directory indexes
    errors.push(`BROKEN ${target} :: in ${f.path}`);
    return;
  }
  if (frag) {
    const id = frag.slice(1).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9-]/g, '');
    const heads = fragSource.get(u) || [];
    if (id && !heads.includes(id)) errors.push(`${f.path}: fragment "${frag}" not found in ${u}`);
  }
}

// /danh-muc/ index and any trailing-slash variants of known URLs are fine:
for (const p of pages) if (p.url) urlSet.add(p.url);
const danhMucIdx = [...pages].find(p => p.url === '/danh-muc/');
if (danhMucIdx) urlSet.add('/danh-muc/');

try { writeReport(ROOT, 'link-errors.json', { count: errors.length, errors }); } catch {}
fail(errors, 'check-links');
console.log(`check-links: OK (${files.length} files scanned, ${urlSet.size} known URLs)`);
