#!/usr/bin/env node
// validate-deploy.mjs — pre-deploy orchestrator.
// Runs every gate in order; fails fast on CRITICAL errors.
// Repair 2026-09-29: a MISSING validator is now a hard failure (previously
// it was silently skipped, so a gate could disappear without notice).
// Usage: node scripts/validate-deploy.mjs
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const steps = [
  ['content quality', 'scripts/validate-content-quality.mjs'],
  ['duplicate detection', 'scripts/detect-duplicates.mjs'],
  ['internal links', 'scripts/check-links.mjs'],
  ['sitemap validation', 'scripts/validate-sitemap.mjs'],
  ['self-heal audit', 'scripts/self-heal-audit.mjs'],
  ['legal freshness', 'scripts/legal-freshness-audit.mjs'],
  ['seo scoring', 'scripts/seo-score.mjs'],
  ['content hashes', 'scripts/compute-content-hashes.mjs']
];

let failed = 0;
for (const [name, script] of steps) {
  if (!existsSync(join(ROOT, script))) {
    console.error('MISSING GATE: ' + name + ' (' + script + ' not found) — required validator must exist and run');
    process.exit(1);
  }
  console.log('');
  console.log('=== ' + name + ' ===');
  const r = spawnSync('node', [join(ROOT, script)], { stdio: 'inherit', cwd: ROOT });
  if (r.status !== 0) { console.error('GATE FAILED: ' + name); failed = 1; break; }
}
if (failed) { console.error(''); console.error('validate-deploy: FAILED — DO NOT PUSH/DEPLOY.'); process.exit(1); }
console.log('');
console.log('validate-deploy: all gates green.');
