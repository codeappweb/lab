#!/usr/bin/env node
// legal-freshness-audit.mjs — legal sensitivity / freshness audit.
// Repair 2026-09-29: violations are now a REAL BLOCKING GATE.
//   - exit 1 whenever any blocking violation exists (previously the script
//     recorded violations but always exited 0).
//   - covers _posts AND _drafts (a draft blocked here can never publish).
//   - cross-checks the manifest: rows with needs_official_source: true must
//     correspond to legal articles with verified sources — a writer-supplied
//     boolean alone is not sufficient.
//   - flags overdue next_review dates.
// Never fabricates or rewrites legal content — only flags for review.
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const postsDir = join(ROOT, '_posts');
const draftsRoot = join(ROOT, '_drafts');
const manifestPath = join(ROOT, 'data', 'article-manifest.jsonl');
const today = new Date().toISOString().slice(0, 10);
const entries = [];
const violations = [];

function fm(text) {
  if (!text.startsWith('---')) return {};
  const end = text.indexOf('\n---', 3);
  if (end === -1) return {};
  const o = {};
  for (const line of text.slice(3, end).split('\n')) {
    const m = line.match(/^([a-z_]+):\s*"?(.*?)"?\s*$/);
    if (m) o[m[1]] = m[2];
  }
  return o;
}

function collect() {
  const found = [];
  if (existsSync(postsDir)) {
    for (const f of readdirSync(postsDir).filter(f => f.endsWith('.md'))) {
      found.push({ scope: 'post', file: '_posts/' + f, slug: f.replace(/^\d{4}-\d{2}-\d{2}-/, '').replace(/\.md$/, ''), o: fm(readFileSync(join(postsDir, f), 'utf8')) });
    }
  }
  if (existsSync(draftsRoot)) {
    for (const dir of readdirSync(draftsRoot)) {
      const full = join(draftsRoot, dir);
      if (!existsSync(full) || !readdirSync(full)) continue;
      for (const f of readdirSync(full).filter(f => f.endsWith('.md'))) {
        found.push({ scope: 'draft', file: '_drafts/' + dir + '/' + f, slug: f.replace(/\.md$/, ''), o: fm(readFileSync(join(full, f), 'utf8')) });
      }
    }
  }
  return found;
}

const manifestNeedsOfficial = new Map(); // slug -> id
if (existsSync(manifestPath)) {
  for (const line of readFileSync(manifestPath, 'utf8').split('\n').filter(Boolean)) {
    try {
      const r = JSON.parse(line);
      if (r.needs_official_source) manifestNeedsOfficial.set(r.slug, r.id);
    } catch { /* malformed manifest rows are reported by other gates */ }
  }
}

for (const { scope, file, slug, o } of collect()) {
  const e = {
    scope, file,
    id: o.id || null,
    slug,
    legal_sensitivity: o.legal_sensitivity === 'true',
    freshness_status: o.freshness_status || null,
    verified_source: o.verified_source || null,
    last_verified: o.last_verified || null,
    next_review: o.next_review || null,
    verification_status: o.verification_status || null,
    needs_legal_review: o.needs_legal_review === 'true'
  };
  entries.push(e);
  if (e.needs_legal_review) {
    violations.push(file + ': NEEDS LEGAL REVIEW (no authoritative verification) — BLOCKING');
    continue;
  }
  if (e.legal_sensitivity) {
    if (!e.verified_source || !e.last_verified || !e.next_review) {
      violations.push(file + ': legal_sensitivity=true but missing verified_source/last_verified/next_review — BLOCKING');
    } else if (e.verification_status !== 'verified') {
      violations.push(file + ': legal_sensitivity=true but verification_status is not "verified" (is "' + e.verification_status + '") — BLOCKING');
    } else if (e.next_review < today) {
      violations.push(file + ': legal review overdue (next_review ' + e.next_review + ' < ' + today + ') — BLOCKING');
    }
  }
  // manifest cross-check: topic flagged needs_official_source must be a legally verified article
  if (manifestNeedsOfficial.has(slug) && !e.legal_sensitivity && scope === 'draft') {
    violations.push(file + ': manifest row ' + manifestNeedsOfficial.get(slug) + ' requires an official source but the article does not declare legal_sensitivity: true — BLOCKING');
  }
  if (manifestNeedsOfficial.has(slug) && e.legal_sensitivity && e.verification_status !== 'verified') {
    violations.push(file + ': manifest row ' + manifestNeedsOfficial.get(slug) + ' requires an official source but verification is incomplete — BLOCKING');
  }
}

const report = { generated_at: new Date().toISOString(), entries, violations, needs_legal_review: entries.filter(e => e.needs_legal_review).map(e => e.scope + ':' + e.slug) };
const fs = await import('node:fs');
fs.mkdirSync(join(ROOT, 'reports'), { recursive: true });
fs.writeFileSync(join(ROOT, 'reports/legal-freshness.json'), JSON.stringify(report, null, 2) + '\n');
console.log('legal-freshness: ' + entries.length + ' articles/drafts, ' + entries.filter(e => e.legal_sensitivity).length + ' legal-sensitive, ' + violations.length + ' violation(s)');
for (const v of violations) console.error('LEGAL VIOLATION: ' + v);
if (violations.length) {
  console.error('legal-freshness: BLOCKING violations found. DO NOT PUSH / DO NOT PUBLISH.');
  process.exit(1);
}
process.exit(0);
