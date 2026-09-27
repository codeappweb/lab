#!/usr/bin/env node
// Precompute derived site data so page rendering avoids O(N) scans per page:
//   data/related-posts.json    -> { "<slug>": { related:[card x3], prev, next } }
//   data/category-members.json -> { parents: {...}, children: {...} }
// Related selection: same child_category, then same parent, then same cluster;
// always <= 3, never self, never duplicates. Deterministic order.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findRoot, parseFM, postSlug, postUrl, postDate } from './lib/lab.mjs';

const ROOT = findRoot(process.argv, path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'));
const POSTS = path.join(ROOT, '_posts');

function card(p) {
  return {
    url: postUrl(p.file),
    title: p.fm.title || '',
    description: (p.fm.description || '').replace(/\s+/g, ' ').trim().slice(0, 160),
    cluster: p.fm.cluster || '',
    date: (p.fm.date || '').toString().slice(0, 10)
  };
}

const posts = fs.readdirSync(POSTS).filter(f => f.endsWith('.md')).map(f => {
  const fm = parseFM(fs.readFileSync(path.join(POSTS, f), 'utf8'));
  return { file: f, fm, slug: postSlug(f), date: postDate(f),
    parent: fm.parent_category || '', child: fm.child_category || '', cluster: fm.cluster || '' };
});

// taxonomy fallback for legacy posts without parent/child front matter
let tax = {};
for (const cand of ['article-taxonomy.json', 'article-taxonomy.yml']) {
  try { tax = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', cand), 'utf8')); break; } catch { /* next */ }
}
for (const p of posts) {
  const t = tax[p.slug];
  if (t) { p.parent = p.parent || t.parent || ''; p.child = p.child || t.child || ''; }
}

const related = {};
for (const p of posts) {
  const pool = posts.filter(x => x.slug !== p.slug);
  const inChild = new Set(pool.filter(x => x.parent && x.parent === p.parent && x.child === p.child && x.child).map(x => x.slug));
  const inParent = new Set(pool.filter(x => x.parent && x.parent === p.parent && !inChild.has(x.slug)).map(x => x.slug));
  const picked = [];
  for (const cand of pool) {
    if (picked.length >= 3) break;
    const pri = inChild.has(cand.slug) ? 0 : inParent.has(cand.slug) ? 1 : (cand.cluster && cand.cluster === p.cluster ? 2 : 9);
    if (pri === 9) continue;
    picked.push(cand);
  }
  related[p.slug] = { related: picked.map(card) };
}

const chrono = [...posts].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : (a.slug < b.slug ? -1 : 1)));
for (let i = 0; i < chrono.length; i++) {
  const slug = chrono[i].slug;
  if (!related[slug]) related[slug] = { related: [] };
  if (i > 0) related[slug].prev = card(chrono[i - 1]);
  if (i < chrono.length - 1) related[slug].next = card(chrono[i + 1]);
}

const members = { parents: {}, children: {} };
for (const p of posts) {
  if (!p.parent) continue;
  const c = card(p);
  (members.parents[p.parent] = members.parents[p.parent] || []).push(c);
  if (p.child) {
    const key = p.parent + '/' + p.child;
    (members.children[key] = members.children[key] || []).push(c);
  }
}

const outDir = path.join(ROOT, 'data');
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'related-posts.json'), JSON.stringify(related, null, 1) + '\n');
fs.writeFileSync(path.join(outDir, 'category-members.json'), JSON.stringify(members, null, 1) + '\n');
console.log('[gen-site-data] posts=' + posts.length + ' related=' + Object.keys(related).length +
  ' parents=' + Object.keys(members.parents).length + ' children=' + Object.keys(members.children).length);
