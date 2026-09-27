#!/usr/bin/env node
// gen-topic-queue.mjs — builds data/topic-queue.json as a view over
// data/article-manifest.jsonl (topics not yet published). View only; the
// manifest remains the single source of truth.
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { readdirSync } from 'node:fs';

const ROOT = new URL('..', import.meta.url).pathname;
const manifestPath = join(ROOT, 'data/article-manifest.jsonl');
if (!existsSync(manifestPath)) { console.error('manifest not found'); process.exit(1); }

const published = new Set();
if (existsSync(join(ROOT, '_posts'))) {
  for (const f of readdirSync(join(ROOT, '_posts')).filter(f => f.endsWith('.md'))) {
    published.add(f.replace(/^\d{4}-\d{2}-\d{2}-/, '').replace(/\.md$/, ''));
  }
}

const recs = readFileSync(manifestPath, 'utf8').split('\n').filter(Boolean).map(JSON.parse);
const queue = recs
  .filter(r => !['published', 'merge', 'skip'].includes(r.status) && !published.has(r.slug))
  .map(r => ({ id: r.id, slug: r.slug, cluster: r.cluster, primary_topic: r.primary_topic, search_intent: r.search_intent, parent_hub: r.parent_hub, status: r.status }));

const fs = await import('node:fs');
fs.writeFileSync(join(ROOT, 'data/topic-queue.json'), JSON.stringify({
  generated_from: 'data/article-manifest.jsonl',
  open_topics: queue.length,
  queue
}, null, 2) + '\n');
console.log('topic-queue: ' + queue.length + ' open topics');
