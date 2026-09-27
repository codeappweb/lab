#!/usr/bin/env node
// Legal freshness + VERIFICATION gate. A legal-sensitive article must present
// a CONSISTENT, actually-verified legal record before it may be published:
//
//   verified_source (or legacy legal_source)  — the checked source URL
//   last_verified   YYYY-MM-DD               — when the source was checked
//   next_review     YYYY-MM-DD               — when it must be re-checked
//   verification_status: verified            — the ONLY passing status
//
// Blocking rules (--gate and audit both fail on CRITICAL):
//   - verification_status missing or != "verified"           -> CRITICAL
//   - needs_legal_review: true (unresolved review)           -> CRITICAL
//   - verification_status "verified" AND needs_legal_review
//     true (contradictory declaration)                        -> CRITICAL
//   - last_verified missing / invalid / in the future        -> CRITICAL
//   - next_review missing / invalid calendar date            -> CRITICAL
//   - next_review in the past (overdue)                      -> CRITICAL
//   - next_review earlier than last_verified                 -> CRITICAL
//   - declared source not registered in data/legal-sources.yml
//     (when the registry exists)                              -> CRITICAL
//     A URL the author merely typed is NOT source-checking evidence; a
//     registry entry (source_title, publisher, fact, last_verified) is.
//   - legacy `legal_source` field without `verified_source`   -> MEDIUM
//     (explicit migration note, never a silent pass-through)
//
// No date is ever updated and no check is ever fabricated here: the gate only
// READS declared evidence and fails closed.
// Usage: node scripts/legal-freshness-audit.mjs [--root <dir>] [--gate]
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { findRoot, discover, writeReport } from './lib/lab.mjs';

const ROOT = findRoot(process.argv);
const GATE = process.argv.includes('--gate');
const today = new Date().toISOString().slice(0, 10);
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const validDate = s => Boolean(s) && DATE_RE.test(s) && !isNaN(Date.parse(s + 'T00:00:00Z'));

// Minimal reader for the flat sources list in data/legal-sources.yml.
// Returns [{ source_url, last_verified }] or null when the registry is absent.
function readSourceRegistry() {
  const file = join(ROOT, 'data', 'legal-sources.yml');
  if (!existsSync(file)) return null;
  const entries = [];
  let cur = null;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const m = /^  - (.+)$/.exec(line);
    if (m) { if (cur) entries.push(cur); cur = {}; continue; }
    if (!cur) continue;
    const kv = /^    ([a-z_]+): (.*)$/.exec(line);
    if (kv) cur[kv[1]] = kv[2].replace(/^["']|["'],?$/g, '').trim();
  }
  if (cur) entries.push(cur);
  return entries.filter(e => e.source_url);
}
const registry = readSourceRegistry();
const normUrl = u => String(u || '').replace(/\/+$/, '').toLowerCase();
const registeredUrls = new Set((registry || []).map(e => normUrl(e.source_url)));
const registryVerified = new Map((registry || []).map(e => [normUrl(e.source_url), e.last_verified || null]));

const { posts } = discover(ROOT);
const findings = [];

for (const p of posts) {
  const d = p.fm.data;
  if (d.legal_sensitivity === true || d.legal_sensitivity === 'true') {
    const push = (severity, issue) => findings.push({ slug: p.slug, severity, issue });

    // Accepted source field: new schema `verified_source`; legacy `legal_source`
    // still blocks correctly below, but is flagged for explicit migration.
    const source = d.verified_source || d.legal_source || d.legal_sources || null;
    const lastVerified = d.last_verified || null;
    const next = d.next_review || null;
    const status = d.verification_status || null;
    const needsReview = d.needs_legal_review === true || d.needs_legal_review === 'true';

    if (!source) push('CRITICAL', 'legal_sensitivity true but no verified_source/legal_source declared');
    if (d.legal_source && !d.verified_source) push('MEDIUM', 'uses legacy field legal_source — migrate to verified_source per docs/SCHEMA-ARTICLE.md');

    // Verification STATUS is the core fact: only an explicit "verified" passes.
    if (!status) push('CRITICAL', 'verification_status missing — a URL and a future date do not establish verification');
    else if (status !== 'verified') push('CRITICAL', `verification_status "${status}" is not "verified" — unverified legal content cannot be published`);
    if (needsReview) push('CRITICAL', 'needs_legal_review: true — legal review is still outstanding');
    if (status === 'verified' && needsReview) push('CRITICAL', 'contradictory verification: status "verified" but needs_legal_review true');

    // last_verified: when the source was ACTUALLY checked.
    if (!lastVerified) push('CRITICAL', 'last_verified missing — no record of when the source was checked');
    else if (!validDate(lastVerified)) push('CRITICAL', `invalid last_verified date "${lastVerified}"`);
    else if (lastVerified > today) push('CRITICAL', `last_verified ${lastVerified} is in the future — verification dates cannot be fabricated`);

    // next_review: must be a valid calendar date, after last_verified, not overdue.
    if (!next) push('CRITICAL', 'next_review missing');
    else if (!validDate(next)) push('CRITICAL', `invalid next_review date "${next}"`);
    else if (next < today) push('CRITICAL', `review overdue: next_review ${next} < today ${today}`);
    else if (validDate(lastVerified) && next < lastVerified) push('CRITICAL', `next_review ${next} is earlier than last_verified ${lastVerified} — inconsistent record`);

    // Source-checking evidence: the declared URL must be a REGISTERED,
    // checked source (data/legal-sources.yml carries publisher + fact +
    // last_verified). An author merely declaring a URL is not evidence.
    if (registry && source && !registeredUrls.has(normUrl(source))) {
      push('CRITICAL', `declared source "${source}" is not registered in data/legal-sources.yml — author declarations are not source-check evidence; register the checked source first`);
    }

    const blocked = findings.some(f => f.slug === p.slug && f.severity === 'CRITICAL');
    if (!blocked) {
      push('OK', `verified: status "verified", source declared${registry ? ' and registered' : ''}, last_verified ${lastVerified}, next_review ${next}`);
    }
  }
  const fs = d.freshness_status;
  if (fs && !['fresh', 'evergreen', 'needs-review', 'outdated', 'seasonal', 'time-sensitive'].includes(fs)) {
    findings.push({ slug: p.slug, severity: 'MEDIUM', issue: `unknown freshness_status "${fs}"` });
  }
}

writeReport(ROOT, 'legal-freshness.json', { checked_at: today, gate: GATE, registry_entries: registry ? registry.length : null, findings });
const blocking = findings.filter(f => f.severity === 'CRITICAL');
for (const f of findings) if (f.severity !== 'OK') console.error(`${f.severity}: ${f.slug}: ${f.issue}`);
console.log(`legal-freshness: ${findings.length} finding(s), ${blocking.length} blocking`);
if (blocking.length && GATE) { console.error('legal-freshness: GATE BLOCKED'); process.exit(1); }
if (blocking.length) process.exit(1);
console.log('legal-freshness: OK');
