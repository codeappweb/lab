#!/usr/bin/env node
// validate-navigation.mjs — navigation single-source-of-truth consistency check.
//
// data/navigation.yml (main + utility), data/menu-cats.yml (primary/more
// parent slugs) and data/taxonomy.yml (parents + children) are the ONLY
// navigation registries. Header .main-nav + mega menu, footer, nav drawer,
// topic sheet and bottom nav all render from them.
//
// This check has two levels:
//   1. SOURCE level (always): registry integrity (unique labels/slugs/URLs),
//      menu-cats ⊆ taxonomy, header mega-menu group string covers EXACTLY the
//      primary+more parent set, no orphan/unknown slugs.
//   2. RENDERED level (--site _site): parse the built HTML surfaces and
//      enforce that the SAME destination URL carries the IDENTICAL visible
//      label on every surface, and that every navigation URL resolves to a
//      built file. Documented exception: the full form "Tất cả <label>" is a
//      legitimate label variant, not a casual shortening.
//
// Output: reports/navigation-inventory.json — item -> label -> URL -> the
// surfaces where it appears. Exit 1 on any error.
// Usage: node scripts/validate-navigation.mjs [--root <dir>] [--site <dir>]
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findRoot, writeReport } from './lib/lab.mjs';

const ROOT = findRoot(process.argv);
const siteArgIdx = process.argv.indexOf('--site');
const SITE = siteArgIdx >= 0 && process.argv[siteArgIdx + 1] ? resolve(process.argv[siteArgIdx + 1]) : null;

const errors = [];
const warnings = [];
const err = (m) => { errors.push(m); console.error('NAV ERROR: ' + m); };
const warn = (m) => { warnings.push(m); console.error('NAV WARN: ' + m); };

// ---------------------------------------------------------------------------
// Minimal YAML-subset readers for the three navigation registries (the repo
// deliberately has no YAML dependency; these files use a fixed simple shape).
function readLines(root, rel) {
  const p = join(root, rel);
  if (!existsSync(p)) return null;
  return readFileSync(p, 'utf8').split('\n');
}

function unquote(v) {
  v = v.trim();
  if (v.length >= 2 && ((v[0] === '"' && v.endsWith('"')) || (v[0] === "'" && v.endsWith("'")))) return v.slice(1, -1);
  return v;
}

// navigation.yml: sections `main:` and `utility:` of `- label: "X"` / `url: "/x/"`.
function readNavigationYml(root) {
  const lines = readLines(root, join('data', 'navigation.yml'));
  if (!lines) return null;
  const out = { main: [], utility: [] };
  let section = null;
  for (const raw of lines) {
    const line = raw.replace(/#.*$/, '');
    if (/^\s*main:\s*$/.test(line)) { section = 'main'; continue; }
    if (/^\s*utility:\s*$/.test(line)) { section = 'utility'; continue; }
    if (!section) continue;
    const labelM = line.match(/^\s*-\s*label:\s*(.+)$/);
    if (labelM) { out[section].push({ label: unquote(labelM[1]) }); continue; }
    const urlM = line.match(/^\s*url:\s*(.+)$/);
    if (urlM && out[section].length) out[section][out[section].length - 1].url = unquote(urlM[1]);
  }
  return out;
}

// menu-cats.yml: `primary:` and `more:` lists of `- slug`.
function readMenuCats(root) {
  const lines = readLines(root, join('data', 'menu-cats.yml'));
  if (!lines) return null;
  const out = { primary: [], more: [] };
  let section = null;
  for (const raw of lines) {
    const line = raw.replace(/#.*$/, '');
    if (/^\s*primary:\s*$/.test(line)) { section = 'primary'; continue; }
    if (/^\s*more:\s*$/.test(line)) { section = 'more'; continue; }
    if (!section) continue;
    const m = line.match(/^\s*-\s*(\S+)\s*$/);
    if (m) out[section].push(m[1]);
  }
  return out;
}

// taxonomy.yml: parents (slug/name) with children (slug/name) at fixed indents.
function readTaxonomy(root) {
  const lines = readLines(root, join('data', 'taxonomy.yml'));
  if (!lines) return null;
  const parents = [];
  let cur = null, curChild = null;
  for (const raw of lines) {
    const line = raw.replace(/#.*$/, '');
    const indent = (line.match(/^ */) || [''])[0].length;
    const parentM = line.match(/^\s{2}-\s*id:\s*(.+)$/);
    const childM = line.match(/^\s{6}-\s*id:\s*(.+)$/);
    if (parentM && indent === 2) { cur = { id: unquote(parentM[1]), children: [] }; parents.push(cur); curChild = null; continue; }
    if (childM && indent === 6 && cur) { curChild = { id: unquote(childM[1]) }; cur.children.push(curChild); continue; }
    const kv = line.match(/^\s*([a-z_]+):\s*(.+)$/);
    if (!kv) continue;
    const key = kv[1], val = unquote(kv[2]);
    if (indent === 4 && cur) cur[key] = val;
    else if (indent === 8 && curChild) curChild[key] = val;
  }
  return parents;
}

// header.html mega-menu group string: 'Group:slug,slug|Group:slug'.
function readMegaGroups(root) {
  const p = join(root, '_includes', 'header.html');
  if (!existsSync(p)) return null;
  const html = readFileSync(p, 'utf8');
  const m = html.match(/assign\s+mega\s*=\s*'([^']+)'/);
  if (!m) return null;
  const groups = [];
  for (const g of m[1].split('|')) {
    const [name, slugs] = g.split(':');
    groups.push({ name, slugs: slugs.split(',') });
  }
  return groups;
}

// ---------------------------------------------------------------------------
// 1. SOURCE-level checks
const nav = readNavigationYml(ROOT);
const cats = readMenuCats(ROOT);
const tax = readTaxonomy(ROOT);
if (!nav) err('data/navigation.yml missing — the single menu source must exist');
if (!cats) err('data/menu-cats.yml missing — the shared menu/footer category list must exist');
if (!tax) err('data/taxonomy.yml missing — the public taxonomy must exist');
if (!nav || !cats || !tax) fail();

const parentBySlug = new Map(tax.map(p => [p.slug, p]));
const childUrls = new Map(); // url -> label (global child-URL uniqueness)
const inventory = []; // {id, label, url, surfaces, origin}

if (nav) {
  for (const section of ['main', 'utility']) {
    const seenLabels = new Map(), seenUrls = new Map();
    nav[section].forEach((item, i) => {
      const id = 'nav.' + section + '[' + i + ']';
      if (!item.label || !item.url) { err(id + ': incomplete item (needs both label and url)'); return; }
      if (!item.url.startsWith('/')) err(id + ': url "' + item.url + '" must be root-relative (start with "/")');
      if (seenLabels.has(item.label)) err(id + ': duplicate label "' + item.label + '" (also ' + seenLabels.get(item.label) + ')');
      else seenLabels.set(item.label, id);
      if (seenUrls.has(item.url)) err(id + ': duplicate url "' + item.url + '" (also ' + seenUrls.get(item.url) + ')');
      else seenUrls.set(item.url, id);
      inventory.push({ id, label: item.label, url: item.url, canonical_surfaces: section === 'main' ? ['header.main-nav', 'nav-drawer.nav-info', 'footer.thong-tin'] : [], origin: 'data/navigation.yml#' + section });
    });
  }
  if (!nav.main.length || !nav.main.some(i => i.url === '/')) err('navigation main must contain the homepage item (url "/")');
}
if (tax) {
  const seenParentSlugs = new Map();
  for (const p of tax) {
    if (!p.slug || !p.name) { err('taxonomy parent ' + (p.id || '?') + ' needs slug + name'); continue; }
    if (seenParentSlugs.has(p.slug)) err('taxonomy: duplicate parent slug "' + p.slug + '" (' + seenParentSlugs.get(p.slug) + ' and ' + p.id + ')');
    else seenParentSlugs.set(p.slug, p.id);
    const url = '/danh-muc/' + p.slug + '/';
    inventory.push({ id: 'parent:' + p.slug, label: p.name, url, canonical_surfaces: ['header.mega', 'footer.kham-pha', 'nav-drawer.kham-pha', 'topic-sheet'], origin: 'data/taxonomy.yml' });
    const seenChild = new Map();
    for (const c of p.children || []) {
      if (!c.slug || !c.name) { err('taxonomy child ' + (c.id || p.id + '/*') + ' needs slug + name'); continue; }
      if (seenChild.has(c.slug)) err('taxonomy: duplicate child slug "' + c.slug + '" under parent "' + p.slug + '"');
      else seenChild.set(c.slug, c.id);
      const curl = '/danh-muc/' + p.slug + '/' + c.slug + '/';
      if (childUrls.has(curl) && childUrls.get(curl) !== c.name) err('taxonomy: duplicate child URL ' + curl + ' with differing labels');
      else childUrls.set(curl, c.name);
      inventory.push({ id: 'child:' + p.slug + '/' + c.slug, label: c.name, url: curl, canonical_surfaces: ['header.mega', 'nav-drawer.children', 'topic-sheet'], origin: 'data/taxonomy.yml' });
    }
  }
}
if (cats && tax) {
  const all = [...cats.primary, ...cats.more];
  const dup = all.filter((s, i) => all.indexOf(s) !== i);
  if (dup.length) err('menu-cats: slug(s) listed twice: ' + dup.join(', '));
  for (const s of all) if (!parentBySlug.has(s)) err('menu-cats: slug "' + s + '" is not a taxonomy parent — the menu must not invent categories');
  const taxSlugs = new Set(tax.map(p => p.slug));
  const missing = [...taxSlugs].filter(s => !all.includes(s));
  if (missing.length) warn('taxonomy parents absent from menu-cats (not reachable from menu/footer): ' + missing.join(', '));
  const mega = readMegaGroups(ROOT);
  if (mega) {
    const megaSlugs = new Set(mega.flatMap(g => g.slugs));
    for (const s of megaSlugs) if (!parentBySlug.has(s)) err('header mega-menu references unknown parent slug "' + s + '"');
    for (const s of all) if (!megaSlugs.has(s)) err('header mega-menu does not cover menu-cats parent "' + s + '" — a shared item missing from a navigation surface');
    for (const s of megaSlugs) if (!all.includes(s)) err('header mega-menu includes parent "' + s + '" that menu-cats does not list — competing registry');
  } else {
    warn('header.html mega-menu group string not found (structure changed? rendered check still applies)');
  }
}

// ---------------------------------------------------------------------------
// 2. RENDERED-level checks
function fail() {
  mkdirSync(join(ROOT, 'reports'), { recursive: true });
  writeReport(ROOT, 'navigation-inventory.json', {
    generated_at: new Date().toISOString(),
    mode: SITE ? 'source+rendered' : 'source-only',
    items: inventory,
    errors, warnings,
  });
  console.error('validate-navigation: ' + errors.length + ' error(s), ' + warnings.length + ' warning(s)');
  process.exit(1);
}

function extractBlock(html, startMarker, endTag) {
  const i = html.indexOf(startMarker);
  if (i < 0) return null;
  const j = html.indexOf(endTag, i);
  return j < 0 ? null : html.slice(i, j + endTag.length);
}

function anchors(block) {
  const out = [];
  if (!block) return out;
  // The footer/header BRAND wordmark (logo/brand link, e.g. the site name
  // linking to /) is not a navigation label: it is the site identity.
  // Documented exception — see docs/ARTICLE-DESIGN.md (navigation source of
  // truth). Everything else must match the canonical label per URL.
  const brandBlock = block.match(/<[^>]*class="[^"]*foot-brand[^"]*"[^>]*>[\s\S]*?<\/div>/);
  if (brandBlock) block = block.replace(brandBlock[0], '');
  const re = /<a\b[^>]*\bhref="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g;
  let m;
  while ((m = re.exec(block))) {
    if (/class="[^"]*\b(?:logo|brand)\b[^"]*"/.test(m[0])) continue; // brand wordmark — not a nav label
    const text = m[2].replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ')
      .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"').replace(/&#39;/g, "'").trim();
    out.push({ href: m[1], text });
  }
  return out;
}

function stripBase(href, base) {
  let h = href;
  if (base && base !== '/' && h.startsWith(base)) h = h.slice(base.length);
  if (!h.startsWith('/')) return null; // external / anchor — not a nav destination
  return h;
}

function sameLabel(a, b) {
  if (a === b) return true;
  // Documented legitimate variant: the full form "Tất cả <label>".
  if (a === 'Tất cả ' + b || b === 'Tất cả ' + a) return true;
  return false;
}

if (SITE) {
  if (!existsSync(SITE)) { err('--site directory does not exist: ' + SITE); fail(); }
  // baseurl from _config.yml (rendered hrefs carry it)
  let base = '';
  const cfgp = join(ROOT, '_config.yml');
  if (existsSync(cfgp)) {
    const m = readFileSync(cfgp, 'utf8').match(/^baseurl:\s*["']?([^"'\n]*)["']?\s*$/m);
    if (m) base = m[1].trim();
  }
  const htmlFiles = [];
  (function walk(d) {
    for (const f of readdirSync(d, { withFileTypes: true })) {
      if (f.isDirectory()) walk(join(d, f.name));
      else if (f.name.endsWith('.html')) htmlFiles.push(join(d, f.name));
    }
  })(SITE);

  const surfacesOf = (name) => ({
    'header.main-nav': (h) => extractBlock(h, 'class="main-nav"', '</nav>'),
    'header.mega': (h) => extractBlock(h, 'class="mega"', '</div></div>'), // mega block ends before </nav>
    'footer': (h) => extractBlock(h, '<footer', '</footer>'),
    'nav-drawer': (h) => extractBlock(h, 'class="nav-drawer"', '</aside>'),
    'topic-sheet': (h) => extractBlock(h, 'class="sheet__nav"', '</nav>'),
    'bottom-nav': (h) => extractBlock(h, 'class="bottom-nav"', '</nav>'),
  });

  // url -> Map(surface -> label)
  const byUrl = new Map();
  let checkedPages = 0;
  for (const page of htmlFiles) {
    const html = readFileSync(page, 'utf8');
    const hasNav = html.includes('class="main-nav"') || html.includes('class="site-footer"');
    if (!hasNav) continue;
    checkedPages++;
    for (const [surface, getter] of Object.entries(surfacesOf())) {
      for (const a of anchors(getter(html))) {
        const url = stripBase(a.href, base);
        if (url === null) continue;
        if (!byUrl.has(url)) byUrl.set(url, new Map());
        const prev = byUrl.get(url).get(surface);
        if (prev === undefined) byUrl.get(url).set(surface, a.text);
        else if (!sameLabel(prev, a.text)) err('label mismatch for ' + url + ' within surface ' + surface + ' on ' + page + ': "' + prev + '" vs "' + a.text + '"');
      }
    }
  }
  if (checkedPages === 0) warn('no rendered pages with navigation found under ' + SITE);

  // cross-surface label consistency + URL resolution
  for (const [url, surfaces] of byUrl) {
    const labels = [...new Set([...surfaces.values()])];
    if (labels.length > 1) {
      const compatible = labels.every(l => labels.every(o => sameLabel(l, o)));
      if (!compatible) err('label mismatch for ' + url + ' across surfaces: ' + labels.map(l => '"' + l + '" (' + [...surfaces].filter(([, v]) => v === l).map(([s]) => s).join(',') + ')').join(' | '));
    }
    // resolution: every nav URL must exist in the build
    let rel = decodeURIComponent(url.split('#')[0].split('?')[0]);
    if (/\.(xml|json|txt|webmanifest)$/.test(rel)) {
      const fp = join(SITE, rel.slice(1));
      if (!existsSync(fp)) err('navigation URL does not resolve in build: ' + url);
    } else {
      if (rel.endsWith('/')) rel += 'index.html';
      else if (!rel.endsWith('.html')) rel += '/index.html';
      const fp = join(SITE, rel.slice(1));
      if (!existsSync(fp)) err('navigation URL does not resolve in build: ' + url);
    }
    // record the surfaces actually observed in the rendered build
    const item = inventory.find(i => sameLabel(i.label, [...surfaces.values()][0]) && (i.url === url || i.url === stripBase(url, base)));
    if (item) item.rendered_surfaces = [...surfaces.keys()].sort();
  }
  console.log('validate-navigation: rendered check over ' + checkedPages + ' page(s), ' + byUrl.size + ' unique nav destination(s)');
}

// ---------------------------------------------------------------------------
mkdirSync(join(ROOT, 'reports'), { recursive: true });
writeReport(ROOT, 'navigation-inventory.json', {
  generated_at: new Date().toISOString(),
  mode: SITE ? 'source+rendered' : 'source-only',
  items: inventory,
  errors, warnings,
});
console.log('validate-navigation: ' + inventory.length + ' inventory item(s), ' + errors.length + ' error(s), ' + warnings.length + ' warning(s)');
if (errors.length) process.exit(1);
process.exit(0);
