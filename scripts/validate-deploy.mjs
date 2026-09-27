#!/usr/bin/env node
// validate-deploy.mjs — pre-deploy orchestrator. Runs every gate in order and
// fails fast. Missing required scripts are a FAILURE, not a skip.
// Usage: node scripts/validate-deploy.mjs [--root <dir>]
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { findRoot } from './lib/lab.mjs';

const ROOT = findRoot(process.argv);
const steps = [
  ['content quality', 'scripts/validate-content-quality.mjs'],
  ['manifest duplicates', 'scripts/detect-duplicates.mjs'],
  ['internal links', 'scripts/check-links.mjs'],
  ['sitemap generation', 'scripts/gen-sitemap-shards.mjs'],
  ['sitemap validation', 'scripts/validate-sitemap.mjs'],
  ['self-heal audit', 'scripts/self-heal-audit.mjs'],
  ['navigation consistency', 'scripts/validate-navigation.mjs'],
  ['legal freshness', 'scripts/legal-freshness-audit.mjs'],
  ['seo scoring', 'scripts/seo-score.mjs'],
  ['content hashes', 'scripts/compute-content-hashes.mjs'],
  ['topic queue', 'scripts/gen-topic-queue.mjs'],
  ['dashboard', 'scripts/gen-dashboard.mjs']
];

let failed = 0;
for (const [name, script] of steps) {
  const p = join(ROOT, script);
  if (!existsSync(p)) { console.error(`GATE MISSING: ${name} (${script})`); failed = 1; break; }
  console.log(`\n=== ${name} ===`);
  const r = spawnSync('node', [p, ...process.argv.slice(2)], { stdio: 'inherit', cwd: ROOT });
  if (r.status !== 0) { console.error(`GATE FAILED: ${name}`); failed = 1; break; }
}
if (failed) { console.error('\nvalidate-deploy: FAILED — DO NOT PUSH/DEPLOY.'); process.exit(1); }
console.log('\nvalidate-deploy: all gates green.');
process.exit(0);
