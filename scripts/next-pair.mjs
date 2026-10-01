#!/usr/bin/env node
// next-pair.mjs — chon EXACT next IDs tu REPOSITORY TRUTH cho writer.
// Deterministic, READ-ONLY: khong tao row, khong ghi state, khong hard-code ID,
// khong tin workspace cu. Nguon chan ly:
//   1. data/article-manifest.jsonl — row status=planned, theo thu tu dong
//   2. tru cac id dang nam trong review_queue cua data/writer-checkpoint.json
//
// 3 PARALLEL WRITERS (coordinator = production.yml):
//   Writer khong bao gio ghi state chia se (manifest/checkpoint/sitemap).
//   Phan chia row ATOMIC BY CONSTRUCTION: writer-K nhan cac row planned
//   eligible o vi tri i voi (i % writers == K-1) — deterministic slice.
//   Slice cua hai writer bat ky RONG giao nhau, khong can file reservation
//   chia se (khong co race condition tren state). Row cua writer fail
//   KHONG bi danh dau COMPLETE: no van la planned va tu dong duoc cap lai
//   o chu ky sau; row published khong bao gio duoc cap lai (sync-manifest).
//
// Usage:
//   node scripts/next-pair.mjs                        # legacy: chunk_size ID dau tien
//   node scripts/next-pair.mjs 3                      # legacy: 3 ID (toi da chunk_size_max)
//   node scripts/next-pair.mjs --writer writer-2      # slice cho writer-2 cua `writers` writer
//   node scripts/next-pair.mjs --writer writer-2 --writers 3 --count 2
import { readFileSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = process.env.LAB_ROOT
  ? resolve(process.env.LAB_ROOT)
  : resolve(join(dirname(fileURLToPath(import.meta.url)), '..'));

function die(msg) {
  console.error('::error::' + msg);
  process.exit(1);
}

const cfgPath = join(ROOT, 'data', 'factory-config.json');
let chunk = 2;
let chunkMax = 2;
let writers = 3;
let writerChunk = 2;
try {
  const c = JSON.parse(readFileSync(cfgPath, 'utf8'));
  chunk = Number.isInteger(c.chunk_size) && c.chunk_size > 0 ? c.chunk_size : 2;
  chunkMax = Number.isInteger(c.chunk_size_max) && c.chunk_size_max > 0 ? c.chunk_size_max : chunk;
  writers = Number.isInteger(c.writers) && c.writers > 0 ? c.writers : 3;
  writerChunk = Number.isInteger(c.writer_chunk_size) && c.writer_chunk_size > 0 ? c.writer_chunk_size : chunk;
} catch (e) {
  die('data/factory-config.json khong hop le: ' + e.message);
}

// ---- parse args -----------------------------------------------------------
const args = process.argv.slice(2);
function opt(name) {
  const i = args.indexOf(name);
  return i !== -1 ? args[i + 1] : undefined;
}
const writerName = opt('--writer');
const writersOpt = opt('--writers');
const countOpt = opt('--count');
const legacyMode = writerName === undefined && writersOpt === undefined && countOpt === undefined;

// ---- load manifest + review_queue (shared cho ca hai che do) --------------
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

const eligible = rows.filter(r => r.status === 'planned' && !review.has(String(r.id)));

function printRows(list) {
  for (const r of list) console.log('  ' + r.id + '  ' + (r.cluster || '') + '  ' + r.slug + '  ' + (r.primary_topic || r.title || ''));
}

if (legacyMode) {
  // ---- legacy: dung nhu truoc — chunk_size ID dau tien --------------------
  const n = Number.parseInt(args[0] || String(chunk), 10);
  if (!Number.isInteger(n) || n < 1) die('so bai phai la so nguyen duong');
  if (n > chunkMax) die(n + ' vuot chunk_size_max=' + chunkMax);
  const next = eligible.slice(0, n);
  if (next.length === 0) {
    console.log('next-pair: khong con row planned hop le (ngoai review_queue).');
    process.exit(0);
  }
  if (next.length < n) console.log('::warning::chi con ' + next.length + '/' + n + ' row planned hop le.');
  console.log('next-pair: ' + next.length + ' ID ke tiep (repository truth, chua claim):');
  printRows(next);
  console.log('next-pair: viet DUNG cac bai nay vao _posts/, push len main — production.yml tu hoan tat claim/QA/publish.');
  process.exit(0);
}

// ---- 3-writer mode: deterministic slice reservation ------------------------
let N = writers;
if (writersOpt !== undefined) {
  N = Number.parseInt(writersOpt, 10);
  if (!Number.isInteger(N) || N < 1) die('--writers phai la so nguyen duong');
}
const wm = /^writer-(\d+)$/.exec(String(writerName));
if (!wm) die('--writer phai co dang writer-K (vd: writer-1, writer-2, writer-3)');
const K = Number(wm[1]);
if (K < 1 || K > N) die('writer-' + K + ' ngoai pham vi 1..' + N + ' writer');

let n = writerChunk;
if (countOpt !== undefined) {
  n = Number.parseInt(countOpt, 10);
  if (!Number.isInteger(n) || n < 1) die('--count phai la so nguyen duong');
}
if (n > chunkMax) die(n + ' vuot chunk_size_max=' + chunkMax + ' (hard invariant cua publish transaction cho moi push)');

const slice = eligible.filter((r, i) => i % N === K - 1).slice(0, n);
if (slice.length === 0) {
  console.log('next-pair: writer-' + K + ' khong con row planned trong slice — cac writer khac co the da phan het. Row khong bi danh COMPLETE; chu ky sau se cap lai.');
  process.exit(0);
}
if (slice.length < n) console.log('::warning::writer-' + K + ' chi con ' + slice.length + '/' + n + ' row trong slice.');
console.log('next-pair: RESERVED (deterministic slice) — writer-' + K + '/' + N + ', ' + slice.length + ' bai:');
printRows(slice);
console.log('next-pair: giao ranh dam bao bang cong: writer-K lay dung cac vi tri i % ' + N + ' == ' + (K - 1) + ' — hai writer bat ky KHONG chung row, khong can state chia se.');
console.log('next-pair: writer CHI viet _posts/ (path duy nhat theo slug) va push rieng; production.yml (coordinator) hoan tat claim/QA/publish mot transaction cho tung push.');
