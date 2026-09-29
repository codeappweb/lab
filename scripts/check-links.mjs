#!/usr/bin/env node
// check-links.mjs — internal link integrity for posts.
// Repair 2026-09-29: link targets are validated against the manifest AND
// the actual posts on disk (previously only manifest slugs were accepted,
// so a valid link to an unmapped post was a false positive).
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
const ROOT = new URL('..', import.meta.url).pathname;
const recs = readFileSync(ROOT + 'data/article-manifest.jsonl', 'utf8').split('\n').filter(Boolean).map(JSON.parse);
const slugs = new Set(recs.map(r => r.slug));
// posts on disk are always valid targets (repository truth wins over manifest)
if (existsSync(ROOT + '_posts')) {
  for (const f of readdirSync(ROOT + '_posts').filter(f => f.endsWith('.md'))) {
    slugs.add(f.replace(/^\d{4}-\d{2}-\d{2}-/, '').replace(/\.md$/, ''));
  }
}
// category and static pages are valid targets
const STATIC = new Set(['danh-muc', 'gioi-thieu', 'lien-he', 'faq', 'dich-vu', 'bao-mat', 'dieu-khoan']);
const files = existsSync(ROOT + '_posts') ? readdirSync(ROOT + '_posts').filter(f => f.endsWith('.md')) : [];
const errs = [];
for (const f of files) {
  const md = readFileSync(ROOT + '_posts/' + f, 'utf8');
  for (const m of md.matchAll(/\]\((\/[^)#\s]+)\)/g)) {
    const target = m[1].replace(/^\/lab(?=\/)/, '');
    if (target.startsWith('/hub/')) continue;
    const parts = target.replace(/^\//, '').replace(/\/$/, '').split('/');
    const leaf = parts[parts.length - 1];
    const isStatic = parts.length === 1 && STATIC.has(leaf);
    const isCategory = parts.length === 2 && parts[0] === 'danh-muc';
    if (!slugs.has(leaf) && !isStatic && !isCategory) errs.push(f + ': link target "' + target + '" not found in manifest or posts');
  }
}
if (errs.length) { console.error(errs.join('\n')); process.exit(1); }
console.log('link check OK (' + files.length + ' posts checked)');
