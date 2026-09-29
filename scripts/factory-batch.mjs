#!/usr/bin/env node
// factory-batch.mjs — deterministic batch controller for the API-free
// content factory of codeappweb/lab.
//
// HARD RULES
//   - This script NEVER calls an AI API, NEVER writes article prose and
//     NEVER invents facts, prices, legal claims or sources. The
//     authenticated Mistral/Vibe writer session (or a human) is the sole
//     writer of every article body.
//   - Hard batch cap: BATCH_SIZE_LIMIT rows (20). Explicitly smaller
//     batches and a final partial batch are allowed; EVERY row in the
//     batch must pass QA.
//   - Never overwrite a published article, never lose a claim, never
//     regenerate completed rows, never publish FAIL/REVIEW rows.
//
// TRANSACTION MODEL (publication is two-phase):
//   publish          -> rows become "staged", drafts move to _posts.
//                       NOTHING is marked published yet.
//   finalize-publish --commit <sha>
//                    -> flips staged rows to "published" ONLY after the
//                       article files are verified inside the pushed
//                       commit on origin/main; records factory-history.
//   rollback         -> moves uncommitted promoted posts back to their
//                       drafts, restores PASS. Refuses to roll back
//                       anything already committed on origin/main.
//   recover          -> completes an interrupted COMMITTED publication, or
//                       rolls back an interrupted UNCOMMITTED promotion.
//                       A false "published" state (no post file) is a
//                       hard error, never silently accepted.
//
// SHARED LOCK (data/factory-lock.json, shared with the writer session):
//   { batch_id, run_id, started_at, last_checkpoint }
//   run_id comes from FACTORY_RUN_ID (set by both content workflows and
//   by the authenticated writer). A fresh foreign lock blocks a second
//   worker. A stale lock (> LOCK_STALE_MS) may be taken over only after
//   checking that the lock's batch matches factory state — the same
//   unfinished batch is resumed, never dropped.
//
// Exit codes:
//   0 ok
//   1 tool/config error, or a BLOCKING gate refused the operation
//   2 usage error
//   3 qa found FAIL rows (publish stays blocked)
//   4 requeue refusals (recorded, not fatal per row)
//   5 qa found REVIEW rows (legal sign-off pending; publish stays blocked)
import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync, renameSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = new URL('..', import.meta.url).pathname;
const MANIFEST_PATH = join(ROOT, 'data', 'article-manifest.jsonl');
const STATE_PATH = join(ROOT, 'data', 'factory-state.json');
const LOCK_PATH = join(ROOT, 'data', 'factory-lock.json');
const HISTORY_PATH = join(ROOT, 'data', 'factory-history.json');
const REPORTS_DIR = join(ROOT, 'reports', 'factory');
const POSTS_DIR = join(ROOT, '_posts');
const DRAFTS_ROOT = join(ROOT, '_drafts');
const TAXONOMY_PATH = join(ROOT, 'data', 'taxonomy.yml');
const DANH_MUC_DIR = join(ROOT, 'danh-muc');
const SCHEMA_DOC = 'docs/SCHEMA-ARTICLE.md';

const BATCH_SIZE_LIMIT = 20;
const LOCK_STALE_MS = 6 * 60 * 60 * 1000;
const ALLOWED_OPS = [
  'check-config', 'consistency', 'recover', 'lock-status',
  'prepare-next', 'qa', 'assert-ready', 'publish',
  'finalize-publish', 'rollback', 'requeue', 'progress'
];
const TERMINAL_ROW = 'published';
const REQUEUEABLE = ['fail', 'review'];
const CJK = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af]/;
const UNDEF = /undefined/;

function today() { return new Date().toISOString().slice(0, 10); }
function nowIso() { return new Date().toISOString(); }
function fail(msg) { console.error('::error::' + msg); process.exit(1); }
function runId() { return process.env.FACTORY_RUN_ID || 'manual'; }
function gitOk(args) { const r = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8' }); return r.status === 0; }
function gitOut(args) { const r = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8' }); return r.status === 0 ? r.stdout.trim() : null; }

// ---------------------------------------------------------------- manifest

function loadManifest() {
  const recs = readFileSync(MANIFEST_PATH, 'utf8').split('\n')
    .filter(Boolean).map(JSON.parse);
  return recs;
}

function postFiles() {
  if (!existsSync(POSTS_DIR)) return [];
  return readdirSync(POSTS_DIR).filter(f => f.endsWith('.md'));
}

function postSlug(f) { return f.replace(/^\d{4}-\d{2}-\d{2}-/, '').replace(/\.md$/, ''); }
function publishedSlugs() { return new Set(postFiles().map(postSlug)); }

// ------------------------------------------------------------------- state
// Corrupt state is a HARD ERROR: it is never treated as "no active batch".

function loadState() {
  if (!existsSync(STATE_PATH)) return null;
  let s = null;
  try { s = JSON.parse(readFileSync(STATE_PATH, 'utf8')); }
  catch (e) { fail('corrupt factory state (' + STATE_PATH + '): ' + e.message + ' — refusing to treat it as "no active batch"; repair or remove the file explicitly'); }
  if (!s || !Array.isArray(s.rows) || !s.batch) {
    fail('factory state is structurally invalid (missing batch/rows) — refusing to treat it as "no active batch"');
  }
  return s;
}

function saveState(state) {
  state.updated_at = nowIso();
  const order = ['claimed', 'pass', 'fail', 'review', 'staged', 'published'];
  state.rows.sort((a, b) => order.indexOf(a.status) - order.indexOf(b.status)
    || a.id.localeCompare(b.id));
  if (state.rows.length > BATCH_SIZE_LIMIT) {
    fail('state has more rows than the hard batch cap (' + BATCH_SIZE_LIMIT + ')');
  }
  const tmp = STATE_PATH + '.tmp';
  writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n');
  renameSync(tmp, STATE_PATH); // atomic: readers never see a partial state
}

function activeBatchId(state) {
  if (state && state.rows.some(r => r.status !== TERMINAL_ROW)) return state.batch;
  return null;
}

function draftDir(batch) { return join(DRAFTS_ROOT, batch); }
function draftPath(batch, slug) { return join(draftDir(batch), slug + '.md'); }

// -------------------------------------------------------------- history

function loadHistory() {
  if (!existsSync(HISTORY_PATH)) return [];
  let h = null;
  try { h = JSON.parse(readFileSync(HISTORY_PATH, 'utf8')); }
  catch (e) { fail('corrupt factory history (' + HISTORY_PATH + '): ' + e.message); }
  if (!Array.isArray(h)) fail('factory history must be a JSON array');
  return h;
}

// Unique batch ids even when several batches finish on the same day:
// batch-YYYY-MM-DD, then batch-YYYY-MM-DD-001, -002, ... Existing drafts
// dirs, report dirs, history entries and the active state can never be
// overwritten by a new batch id.
function batchIdForToday() {
  const base = 'batch-' + today();
  const used = new Set();
  if (existsSync(DRAFTS_ROOT)) {
    for (const d of readdirSync(DRAFTS_ROOT)) if (d.startsWith(base)) used.add(d);
  }
  if (existsSync(REPORTS_DIR)) {
    for (const d of readdirSync(REPORTS_DIR)) if (d.startsWith(base)) used.add(d);
  }
  for (const h of loadHistory()) if (h && h.batch && String(h.batch).startsWith(base)) used.add(h.batch);
  const state = loadState();
  if (state) used.add(state.batch);
  if (!used.has(base)) return base;
  for (let n = 1; n < 1000; n++) {
    const c = base + '-' + String(n).padStart(3, '0');
    if (!used.has(c)) return c;
  }
  fail('no free batch id for today');
}

// ------------------------------------------------------------------- lock

function loadLock() {
  if (!existsSync(LOCK_PATH)) return null;
  let l = null;
  try { l = JSON.parse(readFileSync(LOCK_PATH, 'utf8')); }
  catch (e) { fail('corrupt factory lock (' + LOCK_PATH + '): ' + e.message + ' — refusing to guess worker ownership; repair or remove the file explicitly'); }
  if (!l || !l.run_id || !l.started_at || !l.batch_id) {
    fail('factory lock is structurally invalid (needs batch_id/run_id/started_at)');
  }
  if (!l.last_checkpoint) l.last_checkpoint = l.started_at;
  return l;
}

function saveLock(batchId, tookOverFrom) {
  const l = { batch_id: batchId, run_id: runId(), started_at: nowIso(), last_checkpoint: nowIso() };
  if (tookOverFrom) l.took_over_from = tookOverFrom;
  const tmp = LOCK_PATH + '.tmp';
  writeFileSync(tmp, JSON.stringify(l, null, 2) + '\n');
  renameSync(tmp, LOCK_PATH);
  return l;
}

function lockIsFresh(l) {
  const t = Date.parse(l.last_checkpoint || l.started_at);
  if (Number.isNaN(t)) fail('lock has an unreadable timestamp');
  return (Date.now() - t) < LOCK_STALE_MS;
}

// Shared claim protocol: a valid active lock prevents a second worker from
// processing the same work. A stale lock may be recovered only after
// checking ownership against factory state; the SAME unfinished batch is
// resumed.
function acquireLock(batchId) {
  const existing = loadLock();
  const mine = runId();
  if (existing && existing.run_id !== mine) {
    if (lockIsFresh(existing)) {
      fail('another worker (run ' + existing.run_id + ', batch ' + existing.batch_id + ', checkpoint ' + existing.last_checkpoint + ') holds a valid active lock — refusing to process the same work concurrently');
    }
    const state = loadState();
    if (state && state.batch !== existing.batch_id) {
      fail('stale lock names batch ' + existing.batch_id + ' but factory state holds ' + state.batch + ' — refusing takeover; reconcile the lock and state manually');
    }
    console.log('lock: taking over STALE lock from run ' + existing.run_id + ' (last checkpoint ' + existing.last_checkpoint + '), resuming the same unfinished batch ' + existing.batch_id);
  }
  const tookOver = existing && existing.run_id !== mine ? existing.run_id : undefined;
  return saveLock(batchId, tookOver);
}

function touchLock() {
  const l = loadLock();
  if (l && l.run_id === runId()) { l.last_checkpoint = nowIso(); writeFileSync(LOCK_PATH, JSON.stringify(l, null, 2) + '\n'); }
}

function releaseLock() {
  const l = loadLock();
  if (!l) return;
  if (l.run_id !== runId()) fail('refusing to release a lock owned by run ' + l.run_id);
  unlinkSync(LOCK_PATH);
}

function cmdLockStatus() {
  const l = loadLock();
  const state = loadState();
  const report = {
    lock: l,
    lock_fresh: l ? lockIsFresh(l) : null,
    state_batch: state ? state.batch : null,
    state_statuses: state ? state.rows.map(r => r.id + ':' + r.status) : [],
    now: nowIso()
  };
  console.log(JSON.stringify(report, null, 2));
}

// ------------------------------------------------------- writer manifests

function exportWriterManifest(state, row, manifest) {
  const rec = manifest.find(r => r.id === row.id);
  const dir = join(REPORTS_DIR, state.batch, 'rows');
  mkdirSync(dir, { recursive: true });
  const context = {
    id: rec.id,
    slug: rec.slug,
    primary_topic: rec.primary_topic,
    search_intent: rec.search_intent,
    cluster: rec.cluster,
    parent_hub: rec.parent_hub,
    entities: rec.entities || [],
    freshness: rec.freshness,
    needs_official_source: !!rec.needs_official_source,
    similarity_group: rec.similarity_group || null,
    draft_path: '_drafts/' + state.batch + '/' + rec.slug + '.md',
    schema: SCHEMA_DOC,
    hard_rules: [
      'Vietnamese prose only; no CJK characters; no "undefined" artifacts.',
      'Front matter exactly per ' + SCHEMA_DOC + '; batch: ' + state.batch,
      'Body: no H1, >= 2 "##" sections, >= 400 words, >= 2 internal links.',
      'title 30-70 chars unique; description 90-165 chars unique.',
      'No invented facts, prices, fines, laws, statistics or sources.',
      'Legal topics: verified official source required, or needs_legal_review: true (blocks publish).'
    ]
  };
  writeFileSync(join(dir, row.id + '.json'), JSON.stringify(context, null, 2) + '\n');
}

function exportWriterInstructions(state, manifest) {
  const dir = join(REPORTS_DIR, state.batch);
  mkdirSync(dir, { recursive: true });
  const lines = [
    '# Writer instructions — ' + state.batch,
    '',
    'Deterministic export only. The editorial writer is the authenticated',
    'Mistral/Vibe session (or a human). GitHub Actions NEVER calls an AI API.',
    '',
    '- Schema: ' + SCHEMA_DOC,
    '- Queue: data/article-manifest.jsonl (single source of truth)',
    '- Draft target: _drafts/' + state.batch + '/<slug>.md',
    '- Hard cap: ' + BATCH_SIZE_LIMIT + ' rows in this batch — never write more.',
    '- Rows:',
    ''
  ];
  for (const r of state.rows) {
    const rec = manifest.find(m => m.id === r.id);
    lines.push('- ' + r.id + ' | ' + rec.slug + ' | intent: ' + rec.search_intent +
      ' | official source: ' + (rec.needs_official_source ? 'REQUIRED' : 'no') +
      ' | status: ' + r.status);
  }
  writeFileSync(join(dir, 'writer-instructions.md'), lines.join('\n') + '\n');
}

// ------------------------------------------------------- draft QA checks

function parseFrontMatter(text) {
  if (!text.startsWith('---')) return null;
  const end = text.indexOf('\n---', 3);
  if (end === -1) return null;
  const raw = text.slice(3, end);
  const body = text.slice(end + 4);
  const fm = {};
  const lists = {};
  let listKey = null;
  for (const line of raw.split('\n')) {
    const lm = line.match(/^\s*-\s+"?(.*?)"?\s*$/);
    if (lm && listKey) { (lists[listKey] ||= []).push(lm[1]); continue; }
    const km = line.match(/^([a-z_]+):\s*"?(.*?)"?\s*$/);
    if (km) { fm[km[1]] = km[2]; listKey = (km[1] === 'entities' || km[1] === 'related_articles') ? km[1] : null; }
  }
  return { fm, lists, body, raw };
}

function wordCount(body) {
  return body.split(/\s+/).filter(Boolean).length;
}

// taxonomy: parent slug -> Set of child slugs (parsed from data/taxonomy.yml)
let taxonomyCache = null;
function loadTaxonomy() {
  if (taxonomyCache) return taxonomyCache;
  if (!existsSync(TAXONOMY_PATH)) fail('missing data/taxonomy.yml');
  const parents = new Map();
  let curParent = null;
  for (const line of readFileSync(TAXONOMY_PATH, 'utf8').split('\n')) {
    const pid = line.match(/^  - id: "([^"]+)"$/);
    if (pid) { curParent = null; continue; }
    const pslug = line.match(/^ {4}slug: "([^"]+)"$/);
    if (pslug) { curParent = pslug[1]; parents.set(curParent, new Set()); continue; }
    const cslug = line.match(/^ {8}slug: "([^"]+)"$/);
    if (cslug && curParent) parents.get(curParent).add(cslug[1]);
  }
  taxonomyCache = parents;
  return parents;
}

// valid internal-link targets: manifest slugs + post slugs + taxonomy
// slugs + danh-muc section pages. Draft links are validated BEFORE publish.
let targetsCache = null;
function validLinkTargets(manifest) {
  if (targetsCache) return targetsCache;
  const t = new Set(['danh-muc']);
  for (const r of manifest) t.add(r.slug);
  for (const f of postFiles()) t.add(postSlug(f));
  for (const [p, kids] of loadTaxonomy()) { t.add(p); for (const k of kids) t.add(k); }
  if (existsSync(DANH_MUC_DIR)) {
    const walk = (dir, prefix) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        if (e.isDirectory()) walk(join(dir, e.name), prefix + e.name + '/');
        else if (e.name.endsWith('.md')) t.add(prefix + e.name.replace(/\.md$/, ''));
      }
    };
    walk(DANH_MUC_DIR, 'danh-muc/');
  }
  targetsCache = t;
  return t;
}

function bodyLinks(body) {
  const out = [];
  for (const m of body.matchAll(/\]\(\{\{\s*'([^']+)'/g)) out.push(m[1]);
  for (const m of body.matchAll(/\]\((\/[^)#\s]+)\/?\)/g)) out.push(m[1]);
  return out;
}

function linkTargetKey(raw) {
  let s = raw.replace(/^\/lab(?=\/)/, '');
  if (s.startsWith('/hub/')) return 'hub';
  s = s.replace(/^\//, '').replace(/\/$/, '');
  if (s.startsWith('danh-muc/')) return s;
  return s.split('/').pop();
}

// 3-gram shingles for body-duplicate detection
function shingles(text) {
  const words = text.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(Boolean);
  const s = new Set();
  for (let i = 0; i + 2 < words.length; i++) s.add(words[i] + ' ' + words[i + 1] + ' ' + words[i + 2]);
  return s;
}

function jaccard(a, b) {
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter || 1);
}

function buildCorpus(excludeFile) {
  const c = new Map();
  const add = (label, file) => {
    if (file === excludeFile) return;
    try {
      const p = parseFrontMatter(readFileSync(file, 'utf8'));
      if (p) c.set(label, shingles(p.body));
    } catch { /* unreadable file: skip */ }
  };
  for (const f of postFiles()) add('_posts/' + f, join(POSTS_DIR, f));
  if (existsSync(DRAFTS_ROOT)) {
    for (const d of readdirSync(DRAFTS_ROOT)) {
      const full = join(DRAFTS_ROOT, d);
      let isDir = false;
      try { isDir = statSync(full).isDirectory(); } catch { continue; }
      if (!isDir) continue;
      for (const f of readdirSync(full)) {
        if (f.endsWith('.md')) add('_drafts/' + d + '/' + f, join(full, f));
      }
    }
  }
  return c;
}

function buildSeenIndex(excludeSlug) {
  const seen = new Map();
  const scan = (file, ownerId) => {
    let parsed;
    try { parsed = parseFrontMatter(readFileSync(file, 'utf8')); } catch { return; }
    if (!parsed) return;
    const t = (parsed.fm.title || '').trim().toLowerCase();
    const d = (parsed.fm.description || '').trim().toLowerCase();
    const id = parsed.fm.id || '';
    const pk = (parsed.fm.primary_keyword || '').trim().toLowerCase();
    if (t) seen.set('title:' + t, ownerId);
    if (d) seen.set('desc:' + d, ownerId);
    if (id) seen.set('id:' + id, ownerId);
    if (pk) seen.set('pk:' + pk, ownerId);
  };
  for (const f of postFiles()) scan(join(POSTS_DIR, f), postSlug(f));
  for (const dir of existsSync(DRAFTS_ROOT) ? readdirSync(DRAFTS_ROOT) : []) {
    const full = join(DRAFTS_ROOT, dir);
    let isDir = false;
    try { isDir = statSync(full).isDirectory(); } catch { continue; }
    if (!isDir) continue;
    for (const f of readdirSync(full).filter(f2 => f2.endsWith('.md'))) {
      const slug = f.replace(/\.md$/, '');
      if (slug === excludeSlug) continue;
      scan(join(full, f), slug);
    }
  }
  return seen;
}

// QA a single draft. Legal-review problems produce status "review" (they
// block publish but are not prose failures); quality problems produce
// "fail". The manifest record is cross-checked: needs_official_source is
// authoritative, not just the writer-supplied flags in the draft.
function qaDraft(state, row, rec, manifest, seen, corpus) {
  const path = draftPath(state.batch, row.slug);
  const checkedAt = nowIso();
  if (!existsSync(path)) return { status: 'absent', reasons: ['draft file not written yet'], checked_at: checkedAt };
  const text = readFileSync(path, 'utf8');
  const parsed = parseFrontMatter(text);
  if (!parsed) return { status: 'fail', reasons: ['missing or malformed front matter'], checked_at: checkedAt };
  const { fm, lists, body } = parsed;
  const reasons = [];
  const reviewReasons = [];

  const t = (fm.title || '').trim();
  if (t.length < 30 || t.length > 70) reasons.push('title must be 30-70 chars (is ' + t.length + ')');
  const d = (fm.description || '').trim();
  if (d.length < 90 || d.length > 165) reasons.push('description must be 90-165 chars (is ' + d.length + ')');
  for (const key of ['id', 'primary_keyword', 'search_intent', 'category', 'subcategory',
    'parent_category', 'child_category', 'cluster', 'batch', 'created_at', 'updated_at',
    'freshness_status', 'layout', 'date']) {
    if (!fm[key]) reasons.push('missing front matter key: ' + key);
  }
  if (fm.id && fm.id !== row.slug) reasons.push('front matter id does not equal slug');
  if (fm.batch && fm.batch !== state.batch) reasons.push('front matter batch is "' + fm.batch + '", expected "' + state.batch + '"');
  if ((lists.entities || []).length < 2) reasons.push('entities: need >= 2');
  if ((lists.related_articles || []).length < 2) reasons.push('related_articles: need >= 2');

  if ((body.match(/^# [^#]/gm) || []).length > 0) reasons.push('body contains H1');
  if ((body.match(/^## /gm) || []).length < 2) reasons.push('body needs >= 2 "##" sections');
  const words = wordCount(body);
  if (words < 400) reasons.push('body too short: ' + words + ' words (min 400)');
  const links = (body.match(/\]\(\s*\{\{|\]\(\s*\//g) || []).length;
  if (links < 2) reasons.push('internal links: need >= 2 (found ' + links + ')');
  if (CJK.test(body)) reasons.push('CJK characters in body');
  if (UNDEF.test(body)) reasons.push('"undefined" artifact in body');

  // taxonomy: parent/child must be a real parent-child pair
  const tax = loadTaxonomy();
  if (fm.parent_category && !tax.has(fm.parent_category)) {
    reasons.push('parent_category "' + fm.parent_category + '" is not a taxonomy parent slug');
  } else if (fm.child_category && !tax.get(fm.parent_category).has(fm.child_category)) {
    reasons.push('child_category "' + fm.child_category + '" is not a child of "' + fm.parent_category + '"');
  }

  // internal-link targets must exist in repository truth (manifest, posts,
  // taxonomy, danh-muc) — including links to other articles of this batch
  const targets = validLinkTargets(manifest);
  for (const raw of bodyLinks(body)) {
    const key = linkTargetKey(raw);
    if (key === 'hub') continue;
    if (!targets.has(key)) reasons.push('internal link target "' + raw + '" not found in manifest/posts/taxonomy');
  }

  // LEGAL REVIEW GATE (blocking): never flipped automatically
  const needsReviewFlag = /needs_legal_review:\s*true/.test(text) || fm.verification_status === 'needs_legal_review';
  if (needsReviewFlag) reviewReasons.push('needs_legal_review is set — editorial/legal sign-off required before publish');
  if (fm.next_review && /^\d{4}-\d{2}-\d{2}$/.test(fm.next_review) && fm.next_review < today()) {
    reviewReasons.push('legal/freshness review overdue (next_review ' + fm.next_review + ' < ' + today() + ')');
  }
  if (/legal_sensitivity:\s*true/.test(text) && !fm.verified_source) {
    reviewReasons.push('legal-sensitive article lacks verified_source');
  }
  if (rec && rec.needs_official_source && !fm.verified_source) {
    reviewReasons.push('manifest requires an official source (needs_official_source) but verified_source is missing');
  }

  // duplicates: title / id / description / primary_keyword across posts + drafts
  const key = 'id:' + (fm.id || '');
  for (const kind of ['title:' + t.toLowerCase(), 'desc:' + d.toLowerCase(), key,
    'pk:' + (fm.primary_keyword || '').trim().toLowerCase()]) {
    if (seen.has(kind) && seen.get(kind) !== row.id) {
      reasons.push('duplicate ' + kind.split(':')[0] + ' conflicts with ' + seen.get(kind));
    }
  }

  // substantially duplicated body (3-gram shingles, Jaccard >= 0.8)
  const sh = shingles(body);
  for (const [file, other] of corpus) {
    if (jaccard(sh, other) >= 0.8) { reasons.push('body substantially duplicated with ' + file + ' (Jaccard >= 0.8)'); break; }
  }

  const status = reasons.length ? 'fail' : (reviewReasons.length ? 'review' : 'pass');
  const out = { status, reasons, review_reasons: reviewReasons, words, links, checked_at: checkedAt };
  if (reviewReasons.length && reasons.length) out.status = 'fail';
  return out;
}

// ------------------------------------------------------------- progress

function writeProgress(state, manifest) {
  const dir = join(REPORTS_DIR);
  mkdirSync(dir, { recursive: true });
  const counts = { claimed: 0, pass: 0, fail: 0, review: 0, staged: 0, published: 0 };
  for (const r of state.rows) if (counts[r.status] !== undefined) counts[r.status]++;
  const progress = {
    batch: state.batch,
    generated_at: nowIso(),
    batch_rows: state.rows.length,
    batch_counts: counts,
    manifest_total: manifest.length,
    manifest_published: manifest.filter(r => r.status === 'published').length,
    manifest_planned: manifest.filter(r => r.status === 'planned').length,
    posts_on_disk: postFiles().length,
    note: 'counts derive from repository truth (manifest + _posts + state), not from targets'
  };
  writeFileSync(join(dir, 'progress.json'), JSON.stringify(progress, null, 2) + '\n');
}

// -------------------------------------------------------------------- ops

function cmdCheckConfig() {
  const manifest = loadManifest();
  const bad = manifest.filter(r => !r.id || !r.slug || !r.status);
  if (bad.length) fail('manifest rows missing id/slug/status: ' + bad.map(r => r.id).join(', '));
  const known = new Set(['planned', 'published']);
  const unknown = manifest.filter(r => !known.has(r.status));
  if (unknown.length) fail('manifest rows with unknown status: ' + unknown.map(r => r.id + ':' + r.status).join(', '));
  console.log('factory config OK: ' + manifest.length + ' manifest rows, hard cap ' +
    BATCH_SIZE_LIMIT + ', no AI API keys (deterministic controller only)');
}

// Bidirectional reconciliation: state <-> manifest <-> drafts <-> posts.
function cmdConsistency() {
  const manifest = loadManifest();
  const errs = [];
  const posts = postFiles();
  const pslugs = publishedSlugs();
  const bySlug = new Map(manifest.map(r => [r.slug, r]));

  // every post on disk must be tracked by the manifest
  for (const f of posts) {
    if (!bySlug.has(postSlug(f))) errs.push('post ' + f + ' is not in the manifest — run sync-manifest to reconcile it from post front matter');
  }
  // manifest published rows must have their post on disk
  for (const r of manifest) {
    if (r.status === 'published' && !pslugs.has(r.slug)) errs.push('manifest row ' + r.id + ' is published but no post file exists');
  }

  const state = loadState();
  if (!state) { console.log('consistency: no factory state yet'); }
  else {
    const byId = new Map(manifest.map(r => [r.id, r]));
    for (const row of state.rows) {
      if (!byId.has(row.id)) errs.push('row ' + row.id + ' not in manifest');
      if (row.status === 'published' && !pslugs.has(row.slug)) {
        errs.push('FALSE published state: ' + row.id + ' is published in state but no post file exists');
      }
      if (row.status === 'staged') {
        if (!row.post_file || !existsSync(join(ROOT, row.post_file))) errs.push('staged row ' + row.id + ' has no post file on disk');
      }
      if (row.status === 'pass' && !existsSync(draftPath(state.batch, row.slug))) {
        errs.push('row ' + row.id + ' is PASS but its draft is missing');
      }
    }
    if (state.rows.length > BATCH_SIZE_LIMIT) errs.push('state exceeds hard batch cap');
    if (!/^batch-\d{4}-\d{2}-\d{2}(-\d{3})?$/.test(state.batch)) errs.push('invalid batch id ' + state.batch);
    // drafts inside the active batch dir must be tracked by state
    const dd = draftDir(state.batch);
    if (existsSync(dd)) {
      for (const f of readdirSync(dd)) {
        if (!f.endsWith('.md')) continue;
        const slug = f.replace(/\.md$/, '');
        if (!state.rows.some(r => r.slug === slug)) errs.push('draft ' + slug + ' in batch dir is not tracked in batch state (run prepare-next to absorb it)');
      }
    }
    const lock = loadLock();
    if (lock && lock.batch_id !== state.batch) errs.push('lock names batch ' + lock.batch_id + ' but state holds ' + state.batch);
  }
  if (errs.length) { for (const e of errs) console.error('FAIL: ' + e); process.exit(1); }
  console.log('consistency OK: ' + posts.length + ' posts, ' + manifest.length + ' manifest rows' +
    (state ? ', ' + state.rows.length + ' state rows reconcile' : ''));
}

// Recovery from interruption, fail-closed:
//   - committed publication (staged + posts on origin/main) -> completed via
//     finalize-publish with the discovered commit
//   - uncommitted promotion (staged, not on origin/main) -> rolled back to
//     drafts, statuses restored to PASS; no claim is ever lost
//   - false published state (no post file) -> hard error
function cmdRecover() {
  const manifest = loadManifest();
  const state = loadState();
  const lock = loadLock();
  if (lock && lock.run_id !== runId() && lockIsFresh(lock)) {
    fail('recover: another worker (run ' + lock.run_id + ') holds a valid active lock — recovery refused');
  }
  if (!state) {
    if (lock) { console.log('recover: stale lock without factory state — releasing lock ' + lock.batch_id); unlinkSync(LOCK_PATH); }
    console.log('recover: no state to recover');
    return;
  }
  acquireLock(state.batch);
  const pslugs = publishedSlugs();

  for (const row of state.rows) {
    if (row.status === 'published' && !pslugs.has(row.slug)) {
      fail('recover: FALSE published state — ' + row.id + ' is published but its post file is missing; refusing to accept it');
    }
  }

  const staged = state.rows.filter(r => r.status === 'staged');
  if (staged.length) {
    const allCommitted = staged.every(r => r.post_file && gitOk(['cat-file', '-e', 'origin/main:' + r.post_file]));
    if (allCommitted) {
      // complete the interrupted committed publication
      let sha = null;
      for (const row of staged) {
        const s = gitOut(['log', 'origin/main', '--format=%H', '--diff-filter=A', '-1', '--', row.post_file]);
        if (!sha) sha = s; else if (s !== sha) sha = '__multiple__';
      }
      if (sha && sha !== '__multiple__') {
        const files = new Set((gitOut(['diff-tree', '--no-commit-id', '--name-only', '-r', sha]) || '').split('\n').filter(Boolean));
        const allIn = staged.every(r => files.has(r.post_file));
        if (allIn) {
          console.log('recover: staged publication is committed in ' + sha + ' — completing it');
          finalizeState(state, manifest, sha);
          releaseLock();
          return;
        }
      }
      fail('recover: staged posts are committed on origin/main but a single containing commit could not be verified — run finalize-publish --commit <sha> manually');
    }
    // uncommitted promotion: roll back without losing anything
    for (const row of staged) {
      if (!row.post_file) { row.status = 'pass'; continue; }
      const pp = join(ROOT, row.post_file);
      if (existsSync(pp)) {
        const target = draftPath(state.batch, row.slug);
        if (existsSync(target)) fail('recover: draft target exists for ' + row.slug + ' — refusing to overwrite');
        renameSync(pp, target);
      }
      row.status = 'pass';
      delete row.staged_at; delete row.post_file;
      console.log('recover: rolled back uncommitted promotion of ' + row.slug + ' — draft restored, status PASS');
    }
    saveState(state);
    writeProgress(state, manifest);
    releaseLock();
    console.log('recover: uncommitted promotion undone for ' + staged.length + ' row(s); rerun qa then publish when ready');
    return;
  }

  let fixed = 0;
  for (const row of state.rows) {
    if (pslugs.has(row.slug) && row.status !== TERMINAL_ROW) {
      row.status = TERMINAL_ROW; row.published = true; fixed++;
    }
    if (row.status !== TERMINAL_ROW && !existsSync(draftPath(state.batch, row.slug)) && !pslugs.has(row.slug)) {
      if (row.status !== 'claimed') { row.status = 'claimed'; delete row.qa; fixed++; }
    }
  }
  saveState(state);
  touchLock();
  console.log('recover: ' + fixed + ' row(s) reconciled with repository truth');
}

// Resume unfinished work before claiming new work: if draft directories
// already contain writer-produced drafts for planned manifest rows and
// there is no active batch state, the OLDEST such directory becomes the
// batch (its drafts are absorbed by prepare-next). Never orphan drafts.
function resumableDraftBatch(manifest, posts) {
  if (!existsSync(DRAFTS_ROOT)) return null;
  const candidates = [];
  for (const d of readdirSync(DRAFTS_ROOT)) {
    if (!/^batch-\d{4}-\d{2}-\d{2}(-\d{3})?$/.test(d)) continue;
    let isDir = false;
    try { isDir = statSync(join(DRAFTS_ROOT, d)).isDirectory(); } catch { continue; }
    if (!isDir) continue;
    const drafts = readdirSync(join(DRAFTS_ROOT, d)).filter(f => f.endsWith('.md'));
    if (!drafts.length) continue;
    const planned = drafts.filter(f => {
      const slug = f.replace(/\.md$/, '');
      const rec = manifest.find(r => r.slug === slug);
      return rec && rec.status === 'planned' && !posts.has(slug);
    });
    if (planned.length) candidates.push(d);
  }
  candidates.sort();
  if (candidates.length) {
    console.log('prepare-next: resuming unfinished draft batch ' + candidates[0] + ' (' + candidates.length + ' resumable dir(s) found)');
    return candidates[0];
  }
  return null;
}

function cmdPrepareNext(batchSizeArg) {
  let size;
  if (batchSizeArg !== undefined) {
    if (!/^\d+$/.test(batchSizeArg)) fail('invalid --batch-size "' + batchSizeArg + '" (must be an integer 1-' + BATCH_SIZE_LIMIT + ')');
    const n = parseInt(batchSizeArg, 10);
    if (n < 1 || n > BATCH_SIZE_LIMIT) fail('invalid --batch-size ' + n + ' (must be 1-' + BATCH_SIZE_LIMIT + ')');
    size = n;
  } else {
    size = BATCH_SIZE_LIMIT;
  }
  const manifest = loadManifest();
  const posts = publishedSlugs();
  let state = loadState();
  let batch = activeBatchId(state);
  if (!batch) batch = resumableDraftBatch(manifest, posts);
  if (!batch) batch = batchIdForToday();
  acquireLock(batch);
  if (!state || state.batch !== batch) state = { batch, created_at: nowIso(), rows: [] };
  state.rows ||= [];
  const have = new Set(state.rows.map(r => r.id));

  // 1. absorb drafts the writer already produced for the active batch dir
  const dir = draftDir(batch);
  if (existsSync(dir)) {
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.md')) continue;
      const slug = f.replace(/\.md$/, '');
      const rec = manifest.find(r => r.slug === slug);
      if (!rec || rec.status !== 'planned' || posts.has(slug) || have.has(rec.id)) continue;
      if (state.rows.length >= size) break;
      state.rows.push({ id: rec.id, slug, status: 'claimed' });
      have.add(rec.id);
    }
  }
  // 2. fill remaining slots with the next planned rows in manifest order
  for (const rec of manifest) {
    if (state.rows.length >= size) break;
    if (rec.status !== 'planned' || have.has(rec.id) || posts.has(rec.slug)) continue;
    state.rows.push({ id: rec.id, slug: rec.slug, status: 'claimed' });
    have.add(rec.id);
  }
  saveState(state);
  touchLock();
  for (const row of state.rows) exportWriterManifest(state, row, manifest);
  exportWriterInstructions(state, manifest);
  writeProgress(state, manifest);
  console.log('prepare-next: batch ' + batch + ' has ' + state.rows.length +
    ' row(s) (cap ' + BATCH_SIZE_LIMIT + '); writer manifests exported to reports/factory/' + batch + '/');
}

function cmdQa() {
  const manifest = loadManifest();
  const state = loadState();
  if (!state) { console.log('qa: no active batch — nothing produced by the writer yet'); return; }
  acquireLock(state.batch);
  const byId = new Map(manifest.map(r => [r.id, r]));
  let fails = 0, passes = 0, absent = 0, reviews = 0;
  for (const row of state.rows) {
    if (row.status === TERMINAL_ROW) continue; // never re-QA published rows
    const seen = buildSeenIndex(row.slug);
    const corpus = buildCorpus(join(DRAFTS_ROOT, state.batch, row.slug + '.md'));
    const qa = qaDraft(state, row, byId.get(row.id), manifest, seen, corpus);
    row.qa = qa;
    if (qa.status === 'pass') { row.status = 'pass'; passes++; }
    else if (qa.status === 'absent') { absent++; }
    else if (qa.status === 'review') {
      row.status = 'review'; reviews++;
      console.error('REVIEW ' + row.id + ': ' + qa.review_reasons.join('; '));
    }
    else {
      row.status = 'fail'; fails++;
      console.error('FAIL ' + row.id + ': ' + qa.reasons.join('; '));
      if (qa.review_reasons && qa.review_reasons.length) console.error('  (also pending review: ' + qa.review_reasons.join('; ') + ')');
    }
  }
  saveState(state);
  touchLock();
  writeProgress(state, manifest);
  console.log('qa: ' + passes + ' pass, ' + fails + ' fail, ' + reviews + ' review, ' + absent +
    ' awaiting writer (prose requires the authenticated writer session)');
  if (fails) process.exit(3);
  if (reviews) process.exit(5);
}

// BLOCKING production gate. --expected-size is OPTIONAL: a deliberately
// smaller batch and a final partial batch are allowed, but EVERY row in
// the batch must be PASS with its draft on disk.
function cmdAssertReady(expectedArg) {
  let expected = null;
  if (expectedArg !== undefined) {
    if (!/^\d+$/.test(expectedArg)) fail('invalid --expected-size "' + expectedArg + '"');
    expected = parseInt(expectedArg, 10);
    if (expected < 1 || expected > BATCH_SIZE_LIMIT) fail('expected-size ' + expected + ' outside 1-' + BATCH_SIZE_LIMIT);
  }
  const manifest = loadManifest();
  const state = loadState();
  if (!state) fail('assert-ready: no active batch state — run prepare-next first');
  const errs = [];
  if (state.rows.length === 0) errs.push('batch has no rows');
  if (state.rows.length > BATCH_SIZE_LIMIT) errs.push('batch has ' + state.rows.length + ' rows, hard cap is ' + BATCH_SIZE_LIMIT);
  if (expected !== null && state.rows.length !== expected) {
    errs.push('batch has ' + state.rows.length + ' rows, expected exactly ' + expected);
  }
  const counts = { pass: 0, claimed: 0, fail: 0, review: 0, staged: 0, published: 0 };
  for (const row of state.rows) {
    if (counts[row.status] !== undefined) counts[row.status]++;
    if (row.status !== 'pass') errs.push(row.id + ': status "' + row.status + '" (must be PASS)');
    if (row.qa && row.qa.status === 'absent') errs.push(row.id + ': draft absent');
    if (!existsSync(draftPath(state.batch, row.slug))) {
      errs.push(row.id + ': draft file missing');
    } else if (!row.qa || row.qa.status !== 'pass') {
      errs.push(row.id + ': QA not recorded as PASS — run qa first');
    }
  }
  if (counts.claimed) errs.push(counts.claimed + ' claimed row(s) (awaiting writer or QA)');
  if (counts.fail) errs.push(counts.fail + ' FAIL row(s)');
  if (counts.review) errs.push(counts.review + ' REVIEW row(s)');
  if (counts.staged) errs.push(counts.staged + ' staged row(s) (publication in flight)');
  if (counts.published) errs.push(counts.published + ' row(s) already published');
  if (errs.length) {
    for (const e of errs) console.error('::error::assert-ready: ' + e);
    fail('assert-ready FAILED — production publish is blocked; ZERO articles may be published');
  }
  console.log('assert-ready OK: ' + state.rows.length + ' row(s)' +
    (expected !== null ? ' (exactly ' + expected + ')' : '') + ', all PASS with drafts on disk');
}

// PHASE 1 of the publication transaction: promote drafts to _posts and
// mark rows "staged". Nothing is published until finalize-publish verifies
// the article files inside a pushed commit.
function cmdPublish() {
  const manifest = loadManifest();
  const state = loadState();
  if (!state) fail('publish: no active batch');
  if (state.rows.length === 0) fail('publish: active batch has no rows');
  acquireLock(state.batch);
  const posts = publishedSlugs();
  const violations = [];
  for (const row of state.rows) {
    if (row.status !== 'pass') violations.push(row.id + ': status "' + row.status + '" (only a 100% PASS batch may publish)');
    if (!existsSync(draftPath(state.batch, row.slug))) violations.push(row.id + ': draft file missing');
    if (posts.has(row.slug)) violations.push(row.id + ': already published (never overwrite a published article)');
  }
  if (violations.length) {
    for (const v of violations) console.error('::error::publish refused: ' + v);
    fail('publish refused: batch is not 100% ready — ZERO articles staged (requeue FAIL rows, rerun qa, then retry)');
  }
  mkdirSync(POSTS_DIR, { recursive: true });
  let staged = 0;
  for (const row of state.rows) {
    const parsed = parseFrontMatter(readFileSync(draftPath(state.batch, row.slug), 'utf8'));
    const date = (parsed && /^\d{4}-\d{2}-\d{2}$/.test(parsed.fm.date || '')) ? parsed.fm.date : today();
    const rel = '_posts/' + date + '-' + row.slug + '.md';
    const target = join(ROOT, rel);
    if (existsSync(target)) {
      fail('publish aborted: ' + rel + ' already exists (never overwrite a published article)');
    }
    renameSync(draftPath(state.batch, row.slug), target);
    row.status = 'staged';
    row.staged_at = nowIso();
    row.post_file = rel;
    staged++;
    console.log('staged ' + row.id + ' -> ' + rel);
  }
  saveState(state);
  touchLock();
  writeProgress(state, manifest);
  console.log('publish: ' + staged + ' article(s) staged — commit them, then run: ' +
    'factory-batch.mjs finalize-publish --commit <sha-of-the-pushed-commit>');
}

// PHASE 2: flip staged rows to published ONLY after the article files are
// verified inside the given commit on origin/main.
function cmdFinalizePublish(commitArg) {
  if (!commitArg) fail('finalize-publish requires --commit <sha>');
  const manifest = loadManifest();
  const state = loadState();
  if (!state) fail('finalize-publish: no active batch');
  acquireLock(state.batch);
  const staged = state.rows.filter(r => r.status === 'staged');
  if (!staged.length) fail('finalize-publish: nothing staged (run publish first)');
  if (!gitOk(['cat-file', '-e', commitArg + '^{commit}'])) fail('commit ' + commitArg + ' not found');
  if (!gitOk(['merge-base', '--is-ancestor', commitArg, 'origin/main'])) {
    fail('commit ' + commitArg + ' is not an ancestor of origin/main — the publication commit was not pushed');
  }
  const files = new Set((gitOut(['diff-tree', '--no-commit-id', '--name-only', '-r', commitArg]) || '').split('\n').filter(Boolean));
  const missing = staged.filter(r => !files.has(r.post_file));
  if (missing.length) {
    for (const m of missing) console.error('::error::finalize-publish: ' + m.post_file + ' not present in commit ' + commitArg);
    fail('finalize-publish refused: staged articles are not in the given commit — state stays staged (rollback if the promotion is unwanted)');
  }
  finalizeState(state, manifest, commitArg);
}

function finalizeState(state, manifest, commitSha) {
  const finishedAt = nowIso();
  for (const row of state.rows) {
    if (row.status !== 'staged') continue;
    row.status = TERMINAL_ROW;
    row.published = true;
    row.published_at = today();
    row.finalized_at = finishedAt;
    console.log('published ' + row.id + ' (commit ' + commitSha + ')');
  }
  const history = loadHistory();
  history.push({
    batch: state.batch,
    commit: commitSha,
    finalized_at: finishedAt,
    published: state.rows.filter(r => r.status === TERMINAL_ROW).map(r => r.id)
  });
  const tmp = HISTORY_PATH + '.tmp';
  writeFileSync(tmp, JSON.stringify(history, null, 2) + '\n');
  renameSync(tmp, HISTORY_PATH);
  saveState(state);
  writeProgress(state, manifest);
  releaseLock();
  console.log('finalize-publish OK: batch ' + state.batch + ' published in commit ' + commitSha);
}

// Undo an UNCOMMITTED promotion: move posts back to drafts, restore PASS.
// Committed content can never be rolled back (never lose or overwrite
// published articles).
function cmdRollback(reasonArg) {
  const manifest = loadManifest();
  const state = loadState();
  if (!state) fail('rollback: no active batch');
  acquireLock(state.batch);
  const staged = state.rows.filter(r => r.status === 'staged');
  if (!staged.length) { console.log('rollback: nothing staged — no uncommitted promotion to undo'); releaseLock(); return; }
  for (const row of staged) {
    if (row.post_file && gitOk(['cat-file', '-e', 'origin/main:' + row.post_file])) {
      fail('rollback refused: ' + row.post_file + ' is already committed on origin/main — run finalize-publish instead (published content is never rolled back)');
    }
  }
  for (const row of staged) {
    if (!row.post_file) { row.status = 'pass'; continue; }
    const pp = join(ROOT, row.post_file);
    if (existsSync(pp)) {
      const target = draftPath(state.batch, row.slug);
      if (existsSync(target)) fail('rollback: draft target exists for ' + row.slug + ' — refusing to overwrite');
      renameSync(pp, target);
    }
    row.status = 'pass';
    delete row.staged_at; delete row.post_file;
    console.log('rollback: ' + row.slug + ' moved back to drafts (uncommitted promotion undone)');
  }
  if (reasonArg) state.rollback_reason = reasonArg;
  saveState(state);
  writeProgress(state, manifest);
  releaseLock();
  console.log('rollback: batch ' + state.batch + ' restored to pre-promotion state; rerun qa then publish when ready');
}

function cmdRequeue(idsArg) {
  const manifest = loadManifest();
  const state = loadState();
  if (!state) fail('requeue: no active batch');
  if (!idsArg) fail('requeue requires --ids');
  acquireLock(state.batch);
  const ids = idsArg.split(',').map(s => s.trim()).filter(Boolean);
  let done = 0, refused = 0;
  for (const id of ids) {
    const row = state.rows.find(r => r.id === id);
    if (!row) { console.error('REFUSED ' + id + ': not in batch'); refused++; continue; }
    if (row.status === TERMINAL_ROW) { console.error('REFUSED ' + id + ': published rows are never regenerated'); refused++; continue; }
    if (!REQUEUEABLE.includes(row.status)) { console.error('REFUSED ' + id + ': only FAIL/REVIEW rows can be requeued (is ' + row.status + ')'); refused++; continue; }
    row.status = 'claimed'; delete row.qa; done++;
  }
  saveState(state);
  touchLock();
  writeProgress(state, manifest);
  console.log('requeue: ' + done + ' requeued, ' + refused + ' refused');
  if (refused) process.exit(4);
}

function cmdProgress() {
  const manifest = loadManifest();
  const state = loadState();
  if (!state) { console.log('progress: no active batch'); return; }
  writeProgress(state, manifest);
  console.log('progress: reports/factory/progress.json updated for ' + state.batch);
}

// -------------------------------------------------------------------- main

function usage() {
  console.error('usage: factory-batch.mjs <' + ALLOWED_OPS.join('|') +
    '> [--batch-size N] [--expected-size N] [--ids a,b] [--commit SHA] [--reason TEXT]');
  process.exit(2);
}

const argv = process.argv.slice(2);
const op = argv[0];
if (!ALLOWED_OPS.includes(op)) usage();
const arg = (name) => { const i = argv.indexOf(name); return i !== -1 ? argv[i + 1] : undefined; };

switch (op) {
  case 'check-config': cmdCheckConfig(); break;
  case 'consistency': cmdConsistency(); break;
  case 'recover': cmdRecover(); break;
  case 'lock-status': cmdLockStatus(); break;
  case 'prepare-next': cmdPrepareNext(arg('--batch-size')); break;
  case 'qa': cmdQa(); break;
  case 'assert-ready': cmdAssertReady(arg('--expected-size')); break;
  case 'publish': cmdPublish(); break;
  case 'finalize-publish': cmdFinalizePublish(arg('--commit')); break;
  case 'rollback': cmdRollback(arg('--reason')); break;
  case 'requeue': cmdRequeue(arg('--ids')); break;
  case 'progress': cmdProgress(); break;
  default: usage();
}
