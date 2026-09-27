#!/usr/bin/env node
// selftest.mjs — offline validation of the validation suite itself.
// Runs the validators against synthetic fixture trees:
//   tests/fixtures/ok  — must PASS every gate run against it
//   tests/fixtures/bad — must FAIL (nonzero exit) each gate run against it
// Synthetic fixtures are NEVER real content and are excluded from site builds.
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const FIX = join(ROOT, 'tests/fixtures');

function run(script, root, expect, extra = []) {
  const r = spawnSync('node', [join(ROOT, 'scripts', script), '--root', root, ...extra], { encoding: 'utf8' });
  const pass = expect === 'pass' ? r.status === 0 : r.status !== 0;
  console.log(`${pass ? 'OK ' : 'BAD'} ${script} @ ${root.split('/').pop()} -> exit ${r.status} (expected ${expect})`);
  if (!pass) {
    // Always print full output of an unexpected result so CI annotations
    // contain the actual failure, not just the exit code.
    console.log('--- stdout ---\n' + (r.stdout || '(empty)'));
    console.log('--- stderr ---\n' + (r.stderr || '(empty)'));
  }
  return pass;
}

let failed = 0;
const checks = [
  ['validate-content-quality.mjs', 'ok', 'pass'],
  ['check-links.mjs', 'ok', 'pass'],
  ['gen-sitemap-shards.mjs', 'ok', 'pass'],
  ['validate-sitemap.mjs', 'ok', 'pass'],
  ['self-heal-audit.mjs', 'ok', 'pass'],
  ['legal-freshness-audit.mjs', 'ok', 'pass'],
  ['seo-score.mjs', 'ok', 'pass'],
  ['detect-duplicates.mjs', 'ok', 'pass'],
  ['validate-content-quality.mjs', 'bad', 'fail'],
  ['check-links.mjs', 'bad', 'fail'],
  ['validate-sitemap.mjs', 'bad', 'fail'],
  ['self-heal-audit.mjs', 'bad', 'fail'],
  ['legal-freshness-audit.mjs', 'bad', 'fail'],
];
for (const [script, tree, expect] of checks) {
  if (!run(script, join(FIX, tree), expect)) failed++;
}

if (failed) { console.error(`SELFTEST FAILED: ${failed} expectation(s) not met`); process.exit(1); }
console.log('selftest: all fixture expectations met.');
process.exit(0);
