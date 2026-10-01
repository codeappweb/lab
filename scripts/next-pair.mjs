#!/usr/bin/env node
// next-pair.mjs — chon EXACT next IDs tu REPOSITORY TRUTH cho writer (push-driven pair).
// Deterministic, READ-ONLY: khong tao row, khong ghi state, khong hard-code ID,
// khong tin workspace cu. Nguon chan ly:
//   1. data/article-manifest.jsonl — row status=planned, theo thu tu dong
//   2. tru cac id dang nam trong review_queue cua data/writer-checkpoint.json
// Usage:
//   node scripts/next-pair.mjs        # in chunk_size ID (mac dinh 2)
//   node scripts/next-pair.mjs 3      # in 3 ID (toi da chunk_size_max)
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;

function die(msg) {
  console.error('::error::' + msg);
  process.exit(1);
}

const cfgPath = join(ROOT, 'data', 'factory-config.json');
let chunk = 2;
let chunkMax = 2;
try {
  const c = JSON.parse(readFileSync(cfgPath, 'utf8'));
  chunk = Number.isInteger(c.chunk_size) && c.chunk_size > 0 ? c.chunk_size : 2;
  chunkMax = Number.isInteger(c.chunk_size_max) && c.chunk_size_max > 0 ? c.chunk_size_max : chunk;
} catch (e) {
  die('data/factory-config.json khong hop le: ' + e.message);
}

const n = Number.parseInt(process.argv[2] || String(chunk), 10);
if (!Number.isInteger(n) || n < 1) die('so bai phai la so nguyen duong');
if (n > chunkMax) die(n + ' vuot chunk_size_max=' + chunkMax);

const manifestPath = join(ROOT, 'data', 'article-manifest.jsonl');
if (!existsSync(manifestPath)) die('data/article-manifest.jsonl thieu');
let rows;
try {
  rows = readFileSync(manifestPath, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
} catch (e) {
  die('manifest JSONL hong: ' + e.message);
}

const review = new Set();
const cpPath = join(ROOT, 'data', 'writer-checkpoint.json');
if (existsSync(cpPath)) {
  try {
    const cp = JSON.parse(readFileSync(cpPath, 'utf8'));
    for (const r of (cp.review_queue || [])) review.add(String(r.id));
  } catch (e) {
    die('writer-checkpoint hong: ' + e.message);
  }
}

const next = rows.filter(r => r.status === 'planned' && !review.has(String(r.id))).slice(0, n);
if (next.length === 0) {
  console.log('next-pair: khong con row planned hop le (ngoai review_queue).');
  process.exit(0);
}
if (next.length < n) console.log('::warning::chi con ' + next.length + '/' + n + ' row planned hop le.');
console.log('next-pair: ' + next.length + ' ID ke tiep (repository truth, chua claim):');
for (const r of next) console.log('  ' + r.id + '  ' + (r.cluster || '') + '  ' + r.slug + '  ' + (r.primary_topic || r.title || ''));
console.log('next-pair: viet DUNG cac bai nay vao _posts/, push len main — production.yml tu hoan tat claim/QA/publish.');
