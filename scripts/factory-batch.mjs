#!/usr/bin/env node
// factory-batch.mjs — deterministic batch controller for the API-free
// content factory of codeappweb/lab.
//
// Repair 2026-09-29 — publication transactions, locking and lifecycle:
//   - SHARED LOCK/CLAIM PROTOCOL (data/factory-lock.json) with batch_id,
//     run_id, started_at and last_checkpoint, shared by both content
//     workflows and the authenticated writer session. A valid active lock
//     prevents a second worker from processing the same work; a stale lock
//     is recovered only after checking ownership and repository state, and
//     the SAME unfinished batch is resumed.
//   - ATOMIC STATE WRITES (tmp + rename). Corrupt state is a hard error —
//     it is never silently treated as "no active batch".
//   - TRANSACTIONAL PUBLISH: publish only PROMOTES drafts to _posts and
//     marks rows 'staged'. Rows become 'published' only in
//     finalize-publish, AFTER the commit reached origin/main. A failure
//     before that (rollback) restores drafts and never persists false
//     published statuses.
//   - BIDIRECTIONAL RECONCILIATION (recover/consistency) between state,
//     manifest, drafts and posts.
//   - UNIQUE BATCH IDS (batch-YYYY-MM-DD-NNN) even for several batches on
//     the same day; completed batches are recorded in data/factory-history.json.
//   - PARTIAL BATCHES: a deliberately smaller batch and a final partial
//     batch are supported; every row in the batch must still PASS.
//
// HARD RULES (unchanged):
//   - This script NEVER calls an AI API, NEVER writes article prose and
//     NEVER invents facts. The authenticated writer session (or a human)
//     is the sole writer of every article body.
//   - Hard batch cap: BATCH_SIZE_LIMIT rows (20).
//   - Never overwrite a published article, never reset progress, never
//     publish FAIL/REVIEW rows.
//
// Whitelisted operator commands (anything else exits 2):
//   check-config | consistency | recover | prepare-next | qa |
//   assert-ready | publish | finalize-publish | rollback | requeue | progress | lock-status
//
// Exit codes:
//   0 ok
//   1 tool/config error, corrupt state, lock conflict, or a BLOCKING gate refused
//   2 usage error (including invalid batch size)
//   3 FAIL rows found by qa
//   5 REVIEW rows found by qa (legal review pending)
//   4 refused requeue requests (recorded, not fatal)

import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync, renameSync, statSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

const ROOT = new URL('..', import.meta.url).pathname;
const MANIFEST_PATH = join(ROOT, 'data', 'article-manifest.jsonl');
const STATE_PATH = join(ROOT, 'data', 'factory-state.json');
const LOCK_PATH = join(ROOT, 'data', 'factory-lock.json');
const HISTORY_PATH = join(ROOT, 'data', 'factory-history.json');
const REPORTS_DIR = join(ROOT, 'reports', 'factory');
const POSTS_DIR = join(ROOT, '_posts');
const DRAFTS_ROOT = join(ROOT, '_drafts');
const SCHEMA_DOC = 'docs/SCHEMA-ARTICLE.md';

const BATCH_SIZE_LIMIT = 20;
const LOCK_STALE_MS = parseInt(process.env.FACTORY_LOCK_STALE_MS || '', 10) || 6 * 3600 * 1000;
const RUN_ID = process.env.FACTORY_RUN_ID || 'local-' + randomUUID();
const ALLOWED_OPS = [
  'check-config', 'consistency', 'recover', 'prepare-next', 'qa',
  'assert-ready', 'publish', 'finalize-publish', 'rollback', 'requeue', 'progress', 'lock-status'
];
const TERMINAL_ROW = 'published';
const REQUEUEABLE = ['fail', 'review'];
const CJK = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af]/;
const UNDEF = /undefined/;
const TODAY = new Date().toISOString().slice(0, 10);

function fail(msg) { console.error('::error::' + msg); process.exit(1); }
function usage() {
  console.error('usage: factory-batch.mjs <' + ALLOWED_OPS.join('|') +
    '> [--batch-size N] [--expected-size N] [--ids a,b] [--commit SHA]');
  process.exit(2);
}
function arg(name) {
  const argv = process.argv.slice(2);
  const i = argv.indexOf(name);
  return i !== -1 ? argv[i + 1] : undefined;
}

// ---------------------------------------------------------------- git helpers

function git(args) {
  const r = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8' });
  if (r.error) return null; // git unavailable (rare, e.g. bare sandbox)
  return { status: r.status, stdout: r.stdout || '' };
}
// Is the file part of a commit reachable from HEAD (i.e. repository truth)?
function isCommitted(path) {
  const r = git(['ls-files', '--error-unmatch', '--', path]);
  if (!r) return null; // git unavailable — caller falls back to disk presence
  return r.status === 0;
}

// ---------------------------------------------------------------- manifest

function loadManifest() {
  return readFileSync(MANIFEST_PATH, 'utf8').split('\n')
    .filter(Boolean).map(JSON.parse);
}

function postFiles() {
  if (!existsSync(POSTS_DIR)) return [];
  return readdirSync(POSTS_DIR).filter(f => f.endsWith('.md'));
}
function postSlug(f) { return f.replace(/^\d{4}-\d{2}-\d{2}-/, '').replace(/\.md$/, ''); }
function postPathFor(slug) {
  for (const f of postFiles()) if (postSlug(f) === slug) return join(POSTS_DIR, f);
  return null;
}
function publishedSlugs() { return new Set(postFiles().map(postSlug)); }

// ------------------------------------------------------------------- state
// Atomic writes (tmp + rename); corrupt state is a HARD error and is never
// silently treated as "no active batch".

function loadStateRaw() {
  if (!existsSync(STATE_PATH)) return null;
  let text;
  try { text = readFileSync(STATE_PATH, 'utf8'); }
  catch (e) { fail('factory state unreadable (' + e.message + ') — inspect data/factory-state.json manually'); }
  let s;
  try { s = JSON.parse(text); }
  catch (e) { fail('CORRUPT factory state (JSON parse error: ' + e.message + ') — data/factory-state.json is damaged; refusing to treat it as "no active batch". Repair or restore it manually before continuing.'); }
  if (!s || typeof s.batch !== 'string' || !Array.isArray(s.rows)) {
    fail('CORRUPT factory state (missing batch/rows) — refusing to treat it as "no active batch"');
  }
  return s;
}

function saveState(state) {
  state.updated_at = new Date().toISOString();
  if (state.phase === undefined) state.phase = 'awaiting-writer';
  const order = ['claimed', 'pass', 'fail', 'review', 'staged', 'published'];
  state.rows.sort((a, b) => order.indexOf(a.status) - order.indexOf(b.status) || a.id.localeCompare(b.id));
  if (state.rows.length > BATCH_SIZE_LIMIT) {
    fail('state has more rows than the hard batch cap (' + BATCH_SIZE_LIMIT + ')');
  }
  const tmp = STATE_PATH + '.tmp';
  writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n');
  renameSync(tmp, STATE_PATH); // atomic
}

function phaseFor(state) {
  if (!state.rows.length) return 'awaiting-writer';
  const st = new Set(state.rows.map(r => r.status));
  if (st.has('staged')) return 'publishing';
  if ([...st].every(s => s === 'published')) return 'published';
  if (st.has('fail') || st.has('review')) return 'blocked';
  if ([...st].every(s => s === 'pass')) return 'ready';
  return 'awaiting-writer';
}

function activeBatchId(state) {
  if (state && state.rows.some(r => r.status !== TERMINAL_ROW)) return state.batch;
  return null;
}

function draftDir(batch) { return join(DRAFTS_ROOT, batch); }
function draftPath(batch, slug) { return join(draftDir(batch), slug + '.md'); }

// ------------------------------------------------------- lock/claim protocol

function loadLock() {
  if (!existsSync(LOCK_PATH)) return null;
  let lock;
  try { lock = JSON.parse(readFileSync(LOCK_PATH, 'utf8')); }
  catch (e) { fail('CORRUPT factory lock (' + e.message + ') — refusing to guess lock state; inspect data/factory-lock.json'); }
  if (!lock || !lock.batch_id || !lock.run_id || !lock.started_at) {
    fail('CORRUPT factory lock (missing batch_id/run_id/started_at) — inspect data/factory-lock.json');
  }
  return lock;
}

function lockFresh(lock) {
  return (Date.now() - Date.parse(lock.last_checkpoint || lock.started_at)) < LOCK_STALE_MS;
}

// Acquire the lock. Fails (exit 1) when a fresh lock belongs to another run.
// A stale lock is recovered only after checking ownership and repository
// state, and the SAME unfinished batch is resumed.
function acquireLock(batchId) {
  const lock = loadLock();
  const now = new Date().toISOString();
  if (lock) {
    if (lock.run_id === RUN_ID) {
      lock.last_checkpoint = now;
      if (batchId) lock.batch_id = batchId;
      writeLock(lock);
      return lock;
    }
    if (lockFresh(lock)) {
      fail('lock held by another worker (run ' + lock.run_id + ', batch ' + lock.batch_id +
        ', checkpoint ' + lock.last_checkpoint + ') — refusing to process the same work concurrently');
    }
    // Stale lock takeover: verify ownership claims against repository state
    // before resuming. The lock must point at the unfinished batch recorded
    // in state (or a batch that was never started).
    const state = loadStateRaw();
    if (state && activeBatchId(state) && state.batch !== lock.batch_id) {
      fail('stale lock points at batch ' + lock.batch_id + ' but the unfinished state batch is ' +
        state.batch + ' — refusing takeover until the discrepancy is resolved manually');
    }
    console.log('recovering STALE lock (run ' + lock.run_id + ', checkpoint ' +
      lock.last_checkpoint + ') — resuming the same unfinished batch ' + lock.batch_id);
    const resumed = { batch_id: lock.batch_id, run_id: RUN_ID, started_at: lock.started_at, resumed_at: now, last_checkpoint: now, previous_run_id: lock.run_id };
    writeLock(resumed);
    return resumed;
  }
  const fresh = { batch_id: batchId, run_id: RUN_ID, started_at: now, last_checkpoint: now };
  writeLock(fresh);
  return fresh;
}

function writeLock(lock) {
  const tmp = LOCK_PATH + '.tmp';
  writeFileSync(tmp, JSON.stringify(lock, null, 2) + '\n');
  renameSync(tmp, LOCK_PATH);
}

function checkpointLock() {
  const lock = loadLock();
  if (lock && lock.run_id === RUN_ID) { lock.last_checkpoint = new Date().toISOString(); writeLock(lock); }
}

function releaseLock() {
  const lock = loadLock();
  if (lock && lock.run_id !== RUN_ID) {
    fail('cannot release lock owned by run ' + lock.run_id);
  }
  if (existsSync(LOCK_PATH)) rmSync(LOCK_PATH);
}

// ------------------------------------------------------------- batch history

function loadHistory() {
  if (!existsSync(HISTORY_PATH)) return { completed: [] };
  try { return JSON.parse(readFileSync(HISTORY_PATH, 'utf8')); }
  catch (e) { fail('CORRUPT factory history (' + e.message + ') — inspect data/factory-history.json'); }
}
function saveHistory(h) {
  const tmp = HISTORY_PATH + '.tmp';
  writeFileSync(tmp, JSON.stringify(h, null, 2) + '\n');
  renameSync(tmp, HISTORY_PATH);
}

// Unique batch ids even when several batches finish on the same day:
// batch-YYYY-MM-DD-001, -002, ... never colliding with existing draft dirs,
// report dirs, completed history or the current state.
function nextBatchId() {
  const base = 'batch-' + TODAY;
  const used = new Set();
  if (existsSync(DRAFTS_ROOT)) for (const d of readdirSync(DRAFTS_ROOT)) used.add(d);
  if (existsSync(REPORTS_DIR)) for (const d of readdirSync(REPORTS_DIR)) used.add(d);
  for (const c of loadHistory().completed) used.add(c.batch_id);
  const state = loadStateRaw();
  if (state) used.add(state.batch);
  let n = 1;
  while (used.has(base + '-' + String(n).padStart(3, '0'))) n++;
  return base + '-' + String(n).padStart(3, '0');
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
      'Legal topics: verified official source required, or needs_legal_review: true.'
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

// ------------------------------------------------------------ taxonomy / links

function loadTaxonomy() {
  // parent slugs at indent 4, child slugs at indent 8 under their parent
  const tax = { parents: new Set(), children: new Map() };
  try {
    const text = readFileSync(join(ROOT, 'data', 'taxonomy.yml'), 'utf8');
    let parent = null;
    for (const line of text.split('\n')) {
      const p = line.match(/^    slug: "(.+)"$/);
      if (p) { tax.parents.add(p[1]); parent = p[1]; continue; }
      const c = line.match(/^        slug: "(.+)"$/);
      if (c && parent) { if (!tax.children.has(parent)) tax.children.set(parent, new Set()); tax.children.get(parent).add(c[1]); }
    }
  } catch { /* missing taxonomy reported elsewhere */ }
  return tax;
}

function knownLinkTargets() {
  const known = new Set(['/', '/danh-muc/', '/sitemap.xml', '/feed.xml',
    '/gioi-thieu/', '/lien-he/', '/faq/', '/dich-vu/', '/bao-mat/', '/dieu-khoan/']);
  for (const s of publishedSlugs()) known.add('/' + s + '/');
  const tax = loadTaxonomy();
  for (const p of tax.parents) {
    known.add('/danh-muc/' + p + '/');
    for (const ch of (tax.children.get(p) || new Set())) known.add('/danh-muc/' + p + '/' + ch + '/');
  }
  return known;
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
    const lm = line.match(/^\s*-\s*"?(.*?)"?\s*$/);
    if (lm && listKey) { (lists[listKey] ||= []).push(lm[1]); continue; }
    const km = line.match(/^([a-z_]+):\s*"?(.*?)"?\s*$/);
    if (km) { fm[km[1]] = km[2]; listKey = (km[1] === 'entities' || km[1] === 'related_articles') ? km[1] : null; }
  }
  return { fm, lists, body, raw };
}

function wordCount(body) { return body.split(/\s+/).filter(Boolean).length; }

function shingles(text) {
  const words = text.toLowerCase().split(/[^a-z0-9à-ỹ]+/).filter(w => w.length > 2);
  const out = new Set();
  for (let i = 0; i + 2 < words.length; i++) out.add(words[i] + ' ' + words[i + 1] + ' ' + words[i + 2]);
  return out;
}
function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

function qaDraft(state, row, manifestRec, seen, shingleIndex, knownTargets) {
  const path = draftPath(state.batch, row.slug);
  const reasons = [];
  if (!existsSync(path)) return { status: 'absent', reasons: ['draft file not written yet'], checked_at: new Date().toISOString() };
  const text = readFileSync(path, 'utf8');
  const parsed = parseFrontMatter(text);
  if (!parsed) return { status: 'fail', reasons: ['missing or malformed front matter'], checked_at: new Date().toISOString() };
  const { fm, lists, body } = parsed;

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

  // taxonomy: parent/child must be a valid pair in data/taxonomy.yml
  const tax = loadTaxonomy();
  const pc = fm.parent_category, cc = fm.child_category;
  if (pc && !tax.parents.has(pc)) reasons.push('unknown parent_category: ' + pc);
  if (pc && cc && !(tax.children.get(pc) || new Set()).has(cc)) reasons.push('child_category ' + cc + ' is not a child of ' + pc);

  // internal link targets must be real (posts, same-batch drafts, category/static pages)
  const badLinks = new Set();
  for (const m of body.matchAll(/\]\(\{\{\s*'([^']+)'\s*\|\s*relative_url\s*\}\}\)/g)) {
    const loc = m[1];
    if (!loc.startsWith('/')) continue;
    if (!knownTargets.has(loc.endsWith('/') ? loc : loc + '/')) badLinks.add(loc);
  }
  for (const m of body.matchAll(/\]\((\/[^)#\s]+)\)/g)) {
    const loc = m[1];
    if (!knownTargets.has(loc.endsWith('/') ? loc : loc + '/')) badLinks.add(loc);
  }
  for (const l of badLinks) reasons.push('internal link target does not exist: ' + l);

  // ---- legal review gate (BLOCKING: never publishable PASS while in review)
  const legal = fm.legal_sensitivity === 'true' || (manifestRec && manifestRec.needs_official_source);
  if (legal) {
    if (fm.needs_legal_review === 'true') {
      reasons.push('NEEDS LEGAL REVIEW: authoritative verification unavailable — row is REVIEW, never PASS');
    } else if (fm.verification_status !== 'verified' || !fm.verified_source) {
      reasons.push('legal article without verified_source/verification_status=verified — row is REVIEW');
    } else if (!fm.last_verified || !fm.next_review) {
      reasons.push('legal article missing last_verified/next_review — row is REVIEW');
    } else if (fm.next_review < TODAY) {
      reasons.push('legal review overdue (next_review ' + fm.next_review + ') — row is REVIEW');
    }
    if (manifestRec && manifestRec.needs_official_source && fm.legal_sensitivity !== 'true') {
      reasons.push('manifest requires an official source but the draft does not declare legal_sensitivity: true');
    }
  }

  // duplicate detection against every other post + draft (title/desc/id)
  const key = 'id:' + (fm.id || '');
  for (const kind of ['title:' + t.toLowerCase(), 'desc:' + d.toLowerCase(), key]) {
    if (seen.has(kind) && seen.get(kind) !== row.id) {
      reasons.push('duplicate ' + kind.split(':')[0] + ' conflicts with ' + seen.get(kind));
    }
  }

  // substantially duplicated body (3-gram Jaccard >= 0.8)
  const myShingles = shingles(body);
  for (const [owner, sh] of shingleIndex) {
    if (owner !== row.id && jaccard(myShingles, sh) >= 0.8) {
      reasons.push('body substantially duplicated with ' + owner);
    }
  }

  const review = reasons.some(r => r.includes('REVIEW'));
  const status = reasons.length ? (review ? 'review' : 'fail') : 'pass';
  return { status, reasons, words, links, checked_at: new Date().toISOString() };
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
    if (t) seen.set('title:' + t, ownerId);
    if (d) seen.set('desc:' + d, ownerId);
    if (id) seen.set('id:' + id, ownerId);
  };
  for (const f of postFiles()) scan(join(POSTS_DIR, f), postSlug(f));
  for (const dir of existsSync(DRAFTS_ROOT) ? readdirSync(DRAFTS_ROOT) : []) {
    const full = join(DRAFTS_ROOT, dir);
    let isDir = false;
    try { isDir = statSync(full).isDirectory(); } catch { continue; }
    if (!isDir) continue;
    try {
      for (const f of readdirSync(full)) {
        if (f.endsWith('.md') && f.replace(/\.md$/, '') !== excludeSlug) scan(join(full, f), dir + '/' + f);
      }
    } catch { /* not a directory */ }
  }
  return seen;
}

function buildShingleIndex(excludeId) {
  const idx = new Map();
  const scan = (file, ownerId) => {
    let parsed;
    try { parsed = parseFrontMatter(readFileSync(file, 'utf8')); } catch { return; }
    if (!parsed) return;
    idx.set(ownerId, shingles(parsed.body));
  };
  for (const f of postFiles()) scan(join(POSTS_DIR, f), 'post:' + postSlug(f));
  const dir = existsSync(DRAFTS_ROOT) ? readdirSync(DRAFTS_ROOT) : [];
  for (const b of dir) {
    const full = join(DRAFTS_ROOT, b);
    let isDir = false;
    try { isDir = statSync(full).isDirectory(); } catch { continue; }
    if (!isDir) continue;
    try {
      for (const f of readdirSync(full)) {
        if (f.endsWith('.md')) scan(join(full, f), b + '/' + f.replace(/\.md$/, ''));
      }
    } catch { /* not a directory */ }
  }
  if (excludeId) for (const k of [...idx.keys()]) if (k === excludeId) idx.delete(k);
  return idx;
}

// ------------------------------------------------------------- progress

function writeProgress(state, manifest) {
  mkdirSync(REPORTS_DIR, { recursive: true });
  const counts = { claimed: 0, pass: 0, fail: 0, review: 0, staged: 0, published: 0, absent: 0 };
  for (const r of state.rows) {
    if (r.status === 'claimed' && r.qa && r.qa.status === 'absent') counts.absent++;
    else if (counts[r.status] !== undefined) counts[r.status]++;
  }
  const planned = manifest.filter(r => r.status === 'planned').length;
  const publishedTotal = manifest.filter(r => r.status === 'published').length;
  const postsOnDisk = postFiles().length;
  const prog = {
    batch: state.batch,
    phase: phaseFor(state),
    updated_at: new Date().toISOString(),
    batch_rows: state.rows.length,
    counts,
    // waiting-for-writer vs ready-to-publish are explicit, distinct states:
    waiting_for_writer: counts.absent + counts.claimed,
    ready_to_publish: counts.pass,
    blocked: counts.fail + counts.review,
    queue: { planned, published: publishedTotal, posts_on_disk: postsOnDisk, target: 20000 },
    hard_cap: BATCH_SIZE_LIMIT,
    writer: 'authenticated Mistral/Vibe session (GitHub Actions never calls an AI API)'
  };
  writeFileSync(join(REPORTS_DIR, 'progress.json'), JSON.stringify(prog, null, 2) + '\n');
  const md = [
    '# Content factory progress', '',
    '- batch: ' + state.batch + ' (phase: ' + prog.phase + ')',
    '- rows: ' + state.rows.length + ' / hard cap ' + BATCH_SIZE_LIMIT,
    '- waiting for writer: ' + prog.waiting_for_writer + ' | ready to publish: ' + prog.ready_to_publish +
      ' | blocked (fail/review): ' + prog.blocked + ' | published: ' + counts.published,
    '- queue: ' + planned + ' planned / ' + publishedTotal + ' published in manifest / ' +
      postsOnDisk + ' posts on disk — 20000 is the long-term target, NOT the number of planned topics', ''
  ].join('\n');
  writeFileSync(join(REPORTS_DIR, 'factory-progress.md'), md + '\n');
}

// ---------------------------------------------------------------- commands

function cmdCheckConfig() {
  if (!existsSync(MANIFEST_PATH)) fail('data/article-manifest.jsonl missing');
  const manifest = loadManifest();
  const bad = manifest.filter(r => !r.id || !r.slug || !r.status);
  if (bad.length) fail('manifest rows missing id/slug/status: ' + bad.map(r => r.id).join(', '));
  console.log('factory config OK: ' + manifest.length + ' manifest rows, hard cap ' +
    BATCH_SIZE_LIMIT + ', lock stale after ' + (LOCK_STALE_MS / 3600000) + 'h, no AI API keys (deterministic controller only)');
}

function cmdLockStatus() {
  const lock = loadLock();
  if (!lock) { console.log('no factory lock (no active claim)'); return; }
  const fresh = lockFresh(lock);
  console.log('lock: batch ' + lock.batch_id + ' run ' + lock.run_id +
    ' started ' + lock.started_at + ' checkpoint ' + lock.last_checkpoint +
    (fresh ? ' (ACTIVE — a second worker will be refused)' : ' (STALE — recoverable after ownership checks)'));
}

function cmdConsistency() {
  const manifest = loadManifest();
  const state = loadStateRaw(); // corrupt state is a hard error, never "no state"
  if (!state) { console.log('consistency OK: no factory state yet'); return; }
  const byId = new Map(manifest.map(r => [r.id, r]));
  const bySlug = new Map(manifest.map(r => [r.slug, r]));
  const errs = [];
  const posts = publishedSlugs();
  for (const row of state.rows) {
    const rec = byId.get(row.id);
    if (!rec) errs.push('row ' + row.id + ' not in manifest');
    if (rec && rec.status === 'published' && row.status !== 'published') {
      errs.push('row ' + row.id + ' is published in manifest but "' + row.status + '" in state');
    }
    if (row.status === 'published' && !posts.has(row.slug)) {
      errs.push('row ' + row.id + ' is published in state but the post file is missing');
    }
    if (row.status !== 'published' && posts.has(row.slug) && isCommitted(join(POSTS_DIR, postPathFor(row.slug) || '')) !== false) {
      errs.push('row ' + row.id + ' is "' + row.status + '" in state but its post exists');
    }
  }
  // manifest <-> posts (both directions)
  for (const rec of manifest.filter(r => r.status === 'published')) {
    if (!posts.has(rec.slug)) errs.push('manifest row ' + rec.id + ' is published but the post file is missing');
  }
  const uncounted = [...posts].filter(s => !bySlug.has(s));
  if (uncounted.length) errs.push('posts on disk missing from the manifest (run sync-manifest reconcile): ' + uncounted.join(', '));
  if (state.rows.length > BATCH_SIZE_LIMIT) errs.push('state exceeds hard batch cap');
  if (!/^batch-\d{4}-\d{2}-\d{2}(-\d{3})?$/.test(state.batch)) errs.push('invalid batch id ' + state.batch);
  if (errs.length) { for (const e of errs) console.error('FAIL: ' + e); process.exit(1); }
  console.log('consistency OK: ' + state.rows.length + ' rows reconcile with manifest and posts');
}

function cmdRecover() {
  const manifest = loadManifest();
  const state = loadStateRaw();
  if (!state) { console.log('recover: no state to recover'); return; }
  const posts = publishedSlugs();
  let fixed = 0;
  const notes = [];

  // If the posts of a publishing batch are committed on main but finalize
  // never ran (interrupted between push and finalize), complete the
  // transaction now — never lose the publication.
  const stagedRows = state.rows.filter(r => r.status === 'staged');
  if (stagedRows.length) {
    const allCommitted = stagedRows.every(r => {
      const p = postPathFor(r.slug);
      if (!p) return false;
      const c = isCommitted(p);
      return c === true || c === null; // git unavailable → trust disk presence
    });
    if (allCommitted) {
      for (const r of stagedRows) { r.status = 'published'; r.published = true; r.published_at = r.published_at || TODAY; fixed++; }
      notes.push('completed interrupted publication: ' + stagedRows.length + ' staged row(s) confirmed published');
      const h = loadHistory();
      if (!h.completed.some(c => c.batch_id === state.batch)) {
        h.completed.push({ batch_id: state.batch, finished_at: new Date().toISOString(), rows: state.rows.length, commit: state.published_commit || null });
        saveHistory(h);
      }
      if (existsSync(LOCK_PATH)) releaseLock();
    } else {
      // posts promoted but never committed: publication did NOT happen.
      // Move posts back to drafts and restore the batch — no false published.
      for (const r of stagedRows) {
        const p = postPathFor(r.slug);
        const dp = draftPath(state.batch, r.slug);
        if (p && !existsSync(dp)) {
          if (isCommitted(p) === true) { notes.push('row ' + r.id + ': post already committed — left for finalize'); continue; }
          renameSync(p, dp);
        }
        r.status = 'pass';
        fixed++;
      }
      notes.push('rolled back uncommitted promotion: ' + stagedRows.length + ' row(s) returned to ready state');
    }
  }

  for (const row of state.rows) {
    if (posts.has(row.slug) && row.status !== 'published') {
      row.status = 'published'; row.published = true; fixed++;
    }
    if (row.status === 'published' && !posts.has(row.slug)) {
      // FALSE published state: never silently accept.
      fail('FALSE PUBLISHED STATE: row ' + row.id + ' is marked published but its post is missing from _posts — repair the repository before continuing');
    }
    if (row.status !== 'published' && !existsSync(draftPath(state.batch, row.slug)) && !posts.has(row.slug)) {
      if (row.status !== 'claimed') { row.status = 'claimed'; delete row.qa; fixed++; }
    }
  }
  state.phase = phaseFor(state);
  saveState(state);
  for (const n of notes) console.log('recover: ' + n);
  console.log('recover: ' + fixed + ' row(s) reconciled with repository truth');
}

function parseBatchSize(raw) {
  if (raw === undefined) return BATCH_SIZE_LIMIT;
  if (!/^\d+$/.test(String(raw))) { console.error('::error::invalid batch size "' + raw + '" — must be an integer between 1 and ' + BATCH_SIZE_LIMIT); process.exit(2); }
  const n = parseInt(String(raw), 10);
  if (n < 1 || n > BATCH_SIZE_LIMIT) { console.error('::error::invalid batch size ' + n + ' — must be between 1 and ' + BATCH_SIZE_LIMIT); process.exit(2); }
  return n;
}

function cmdPrepareNext(batchSizeArg) {
  const size = parseBatchSize(batchSizeArg);
  const manifest = loadManifest();
  const posts = publishedSlugs();
  let state = loadStateRaw();

  // Resume unfinished work before claiming new work.
  let batch = activeBatchId(state);
  if (batch) {
    acquireLock(batch);
    checkpointLock();
    state.rows ||= [];
    console.log('prepare-next: unfinished batch ' + batch + ' resumed (no new batch will be claimed until it is finished)');
  } else {
    batch = nextBatchId();
    acquireLock(batch);
    checkpointLock();
    state = { batch, run_id: RUN_ID, created_at: new Date().toISOString(), rows: [] };
    console.log('prepare-next: new batch ' + batch);
  }
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
  state.phase = phaseFor(state);
  saveState(state);
  checkpointLock();
  for (const row of state.rows) exportWriterManifest(state, row, manifest);
  exportWriterInstructions(state, manifest);
  writeProgress(state, manifest);
  console.log('prepare-next: batch ' + batch + ' has ' + state.rows.length +
    ' row(s) (requested size ' + size + ', hard cap ' + BATCH_SIZE_LIMIT + '); writer manifests exported to reports/factory/' + batch + '/');
}

function cmdQa() {
  const manifest = loadManifest();
  const state = loadStateRaw();
  if (!state) { console.log('qa: no active batch — nothing produced by the writer yet'); return; }
  acquireLock(state.batch);
  let fails = 0, passes = 0, absent = 0, reviews = 0;
  const knownTargets = knownLinkTargets();
  for (const row of state.rows) {
    if (row.status === 'published' || row.status === 'staged') continue; // never re-QA published/staged rows
    const seen = buildSeenIndex(row.slug);
    const shingleIdx = buildShingleIndex(null);
    const rec = manifest.find(m => m.id === row.id);
    const qa = qaDraft(state, row, rec, seen, shingleIdx, knownTargets);
    row.qa = qa;
    if (qa.status === 'pass') { row.status = 'pass'; passes++; }
    else if (qa.status === 'absent') { absent++; }
    else if (qa.status === 'review') { row.status = 'review'; reviews++; console.error('REVIEW ' + row.id + ': ' + qa.reasons.join('; ')); }
    else { row.status = 'fail'; fails++; console.error('FAIL ' + row.id + ': ' + qa.reasons.join('; ')); }
  }
  state.phase = phaseFor(state);
  saveState(state);
  checkpointLock();
  writeProgress(state, manifest);
  console.log('qa: ' + passes + ' pass, ' + fails + ' fail, ' + reviews +
    ' review, ' + absent + ' awaiting writer (prose requires the authenticated writer session)');
  if (reviews) process.exit(5);
  if (fails) process.exit(3);
}

// assert-ready: BLOCKING production gate. Publishes only a 100% ready batch.
// A deliberately smaller batch and a final partial batch are supported:
// there is NO unconditional row-count requirement — but every row present
// must be PASS with its draft on disk.
function cmdAssertReady(expectedArg) {
  const manifest = loadManifest();
  const state = loadStateRaw();
  if (!state) fail('assert-ready: no active batch state — run prepare-next first');
  const lock = loadLock();
  if (!lock || lock.run_id !== RUN_ID) fail('assert-ready: the batch lock is not held by this run (' + (lock ? lock.run_id : 'no lock') + ')');
  const errs = [];
  if (state.rows.length < 1) errs.push('batch has no rows');
  if (state.rows.length > BATCH_SIZE_LIMIT) errs.push('batch exceeds the hard cap of ' + BATCH_SIZE_LIMIT);
  if (expectedArg !== undefined) {
    const expected = parseBatchSize(expectedArg);
    if (state.rows.length !== expected) errs.push('batch has ' + state.rows.length + ' rows, expected exactly ' + expected);
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
  if (counts.published) errs.push(counts.published + ' row(s) already published');
  if (counts.staged) errs.push(counts.staged + ' row(s) still staged (publish transaction incomplete)');
  if (errs.length) {
    for (const e of errs) console.error('::error::assert-ready: ' + e);
    fail('assert-ready FAILED — production publish is blocked; ZERO articles may be published');
  }
  console.log('assert-ready OK: ' + state.rows.length + ' row(s), all PASS with drafts on disk (partial batches allowed, every row must pass)');
}

// publish: ALL-OR-NOTHING promotion. Every row must be PASS with its draft
// on disk, and no target post may already exist (never overwrite a
// published article). This step only PROMOTES drafts to _posts and marks
// rows 'staged' — the 'published' status is granted by finalize-publish
// only after the commit reached origin/main. A failure before that runs
// rollback, which restores drafts and keeps rows at PASS.
function cmdPublish() {
  const manifest = loadManifest();
  const state = loadStateRaw();
  if (!state) fail('publish: no active batch');
  const lock = loadLock();
  if (!lock || lock.run_id !== RUN_ID) fail('publish: the batch lock is not held by this run');
  if (state.rows.length === 0) fail('publish: active batch has no rows');
  if (state.rows.some(r => r.status === 'published')) fail('publish: batch already published — nothing to do (idempotent rerun)');
  const posts = publishedSlugs();
  const violations = [];
  for (const row of state.rows) {
    if (row.status !== 'pass') violations.push(row.id + ': status "' + row.status + '" (only a 100% PASS batch may publish)');
    if (!existsSync(draftPath(state.batch, row.slug))) violations.push(row.id + ': draft file missing');
    if (posts.has(row.slug)) violations.push(row.id + ': already published (never overwrite a published article)');
  }
  if (violations.length) {
    for (const v of violations) console.error('::error::publish refused: ' + v);
    fail('publish refused: batch is not 100% ready — ZERO articles published (requeue FAIL rows, rerun qa, then retry)');
  }
  mkdirSync(POSTS_DIR, { recursive: true });
  let staged = 0;
  for (const row of state.rows) {
    const parsed = parseFrontMatter(readFileSync(draftPath(state.batch, row.slug), 'utf8'));
    const date = (parsed && /^\d{4}-\d{2}-\d{2}$/.test(parsed.fm.date || '')) ? parsed.fm.date : TODAY;
    const target = join(POSTS_DIR, date + '-' + row.slug + '.md');
    if (existsSync(target)) {
      fail('publish aborted: ' + target + ' already exists (never overwrite a published article)');
    }
    renameSync(draftPath(state.batch, row.slug), target);
    row.status = 'staged'; row.staged_at = new Date().toISOString(); row.staged_target = '_posts/' + date + '-' + row.slug + '.md';
    staged++;
    console.log('staged ' + row.id + ' -> _posts/' + date + '-' + row.slug + '.md (NOT published until finalize-publish)');
  }
  state.phase = 'publishing';
  state.published_commit = null;
  saveState(state);
  checkpointLock();
  writeProgress(state, manifest);
  console.log('publish: ' + staged + ' article(s) staged (all-or-nothing; run finalize-publish only after the commit reached origin/main)');
}

// finalize-publish: run ONLY after the posts+state commit reached origin/main.
// Flips staged rows to published, records the batch in history, releases the lock.
function cmdFinalizePublish(commitSha) {
  const manifest = loadManifest();
  const state = loadStateRaw();
  if (!state) fail('finalize-publish: no active batch');
  const lock = loadLock();
  if (!lock || lock.run_id !== RUN_ID) fail('finalize-publish: the batch lock is not held by this run');
  const errs = [];
  for (const row of state.rows) {
    const p = postPathFor(row.slug);
    if (!p) errs.push(row.id + ': post file missing — publication did not complete');
    else if (isCommitted(p) === false) errs.push(row.id + ': post ' + row.staged_target + ' is NOT committed — refusing to mark published');
  }
  if (errs.length) { for (const e of errs) console.error('::error::finalize-publish: ' + e); fail('finalize-publish refused — posts did not reach the repository'); }
  for (const row of state.rows) {
    row.status = 'published'; row.published = true; row.published_at = TODAY;
    row.published_commit = commitSha || null;
  }
  state.phase = 'published';
  state.published_commit = commitSha || null;
  saveState(state);
  const h = loadHistory();
  if (!h.completed.some(c => c.batch_id === state.batch)) {
    h.completed.push({ batch_id: state.batch, finished_at: new Date().toISOString(), rows: state.rows.length, commit: commitSha || null });
    saveHistory(h);
  }
  writeProgress(state, manifest);
  releaseLock();
  console.log('finalize-publish: ' + state.rows.length + ' row(s) published (commit ' + (commitSha || 'n/a') + '); lock released; batch ' + state.batch + ' recorded in history');
}

// rollback: failure path AFTER promotion but BEFORE the commit reached
// origin/main. Restores staged posts to drafts, rows back to PASS.
// Committed posts are never rolled back — those belong to recover.
function cmdRollback(reason) {
  const state = loadStateRaw();
  if (!state) { console.log('rollback: no active batch'); return; }
  const stagedRows = state.rows.filter(r => r.status === 'staged');
  if (!stagedRows.length) { console.log('rollback: nothing staged — batch stays at its pre-publish state'); return; }
  mkdirSync(draftDir(state.batch), { recursive: true });
  let restored = 0;
  for (const row of stagedRows) {
    const p = postPathFor(row.slug);
    const dp = draftPath(state.batch, row.slug);
    if (p && !existsSync(dp)) {
      if (isCommitted(p) === true) {
        console.error('rollback: ' + row.id + ': post already committed to the repository — NOT rolling back (run recover instead)');
        continue;
      }
      renameSync(p, dp);
    }
    row.status = 'pass';
    delete row.staged_at; delete row.staged_target;
    restored++;
  }
  state.phase = phaseFor(state);
  state.last_failure = { at: new Date().toISOString(), reason: reason || 'gate failure before publication commit' };
  saveState(state);
  writeProgress(state, loadManifest());
  console.log('rollback: ' + restored + ' staged row(s) restored to drafts; NO false published state persisted' +
    (reason ? ' (reason: ' + reason + ')' : ''));
}

function cmdRequeue(idsArg) {
  const manifest = loadManifest();
  const state = loadStateRaw();
  if (!state) fail('requeue: no active batch');
  acquireLock(state.batch);
  if (!idsArg) fail('requeue requires --ids');
  const ids = idsArg.split(',').map(s => s.trim()).filter(Boolean);
  let done = 0, refused = 0;
  for (const id of ids) {
    const row = state.rows.find(r => r.id === id);
    if (!row) { console.error('REFUSED ' + id + ': not in batch'); refused++; continue; }
    if (row.status === 'published') { console.error('REFUSED ' + id + ': published rows are never regenerated'); refused++; continue; }
    if (!REQUEUEABLE.includes(row.status)) { console.error('REFUSED ' + id + ': only FAIL/REVIEW rows can be requeued (is ' + row.status + ')'); refused++; continue; }
    row.status = 'claimed'; delete row.qa; done++;
  }
  state.phase = phaseFor(state);
  saveState(state);
  checkpointLock();
  writeProgress(state, manifest);
  console.log('requeue: ' + done + ' requeued, ' + refused + ' refused');
  if (refused) process.exit(4);
}

function cmdProgress() {
  const manifest = loadManifest();
  const state = loadStateRaw();
  if (!state) { console.log('progress: no active batch'); return; }
  writeProgress(state, manifest);
  const lock = loadLock();
  console.log('progress: reports/factory/progress.json updated for ' + state.batch +
    ' (phase ' + phaseFor(state) + '; lock ' + (lock ? 'held by run ' + lock.run_id : 'absent') + ')');
}

// -------------------------------------------------------------------- main

const argv = process.argv.slice(2);
const op = argv[0];
if (!ALLOWED_OPS.includes(op)) {
  if (op) console.error('unsupported op: ' + op);
  usage();
}

switch (op) {
  case 'check-config': cmdCheckConfig(); break;
  case 'lock-status': cmdLockStatus(); break;
  case 'consistency': cmdConsistency(); break;
  case 'recover': cmdRecover(); break;
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
