#!/usr/bin/env node
// legal-freshness-audit.mjs — legal sensitivity / freshness audit.
// Articles flagged legal_sensitivity: true must declare verified_source,
// last_verified, next_review, verification_status (or needs_legal_review: true).
// Never fabricates or rewrites legal content — only flags for review.
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const postsDir = join(ROOT, '_posts');
const entries = [];
const violations = [];

function fm(text) {
  if (!text.startsWith('---')) return {};
  const end = text.indexOf('\n---', 3);
  if (end === -1) return {};
  const raw = text.slice(3, end);
  const o = {};
  for (const line of raw.split('\n')) {
    const m = line.match(/^([a-z_]+):\s*"?([^"\n]*)"?\s*$/);
    if (m) o[m[1]] = m[2];
  }
  return o;
}

if (existsSync(postsDir)) {
  for (const f of readdirSync(postsDir).filter(f => f.endsWith('.md'))) {
    const o = fm(readFileSync(join(postsDir, f), 'utf8'));
    const e = {
      id: o.id || null,
      slug: f.replace(/^\d{4}-\d{2}-\d{2}-/, '').replace(/\.md$/, ''),
      legal_sensitivity: o.legal_sensitivity === 'true',
      freshness_status: o.freshness_status || null,
      verified_source: o.verified_source || null,
      last_verified: o.last_verified || null,
      next_review: o.next_review || null,
      verification_status: o.verification_status || null,
      needs_legal_review: o.needs_legal_review === 'true'
    };
    entries.push(e);
    if (e.legal_sensitivity) {
      const complete = e.verified_source && e.last_verified && e.next_review &&
        (e.verification_status || e.needs_legal_review);
      if (!complete) violations.push(e.slug + ': legal_sensitivity=true but missing freshness fields');
      if (e.needs_legal_review) violations.push(e.slug + ': NEEDS LEGAL REVIEW (no authoritative verification)');
    }
  }
}

const report = { entries, violations, needs_legal_review: entries.filter(e => e.needs_legal_review).map(e => e.slug) };
const fs = await import('node:fs');
fs.mkdirSync(join(ROOT, 'reports'), { recursive: true });
fs.writeFileSync(join(ROOT, 'reports/legal-freshness.json'), JSON.stringify(report, null, 2) + '\n');
console.log('legal-freshness: ' + entries.length + ' articles, ' + entries.filter(e => e.legal_sensitivity).length + ' legal-sensitive, ' + violations.length + ' violation(s)');
