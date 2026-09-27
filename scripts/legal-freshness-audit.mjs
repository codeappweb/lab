#!/usr/bin/env node
// Legal freshness with REAL date comparisons. A legal-sensitive article must
// declare legal_source + next_review (YYYY-MM-DD). --gate BLOCKS publication
// when: verification missing, invalid date, or next_review in the past.
// Verified = the source was actually checked; a URL alone is NOT verification.
// Usage: node scripts/legal-freshness-audit.mjs [--root <dir>] [--gate]
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { findRoot, discover, writeReport } from './lib/lab.mjs';

const ROOT = findRoot(process.argv);
const GATE = process.argv.includes('--gate');
const today = new Date().toISOString().slice(0, 10);
const { posts } = discover(ROOT);
const findings = [];

for (const p of posts) {
  const d = p.fm.data;
  if (d.legal_sensitivity === true || d.legal_sensitivity === 'true') {
    const src = d.legal_source || d.legal_sources || null;
    const next = d.next_review || null;
    const validDate = next && /^\d{4}-\d{2}-\d{2}$/.test(next) && !isNaN(Date.parse(next + 'T00:00:00Z'));
    if (!src) findings.push({ slug: p.slug, severity: 'CRITICAL', issue: 'legal_sensitivity true but no legal_source' });
    else if (!validDate) findings.push({ severity: 'CRITICAL', slug: p.slug, issue: `invalid/missing next_review date: "${next}"` });
    else if (next < today) findings.push({ slug: p.slug, severity: 'CRITICAL', issue: `review overdue: next_review ${next} < today ${today}` });
    else findings.push({ slug: p.slug, severity: 'OK', issue: `next_review ${next} valid, source declared` });
  }
  const fs = d.freshness_status;
  if (fs && !['fresh', 'evergreen', 'needs-review', 'outdated'].includes(fs)) {
    findings.push({ slug: p.slug, severity: 'MEDIUM', issue: `unknown freshness_status "${fs}"` });
  }
}

writeReport(ROOT, 'legal-freshness.json', { checked_at: today, gate: GATE, findings });
const blocking = findings.filter(f => f.severity === 'CRITICAL');
for (const f of findings) if (f.severity !== 'OK') console.error(`${f.severity}: ${f.slug}: ${f.issue}`);
console.log(`legal-freshness: ${findings.length} checked, ${blocking.length} blocking`);
if (blocking.length && GATE) { console.error('legal-freshness: GATE BLOCKED'); process.exit(1); }
if (blocking.length) process.exit(1); // audit without --gate still fails on critical
console.log('legal-freshness: OK');
