#!/usr/bin/env node
// next-pair.mjs — chon EXACT next IDs tu REPOSITORY TRUTH cho writer.
// Deterministic, READ-ONLY tru che do --allocate (ghi plan vua mot file).
//
// 3 PARALLEL WRITERS + IMMUTABLE CYCLE (cycle-based assignment):
//   Mot chu ky production = MÔT cycle bat bien trong data/factory-cycle.json
//   + data/writer-assignments.json (slice row du lieu day du cho tung writer):
//     node scripts/next-pair.mjs --allocate      [CHI COORDINATOR chay — production.yml]
//       -> doc manifest + review_queue TAI CHINH XAC origin/main (base_sha),
//          chon writers x writer_chunk_size row eligible dau tien, chia slice
//          deterministic (i % writers == K-1), ghi plan {cycle_id, base_sha,
//          assignments} vao data/factory-cycle.json VA row du lieu day du cua
//          tung writer vao data/writer-assignments.json (MÔT commit rieng tren
//          main, message "cycle(allocate): ..."). TU CHOI allocate khi con
//          cycle chua complete/failed (recovery-safe: khong bao gio tao cycle
//          moi de len cycle recoverable). TU CHOI allocate khi manifest/checkpoint
//          drift (sync-manifest --dry-run exit 1 hoac checkpoint
//          last_publication chua duoc manifest danh published) — phai chay
//          maintenance dispatch (production.yml, maintenance=true) truoc.
//     node scripts/next-pair.mjs --writer writer-K [--base-sha <sha>]
//       -> doc DUNG slice cua minh tu data/writer-assignments.json (writer
//          KHONG doc manifest — fail-closed neu assignment file thieu hoac
//          khong khop cycle). --base-sha (neu truyen) phai khop base_sha cua
//          cycle — writer session fetch main nao thi phai ghi bai theo plan
//          cua chu ky do.
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

// ---- manifest + review_queue (CHI can cho --allocate va che do legacy) ----
// ---- writer cycle mode KHONG doc manifest — doc slice tu assignment file. --
const manifestPath = join(ROOT, 'data', 'article-manifest.jsonl');
const cpPath = join(ROOT, 'data', 'writer-checkpoint.json');
let rows = null;
let review = new Set();
let eligible = null;
function ensureManifest() {
  if (eligible) return;
  if (!existsSync(manifestPath)) die('data/article-manifest.jsonl thieu');
  try {
    rows = readFileSync(manifestPath, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
  } catch (e) {
    die('manifest JSONL hong: ' + e.message);
  }
  if (existsSync(cpPath)) {
    try {
      const cp = JSON.parse(readFileSync(cpPath, 'utf8'));
      for (const r of (cp.review_queue || [])) review.add(String(r.id));
    } catch (e) {
      die('writer-checkpoint hong: ' + e.message);
    }
  }
  eligible = rows.filter(r => r.status === 'planned' && !review.has(String(r.id)));
}

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
  ensureManifest();
  if (cycle && !['idle', 'complete', 'failed'].includes(cycle.phase)) {
    die('TU CHOI allocate: cycle ' + cycle.cycle_id + ' dang o phase ' + cycle.phase +
      ' (chua complete/failed). Hoan thanh/phuc hoi cycle nay truoc — khong bao gio tao cycle moi de len cycle recoverable.');
  }
  // ---- fail-closed pre-allocation guard (manifest + checkpoint drift) -----
  // TU CHOI allocate khi (a) sync-manifest --dry-run exit 1 (manifest/progress
  // lech repository truth), hoac (b) checkpoint last_publication chua duoc
  // reflect published trong manifest. Khong bao gio phan cong ID tren du lieu
  // lech — ID planned da thuc te published se bi cap phat lai = duplicate.
  const { spawnSync } = await import('node:child_process');
  const drift = spawnSync('node', ['scripts/sync-manifest.mjs', '--dry-run'], { cwd: ROOT, encoding: 'utf8' });
  if (drift.status !== 0) {
    die('TU CHOI allocate: MANIFEST DRIFT — sync-manifest --dry-run exit ' + drift.status +
      '. Chay maintenance dispatch (production.yml, maintenance=true, ref=main) truoc khi phan cong bai moi. ' + String(drift.stderr || '').trim());
  }
  if (existsSync(cpPath)) {
    let cpAlloc;
    try { cpAlloc = JSON.parse(readFileSync(cpPath, 'utf8')); }
    catch (e) { die('TU CHOI allocate: writer-checkpoint hong: ' + e.message); }
    const lastIds = cpAlloc && cpAlloc.last_publication && Array.isArray(cpAlloc.last_publication.ids)
      ? cpAlloc.last_publication.ids : [];
    const notPublished = lastIds.filter(id => {
      const r = rows.find(x => String(x.id) === String(id));
      return !r || r.status !== 'published';
    });
    if (notPublished.length) {
      die('TU CHOI allocate: CHECKPOINT DRIFT — last_publication ids chua duoc manifest danh published: ' +
        notPublished.join(', ') + '. Chay maintenance dispatch (production.yml, maintenance=true, ref=main) truoc khi allocate.');
    }
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
  // Slice row du lieu DAY DU cho tung writer — writer KHONG bao gio doc manifest.
  const assignFile = {
    schema_version: 1,
    cycle_id: plan.cycle_id,
    base_sha: baseSha,
    rows_total: batch.length,
    writers: {},
    created_at: new Date().toISOString(),
  };
  for (let k = 1; k <= writers; k++) assignFile.writers['writer-' + k] = [];
  batch.forEach((r, i) => { assignFile.writers['writer-' + ((i % writers) + 1)].push(r); });
  const assignPath = join(ROOT, 'data', 'writer-assignments.json');
  writeFileSync(assignPath, JSON.stringify(assignFile, null, 2) + '\n');
  console.log('next-pair: ALLOCATED cycle ' + plan.cycle_id + ' (base=' + plan.base_sha.slice(0, 10) + ') — ' +
    batch.length + ' bai / ' + writers + ' writer:');
  for (let k = 1; k <= writers; k++) {
    console.log('  writer-' + k + ': ' + (assignments['writer-' + k].join(', ') || '(rong)'));
  }
  console.log('next-pair: COMMIT data/factory-cycle.json + data/writer-assignments.json vao main (message: cycle(allocate): ' + plan.cycle_id + ') truoc khi writer bat dau.');
  console.log('next-pair: sau do moi writer chay: node scripts/next-pair.mjs --writer writer-K --base-sha ' + plan.base_sha);
  process.exit(0);
}

// ---- legacy / 3-writer slice mode ------------------------------------------
const legacyMode = writerName === undefined && writersOpt === undefined && countOpt === undefined;

if (legacyMode) {
  ensureManifest();
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

// CYCLE MODE: doc DUNG slice tu data/writer-assignments.json — KHONG doc manifest
if (cycleActive && cycle.assignments && Array.isArray(cycle.assignments['writer-' + K])) {
  if (baseShaOpt !== undefined && baseShaOpt !== cycle.base_sha) {
    die('--base-sha ' + baseShaOpt + ' KHAC base_sha cua cycle dang mo (' + cycle.base_sha + ') — ca 3 writer cung chu ky PHAI doc cung mot snapshot bat bien; fetch main cua ban da tien truoc cycle. Dung plan cua cycle ' + cycle.cycle_id + ' (base ' + cycle.base_sha.slice(0, 10) + ') hoac cho cycle nay complete.');
  }
  const assignPath = join(ROOT, 'data', 'writer-assignments.json');
  if (!existsSync(assignPath)) {
    die('data/writer-assignments.json thieu — coordinator chua tao assignment slice cho cycle ' + cycle.cycle_id + '. Fail-closed: writer KHONG doc manifest; cho coordinator chay cycle allocate (production.yml) truoc.');
  }
  let assign;
  try { assign = JSON.parse(readFileSync(assignPath, 'utf8')); }
  catch (e) { die('writer-assignments.json hong: ' + e.message); }
  if (assign.cycle_id !== cycle.cycle_id || assign.base_sha !== cycle.base_sha) {
    die('writer-assignments.json (cycle ' + assign.cycle_id + ') KHONG khop cycle dang mo ' + cycle.cycle_id + ' — assignment file khong nhat quan voi factory-cycle.json, kiem tra tay');
  }
  const assignRows = assign.writers && Array.isArray(assign.writers['writer-' + K]) ? assign.writers['writer-' + K] : null;
  if (!assignRows) {
    die('slice cua ' + writerName + ' khong ton tai trong writer-assignments.json cua cycle ' + cycle.cycle_id);
  }
  const sliceRows = assignRows.filter(r => r.status === 'planned' || r.status === 'drafting' || r.status === 'review'); // da published trong ky nay
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
ensureManifest();
const slice = eligible.filter((r, i) => i % N === K - 1).slice(0, n);
if (slice.length === 0) {
  console.log('next-pair: writer-' + K + ' khong con row planned trong slice — cac writer khac co the da phan het. Row khong bi danh COMPLETE; chu ky sau se cap lai.');
  process.exit(0);
}
if (slice.length < n) console.log('::warning::writer-' + K + ' chi con ' + slice.length + '/' + n + ' row trong slice.');
console.log('next-pair: RESERVED (deterministic slice) — ' + writerName + '/' + N + ', ' + slice.length + ' bai:');
printRows(slice);
console.log('::warning::KHONG co cycle dang mo — assignment tu HEAD hien tai, khong duoc verify khi tich hop. Production: chay next-pair.mjs --allocate truoc; bai khong kem factory metadata se bi dan ve REVIEW.');
console.log('next-pair: giao ranh dam bao bang cong: writer-K lay dung cac vi tri i % ' + N + ' == ' + (K - 1) + ' — hai writer bat ky KHONG chung row, khong can state chia se.');
