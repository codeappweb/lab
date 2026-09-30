#!/usr/bin/env node
// detect-duplicates.mjs — duplicate gate for data/article-manifest.jsonl.
// Audit fix 2026-09-29: the previous O(n^2) pairwise scan over all active
// records does not scale to the 20k-article target. Candidate pairs are now
// generated from an inverted token index (only records sharing at least one
// token are compared), with IDENTICAL detection semantics:
//   - exact duplicate slug (any status)
//   - exact duplicate primary_topic (lowercased, any status)
//   - token Jaccard similarity >= 0.8 within the same search_intent
// A high-similarity pair is still a hard error, never auto-merged.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
const ROOT = new URL('..', import.meta.url).pathname;
// Explicit manifest path (positional arg; used by benchmark-scale.mjs so a
// benchmark can never read the production manifest by accident — issue #7).
// Default: repository truth.
const argPath = process.argv.slice(2).find(a => !a.startsWith('--'));
const manifestPath = argPath ? resolve(argPath) : ROOT + 'data/article-manifest.jsonl';
const recs = readFileSync(manifestPath, 'utf8').split('\n').filter(Boolean).map(JSON.parse);
const errs = [];
const bySlug = {}, byTitle = {};
for (const r of recs) {
  (bySlug[r.slug] ||= []).push(r.id);
  (byTitle[(r.primary_topic || '').toLowerCase()] ||= []).push(r.id);
}
for (const [s, ids] of Object.entries(bySlug)) if (ids.length > 1) errs.push(`duplicate slug "${s}": ${ids.join(', ')}`);
for (const [t, ids] of Object.entries(byTitle)) if (ids.length > 1) errs.push(`duplicate topic "${t}": ${ids.join(', ')}`);

const tok = s => (s || '').toLowerCase().split(/[\s,.:;?!()\/-]+/).filter(w => w.length > 2);
const active = recs.filter(r => !['merge','skip'].includes(r.status));
const tokens = active.map(r => new Set(tok(r.primary_topic)));

// inverted index: token -> record indices that contain it
const byToken = new Map();
active.forEach((r, i) => {
  for (const t of tokens[i]) {
    if (!byToken.has(t)) byToken.set(t, []);
    byToken.get(t).push(i);
  }
});

const seenPair = new Set();
let compared = 0;
for (const [, list] of byToken) {
  for (let a = 0; a < list.length; a++) {
    for (let b = a + 1; b < list.length; b++) {
      const i = Math.min(list[a], list[b]), j = Math.max(list[a], list[b]);
      const key = i + ':' + j;
  
    if (seenPair.has(key)) continue;
      seenPair.add(key);
      compared++;
      const A = tokens[i], B = tokens[j];
      let inter = 0;
      for (const w of A) if (B.has(w)) inter++;
      const sim = inter / (A.size + B.size - inter); // Jaccard == old union formula
      if (sim >= 0.8 && active[i].search_intent === active[j].search_intent) {
        errs.push(`HIGH SIMILARITY (${sim.toFixed(2)}) ${active[i].id} vs ${active[j].id}`);
      }
    }
  }
}

if (errs.length) { console.error(errs.join('\n')); process.exit(1); }
console.log(`checked ${active.length} active records (${compared} candidate pairs via inverted index), no duplicates`);
