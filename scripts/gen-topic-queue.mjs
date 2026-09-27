#!/usr/bin/env node
// Real approved queue view: manifest entries with status=planned that do not
// duplicate a published slug. Reports the TRUE queue size even when far below
// the 20,000 target. Writes data/topic-queue.json.
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { findRoot, discover, isExcluded } from './lib/lab.mjs';

const ROOT = findRoot(process.argv);
const { posts } = discover(ROOT);
const published = new Set(posts.filter(p => !isExcluded(p.fm.data)).map(p => p.slug));
const queue = [];
const seen = new Set();
if (existsSync(join(ROOT, 'data/article-manifest.jsonl'))) {
  for (const l of readFileSync(join(ROOT, 'data/article-manifest.jsonl'), 'utf8').split('\n').filter(Boolean)) {
    try {
      const e = JSON.parse(l);
      if (e.status !== 'planned') continue;
      if (published.has(e.slug) || seen.has(e.slug)) continue;
      seen.add(e.slug);
      queue.push({ id: e.id, slug: e.slug, cluster: e.cluster, title: e.title, intent: e.search_intent });
    } catch { /* skip */ }
  }
}
const fs = await import('node:fs');
fs.writeFileSync(join(ROOT, 'data/topic-queue.json'), JSON.stringify({
  generated_at: new Date().toISOString(),
  note: 'Approved topics only (manifest status=planned). Candidates awaiting approval live in data/topic-candidates.json.',
  approved_queue_size: queue.length, queue
}, null, 2) + '\n');
console.log(`gen-topic-queue: approved queue = ${queue.length} topics (real size, reported even when below target)`);
