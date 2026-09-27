#!/usr/bin/env node
// Scalable near-duplicate detection: shingling + LSH-style banding so only
// band-colliding pairs are compared (no all-pairs scan). Sources: manifest
// entries + published posts. Nonzero exit on high-similarity pairs.
// Usage: node scripts/detect-duplicates.mjs [--root <dir>]
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { findRoot, discover, writeReport } from './lib/lab.mjs';

const ROOT = findRoot(process.argv);
const items = [];
const manifest = join(ROOT, 'data/article-manifest.jsonl');
if (existsSync(manifest)) {
  for (const l of readFileSync(manifest, 'utf8').split('\n').filter(Boolean)) {
    try {
      const r = JSON.parse(l);
      items.push({ id: r.id || r.slug, slug: r.slug, text: (r.title || '') + ' ' + (r.primary_topic || '') + ' ' + (r.search_intent || '') });
    } catch { /* skip */ }
  }
}
for (const p of discover(ROOT).posts) {
  items.push({ id: p.path, slug: p.slug, text: (p.fm.data.title || '') + ' ' + (p.fm.body || '').slice(0, 2000) });
}

function normTokens(s) {
  return String(s).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd').replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(w => w.length > 2);
}
function shingles(tokens, k = 3) {
  const out = new Set();
  for (let i = 0; i + k <= tokens.length; i++) out.add(tokens.slice(i, i + k).join(' '));
  return out;
}
function hash(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
  return h;
}
const BANDS = 4, ROWS = 4; // 16 shingles signature
const sigs = items.map(it => {
  const sh = shingles(normTokens(it.text));
  const sig = [];
  for (let b = 0; b < BANDS * ROWS; b++) {
    let min = Infinity;
    for (const s of sh) min = Math.min(min, hash(b + ':' + s));
    sig.push(min === Infinity ? 0 : min);
  }
  return { ...it, sig, sh };
});

// banding: only items sharing a full band get compared
const bandMap = new Map();
sigs.forEach((it, idx) => {
  for (let b = 0; b < BANDS; b++) {
    const key = b + ':' + it.sig.slice(b * ROWS, (b + 1) * ROWS).join(',');
    if (!bandMap.has(key)) bandMap.set(key, []);
    bandMap.get(key).push(idx);
  }
});
const candidates = new Set();
for (const group of bandMap.values()) {
  for (let i = 0; i < group.length; i++) for (let j = i + 1; j < group.length; j++) {
    const a = Math.min(group[i], group[j]), b = Math.max(group[i], group[j]);
    candidates.add(a + ':' + b);
  }
}
const dupes = [];
for (const key of candidates) {
  const [i, j] = key.split(':').map(Number);
  const A = sigs[i].sh, B = sigs[j].sh;
  if (!A.size || !B.size) continue;
  let inter = 0; for (const s of A) if (B.has(s)) inter++;
  const jac = inter / (A.size + B.size - inter);
  if (jac >= 0.6) dupes.push({ a: sigs[i].id, b: sigs[j].id, similarity: Math.round(jac * 100) / 100 });
}
writeReport(ROOT, 'duplicates.json', { checked_pairs: candidates.size, duplicates: dupes, generated_at: new Date().toISOString() });
if (dupes.length) {
  for (const d of dupes) console.error(`FAIL: near-duplicate ${d.similarity}: ${d.a} <-> ${d.b}`);
  console.error('detect-duplicates: ' + dupes.length + ' near-duplicate pair(s)');
  process.exit(1);
}
console.log('detect-duplicates: OK (' + items.length + ' items, ' + candidates.size + ' candidate pairs compared)');
