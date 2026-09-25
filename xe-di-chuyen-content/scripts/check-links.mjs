#!/usr/bin/env node
import { readFileSync, readdirSync, existsSync } from 'node:fs';
const ROOT = new URL('..', import.meta.url).pathname;
const recs = readFileSync(ROOT + 'data/article-manifest.jsonl', 'utf8').split('\n').filter(Boolean).map(JSON.parse);
const slugs = new Set(recs.map(r => r.slug));
const files = existsSync(ROOT + '_posts') ? readdirSync(ROOT + '_posts').filter(f => f.endsWith('.md')) : [];
const errs = [];
for (const f of files) {
  const md = readFileSync(ROOT + '_posts/' + f, 'utf8');
  for (const m of md.matchAll(/\]\((\/[^)#\s]+)\)/g)) {
    const target = m[1];
    if (target.startsWith('/hub/')) continue;
    const t = target.replace(/^\//, '').replace(/\/$/, '').split('/').pop();
    if (!slugs.has(t)) errs.push(`${f}: link target "${target}" not found in manifest`);
  }
}
if (errs.length) { console.error(errs.join('\n')); process.exit(1); }
console.log('link check OK');
