#!/usr/bin/env node
// next-pair.mjs — chon EXACT next IDs tu REPOSITORY TRUTH cho writer.
// Deterministic, READ-ONLY tru che do --allocate (ghi plan vua mot file).
//
// 3 PARALLEL WRITERS + IMMUTABLE CYCLE (cycle-based assignment):
//   Mot chu ky production = MÔT cycle bat bien trong data/factory-cycle.json:
//     node scripts/next-pair.mjs --allocate
//       -> doc manifest + review_queue TAI CHINH XAC origin/main (base_sha),
//          chon writers x writer_chunk_size row eligible dau tien, chia slice
//          deterministic (i % writers == K-1), ghi plan {cycle_id, base_sha,
//          assignments} vao data/factory-cycle.json (MÔT commit rieng tren main,
//          message "cycle(allocate): ..."). TU CHOI allocate khi con cycle
//          chua complete/failed (recovery-safe: khong bao gio tao cycle moi
//          de len cycle recoverable).
//     node scripts/next-pair.mjs --writer writer-K [--base-sha <sha>]
//       -> doc plan tu data/factory-cycle.json (bat bien, commit tren main),
//          KHONG tu derive tu HEAD moi. --base-sha (neu truyen) phai khop
//          base_sha cua cycle — writer session fetch main nao thi phai ghi
//          bai theo plan cua chu ky do.
//   Writer ghi bai kem front matter: factory_writer, factory_cycle,
//   factory_base_sha (xem docs/SCHEMA-ARTICLE.md) — integrate-guard kiem tra
//   ba truong nay khi tich hop; sai cycle/slice -> REVIEW, khong publish.
//
// Legacy (khong co cycle dang mo): giu nguyen hanh vi cu (chunk_size ID dau
// tien, hoac slice --writer). Ket qua legacy KHONG co factory metadata nen
// se bi integrate-guard dan ve REVIEW — dung legacy chi cho thao tac sua chua
// tay, khong dung cho production.
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
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
  chunkMax = Number.isInteger(c.chunk_size_max) && c.chunk_size_max > 0 ? c.chunk_size_max : 2;
  writers = Number.isInteger(c.writers) && c.writers > 0 ? c.writers : 3;
  writerChunk = Number.isInteger(c.writer_chunk_size) && c.writer_chunk_size > 0 ? c.writer_chunk_size : 2;
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
const baseShaOpt = opt('--base-sha');
const ALLOCATE = args.includes('--allocate');

// ---- load manifest + review_queue ------------------------------------------
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

// ---- cycle state -----------------------------------------------------------
const cyclePath = join(ROOT, 'data', 'factory-cycle.json');
let cycle = null;
if (existsSync(cyclePath)) {
  try { cycle = JSON.parse(readFileSync(cyclePath, 'utf8')); } catch (e) { die('data/factory-cycle.json hong: ' + e.message); }
}
const cycleActive = cycle && cycle.cycle_id && !["idle", "complete"].includes(cycle.phase);

// ---- ALLOCATE: tao plan bat bien cho chu ky moi -----------------------------
if (ALLOCATE) {
  if (cycle && !['idle', 'complete', 'failed'].includes(cycle.phase)) {
    die('TU CHOI allocate: cycle ' + cycle.cycle_id + ' dang o phase ' + cycle.phase +
      ' (chua complete/failed). Hoan thanh/phuc hoi cycle nay truoc — khong bao gio tao cycle moi de len cycle recoverable.');
  }
  const need = writers * writerChunk;
  if (need > chunkMax * writers) die('writers x writer_chunk_size=' + need + ' vuot writers x chunk_size_max=' + (chunkMax * writers));
  const batch = eligible.slice(0, need);
  if (batch.length === 0) die('khong con row planned hop le (ngoai review_queue) — khong the allocate cycle moi');
  if (batch.length < need) console.log('::warning::chi con ' + batch.length + '/' + need + ' row planned — cycle se nho hon kha nang.');
  const assignments = {};
  for (let k = 1; k <= writers; k++) assignments['writer-' + k] = [];
  batch.forEach((r, i) => { assignments['writer-' + ((i % writers) + 1)].push(String(r.id)); });
  let baseSha = baseShaOpt;
  if (!baseSha) {
    try {
      const { execSync } = await import('node:child_process');
      baseSha = String(execSync('git rev-parse origin/main', { cwd: ROOT, encoding: 'utf8' })).trim();
    } catch (e) {
      die('khong xac dinh duoc base_sha (git rev-parse origin/main that bai) — truyen --base-sha <origin/main sha> khi allocate');
    }
  }
  const plan = {
    schema_version: 1,
    cycle_id: 'cyc-' + (batch[0] ? String(batch[0].id).toLowerCase().replace(/[^a-z0-9]+/g, '') : 'empty'),
    base_sha: baseSha,
    coordinator_run_id: null,
    phase: 'allocated',
    assignments,
    staging_snapshot: {},
    publication: null,
    pages: null,
    history: cycle ? (cycle.history || []) : [],
    created_at: new Date().toISOString(),
  };
  writeFileSync(cyclePath, JSON.stringify(plan, null, 2) + '\n');
  console.log('next-pair: ALLOCATED cycle ' + plan.cycle_id + ' (base=' + plan.base_sha.slice(0, 10) + ') — ' +
    batch.length + ' bai / ' + writers + ' writer:');
  for (let k = 1; k <= writers; k++) {
    console.log('  writer-' + k + ': ' + (assignments['writer-' + k].join(', ') || '(rong)'));
  }
  console.log('next-pair: COMMIT file data/factory-cycle.json vao main (message: cycle(allocate): ' + plan.cycle_id + ') truoc khi writer bat dau.');
  console.log('next-pair: sau do moi writer chay: node scripts/next-pair.mjs --writer writer-K --base-sha ' + plan.base_sha);
  process.exit(0);
}

// ---- legacy / 3-writer slice mode ------------------------------------------
const legacyMode = writerName === undefined && writersOpt === undefined && countOpt === undefined;

if (legacyMode) {
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
  console.log('next-pair: che do legacy (khong cycle) — production nen dung --allocate; bai khong kem factory metadata se bi dan ve REVIEW khi tich hop.');
  process.exit(0);
}

// --writer writer-K
const wm = /^writer-(\d+)$/.exec(String(writerName));
if (!wm) die('--writer phai co dang writer-K (vd: writer-1, writer-2, writer-3)');
let N = writers;
if (writersOpt !== undefined) {
  N = Number.parseInt(writersOpt, 10);
  if (!Number.isInteger(N) || N < 1) die('--writers phai la so nguyen duong');
}
const K = Number(wm[1]);
if (K < 1 || K > N) die('writer-' + K + ' ngoai pham vi 1..' + N + ' writer');

let n = writerChunk;
if (countOpt !== undefined) {
  n = Number.parseInt(countOpt, 10);
  if (!Number.isInteger(n) || n < 1) die('--count phai la so nguyen duong');
}
if (n > chunkMax) die(n + ' vuot chunk_size_max=' + chunkMax + ' (hard invariant cua publish transaction cho moi push)');

// CYCLE MODE: plan bat bien tu data/factory-cycle.json
if (cycleActive && cycle.assignments && Array.isArray(cycle.assignments['writer-' + K])) {
  if (baseShaOpt !== undefined && baseShaOpt !== cycle.base_sha) {
    die('--base-sha ' + baseShaOpt + ' KHAC base_sha cua cycle dang mo (' + cycle.base_sha + ') — ca 3 writer cung chu ky PHAI doc cung mot snapshot bat bien; fetch main cua ban da tien truoc cycle. Dung plan cua cycle ' + cycle.cycle_id + ' (base ' + cycle.base_sha.slice(0, 10) + ') hoac cho cycle nay complete.');
  }
  const sliceRows = [];
  for (const id of cycle.assignments['writer-' + K]) {
    const r = rows.find(x => String(x.id) === String(id));
    if (!r) die('cycle plan tham chieu id ' + id + ' khong ton tai trong manifest — cycle state khong nhat quan, kiem tra tay');
    if (r.status !== 'planned' && r.status !== 'drafting' && r.status !== 'review') continue; // da published trong ky nay
    sliceRows.push(r);
  }
  if (sliceRows.length === 0) {
    console.log('next-pair: writer-' + K + ' khong con row planned trong slice cua cycle ' + cycle.cycle_id + ' (co the da publish trong chu ky nay).');
    process.exit(0);
  }
  console.log('next-pair: RESERVED (cycle plan) — ' + writerName + ' cua cycle ' + cycle.cycle_id + ' (base ' + cycle.base_sha.slice(0, 10) + '), ' + sliceRows.length + ' bai:');
  printRows(sliceRows);
  console.log('next-pair: front matter bat buoc cho moi bai (integrate-guard kiem tra):');
  console.log('  factory_writer: ' + writerName);
  console.log('  factory_cycle: ' + cycle.cycle_id);
  console.log('  factory_base_sha: ' + cycle.base_sha);
  console.log('next-pair: writer CHI viet _posts/ (path duy nhat theo slug) va push rieng len staging/' + writerName + '; production.yml (coordinator) hoan tat QA/publish mot transaction.');
  process.exit(0);
}

// Legacy slice (khong cycle dang mo) — giu hanh vi cu, them canh bao.
const slice = eligible.filter((r, i) => i % N === K - 1).slice(0, n);
if (slice.length === 0) {
  console.log('next-pair: writer-' + K + ' khong con row planned trong slice — cac writer khac co the da phan het. Row khong bi danh COMPLETE; chu ky sau se cap lai.');
  process.exit(0);
}
if (slice.length < n) console.log('::warning::writer-' + K + ' chi con ' + slice.length + '/' + n + ' row trong slice.');
console.log('next-pair: RESERVED (deterministic slice) — writer-' + K + '/' + N + ', ' + slice.length + ' bai:');
printRows(slice);
console.log('::warning::KHONG co cycle dang mo — assignment tu HEAD hien tai, khong duoc verify khi tich hop. Production: chay next-pair.mjs --allocate truoc; bai khong kem factory metadata se bi dan ve REVIEW.');
console.log('next-pair: giao ranh dam bao bang cong: writer-K lay dung cac vi tri i % ' + N + ' == ' + (K - 1) + ' — hai writer bat ky KHONG chung row, khong can state chia se.');
