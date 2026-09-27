#!/usr/bin/env node
// Navigation consistency validator — v2 (identity-based).
//
// Three independent layers:
//   1. CANONICAL data loads: data/navigation.yml (main links), data/actions.yml
//      (shared action buttons — ONE source for every surface that renders them),
//      data/taxonomy.yml (parents/children), data/menu-cats.yml (which parents
//      appear in drawer/footer discovery columns). The canonical data itself is
//      sanity-checked (e.g. home label must be "Trang chủ").
//   2. RENDERED surfaces are validated by STABLE IDENTITY, not by cross-surface
//      agreement alone:
//        - links    -> identity = canonical item id, matched by URL; the visible
//                      label must equal the canonical label EXACTLY (accents,
//                      capitalization). A label wrong the same way on EVERY
//                      surface still fails here.
//        - buttons  -> identity = data-qa / data-nav-cat / data-*-open
//                      attributes; where the action renders a visible text
//                      label it must equal the canonical label.
//   3. REQUIRED surfaces and required items per surface are EXPLICIT
//      (EXPECTED_SURFACES): every page with site chrome must contain every
//      required surface, and each surface its required items. A missing
//      surface/item is a hard error — a half-rendered menu can never pass.
//
// HTML is parsed with a real tokenizer (tags, attributes, entities, balanced
// nesting) — never substring extraction, which can silently skip part of a
// surface. Hidden mobile menu screens (nav-drawer screens[hidden]) and
// collapsed footer <details> sections are part of the DOM and are validated.
//
// Documented, narrowly-scoped exceptions:
//   - BRAND WORDMARK: the logo/site-name link to "/" (class contains logo,
//     brand or foot-brand__link) is the site identity, not a navigation label.
//   - "Tất cả <label>" is a legitimate long form of a parent category label in
//     drawer child screens and the topic sheet.
//
// Output: reports/navigation-inventory.json. Exit 1 on any error.
//
// Usage:
//   node scripts/validate-navigation.mjs                          # canonical only
//   node scripts/validate-navigation.mjs --site _site            # + rendered
//   node scripts/validate-navigation.mjs --site DIR --data-root DIR   # fixtures
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findRoot, writeReport } from './lib/lab.mjs';
import { loadCanonical } from './lib/nav-data.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = findRoot(process.argv, path.resolve(HERE, '..'));
const SITE = (() => { const i = process.argv.indexOf('--site'); return i > 0 ? path.resolve(process.argv[i + 1]) : null; })();
const DATA_ROOT = (() => { const i = process.argv.indexOf('--data-root'); return i > 0 ? path.resolve(process.argv[i + 1]) : ROOT; })();

const errors = [];
const warnings = [];
const inventory = [];
const err = (m) => { errors.push(m); console.error('NAV ERROR: ' + m); };
const warn = (m) => { warnings.push(m); console.error('NAV WARN: ' + m); };

/* ---------------- canonical data (shared, single source) ---------------- */
let CANON;
try { CANON = loadCanonical(DATA_ROOT); }
catch (e) { console.error('NAV ERROR: cannot load canonical data from ' + DATA_ROOT + ': ' + e.message); process.exit(1); }
const parentBySlug = new Map(CANON.parents.map(p => [p.slug, p]));
const act = (id) => CANON.actions.find(a => a.id === id);
const navItem = (i) => ({ id: 'nav.main[' + i + ']', label: CANON.navMain[i].label, url: CANON.navMain[i].url });
const parentLink = (p) => ({ id: 'parent:' + p.slug, label: p.name, url: '/danh-muc/' + p.slug + '/' });
const parentAllLink = (p) => ({ id: 'parent-all:' + p.slug, label: 'Tất cả ' + p.name, url: '/danh-muc/' + p.slug + '/' });
const childLink = (p, c) => ({ id: 'child:' + p.slug + '/' + c.slug, label: c.name, url: '/danh-muc/' + p
.slug + '/' + c.slug + '/' });

/* ---------------- expected items per surface (EXPLICIT contract) ---------------- */
function expectedSurfaces() {
  const exp = {
    'header.main-nav': {
      locate: { tag: 'nav', attr: 'class', value: 'main-nav' },
      links: CANON.navMain.map((_, i) => navItem(i)).slice(1, 4), // header renders main[1..3]
      buttons: [{ id: 'mega-trigger', cls: 'mega-trigger', label: 'Danh mục' }],
    },
    'header.mega': {
      locate: { tag: 'div', attr: 'class', value: 'mega' },
      links: CANON.parents.flatMap(p => [parentLink(p), ...(p.children || []).map(c => childLink(p, c))]),
    },
    'header.actions': {
      locate: { tag: 'div', attr: 'class', value: 'app-bar__actions' },
      // icon buttons: identity only — the visible label is a short
      // abbreviation by design (aria-label carries the full action label)
      buttons: [
        { id: 'action:search', attrOpen: 'data-search-open' },
        { id: 'action:assistant', qa: 'assistant' },
        { id: 'action:saved', qa: 'saved' },
        { id: 'chrome:theme-toggle', attrOpen: 'data-theme-toggle' },
        { id: 'chrome:nav-open', attrOpen: 'data-nav-open' },
      ],
    },
    'footer.quick-actions': {
      locate: { tag: 'div', attr: 'class', value: 'foot-links--actions' },
      links: CANON.actions.filter(a => a.url).map(a => ({ id: 'action:' + a.id, label: a.label, url: a.url })),
      buttons: CANON.actions.filter(a => !a.url && a.data_qa).map(a => ({ id: 'action:' + a.id, qa: a.data_qa, label: a.label })),
    },
    'footer.discover': {
      locate: { tag: 'div', attr: 'class', value: 'foot-discover' },
      links: [...(CANON.menuCats.primary || []), ...(CANON.menuCats.more || [])]
        .map(s => parentBySlug.get(s)).filter(Boolean).map(parentLink),
    },
    'footer.info': { special: 'footer-info' },
    'nav-drawer.actions': {
      locate: { tag: 'div', attr: 'class', value: 'nav-actions' },
      links: CANON.actions.filter(a => a.url).map(a => ({ id: 'action:' + a.id, label: a.label, url: a.url })),
      buttons: CANON.actions.filter(a => !a.url && a.data_qa).map(a => ({ id: 'action:' + a.id, qa: a.data_qa, label: a.label })),
    },
    'nav-drawer.discover': {
      locate: { tag: 'div', attr: 'class', value: 'nav-cats' },
      buttons: [...(CANON.menuCats.primary || []), ...(CANON.menuCats.more || [])]
        .map(s => parentBySlug.get(s)).filter(Boolean)
        .map(p => ({ id: 'parent:' + p.slug, navCat: p.slug, label: p.name })),
    },
    'nav-drawer.info': {
      locate: { tag: 'nav', attr: 'class', value: 'nav-info' },
      links: CANON.navMain.map((_, i) => navItem(i)),
    },
    'topic-sheet': {
      locate: { tag: 'nav', attr: 'class', value: 'sheet__nav' },
      links: CANON.parents.flatMap(p => [parentAllLink(p), ...(p.children || []).map(c => childLink(p, c))]),
    },
    'bottom-nav': {
      locate: { tag: 'nav', attr: 'class', value: 'bottom-nav' },
      links: [navItem(0)],
      buttons: [
        { id: 'action:topics', attrOpen: 'data-sheet-open', label: act('topics') ? act('topics').label : 'Chủ đề' },
        { id: 'action:search', attrOpen: 'data-search-open', label: act('search') ? act('search').label : 'Tìm kiếm' },
      ],
    },
  };
  for (const p of CANON.parents) {
    exp['nav-drawer.screen:' + p.slug] = {
      locate: { tag: 'div', attr: 'id', value: 'navScr-' + p.slug },
      links: [parentAllLink(p), ...(p.children || []).map(c => childLink(p, c))],
    };
  }
  return exp;
}

const EXPECTED = expectedSurfaces();
const REQUIRED_SURFACES = Object.keys(EXPECTED);

/* ---------------- HTML tokenizer (no substring extraction) ---------------- */
function tokenize(html) {
  const ev = [];
  let i = 0, n = html.length;
  while (i < n) {
    if (html.startsWith('<!--', i)) { const e = html.indexOf('-->', i); i = e < 0 ? n : e + 3; continue; }
    const lt = html.indexOf('<', i);
    if (lt < 0) break;
    if (lt > i) ev.push({ type: 'text', text: html.slice(i,
 lt) });
    const gt = html.indexOf('>', lt);
    if (gt < 0) break;
    let t = html.slice(lt + 1, gt);
    if (t.startsWith('!') || t.startsWith('?')) { i = gt + 1; continue; }
    if (t.startsWith('/')) { ev.push({ type: 'close', tag: t.slice(1).trim().split(/\s+/)[0].toLowerCase() }); i = gt + 1; continue; }
    const nameM = /^([a-zA-Z][a-zA-Z0-9-]*)/.exec(t);
    if (!nameM) { i = gt + 1; continue; }
    const tag = nameM[1].toLowerCase();
    const attrs = {};
    const are = /([:@\w.-]+)(?:\s*=\s*("[^"]*"|'[^']*'|[^\s"'>]+))?/g;
    let am;
    while ((am = are.exec(t.slice(nameM[1].length)))) {
      const raw = am[2] !== undefined ? am[2] : '';
      attrs[am[1].toLowerCase()] = raw.startsWith('"') && raw.endsWith('"') ? raw.slice(1, -1)
        : (raw.startsWith("'") && raw.endsWith("'") ? raw.slice(1, -1) : raw);
    }
    ev.push({ type: 'open', tag, attrs, selfClose: /\/\s*$/.test(t) });
    i = gt + 1;
    if (tag === 'script' || tag === 'style') {
      const ci = html.toLowerCase().indexOf('</' + tag, i);
      const ng = ci < 0 ? n : html.indexOf('>', ci);
      i = ng < 0 ? n : ng + 1;
    }
  }
  return ev;
}

const decodeEntities = (s) => String(s)
  .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ');

function hasClass(attrs, value) { return String(attrs.class || '').split(/\s+/).includes(value); }

// Inner HTML of the element matching (tag, attr=class|id, value); nesting-aware.
function extractSurface(html, spec) {
  const ev = tokenize(html);
  let depth = -1;
  const out = [];
  for (const e of ev) {
    if (depth < 0) {
      if (e.type === 'open' && e.tag === spec.tag &&
          ((spec.attr === 'class' && hasClass(e.attrs, spec.value)) ||
           (spec.attr === 'id' && e.attrs.id === spec.value))) {
        if (e.selfClose) return '';
        depth = 1; continue;
      }
      continue;
    }
    if (e.type === 'open' && e.tag === spec.tag && 
!e.selfClose) depth++;
    else if (e.type === 'close' && e.tag === spec.tag) { depth--; if (depth === 0) return out.join(''); }
    if (e.type === 'text') out.push(e.text);
    else if (e.type === 'open') out.push(' ');
  }
  return depth > 0 ? out.join('') : null;
}

// Parse a surface's inner HTML into link/button items with identity attrs.
function surfaceItems(inner) {
  const norm = (ts) => ts.join(' ').replace(/\s+/g, ' ').trim();
  const ev = tokenize(inner);
  const items = [];
  let curA = null, curB = null;
  const flushA = () => { if (curA) { items.push({ kind: 'link', attrs: curA.attrs, href: curA.attrs.href || '', label: norm(curA.texts) }); curA = null; } };
  const flushB = () => { if (curB) { items.push({ kind: 'button', attrs: curB.attrs, label: norm(curB.texts) }); curB = null; } };
  for (const e of ev) {
    if (e.type === 'open') {
      if (e.tag === 'a') { flushA(); curA = { attrs: e.attrs, texts: [] }; }
      else if (e.tag === 'button') { flushB(); curB = { attrs: e.attrs, texts: [] }; }
    } else if (e.type === 'close') {
      if (e.tag === 'a') flushA();
      else if (e.tag === 'button') flushB();
    } else if (e.type === 'text') {
      if (curA) curA.texts.push(decodeEntities(e.text));
      if (curB) curB.texts.push(decodeEntities(e.text));
    }
  }
  flushA(); flushB();
  return items;
}

// Documented brand-wordmark exception (narrowly scoped: only the site identity
// link to "/", marked with a brand/logo class).
function isBrandWordmark(a) {
  const cls = String(a.attrs.class || '');
  return /(^|\s)(logo|brand|foot-brand__link)(\s|$)/.test(cls);
}

function sameLabel(a, b) {
  if (a === b) return true;
  if (a === 'Tất cả ' + b || b === 'Tất cả ' + a) return true;
  return false;
}

function stripBase(href, base) {
  let h = String(href || '');
  if (base && base !== '/' && h.startsWith(base)) h = h.slice(base.length);
  if (!h.startsWith('/')) return null;
  return decodeURIComponent(h.split('#')[0].split('?')[0]) || '/';
}


/* ---------------- canonical sanity ---------------- */
{
  if (!CANON.navMain.length) err('canonical data: data/navigation.yml has no main items');
  const homeIdx = CANON.navMain.findIndex(n => n.url === '/');
  if (homeIdx < 0) err('canonical data: navigation.main must contain the home item (url "/")');
  else if (CANON.navMain[homeIdx].label !== 'Trang chủ') err('canonical data: home label must be "Trang chủ" (got "' + CANON.navMain[homeIdx].label + '")');
  for (const a of CANON.actions) {
    if (!a.url && !a.data_qa) err('canonical data: action ' + a.id + ' needs url or data_qa');
  }
  for (const s of [...(CANON.menuCats.primary || []), ...(CANON.menuCats.more || [])]) {
    if (!parentBySlug.has(s)) err('canonical data: menu-cats slug "' + s + '" not found in taxonomy parents');
  }
  for (const p of CANON.parents) inventory.push({ id: 'parent:' + p.slug, label: p.name, url: '/danh-muc/' + p.slug + '/', origin: 'data/taxonomy.yml', children: (p.children || []).map(c => c.slug) });
  for (const a of CANON.actions) inventory.push({ id: 'action:' + a.id, label: a.label, url: a.url || null, data_qa: a.data_qa || null, origin: 'data/actions.yml' });
  CANON.navMain.forEach((n, i) => inventory.push({ id: 'nav.main[' + i + ']', label: n.label, url: n.url, origin: 'data/navigation.yml#main' }));
}

/* ---------------- rendered identity checks ---------------- */
if (SITE) {
  if (!fs.existsSync(SITE)) err('--site directory does not exist: ' + SITE);
  else {
    let base = '';
    const cfgp = path.join(ROOT, '_config.yml');
    if (fs.existsSync(cfgp)) {
      const m = fs.readFileSync(cfgp, 'utf8').match(/^baseurl:\s*["']?([^"'\n]*)["']?\s*$/m);
      if (m) base = m[1].trim();
    }
    const htmlFiles = [];
    (function walk(d) {
      for (const f of fs.readdirSync(d, { withFileTypes: true })) {
        if (f.isDirectory()) walk(path.join(d, f.name));
        else if (f.name.endsWith('.html')) htmlFiles.push(path.join(d, f.name));
      }
    })(SITE);
   
 if (!htmlFiles.length) err('no rendered HTML pages found under ' + SITE);

    const pagesWithChrome = htmlFiles.filter(p => {
      const h = fs.readFileSync(p, 'utf8');
      return /class="main-nav"/.test(h) || /class="site-footer"/.test(h) || /class="bottom-nav"/.test(h);
    });
    if (!pagesWithChrome.length) err('no rendered pages with navigation chrome found under ' + SITE);

    const observed = new Map(); // surface -> Map(id -> {label,url,firstPage})
    function record(surface, id, label, url, page) {
      if (!observed.has(surface)) observed.set(surface, new Map());
      const m = observed.get(surface);
      const prev = m.get(id);
      if (!prev) m.set(id, { label, url, page: path.relative(SITE, page) });
      else if (prev.label !== label && !sameLabel(prev.label, label)) {
        err('label mismatch across pages for ' + id + ' on ' + surface + ': "' + prev.label + '" (on ' + prev.page + ') vs "' + label + '" (on ' + path.relative(SITE, page) + ')');
      }
    }

    function checkLinks(surface, links, expected, page, base) {
      const rel = path.relative(SITE, page);
      for (const exp of expected) {
        const found = links.find(l => stripBase(l.href, base) === exp.url);
        if (!found) { err('required item MISSING: ' + exp.id + ' on surface ' + surface + ' (' + rel + ')'); continue; }
        if (!sameLabel(found.label, exp.label)) {
          err('label mismatch: ' + exp.id + ' on surface ' + surface + ' (' + rel + '): expected "' + exp.label + '", got "' + found.label + '"');
        }
        record(surface, exp.id, found.label, exp.url, page);
      }
      // within-surface: one URL must never carry two different labels
      const byUrl = new Map();
      for (const l of links) {
        const u = stripBase(l.href, base);
        if (!u) continue;
        const prev = byUrl.get(u);
        if (prev === undefined) byUrl.set(u, l.label);
        else if (!sameLabel(prev, l.label)) err('label mismatch for ' + u + ' within surface ' + surface + ' (' + rel + '): "' + prev + '" vs "' + l.label + '"');
      }
    }

    function checkButtons(surface, buttons, expected, page) {
      const rel = path.relative(SITE, page);
      for (const exp of expected) {
        const found = buttons.find(b => {
          if (exp.qa) return b.attrs['data-qa'] === exp.qa;
          if (exp.navCat) return b.attrs['data-nav-cat'] === exp.navCat;
          if (exp.attrOpen) return Object.prototype.hasOwnProperty.call(b.attrs, exp.attrOpen);
          if (exp.cls) return hasClass(b.attrs, exp.cls);
          return false;
        });
        if (!found) { err('required item MISSING: ' + exp.id + ' on surface ' + surface + ' (' + rel + ')'); continue; }
        if (exp.label !== undefined && exp.label !== null && !sameLabel(found.label, exp.label)) {
          err('action label mismatch: ' + exp.id + ' on surface ' + surface + ' (' + rel + '): expected "' + exp.label + '", got "' + found.label + '"');
        }
        record(surface, exp.id, found.label, null, page);
      }
    }

    let checked = 0;
    for (const page of pagesWithChrome) {
      checked++;
      const html = fs.readFileSync(page, 'utf8');
      for (const [surface, spec] of Object.entries(EXPECTED)) {
        let inner = null;
        if (spec.special === 'footer-info') {
          // footer.info = the .foot-sec <details> whose <summary> is "Thông tin"
          const blocks = html.match(/<details[^>]*class="[^"]*foot-sec[^"]*"[^>]*>[\s\S]*?<\/details>/g) || [];
          const info = blocks.find(b => /<summary[^>]*>\s*Thông tin\s*<\/summary>/.test(b)) || null;
          inner = info;
        } else {
          inner = extractSurface(html, spec.locate);
        }
        if (inner === null) { err('required surface MISSING: ' + surface + ' (on ' + path.relative(SITE, page) + ')'); continue; }
        const items = surfaceItems(inner);
        const links = items.filter(i => i.kind === 'link' && !isBrandWordmark(i));
        const buttons 
= items.filter(i => i.kind === 'button');
        if (spec.links) checkLinks(surface, links, spec.links, page, base);
        if (spec.buttons) checkButtons(surface, buttons, spec.buttons, page);
      }
    }

    // cross-surface consistency for one canonical id
    const labelById = new Map();
    for (const [surface, m] of observed) {
      for (const [id, v] of m) {
        const prev = labelById.get(id);
        if (!prev) labelById.set(id, { label: v.label, surfaces: [surface] });
        else {
          prev.surfaces.push(surface);
          if (!sameLabel(prev.label, v.label)) err('label mismatch across surfaces for ' + id + ': "' + prev.label + '" (' + prev.surfaces.join(',') + ') vs "' + v.label + '" (' + surface + ')');
        }
      }
    }

    // URL resolution: every canonical nav URL must exist in the build
    const allUrls = new Set();
    for (const spec of Object.values(EXPECTED)) {
      for (const l of spec.links || []) allUrls.add(l.url);
    }
    for (const url of allUrls) {
      let r = url;
      if (/\.(xml|json|txt|webmanifest)$/.test(r)) {
        if (!fs.existsSync(path.join(SITE, r.slice(1)))) err('navigation URL does not resolve in build: ' + url);
      } else {
        if (r.endsWith('/')) r += 'index.html';
        else if (!r.endsWith('.html')) r += '/index.html';
        if (!fs.existsSync(path.join(SITE, r.slice(1)))) err('navigation URL does not resolve in build: ' + url);
      }
    }

    for (const it of inventory) {
      const surfs = [];
      for (const [surface, m] of observed) if (m.has(it.id)) surfs.push(surface);
      if (surfs.length) it.rendered_surfaces = surfs.sort();
    }
    console.log('validate-navigation: rendered identity check over ' + checked + ' page(s), ' + observed.size + ' required surface(s) observed');
  }
}

/* ---------------- report ---------------- */
fs.mkdirSync(path.join(DATA_ROOT, 'reports'), { recursive: true });
writeReport(DATA_ROOT, 'navigation-inventory.json', {
  generated_at:
 new Date().toISOString(),
  mode: SITE ? 'canonical+rendered' : 'canonical',
  data_root: DATA_ROOT,
  items: inventory,
  required_surfaces: REQUIRED_SURFACES,
  errors, warnings,
});
console.log('validate-navigation: ' + inventory.length + ' inventory item(s), ' + REQUIRED_SURFACES.length + ' required surface(s), ' + errors.length + ' error(s), ' + warnings.length + ' warning(s)');
if (errors.length) process.exit(1);
process.exit(0);
