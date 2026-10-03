#!/usr/bin/env node
// check-links.mjs — internal link integrity gate.
// Audit fix 2026-09-29: link targets are validated against REPOSITORY TRUTH
// ONLY — posts on disk, category pages on disk (danh-muc/**), hub pages on
// disk (hub/**) and static root pages. A "planned" slug in
// data/article-manifest.jsonl is NOT evidence that a URL exists, so the
// manifest is no longer used as a source of valid targets.
// Checked sources: _posts/**, danh-muc/**, hub/** and root content pages
// (technical docs README/AGENTS/CONTRIBUTING/docs are excluded).
// Both markdown links and Liquid relative_url filters are checked.
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;

// --only a,b  restrict CHECKING to the given files (targets are still built
// from repository truth — a scoped check never weakens target validation).
const onlyIdx = process.argv.indexOf('--only');
const ONLY = onlyIdx !== -1
  ? (process.argv[onlyIdx + 1] || '').split(',').map(s => s.trim().replace(/^\/+/, '')).filter(Boolean)
  : null;

function parseFm(text) {
  if (!text.startsWith('---')) return null;
  const end = text.indexOf('\n---', 3);
  if (end === -1) return null;
  const o = {};
  for (const line of text.slice(3, end).split('\n')) {
    const m = line.match(/^([a-z_]+):\s*\"?([^\"\n]*)\"?\s*$/);
    if (m) o[m[1]] = m[2];
  }
  return o;
}

function walkMd(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walkMd(full, out);
    else if (name.endsWith('.md')) out.push(full);
  }
  return out;
}

// Normalize an internal path: strip the /lab baseurl prefix, query and
// fragment, collapse trailing slashes. Returns '' for the homepage.
function norm(p) {
  return p.replace(/^\/lab(?=\/)/, '').split('#')[0].split('?')[0].replace(/\/+$/, '');
}

// ---- Build the set of valid internal link targets from repository truth ----
const targets = new Set();
function addTarget(raw) {
  const p = norm(raw);
  if (p) targets.add(p);
}

// static root pages (permalink wins over filename)
for (const f of readdirSync(ROOT).filter(f => f.endsWith('.md'))) {
  const meta = parseFm(readFileSync(join(ROOT, f), 'utf8')) || {};
  if (meta.permalink) addTarget(meta.permalink);
  addTarget('/' + f.replace(/\.md$/, ''));
}
targets.add(norm('/index'));

// posts: slug từ tên file (KHÔNG cần đọc file) + permalink.
// Scoped (có --only): permalink lấy từ content-index — KHÔNG đọc lại front
// matter của mọi bài cũ; post thiếu row index → LỖI (fail-closed).
// Full mode (mặc định — CI/full audit) đọc trực tiếp như cũ: KHÔNG yếu đi.
const postFiles = walkMd(join(ROOT, '_posts'));
let idxRowsL = null;
if (ONLY) {
  idxRowsL = new Map();
  try {
    const rawIdx = readFileSync(join(ROOT, 'data/content-index.jsonl'), 'utf8');
    if (rawIdx && !rawIdx.endsWith('\n')) throw new Error('không kết thúc bằng newline');
    for (const l of rawIdx.split('\n').filter(Boolean)) {
      const r = JSON.parse(l);
      idxRowsL.set(r.path, r);
    }
  } catch (e) {
    console.error('::error::data/content-index.jsonl thiếu/hỏng (' + e.message + ') — chạy node scripts/content-index.mjs --build (fail-closed)');
    process.exit(1);
  }
}
for (const f of postFiles) {
  const relL = f.slice(ROOT.length).replace(/\\/g, '/');
  const slug = f.replace(/^.*\d{4}-\d{2}-\d{2}-/, '').replace(/\.md$/, '');
  addTarget('/' + slug);
  if (!idxRowsL) {
    const meta = parseFm(readFileSync(f, 'utf8')) || {};
    if (meta.permalink) addTarget(meta.permalink);
  } else {
    const r = idxRowsL.get(relL);
    if (!r) {
      console.error('::error::' + relL + ': không có trong content-index — rebuild index (fail-closed)');
      process.exit(1);
    }
    if (r.permalink) addTarget(r.permalink);
  }
}

// category and hub pages on disk (permalink wins over path)
const contentFiles = [];
for (const dir of ['danh-muc', 'hub']) {
  for (const f of walkMd(join(ROOT, dir))) {
    contentFiles.push(f);
    const rel = f.slice(ROOT.length).replace(/\\/g, '/');
    const meta = parseFm(readFileSync(f, 'utf8')) || {};
    if (meta.permalink) addTarget(meta.permalink);
    addTarget(rel.replace(/\.md$/, ''));
  }
}

// Scoped noop (scope rỗng — chu kỳ không có bài mới): target set + độ phủ
// content-index đã được verify ở trên; không đọc lại nội dung bài cũ.
if (ONLY && ONLY.length === 0) {
  console.log('link check OK (scope rỗng — target set + content-index coverage verified)');
  process.exit(0);
}

// ---- Collect internal links from the files we own ----
// Hub pages are legacy noindex pages whose rendering is verified after the
// build by validate-built.mjs against the real _site tree.
const SKIP_PREFIX = ['/assets/', '/sitemap', '/robots.txt', '/manifest.webmanifest', '/hub/'];
const errs = [];
let linkCount = 0;

function checkFile(f) {
  const rel = f.slice(ROOT.length).replace(/\\/g, '/');
  const text = readFileSync(f, 'utf8');
  const links = new Set();
  for (const m of text.matchAll(/\]\((\/[^)\s]*)\)/g)) links.add(m[1]);          // markdown
  for (const m of text.matchAll(/'(\/[^']*)'\s*\|\s*relative_url/g)) links.add(m[1]); // liquid
  for (const m of text.matchAll(/href=\"(\/[^\"]*)\"/g)) links.add(m[1]);         // raw html
  for (const raw of links) {
    const p = norm(raw);
    if (p === '' || p === '/') continue; // homepage
    if (SKIP_PREFIX.some(s => (p + '/').startsWith(s))) continue;
    linkCount++;
    if (!targets.has(p)) errs.push(rel + ': link target "' + p + '" does not exist on disk (not a post, category, hub or static page)');
  }
}

const inScope = f => {
  if (!ONLY) return true;
  const rel = f.slice(ROOT.length).replace(/\\/g, '/').replace(/^\//, '');
  return ONLY.includes(rel);
};
let checkedCount = 0;
for (const f of postFiles) if (inScope(f)) { checkFile(f); checkedCount++; }
for (const f of contentFiles) if (inScope(f)) { checkFile(f); checkedCount++; }
for (const f of readdirSync(ROOT).filter(f => f.endsWith('.md'))) {
  if (['README.md', 'AGENTS.md', 'CONTRIBUTING.md'].includes(f)) continue;
  if (inScope(join(ROOT, f))) { checkFile(join(ROOT, f)); checkedCount++; }
}
if (ONLY && checkedCount === 0) {
  console.error('check-links: --only matched no file on disk: ' + ONLY.join(', '));
  process.exit(1);
}

if (errs.length) {
  console.error(errs.join('\n'));
  console.error('check-links: ' + errs.length + ' broken internal link(s).');
  process.exit(1);
}
console.log('link check OK' + (ONLY ? ' (scoped to ' + checkedCount + ' changed file(s))' : '') + ': ' + (postFiles.length + contentFiles.length) + ' content files, ' + linkCount + ' internal links, all targets verified against repository truth');
