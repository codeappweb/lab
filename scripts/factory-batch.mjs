#!/usr/bin/env node
// factory-batch.mjs — deterministic batch controller for the API-free
// content factory of codeappweb/lab.
//
// Modeled on thuexemayhanoi/shop (scripts/run_article_batch.py +
// scripts/js/factory.mjs), adapted to this repository's Node-only engine.
//
// HARD RULES
//   - This script NEVER calls an AI API, NEVER writes article prose and
//     NEVER invents facts, prices, legal claims or sources. The
//     authenticated Mistral/Vibe writer session (or a human) is the sole
//     writer of every article body.
//   - GitHub Actions runs this script: Actions are deterministic hands.
//   - Hard batch cap: BATCH_SIZE_LIMIT rows (20 for the 2026-09-27 test).
//   - Never overwrite a published article, never reset progress, never
//     regenerate completed rows, never publish FAIL/REVIEW rows.
//
// EXISTING ENGINE REUSED (this controller only adds the deterministic
// claim/QA/promote glue; it does not replace any repository logic):
//   queue        : data/article-manifest.jsonl (single source of truth)
//   publishing   : scripts/sync-manifest.mjs (flips manifest rows to
//                  published once the post file exists)
//   QA gates     : scripts/validate-content-quality.mjs,
//                  scripts/detect-duplicates.mjs, scripts/check-links.mjs,
//                  scripts/validate-deploy.mjs
//   sitemap      : scripts/gen-sitemap-shards.mjs + validate-sitemap.mjs
//   reports      : scripts/seo-score.mjs, compute-content-hashes.mjs,
//                  gen-topic-queue.mjs, gen-dashboard.mjs,
//                  self-heal-audit.mjs, legal-freshness-audit.mjs
//   schema       : docs/SCHEMA-ARTICLE.md (front-matter contract)
//
// Whitelisted operator commands (anything else exits 1):
//   check-config | consistency | recover | prepare-next | qa | publish |
//   requeue | progress
//
// Exit codes: 0 ok, 1 tool/config error, 2 usage error, 3 FAIL rows found
// (recorded, not fatal), 4 refused requeue requests (recorded).

import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const MANIFEST_PATH = join(ROOT, 'data', 'article-manifest.jsonl');
const STATE_PATH = join(ROOT, 'data', 'factory-state.json');
const REPORTS_DIR = join(ROOT, 'reports', 'factory');
const POSTS_DIR = join(ROOT, '_posts');
const DRAFTS_ROOT = join(ROOT, '_drafts');
const SCHEMA_DOC = 'docs/SCHEMA-ARTICLE.md';

const BATCH_SIZE_LIMIT = 20;            // HARD cap for the 2026-09-27 test
const ALLOWED_OPS = [
  'check-config', 'consistency', 'recover',
  'prepare-next', 'qa', 'publish', 'requeue', 'progress'
];
const TERMINAL_ROW = 'published';
const REQUEUEABLE = ['fail', 'review'];
const CJK = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af]/;
const UNDEF = /undefined/;

function today() { return new Date().toISOString().slice(0, 10); }
function fail(msg) { console.error('::error::' + msg); process.exit(1); }

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

function loadState() {
  if (!existsSync(STATE_PATH)) return null;
  try {
    const s = JSON.parse(readFileSync(STATE_PATH, 'utf8'));
    if (!s || !Array.isArray(s.rows) || !s.batch) return null;
    return s;
  } catch { return null; }
}

function saveState(state) {
  state.updated_at = new Date().toISOString();
  const order = ['claimed', 'pass', 'fail', 'review', 'published'];
  state.rows.sort((a, b) => order.indexOf(a.status) - order.indexOf(b.status)
    || a.id.localeCompare(b.id));
  if (state.rows.length > BATCH_SIZE_LIMIT) {
    fail('state has more rows than the hard batch cap (' + BATCH_SIZE_LIMIT + ')');
  }
  writeFileSync(STATE_PATH, JSON.stringify(state, null, 2) + '\n');
}

function activeBatchId(state) {
  if (state && state.rows.some(r => r.status !== TERMINAL_ROW)) return state.batch;
  return null;
}

function draftDir(batch) { return join(DRAFTS_ROOT, batch); }
function draftPath(batch, slug) { return join(draftDir(batch), slug + '.md'); }

function batchIdForToday() {
  const id = 'batch-' + today();
  // never collide with an already-completed batch dir: append -b, -c …
  let candidate = id, n = 0;
  while (existsSync(join(DRAFTS_ROOT, candidate)) && loadState() && loadState().batch !== candidate) {
    n += 1; candidate = id + '-' + String.fromCharCode(96 + n); // -b, -c …
  }
  return candidate;
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

function qaDraft(state, row, seen) {
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

  const legal = /legal_sensitivity:\s*true/.test(text);
  if (legal && !fm.verified_source && !/needs_legal_review:\s*true/.test(text)) {
    reasons.push('legal article without verified_source and without needs_legal_review');
  }

  // duplicate detection against every other post + draft (title/id/description)
  const key = 'id:' + (fm.id || '');
  for (const kind of ['title:' + t.toLowerCase(), 'desc:' + d.toLowerCase(), key]) {
    if (seen.has(kind) && seen.get(kind) !== row.id) {
      reasons.push('duplicate ' + kind.split(':')[0] + ' conflicts with ' + seen.get(kind));
    }
  }

  const status = reasons.length ? 'fail' : 'pass';
  return { status, reasons, words, links, checked_at: new Date().toISOString() };
}

function buildSeenIndex(excludeSlug) {
  // titles/descriptions/ids of all published posts and all other drafts
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

// ------------------------------------------------------------- progress

function writeProgress(state, manifest) {
  mkdirSync(REPORTS_DIR, { recursive: true });
  const counts = { claimed: 0, pass: 0, fail: 0, review: 0, published: 0, absent: 0 };
  for (const r of state.rows) {
    if (r.status === 'claimed' && r.qa && r.qa.status === 'absent') counts.absent++;
    else if (counts[r.status] !== undefined) counts[r.status]++;
  }
  const planned = manifest.filter(r => r.status === 'planned').length;
  const publishedTotal = manifest.filter(r => r.status === 'published').length;
  const prog = {
    batch: state.batch,
    updated_at: new Date().toISOString(),
    batch_rows: state.rows.length,
    counts,
    queue: { planned, published: publishedTotal, target: 20000 },
    hard_cap: BATCH_SIZE_LIMIT,
    writer: 'authenticated Mistral/Vibe session (GitHub Actions never calls an AI API)'
  };
  writeFileSync(join(REPORTS_DIR, 'progress.json'), JSON.stringify(prog, null, 2) + '\n');
  const md = [
    '# Content factory progress', '',
    '- batch: ' + state.batch,
    '- rows: ' + state.rows.length + ' / hard cap ' + BATCH_SIZE_LIMIT,
    '- pass: ' + counts.pass + ' | fail: ' + counts.fail + ' | review: ' + counts.review +
      ' | published: ' + counts.published + ' | awaiting writer: ' + counts.absent,
    '- queue: ' + planned + ' planned / ' + publishedTotal + ' published of 20000 target', ''
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
    BATCH_SIZE_LIMIT + ', no AI API keys (deterministic controller only)');
}

function cmdConsistency() {
  const manifest = loadManifest();
  const state = loadState();
  if (!state) { console.log('consistency OK: no factory state yet'); return; }
  const byId = new Map(manifest.map(r => [r.id, r]));
  const errs = [];
  for (const row of state.rows) {
    if (!byId.has(row.id)) errs.push('row ' + row.id + ' not in manifest');
    const rec = byId.get(row.id);
    if (rec && rec.status === 'published' && row.status !== 'published') {
      errs.push('row ' + row.id + ' is published in manifest but "' + row.status + '" in state');
    }
  }
  if (state.rows.length > BATCH_SIZE_LIMIT) errs.push('state exceeds hard batch cap');
  if (!/^batch-\d{4}-\d{2}-\d{2}(-[a-z])?$/.test(state.batch)) errs.push('invalid batch id ' + state.batch);
  if (errs.length) { for (const e of errs) console.error('FAIL: ' + e); process.exit(1); }
  console.log('consistency OK: ' + state.rows.length + ' rows reconcile with manifest');
}

function cmdRecover() {
  const manifest = loadManifest();
  let state = loadState();
  if (!state) { console.log('recover: no state to recover'); return; }
  const posts = publishedSlugs();
  let fixed = 0;
  for (const row of state.rows) {
    if (posts.has(row.slug) && row.status !== 'published') {
      row.status = 'published'; row.published = true; fixed++;
    }
    if (row.status !== 'published' && !existsSync(draftPath(state.batch, row.slug)) && !posts.has(row.slug)) {
      // writer never produced the file: back to plain claim, never lose the claim
      if (row.status !== 'claimed') { row.status = 'claimed'; delete row.qa; fixed++; }
    }
  }
  saveState(state);
  console.log('recover: ' + fixed + ' row(s) reconciled with repository truth');
}

function cmdPrepareNext(batchSizeArg) {
  const size = Math.min(parseInt(batchSizeArg, 10) || BATCH_SIZE_LIMIT, BATCH_SIZE_LIMIT);
  const manifest = loadManifest();
  const posts = publishedSlugs();
  let state = loadState();
  let batch = activeBatchId(state);
  if (!batch) { batch = batchIdForToday(); state = { batch, created_at: new Date().toISOString(), rows: [] }; }
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
  for (const row of state.rows) exportWriterManifest(state, row, manifest);
  exportWriterInstructions(state, manifest);
  writeProgress(state, manifest);
  console.log('prepare-next: batch ' + batch + ' has ' + state.rows.length +
    ' row(s) (hard cap ' + BATCH_SIZE_LIMIT + '); writer manifests exported to reports/factory/' + batch + '/');
}

function cmdQa() {
  const manifest = loadManifest();
  const state = loadState();
  if (!state) { console.log('qa: no active batch — nothing produced by the writer yet'); return; }
  let fails = 0, passes = 0, absent = 0;
  for (const row of state.rows) {
    if (row.status === 'published') continue; // never re-QA published rows
    const seen = buildSeenIndex(row.slug);
    const qa = qaDraft(state, row, seen);
    row.qa = qa;
    if (qa.status === 'pass') { row.status = 'pass'; passes++; }
    else if (qa.status === 'absent') { absent++; }
    else { row.status = 'fail'; fails++; console.error('FAIL ' + row.id + ': ' + qa.reasons.join('; ')); }
  }
  saveState(state);
  writeProgress(state, manifest);
  console.log('qa: ' + passes + ' pass, ' + fails + ' fail, ' + absent +
    ' awaiting writer (prose requires the authenticated writer session)');
  if (fails) process.exit(3);
}

function cmdPublish() {
  const manifest = loadManifest();
  const state = loadState();
  if (!state) fail('publish: no active batch');
  const posts = publishedSlugs();
  mkdirSync(POSTS_DIR, { recursive: true });
  let published = 0, skipped = 0, blocked = 0;
  for (const row of state.rows) {
    if (row.status === 'published') continue;
    if (row.status !== 'pass') { blocked++; continue; } // FAIL/REVIEW/claimed never publish
    const draft = draftPath(state.batch, row.slug);
    if (!existsSync(draft)) { blocked++; console.error('SKIP ' + row.id + ': no draft file'); continue; }
    const parsed = parseFrontMatter(readFileSync(draft, 'utf8'));
    const date = (parsed && /^\d{4}-\d{2}-\d{2}$/.test(parsed.fm.date || '')) ? parsed.fm.date : today();
    const target = join(POSTS_DIR, date + '-' + row.slug + '.md');
    if (existsSync(target)) {
      skipped++; console.error('SKIP ' + row.id + ': ' + target + ' already exists (never overwrite a published article)');
      continue;
    }
    renameSync(draft, target);
    row.status = 'published'; row.published = true; row.published_at = date;
    published++;
    console.log('published ' + row.id + ' -> _posts/' + date + '-' + row.slug + '.md');
  }
  saveState(state);
  writeProgress(state, manifest);
  console.log('publish: ' + published + ' published, ' + skipped +
    ' skipped (existing), ' + blocked + ' blocked (not PASS)');
}

function cmdRequeue(idsArg) {
  const manifest = loadManifest();
  const state = loadState();
  if (!state) fail('requeue: no active batch');
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
  saveState(state);
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
  console.error('usage: factory-batch.mjs <' + ALLOWED_OPS.join('|') + '> [--batch-size N] [--ids a,b]');
  process.exit(2);
}

const argv = process.argv.slice(2);
const op = argv[0];
if (!ALLOWED_OPS.includes(op)) {
  if (op) console.error('unsupported op: ' + op);
  usage();
}
const arg = (name) => {
  const i = argv.indexOf(name);
  return i !== -1 ? argv[i + 1] : undefined;
};

switch (op) {
  case 'check-config': cmdCheckConfig(); break;
  case 'consistency': cmdConsistency(); break;
  case 'recover': cmdRecover(); break;
  case 'prepare-next': cmdPrepareNext(arg('--batch-size')); break;
  case 'qa': cmdQa(); break;
  case 'publish': cmdPublish(); break;
  case 'requeue': cmdRequeue(arg('--ids')); break;
  case 'progress': cmdProgress(); break;
  default: usage();
}
