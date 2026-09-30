#!/usr/bin/env node
// validate-deploy.mjs — chuẩn bị + QA nhẹ trước khi push (dùng local bởi Mistral).
// Chuẩn bị (ghi file): sinh lại sitemap shards, đồng bộ manifest/progress.
// Gate (blocking): manifest, chất lượng nội dung, trùng lặp, link nội bộ,
// sitemap, manifest dry-run.
// KHÔNG thay cho CI/Actions; không bypass build Jekyll (CI chạy build thật).
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const prepare = [
  ['sitemap shards', 'scripts/gen-sitemap-shards.mjs'],
  ['sync manifest', 'scripts/sync-manifest.mjs'],
];
const gates = [
  ['manifest + bài viết', 'scripts/validate-content.mjs'],
  ['content quality', 'scripts/validate-content-quality.mjs'],
  ['duplicate detection', 'scripts/detect-duplicates.mjs'],
  ['internal links', 'scripts/check-links.mjs'],
  ['sitemap validation', 'scripts/validate-sitemap.mjs'],
  ['manifest dry-run', 'scripts/sync-manifest.mjs', ['--dry-run']],
];

function run(name, script, args = []) {
  if (!existsSync(join(ROOT, script))) {
    console.error('MISSING GATE: ' + name + ' (' + script + ' not found) — required validator must exist and run');
    process.exit(1);
  }
  console.log('');
  console.log('=== ' + name + ' ===');
  const r = spawnSync('node', [join(ROOT, script), ...args], { stdio: 'inherit', cwd: ROOT });
  if (r.status !== 0) { console.error('STEP FAILED: ' + name); process.exit(1); }
}

console.log('== Chuẩn bị artifact (ghi file) ==');
for (const [name, script] of prepare) run(name, script);
console.log('');
console.log('== QA nhẹ (blocking) ==');
for (const [name, script, args] of gates) run(name, script, args || []);
console.log('');
console.log('validate-deploy: all gates green. Commit + push, sau đó chờ CI đạt trên main.');
