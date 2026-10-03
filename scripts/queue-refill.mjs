#!/usr/bin/env node
// queue-refill.mjs — AUTO-REFILL ALLOCATOR (deterministic, KHONG AI).
// Khi planned rows < queue_refill.low_threshold (factory-config.json, mac dinh
// 100): append planned rows (den ~ queue_refill.target, mac dinh 300) tu ngan
// hang de muc da duyet data/queue-templates.json, tuan thu cluster-map
// (taxonomy/budget/hub_path). Moi ung vien dedup chong TOAN BO manifest:
// id/slug, topic chuan hoa (exact + Jaccard >= 0.6), cap entities+intent+
// cluster (chong cannibalization), budget cluster. Append la transactional:
// verify moi dong parse duoc, prefix lich su BYTE-IDENTICAL, khong trung
// id/slug, status hop le — loi bat ky => KHONG ghi manifest (fail-closed).
// Chay duy nhat trong production-coordinator (concurrency singleton) nen
// luon chi MOT process refill tai mot thoi diem. Writer KHONG bao gio tu
// sinh manifest row.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = process.env.LAB_ROOT
  || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const die = (msg) => { console.error('::error::queue-refill: ' + msg); process.exit(1); };
const R = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const W = (p, s) => fs.writeFileSync(path.join(ROOT, p), s);

let cfg;
try { cfg = JSON.parse(R('data/factory-config.json')); }
catch (e) { die('factory-config.json: ' + e.message); }
const QR = cfg.queue_refill || {};
const THRESHOLD = QR.low_threshold ?? 100;
const TARGET = QR.target ?? 300;
if (!Number.isInteger(THRESHOLD) || THRESHOLD < 1
  || !Number.isInteger(TARGET) || TARGET < THRESHOLD) die('queue_refill config khong hop le');

let CLUSTERS;
try { CLUSTERS = JSON.parse(R('data/cluster-map.json')); }
catch (e) { die('cluster-map.json: ' + e.message); }

const ALLOWED = new Set(['planned', 'drafting', 'review', 'published', 'skip']);
const MANIFEST = 'data/article-manifest.jsonl';
let raw;
try { raw = R(MANIFEST); } catch (e) { die('khong doc duoc manifest: ' + e.message); }
if (!raw.endsWith('\n')) die('manifest khong ket thuc bang newline — tu choi xu ly (fail-closed)');
const lines = raw.split('\n');
while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
const rows = [];
const seenId = new Set();
const seenSlug = new Set();
for (let i = 0; i < lines.length; i++) {
  let r;
  try { r = JSON.parse(lines[i]); } catch (e) { die('manifest dong ' + (i + 1) + ' khong phai JSON'); }
  if (!r.id || !r.slug || !r.status) die('manifest dong ' + (i + 1) + ' thieu id/slug/status');
  if (!ALLOWED.has(r.status)) die('manifest dong ' + (i + 1) + ' status khong hop le: ' + r.status);
  if (seenId.has(r.id)) die('trung id trong manifest: ' + r.id);
  if (seenSlug.has(r.slug)) die('trung slug trong manifest: ' + r.slug);
  seenId.add(r.id); seenSlug.add(r.slug); rows.push(r);
}

const summary = {
  ts: new Date().toISOString(),
  run_id: process.env.GITHUB_RUN_ID || 'local',
  before: 0, threshold: THRESHOLD, target: TARGET, need: 0,
  candidates: 0, rejected_duplicate: 0, rejected_invalid: 0, rejected_budget: 0,
  appended: 0, after: 0, result: 'noop-ok', rows: []
};
const finish = () => {
  fs.mkdirSync(path.join(ROOT, 'reports'), { recursive: true });
  W('reports/queue-refill-latest.json', JSON.stringify(summary, null, 2) + '\n');
  const logRow = {};
  for (const k of Object.keys(summary)) if (k !== 'rows') logRow[k] = summary[k];
  try { fs.appendFileSync(path.join(ROOT, 'data/queue-refill-log.jsonl'), JSON.stringify(logRow) + '\n'); }
  catch (e) { die('khong ghi duoc queue-refill-log.jsonl: ' + e.message); }
  console.log('queue-refill: result=' + summary.result + ' before=' + summary.before
    + ' appended=' + summary.appended + ' after=' + summary.after
    + ' rejected_dup=' + summary.rejected_duplicate
    + ' rejected_invalid=' + summary.rejected_invalid);
  process.exit(0);
};

const planned = rows.filter((r) => r.status === 'planned').length;
summary.before = planned;
summary.after = planned;
if (planned >= THRESHOLD) finish();

const need = TARGET - planned;
summary.need = need;

let bank;
try { bank = JSON.parse(R('data/queue-templates.json')); }
catch (e) { die('queue-templates.json: ' + e.message); }
if (!bank || typeof bank !== 'object' || Array.isArray(bank)) die('queue-templates.json khong hop le');

// ---- dedup indexes tren TOAN BO manifest ----
const norm = (s) => String(s || '').toLowerCase()
  .replace(/đ/g, 'd').replace(/Đ/g, 'd')
  .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .replace(/[^a-z0-9]+/g, ' ').trim();
const toks = (s) => norm(s).split(' ').filter((w) => w.length > 2);
const jac = (a, b) => {
  const A = new Set(a), Bs = new Set(b);
  if (A.size === 0 || Bs.size === 0) return 0;
  let inter = 0;
  for (const x of A) if (Bs.has(x)) inter++;
  return inter / (A.size + Bs.size - inter);
};
const entKey = (ents, intent, cluster) =>
  (Array.isArray(ents) ? ents.map(norm).sort().join('|') : '') + '::' + intent + '::' + cluster;

const allTokSets = rows.map((r) => toks(r.primary_topic));
const seenNorm = new Set(rows.map((r) => norm(r.primary_topic)));
const seenEnt = new Set(rows.map((r) => entKey(r.entities, r.search_intent, r.cluster)));

const perC = {};
for (const id of seenId) {
  const m = /^([A-Z][0-9]{2})-(\d+)$/.exec(id);
  if (!m) continue;
  const c = m[1];
  if (!perC[c]) perC[c] = { count: 0, maxSeq: 0 };
  perC[c].count++;
  const seq = parseInt(m[2], 10);
  if (seq > perC[c].maxSeq) perC[c].maxSeq = seq;
}
for (const c of Object.keys(CLUSTERS)) if (!perC[c]) perC[c] = { count: 0, maxSeq: 0 };

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const INTENTS = new Set(['informational', 'how-to', 'comparison']);

const order = Object.keys(CLUSTERS);
const bankList = {};
const ptr = {};
for (const c of order) {
  bankList[c] = Array.isArray(bank[c]) ? bank[c].filter((x) => x && typeof x === 'object') : [];
  ptr[c] = 0;
}
const chosen = [];
let active = order.filter((c) => bankList[c].length > 0
  && perC[c].count < (CLUSTERS[c].budget || Infinity));

while (chosen.length < need && active.length > 0) {
  const next = [];
  for (const c of active) {
    if (chosen.length >= need) break;
    const info = perC[c];
    const budget = CLUSTERS[c].budget || Infinity;
    if (info.count >= budget) { summary.rejected_budget += bankList[c].length - ptr[c]; continue; }
    let placed = false;
    while (!placed && ptr[c] < bankList[c].length && chosen.length < need) {
      const cand = bankList[c][ptr[c]++];
      summary.candidates++;
      let ok = true;
      let dup = false;
      if (typeof cand.topic !== 'string' || cand.topic.length < 15 || cand.topic.length > 130) { summary.rejected_invalid++; ok = false; }
      else if (typeof cand.slug !== 'string' || cand.slug.length < 3 || cand.slug.length > 120 || !SLUG_RE.test(cand.slug)) { summary.rejected_invalid++; ok = false; }
      else if (!INTENTS.has(cand.intent)) { summary.rejected_invalid++; ok = false; }
      else if (!Array.isArray(cand.entities) || cand.entities.length < 2) { summary.rejected_invalid++; ok = false; }
      else if (seenSlug.has(cand.slug)) { summary.rejected_duplicate++; ok = false; }
      else if (seenNorm.has(norm(cand.topic))) { summary.rejected_duplicate++; ok = false; }
      else {
        const tk = toks(cand.topic);
        for (const s of allTokSets) { if (jac(tk, s) >= 0.6) { dup = true; break; } }
        if (dup) { summary.rejected_duplicate++; ok = false; }
        else {
          const ek = entKey(cand.entities.slice(0, 2), cand.intent, c);
          if (seenEnt.has(ek)) { summary.rejected_duplicate++; ok = false; }
          else {
            let seq = info.maxSeq + 1;
            while (seenId.has(c + '-' + String(seq).padStart(4, '0'))) seq++;
            const id = c + '-' + String(seq).padStart(4, '0');
            const row = {
              id: id, cluster: c, status: 'planned',
              primary_topic: cand.topic, search_intent: cand.intent,
              title: '', slug: cand.slug, parent_hub: CLUSTERS[c].hub_path,
              entities: cand.entities.slice(0, 2),
              freshness: (cand.freshness === 'medium' || cand.freshness === 'high') ? cand.freshness : 'low',
              needs_official_source: cand.needs_official_source === true,
              similarity_group: c + '-core',
              source_plan: [], internal_links: [], published_url: null
            };
            seenId.add(id); seenSlug.add(cand.slug);
            seenNorm.add(norm(cand.topic)); seenEnt.add(ek); allTokSets.push(tk);
            info.maxSeq = seq; info.count++;
            chosen.push(row);
            summary.rows.push({ id: id, cluster: c, slug: cand.slug, primary_topic: cand.topic, search_intent: cand.intent, entities: row.entities });
            placed = true;
          }
        }
      }
    }
    if (ptr[c] < bankList[c].length && perC[c].count < (CLUSTERS[c].budget || Infinity)) next.push(c);
    else if (ptr[c] < bankList[c].length) summary.rejected_budget += bankList[c].length - ptr[c];
  }
  if (next.length === 0) break;
  active = next;
}

summary.appended = chosen.length;
if (chosen.length === 0) {
  summary.result = 'exhausted';
  console.error('::warning::queue-refill: het ung vien hop le (0 appended) — can mo rong data/queue-templates.json trong mot commit rieng.');
} else {
  summary.result = chosen.length >= need ? 'refilled' : 'partial';
  const newContent = raw + chosen.map((r) => JSON.stringify(r)).join('\n') + '\n';
  let parsedAll;
  try {
    parsedAll = newContent.split('\n').filter((l) => l !== '').map((l) => JSON.parse(l));
  } catch (e) { die('transaction verify: JSON parse fail — KHONG ghi manifest'); }
  if (parsedAll.length !== rows.length + chosen.length) die('transaction verify: sai so dong');
  if (!newContent.startsWith(raw)) die('transaction verify: prefix lich su khong nguyen ven');
  for (let i = 0; i < rows.length; i++) {
    if (JSON.stringify(parsedAll[i]) !== JSON.stringify(rows[i])) {
      die('transaction verify: row lich su bi thay doi tai dong ' + (i + 1));
    }
  }
  const idSet = new Set(), slugSet = new Set();
  for (const r of parsedAll) {
    if (!ALLOWED.has(r.status)) die('transaction verify: status khong hop le');
    if (idSet.has(r.id)) die('transaction verify: trung id ' + r.id);
    if (slugSet.has(r.slug)) die('transaction verify: trung slug ' + r.slug);
    idSet.add(r.id); slugSet.add(r.slug);
    if (!CLUSTERS[r.cluster]) die('transaction verify: cluster khong ton tai: ' + r.cluster);
  }
  W(MANIFEST, newContent);
  summary.after = parsedAll.filter((r) => r.status === 'planned').length;
}
finish();
