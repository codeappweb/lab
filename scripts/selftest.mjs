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
  if (!pass && process.argv.includes('--verbose')) console.log(r.stdout, r.stderr);
  return pass;
}

let ok = true;
ok &= run('validate-content-quality.mjs', join(FIX, 'ok'), 'pass');
ok &= run('check-links.mjs', join(FIX, 'ok'), 'pass');
ok &= run('gen-sitemap-shards.mjs', join(FIX, 'ok'), 'pass');
ok &= run('validate-sitemap.mjs', join(FIX, 'ok'), 'pass');
ok &= run('self-heal-audit.mjs', join(FIX, 'ok'), 'pass');
ok &= run('legal-freshness-audit.mjs', join(FIX, 'ok'), 'pass');
ok &= run('seo-score.mjs', join(FIX, 'ok'), 'pass');
ok &= run('detect-duplicates.mjs', join(FIX, 'ok'), 'pass');
ok &= run('validate-content-quality.mjs', join(FIX, 'bad'), 'fail');
ok &= run('check-links.mjs', join(FIX, 'bad'), 'fail');
ok &= run('validate-sitemap.mjs', join(FIX, 'bad'), 'fail');
ok &= run('self-heal-audit.mjs', join(FIX, 'bad'), 'fail');
ok &= run('legal-freshness-audit.mjs', join(FIX, 'bad'), 'fail');

if (!ok) { console.error('SELFTEST FAILED'); process.exit(1); }
console.log('selftest: all fixture expectations met.');
process.exit(0);
