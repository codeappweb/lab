#!/usr/bin/env node
import { readFileSync } from 'node:fs';
const ROOT = new URL('..', import.meta.url).pathname;
const recs = readFileSync(ROOT + 'data/article-manifest.jsonl', 'utf8').split('\n').filter(Boolean).map(JSON.parse);
const errs = [];
const bySlug = {}, byTitle = {};
for (const r of recs) {
  (bySlug[r.slug] ||= []).push(r.id);
  (byTitle[(r.primary_topic || '').toLowerCase()] ||= []).push(r.id);
}
for (const [s, ids] of Object.entries(bySlug)) if (ids.length > 1) errs.push(`duplicate slug "${s}": ${ids.join(', ')}`);
for (const [t, ids] of Object.entries(byTitle)) if (ids.length > 1) errs.push(`duplicate topic "${t}": ${ids.join(', ')}`);
const tok = s => new Set((s || '').toLowerCase().split(/[\s,.:;?!()\/-]+/).filter(w => w.length > 2));
const active = recs.filter(r => !['merge','skip'].includes(r.status));
for (let i = 0; i < active.length; i++) for (let j = i + 1; j < active.length; j++) {
  const a = active[i], b = active[j];
  const A = tok(a.primary_topic), B = tok(b.primary_topic);
  const uni = new Set([...A, ...B]).size;
  const sim = uni ? [...A].filter(w => B.has(w)).length / uni : 0;
  if (sim >= 0.8 && a.search_intent === b.search_intent) errs.push(`HIGH SIMILARITY (${sim.toFixed(2)}) ${a.id} vs ${b.id}`);
}
if (errs.length) { console.error(errs.join('\n')); process.exit(1); }
console.log(`checked ${active.length} active records, no duplicates`);
