#!/usr/bin/env node
// Reconcile _posts <-> data/article-manifest.jsonl and DERIVE progress.json
// counts from actual state. Runs in CI where the checkout is exact.
//   - published post not in manifest -> create a record (after intent-dup
//     check against existing manifest entries; conflicts -> report + exit 2)
//   - manifest entry whose slug is now a published post -> status published
//   - invalid transitions (published -> planned) -> error
// --dry-run: print the plan, write nothing.
// NEVER edit this file's inputs by hand-mangled fetches; CI checkout is truth.
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { findRoot, discover, isExcluded, writeReport } from './lib/lab.mjs';

const ROOT = findRoot(process.argv);
const DRY = process.argv.includes('--dry-run');
const manifestFile = join(ROOT, 'data/article-manifest.jsonl');
const { posts } = discover(ROOT);
const published = new Map();
for (const p of posts) {
  if (isExcluded(p.fm.data)) continue;
  published.set(p.slug, p);
}

const entries = [];
if (existsSync(manifestFile)) {
  for (const l of readFileSync(manifestFile, 'utf8').split('\n').filter(Boolean)) {
    entries.push(JSON.parse(l)); // invalid JSON throws: this is a hard failure
  }
}
const bySlug = new Map();
const errors = [];
for (const e of entries) {
  if (bySlug.has(e.slug)) errors.push(`duplicate slug in manifest: ${e.slug} (${e.id}, ${bySlug.get(e.slug).id})`);
  bySlug.set(e.slug, e);
}
const VALID_STATUS = new Set(['planned', 'researching', 'drafting', 'validating', 'ready', 'publishing', 'published', 'blocked', 'failed']);

function tokenOverlap(a, b) {
  const S = s => new Set(String(s).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').split(/[^a-z0-9]+/).filter(w => w.length > 2));
  const A = S(a), B = S(b);
  if (!A.size || !B.size) return 0;
  let n = 0; for (const w of A) if (B.has(w)) n++;
  return n / Math.min(A.size, B.size);
}

const created = [], updated = [], conflicts = [];
let nextIdByCluster = {};
for (const e of entries) {
  if (e.status === 'published' && !published.has(e.slug)) {
    errors.push(`manifest says published but no post on disk: ${e.slug} (${e.id})`);
  }
  if (!VALID_STATUS.has(e.status)) errors.push(`invalid status "${e.status}" on ${e.id}`);
}
for (const [slug, p] of published) {
  const e = bySlug.get(slug);
  if (!e) {
    // intent-duplicate guard before creating
    const dup = entries.find(x => x.slug !== slug && tokenOverlap((x.title || '') + ' ' + (x.primary_topic || ''), (p.fm.data.title || '') + ' ' + (p.fm.data.title || '')) >= 0.7);
    if (dup) { conflicts.push({ slug, conflicts_with: dup.id, reason: 'intent similarity >= 0.7' }); continue; }
    const cluster = p.fm.data.cluster || 'C05';
    nextIdByCluster[cluster] = nextIdByCluster[cluster] || 0;
    const id = cluster + '-' + String(++nextIdByCluster[cluster]).padStart(4, '0');
    created.push({
      id, cluster, slug, status: 'published',
      primary_topic: p.fm.data.primary_keyword || p.fm.data.title || slug,
      search_intent: p.fm.data.search_intent || 'informational',
      title: p.fm.data.title || slug,
      published_at: p.date,
      parent_hub: p.fm.data.parent_category || null,
      source_plan: 'sync-manifest (reconciled from published post)',
      reconciled: true
    });
  } else if (e.status !== 'published') {
    if (['planned', 'researching', 'drafting', 'validating', 'ready', 'publishing'].includes(e.status)) {
      updated.push({ id: e.id, slug, from: e.status, to: 'published' });
      e.status = 'published';
    } else {
      errors.push(`invalid transition for ${e.id} (${e.status} -> published)`);
    }
  }
}
// choose ids that don't collide with existing
const usedIds = new Set(entries.map(e => e.id));
for (const c of created) {
  while (usedIds.has(c.id)) c.id = c.cluster + '-' + String(++nextIdByCluster[c.cluster]).padStart(4, '0');
  usedIds.add(c.id);
}

writeReport(ROOT, 'manifest-conflicts.json', { generated_at: new Date().toISOString(), conflicts });
if (conflicts.length) {
  for (const c of conflicts) console.error(`CONFLICT: ${c.slug} vs ${c.conflicts_with}: ${c.reason}`);
}

// derive progress counts from ACTUAL state
const planned = entries.filter(e => e.status === 'planned').length;
const progress = {
  last_updated: new Date().toISOString().slice(0, 10),
  derived_from: 'actual _posts + manifest (sync-manifest.mjs)',
  articles: {
    planned, published: published.size,
    by_manifest_status: entries.reduce((m, e) => { m[e.status] = (m[e.status] || 0) + 1; return m; }, {})
  },
  changes: { created: created.map(c => c.id), updated: updated.map(u => u.id) }
};

if (DRY) {
  console.log(`sync-manifest (dry-run): would create ${created.length}, update ${updated.length}, conflicts ${conflicts.length}`);
  console.log(JSON.stringify(progress, null, 2));
} else {
  const out = [...entries, ...created].map(e => JSON.stringify(e)).join('\n') + '\n';
  writeFileSync(manifestFile, out);
  writeFileSync(join(ROOT, 'data/progress.json'), JSON.stringify(progress, null, 2) + '\n');
  console.log(`sync-manifest: created ${created.length}, updated ${updated.length}, conflicts ${conflicts.length}, published=${published.size}, planned=${planned}`);
}
if (errors.length) { for (const e of errors) console.error('FAIL: ' + e); process.exit(1); }
if (conflicts.length) process.exit(2);
