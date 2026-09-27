// Shared library for all lab scripts: front-matter parsing, discovery,
// canonical indexable URL set, reporting, --root support for fixtures.
export const SITE = 'https://codeappweb.github.io/lab';

export function findRoot(argv, fallback) {
  const i = (argv || process.argv).indexOf('--root');
  if (i >= 0 && argv[i + 1]) return argv[i + 1].replace(/\/+$/, '');
  return fallback || process.cwd();
}

// Robust YAML front-matter parser for our subset: key: value, quoted strings,
// arrays [a, b], bare scalars. Never throws on odd input.
export function parseFM(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!m) return { data: {}, raw: '', body: text };
  const data = {};
  for (const line of m[1].split('\n')) {
    const km = /^([\w-]+):\s*(.*)$/.exec(line);
    if (!km) continue;
    let v = km[2].trim();
    if (v === '' ) { data[km[1]] = null; continue; }
    if (v === 'true') { data[km[1]] = true; continue; }
    if (v === 'false') { data[km[1]] = false; continue; }
    if (v.startsWith('[') && v.endsWith(']')) {
      data[km[1]] = v.slice(1, -1).split(',').map(s => s.trim().replace(/^["']|["']$/g, '')).filter(s => s.length);
      continue;
    }
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    data[km[1]] = v;
  }
  return { data, raw: m[1], body: m[2] };
}

import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join, basename, relative } from 'node:path';

export function walkFiles(dir, out = [], skip = ['node_modules', '.git', '.jekyll-cache', '_site', 'vendor', 'tests']) {
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir)) {
    if (skip.includes(e)) continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walkFiles(p, out, skip);
    else out.push(p);
  }
  return out;
}

export function postSlug(filename) {
  return basename(filename, '.md').replace(/^\d{4}-\d{2}-\d{2}-/, '');
}
export function postDate(filename) {
  return filename.slice(0, 10);
}
export function postUrl(filename) { return '/' + postSlug(filename) + '/'; }

export function discover(root) {
  const posts = [];
  const postsDir = join(root, '_posts');
  if (existsSync(postsDir)) {
    for (const f of readdirSync(postsDir).filter(f => f.endsWith('.md')).sort()) {
      const text = readFileSync(join(postsDir, f), 'utf8');
      const fm = parseFM(text);
      posts.push({ path: '_posts/' + f, slug: postSlug(f), date: postDate(f), fm, text });
    }
  }
  const pages = [];
  for (const f of walkFiles(join(root, 'danh-muc'))) {
    const rel = f.slice(root.length + 1);
    const text = readFileSync(f, 'utf8');
    const fm = parseFM(text);
    pages.push({ path: rel, fm, text, url: fm.data.permalink || null });
  }
  const hubs = [];
  const hubDir = join(root, 'hub');
  if (existsSync(hubDir)) {
    for (const f of readdirSync(hubDir).filter(f => f.endsWith('.md'))) {
      const text = readFileSync(join(hubDir, f), 'utf8');
      const fm = parseFM(text);
      hubs.push({ path: 'hub/' + f, fm, text, url: '/hub/' + basename(f, '.md') + '/' });
    }
  }
  const statics = [];
  // README.md is repository documentation, never site content (spec:
  // exclude documentation and fixtures). It has no front matter and Jekyll
  // copies it verbatim, so it must not enter any content/URL set.
  for (const f of readdirSync(root).filter(f => f.endsWith('.md') && f !== 'README.md')) {
    const text = readFileSync(join(root, f), 'utf8');
    const fm = parseFM(text);
    const url = fm.data.permalink || (f === 'index.md' ? '/' : '/' + basename(f, '.md') + '/');
    statics.push({ path: f, fm, text, url });
  }
  return { posts, pages, hubs, statics };
}

// ---------- exclusions ---------------------------------------------------------
export function isExcluded(fmData) {
  if (!fmData) return true;
  if (fmData.noindex === true || fmData.noindex === 'true') return true;
  if (fmData.sitemap === false || fmData.sitemap === 'false') return true;
  if (fmData.published === false || fmData.published === 'false') return true;
  return false;
}
export function isFutureDated(dateStr, now) {
  if (!dateStr) return false;
  const d = new Date(dateStr + 'T00:00:00Z');
  if (isNaN(d)) return false;
  return d > (now || new Date());
}

// canonical, indexable (sitemap-eligible) URL set of the whole site
export function canonicalIndex(root, now) {
  const { posts, pages, statics } = discover(root);
  const set = new Map(); // url -> {kind, path, lastmod}
  for (const p of posts) {
    if (isExcluded(p.fm.data)) continue;
    if (isFutureDated(p.date, now)) continue;
    const lastmod = [p.date, p.fm.data.updated_at].filter(Boolean).sort().pop();
    set.set(postUrl(p.path), { kind: 'post', path: p.path, lastmod });
  }
  for (const c of pages) {
    if (isExcluded(c.fm.data)) continue;
    if (!c.url) continue; // no permalink -> not indexable by our scheme
    set.set(c.url, { kind: 'category', path: c.path, lastmod: null });
  }
  for (const s of statics) {
    if (isExcluded(s.fm.data)) continue;
    set.set(s.url, { kind: 'static', path: s.path, lastmod: null });
  }
  return set;
}

// ---------- reporting -----------------------------------------------------------
import { writeFileSync as _wfs, mkdirSync as _mkdir } from 'node:fs';

export function writeReport(root, name, obj) {
  const dir = join(root, 'reports');
  if (!existsSync(dir)) _mkdir(dir, { recursive: true });
  const p = join(dir, name);
  _wfs(p, JSON.stringify(obj, null, 2) + '\n');
  return p;
}

export function fail(msgs, label) {
  if (msgs.length) {
    for (const m of msgs) console.error('FAIL: ' + m);
    console.error(`${label}: ${msgs.length} error(s). DO NOT PUSH.`);
    process.exit(1);
  }
}
