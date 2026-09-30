#!/usr/bin/env node
// detect-duplicates.mjs — duplicate gate cho data/article-manifest.jsonl.
// QA nhẹ:
//   BLOCKING : trùng slug, trùng primary_topic (exact, mọi trạng thái)
//   WARNING  : token Jaccard similarity >= 0.8 (cảnh báo cannibalization,
//              cần người đọc đánh giá — KHÔNG chặn publish)
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
const ROOT = new URL('..', import.meta.url).pathname;
const argPath = process.argv.slice(2).find(a => !a.startsWith('--'));
const manifestPath = argPath ? resolve(argPath) : ROOT + 'data/article-manifest.jsonl';
const recs = readFileSync(manifestPath, 'utf8').split('\n').filter(Boolean).map(JSON.parse);
const errs = [], warns = [];
const bySlug = {}, byTitle = {};
for (const r of recs) {
  (bySlug[r.slug] ||= []).push(r.id);
  (byTitle[(r.primary_topic || '').toLowerCase()] ||= []).push(r.id);
}
for (const [s, ids] of Object.entries(bySlug)) if (ids.length > 1) errs.push(`duplicate slug "${s}": ${ids.join(', ')}`);
for (const [t, ids] of Object.entries(byTitle)) if (ids.length > 1) errs.push(`duplicate topic "${t}": ${ids.join(', ')}`);

const tok = s => (s || '').toLowerCase().split(/[\s,.:;?!()/\-]+/).filter(w => w.length > 2);
const active = recs.filter(r => r.status !== 'skip');
const tokens = active.map(r => new Set(tok(r.primary_topic)));

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
      const sim = inter / (A.size + B.size - inter);
      if (sim >= 0.8 && active[i].search_intent === active[j].search_intent) {
        warns.push(`HIGH SIMILARITY (${sim.toFixed(2)}) ${active[i].id} vs ${active[j].id} — cảnh báo cannibalization, người đọc đánh giá`);
      }
    }
  }
}

for (const w of warns) console.log('WARN: ' + w);
if (errs.length) { console.error(errs.join('\n')); process.exit(1); }
console.log(`checked ${active.length} active records (${compared} candidate pairs), ${errs.length} duplicate, ${warns.length} similarity warning(s)`);
