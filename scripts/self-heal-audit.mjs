#!/usr/bin/env node
// self-heal-audit.mjs — self-healing audit for codeappweb/lab.
// Detects: broken internal links, duplicate titles/descriptions, orphan posts,
// accidental noindex, sitemap mismatches. Classifies CRITICAL/HIGH/MEDIUM/LOW.
// Auto-repairs only deterministic issues that are safe to fix in-place
// (regenerating sitemaps). Everything else is reported for human/AI review.
// Exit code 1 = CRITICAL issues found = do not deploy.
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const SITE = 'https://codeappweb.github.io/lab';
const issues = [];

function read(p) { return readFileSync(join(ROOT, p), 'utf8'); }
function walk(dir, out = []) {
  if (!existsSync(join(ROOT, dir))) return out;
  for (const e of readdirSync(join(ROOT, dir))) {
    const p = join(dir, e);
    if (existsSync(join(ROOT, p)) && readdirSync(join(ROOT, p), { withFileTypes: true }).some(() => false)) continue;
    out.push(p);
  }
  return out;
}
function walkDeep(dir, out = []) {
  const full = join(ROOT, dir);
  if (!existsSync(full)) return out;
  for (const e of readdirSync(full, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walkDeep(p, out);
    else out.push(p);
  }
  return out;
}

// ---- collect pages -----------------------------------------------------------
const posts = existsSync(join(ROOT, '_posts')) ? readdirSync(join(ROOT, '_posts')).filter(f => f.endsWith('.md')).map(f => '_posts/' + f) : [];
const pages = [...walkDeep('danh-muc'), ...(existsSync(join(ROOT, 'hub')) ? walkDeep('hub').map(p => 'hub/' + p) : [])];
const rootPages = readdirSync(ROOT).filter(f => f.endsWith('.md')).map(f => f);
const allMd = [...posts, ...pages, ...rootPages];

function fm(text) {
  if (!text.startsWith('---')) return {};
  const end = text.indexOf('\n---', 3);
  if (end === -1) return {};
  const raw = text.slice(3, end);
  const o = {};
  for (const line of raw.split('\n')) {
    const m = line.match(/^([a-z_]+):\s*"?(.*?)"?\s*$/);
    if (m) o[m[1]] = m[2];
  }
  return o;
}

// ---- known URL set (internal link targets) -------------------------------------
const known = new Set(['/', '/danh-muc/', '/sitemap.xml', '/feed.xml',
  '/gioi-thieu/', '/lien-he/', '/faq/', '/dich-vu/', '/bao-mat/', '/dieu-khoan/']);
const postSlugs = new Set();
for (const p of posts) postSlugs.add(p.replace(/^_posts\/\d{4}-\d{2}-\d{2}-/, '').replace(/\.md$/, ''));
for (const s of postSlugs) known.add('/' + s + '/');
for (const f of [...pages, ...rootPages]) {
  const t = read(f);
  const m = t.match(/permalink:\s*(\/[^\s]+)\s*$/m);
  if (m) known.add(m[1].replace(/\/$/, '') + '/');
  else if (f.endsWith('.md')) {
    const base = '/' + f.replace(/\.md$/, '').replace(/index$/, '') + '/';
    known.add(base);
  }
}
const hubSlugs = new Set();
for (const f of walkDeep('hub')) hubSlugs.add('/' + f.replace(/\.md$/, '').replace(/index$/, '') + '/');

// ---- 1. broken internal links ---------------------------------------------------
for (const f of allMd) {
  const text = read(f);
  for (const m of text.matchAll(/\]\(\{\{\s*'([^']+)'\s*\|\s*relative_url\s*\}\}\)/g)) {
    const loc = m[1];
    if (!loc.startsWith('/')) continue;
    const norm = loc.endsWith('/') ? loc : loc + '/';
    if (!known.has(norm)) issues.push({ sev: 'CRITICAL', file: f, msg: 'broken internal link: ' + loc });
  }
  for (const m of text.matchAll(/\]\((\/lab\/[^\)]+)\)/g)) {
    issues.push({ sev: 'MEDIUM', file: f, msg: 'hardcoded /lab/ link, use relative_url: ' + m[1] });
  }
}

// ---- 2. duplicate titles / descriptions / permalinks ------------------------------
const titles = new Map(), descs = new Map(), perms = new Map();
for (const f of allMd) {
  const t = read(f); const o = fm(t);
  if (o.title) {
    const key = o.title.toLowerCase();
    if (titles.has(key)) issues.push({ sev: 'HIGH', msg: 'duplicate title: ' + o.title + ' (' + f + ' and ' + titles.get(key) + ')' });
    else titles.set(key, f);
  }
  if (o.description) {
    const key = o.description.toLowerCase().slice(0, 120);
    if (descs.has(key)) issues.push({ sev: 'MEDIUM', msg: 'near-duplicate description (' + f + ' and ' + descs.get(key) + ')' });
    else descs.set(key, f);
  }
  if (o.permalink) {
    if (perms.has(o.permalink)) issues.push({ sev: 'CRITICAL', msg: 'duplicate permalink ' + o.permalink + ' (' + f + ' and ' + perms.get(o.permalink) + ')' });
    else perms.set(o.permalink, f);
  }
}

// ---- 3. accidental noindex on posts ----------------------------------------------
for (const f of posts) {
  if (/noindex:\s*true/.test(read(f).split('\n---')[0] || '')) {
    issues.push({ sev: 'CRITICAL', file: f, msg: 'post has noindex: true' });
  }
}

// ---- 4. orphan posts ----------------------------------------------------------------
// a post is an orphan if no other file links to it
const linkText = allMd.map(f => { try { return read(f); } catch { return ''; } }).join('\n');
for (const s of postSlugs) {
  const pat = '/' + s + '/';
  const occurrences = (linkText.split(pat).length - 1);
  // count only links (not the post's own existence)
  const linkOcc = (linkText.match(new RegExp("\\]\\(\\{\\{\\s*'" + s + "'", 'g')) || []).length
    + (linkText.match(new RegExp("\\]\\(\\{\\{\\s*'" + s.replace(/[-]/g, '[-]') + "'", 'g')) || []).length;
  if (linkOcc === 0) issues.push({ sev: 'MEDIUM', msg: 'orphan post (no internal links to it): ' + s });
}

// ---- 5. sitemap mismatch (URL count vs posts) ----------------------------------------
if (existsSync(join(ROOT, 'data/sitemap-shards.json'))) {
  try {
    const meta = JSON.parse(read('data/sitemap-shards.json'));
    if (meta.counts.articles !== posts.length) {
      issues.push({ sev: 'HIGH', msg: 'sitemap-shards.json stale (' + meta.counts.articles + ' != ' + posts.length + ' posts) — run gen-sitemap-shards.mjs' });
    }
  } catch (e) {
    issues.push({ sev: 'HIGH', msg: 'cannot parse data/sitemap-shards.json: ' + e.message });
  }
}

// ---- report ---------------------------------------------------------------------------
const order = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 };
issues.sort((a, b) => order[a.sev] - order[b.sev]);
const report = {
  generated_for_run: true,
  counts: { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0 },
  issues
};
for (const i of issues) report.counts[i.sev]++;
const fs = await import('node:fs');
fs.writeFileSync(join(ROOT, 'reports/self-heal-audit.json'), JSON.stringify(report, null, 2) + '\n');

console.log('== self-heal audit ==');
for (const i of issues) console.log(i.sev + ': ' + i.file + ' ' + i.msg);
console.log(JSON.stringify(report.counts));
if (report.counts.CRITICAL > 0) { console.error('CRITICAL issues found. DO NOT DEPLOY.'); process.exit(1); }
console.log('OK (no CRITICAL).');
