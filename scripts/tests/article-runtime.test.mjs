#!/usr/bin/env node
// Article enhancement runtime regression test.
//
// Loads assets/js/article.js in Node (CommonJS-compatible IIFE) and runs its
// exported factory against a minimal in-memory DOM implementation. This stub
// is a LOGIC-TEST HARNESS: it models browser DOM behavior to assert the
// module's contracts, but it is NOT a real browser — passing this test does
// not certify rendered layout or styling (the browser QA job covers rendered
// behavior). Note on fidelity: assigning an anchor's href attribute reflects
// the href property in real browsers; that is valid behavior, not a stub
// limitation, and is not reported as a browser defect.
//
// Covers the required matrix:
//
//   tables: none | one | multiple | already-wrapped (repeated init)
//   headings: none | one | multiple | without ids | already-linked (repeated init)
//   clipboard: success (announced), failure (NOT announced), fallback success/failure
//   scope: enhancements run ONLY within .article; bare .prose stays untouched
//
// Run: node scripts/tests/article-runtime.test.mjs
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log('OK   ' + name); }
  else { failed++; console.log('BAD  ' + name + (detail ? ' — ' + detail : '')); }
}

/* ---------------- minimal DOM implementation ---------------- */
class ClassList {
  constructor() { this.set = new Set(); }
  add(...t) { t.forEach(x => this.set.add(x)); }
  remove(...t) { t.forEach(x => this.set.delete(x)); }
  contains(t) { return this.set.has(t); }
  toggle(t, force) {
    if (force === undefined) force = !this.set.has(t);
    force ? this.set.add(t) : this.set.delete(t);
    return force;
  }
}
class Elem {
  constructor(doc, tag) {
    this.doc = doc;
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.parentNode = null;
    this.attributes = {};
    this.classList = new ClassList();
    this._text = '';
    this._listeners = {};
    this.style = {};
    this.id = '';
    this.hidden = false;
  }
  get parentElement() { return this.parentNode; }
  set className(v) { this.classList = new ClassList(); String(v).split(/\s+/).filter(Boolean).forEach(c => this.classList.add(c))
; this._cls = String(v); }
  get className() { return this._cls || ''; }
  get textContent() {
    let s = this._text;
    for (const c of this.children) s += c.textContent;
    return s;
  }
  set textContent(v) { this.children = []; this._text = String(v); }
  appendChild(n) { n.parentNode = this; this.children.push(n); return n; }
  insertBefore(n, ref) {
    n.parentNode = this;
    const i = this.children.indexOf(ref);
    if (i < 0) this.children.push(n); else this.children.splice(i, 0, n);
    return n;
  }
  removeChild(n) { const i = this.children.indexOf(n); if (i >= 0) this.children.splice(i, 1); n.parentNode = null; return n; }
  remove() { if (this.parentNode) this.parentNode.removeChild(this); }
  setAttribute(k, v) { this.attributes[k] = String(v); if (k === 'class') this.className = v; if (k === 'id') this.id = v; }
  getAttribute(k) { return this.attributes.hasOwnProperty(k) ? this.attributes[k] : null; }
  addEventListener(type, fn) { (this._listeners[type] = this._listeners[type] || []).push(fn); }
  dispatch(type, event) {
    (this._listeners[type] || []).forEach(fn => fn(event || {}));
    // bubble to parent like a click
    if (type === 'click' && this.parentNode && this.parentNode.dispatch && !event.__stopped) this.parentNode.dispatch(type, event);
  }
  querySelector(sel) { const r = this.querySelectorAll(sel); return r.length ? r[0] : null; }
  querySelectorAll(sel) { return matchAll(this, sel); }
  select() {}
  scrollIntoView() { this.doc.scrollIntoViewCalls.push(this); }
  // selector support: tag, .class, tag.class, [attr], compound tag[attr], comma lists
}
function matchAll(root, sel) {
  const sels = sel.split(',').map(s => s.trim()).filter(Boolean);
  const out = [];
  walk(root, n => {
    for (const s of sels) if (matches(n, s) && out.indexOf(n) < 0) out.push(n);
  });
  return out;
}
// Descendant combinator support (".article .prose") plus simple selectors:
// tag, .class, tag.class, [attr], tag[attr], comma lists.
function matches(n, s) {
  const parts = s.split(/\s+/).filter(Boolean);
  if (parts.length < 2) return matchSimple(n, s);
  // rightmost part matches the node; earlier parts must match an ancestor chain
  let idx = parts.length - 1;
  if (!matchSimple(n, parts[idx])) return false;
  idx--;
  let p = n.parentNode;
  while (idx >= 0 && p) {
    if (matchSimple(p, parts[idx])) idx--;
    p = p.parentNode;
  }
  return idx < 0;
}
function walk(node, fn) { for (const c of node.children) { fn(c); walk(c, fn); } }
function matchSimple(n, s) {
  if (s === '*') return true;
  // generic: support "tag", "tag.cls", ".cls", "tag[attr]"
  const re = /^([a-zA-Z0-9]+)?((?:\.[\w-]+)*)?(\[[^\]]+\])?$/;
  const r = re.exec(s);
  if (!r) return false;
  const [, tag, cls, attr] = r;
  if (tag && n.tagName !== tag.toUpperCase()) return false;
  if (cls) {
    for (const c of cls.split('.').filter(Boolean)) if (!n.classList.contains(c)) return false;
  }
  if (attr) {
    const am = /^\[([\w-]+)(?:="([^"]*)")?\]$/.exec(attr);
    if (!am) return false;
    const v = n.getAttribute(am[1]);
    if (v === null) return false;
    if (am[2] !== undefined && v !== am[2]) return false;
  }
  return true;
}
class MiniDoc {
  constructor() {
    this.body = new Elem(this, 'body');
    this.scrollIntoViewCalls = [];
    this.execCommandResult = true;
    this.execCommandCalls = 0;
    this._suppressed = true;
  }
  createElement(tag) { return new Elem(this, tag); }
  querySelector(sel) { return this.body.querySelector(sel); }
  querySelectorAll(sel) { return this.body.querySelectorAll(sel); }
  queryCommandSupported(cmd) { return cmd === 'copy'; }
  execCommand(cmd) { this.execCommandCalls++; return this.execCommandResult; }
}
function makeWin(doc, clipboardBehavior) {
  const win = {
    history: { replaceStateCalls: [], replaceState: function () { this.replaceStateCalls.push(Array.from(arguments)); } },
    location: { href: 'https://example.invalid/lab/bai-thu/' },
    navigator: {},
    matchMedia: function (q) { return { matches: false, media: q }; },
    setTimeout: setTimeout,
  };
  if (clipboardBehavior === 'ok') {
    win.navigator.clipboard = { writeText: (t) => Promise.resolve(t) };
  } else if (clipboardBehavior === 'fail') {
    win.navigator.clipboard = { writeText: () => Promise.reject(new Error('denied')) };
  }
  // 'none' -> no clipboard API, legacy execCommand path used
  return win;
}
/* ------------------------------------------------------------ 
*/

// Load the module (registers globalThis.XDCArticleEnhance).
await import(pathToFileURL(path.join(HERE, '..', '..', 'assets', 'js', 'article.js')).href);
const enhance = globalThis.XDCArticleEnhance;
check('module loads and exports the factory', typeof enhance === 'function');

function articleDom({ tables = 0, headings = 0, headingIds = true, extraHeadingNoId = false } = {}) {
  const doc = new MiniDoc();
  const article = doc.createElement('article'); article.className = 'article';
  const prose = doc.createElement('div'); prose.className = 'prose';
  article.appendChild(prose); doc.body.appendChild(article);
  for (let i = 0; i < headings; i++) {
    const h = doc.createElement('h2');
    if (headingIds) h.setAttribute('id', 'muc-' + (i + 1));
    h.textContent = 'Mục ' + (i + 1) + ' kiểm thử';
    prose.appendChild(h);
  }
  if (extraHeadingNoId) { const h = doc.createElement('h2'); h.textContent = 'Không id'; prose.appendChild(h); }
  for (let i = 0; i < tables; i++) {
    const t = doc.createElement('table'); prose.appendChild(t);
  }
  return { doc, prose };
}

// 1. no tables, no headings
{
  const { doc } = articleDom({});
  const r = enhance(doc, makeWin(doc));
  check('no tables/headings: zero work, no exception', r.tablesWrapped === 0 && r.headingsLinked === 0);
}

// 2. one table, one heading
{
  const { doc } = articleDom({ tables: 1, headings: 1 });
  const r = enhance(doc, makeWin(doc));
  check('one table wrapped once', r.tablesWrapped === 1 && doc.body.querySelectorAll('.table-wrap').length === 1);
  const w = doc.body.querySelector('.table-wrap');
  check('table-wrap is a labelled scroll region', w.getAttribute('role') === 'region' && w.getAttribute('tabindex') === '0' && !!w.getAttribute('aria-label'));
  check('one heading linked once', r.headingsLinked === 1 && doc.body.querySelectorAll('.h-link').length === 1);
  check('heading link points at the anchor', doc.body.querySelector('.h-link').getAttribute('href') === '#muc-1');
}

// 3. multiple tables + multiple headings + un-id-ed heading skipped
{
  const { doc } = articleDom({ tables: 3, headings: 4, extraHeadingNoId: true });
  const r = enhance(doc, makeWin(doc));
  check('three tables each wrapped once', r.tablesWrapped === 3 && doc.body.querySelectorAll('.table-wrap').length === 3 && doc.body.querySelectorAll('table').length === 3);
  check('four headings linked, un-id-ed heading skipped', r.headingsLinked === 4 && doc.body.querySelectorAll('.h-link').length === 4);
}

// 4. repeated initialization is idempotent
{
  const { doc } = articleDom({ tables: 2, headings: 2 });
  enhance(doc, makeWin(doc));
  const r2 = enhance(doc, makeWin(doc));
  const r3 = enhance(doc, makeWin(doc));
  check('repeated init: no double wrap', r2.tablesWrapped === 0 && r3.tablesWrapped === 0 && doc.body.querySelectorAll('.table-wrap').length === 2);
  check('repeated init: no duplicate heading links', r2.headingsLinked === 0 && r3.headingsLinked === 0 && doc.body.querySelectorAll('.h-link').length === 2);
}

// 5. clipboard success announces copied
{
  const { doc } = articleDom({ headings: 1 });
  const win = makeWin(doc, 'ok');
  enhance(doc, win);
  const a = doc.body.querySelector('.h-link');
  a.dispatch('click', { preventDefault() {} });
  await new Promise(r => setTimeout(r, 5));
  check('clipboard success: link marked copied', a.classList.contains('is-copied'));
}

// 6. clipboard failure does NOT announce copied
{
  const { doc } = articleDom({ headings: 1 });
  const win = makeWin(doc, 'fail');
  enhance(doc, win);
  const a = doc.body.querySelector('.h-link');
  a.dispatch('click', { preventDefault() {} });
  await new Promise(r => setTimeout(r, 5));
  check('clipboard failure: NO copied announcement', !a.classList.contains('is-copied'));
}

// 7. legacy fallback: success announces, failure does not
{
  const { doc } = articleDom({ headings: 2 });
  const win = makeWin(doc, 'none');
  enhance(doc, win);
  const links = doc.body.querySelectorAll('.h-link');
 
 doc.execCommandResult = true;
  links[0].dispatch('click', { preventDefault() {} });
  check('legacy fallback success: copied announced, textarea cleaned up', links[0].classList.contains('is-copied') && doc.execCommandCalls === 1 && doc.body.querySelectorAll('textarea').length === 0);
  doc.execCommandResult = false;
  links[1].dispatch('click', { preventDefault() {} });
  check('legacy fallback failure: NOT announced', !links[1].classList.contains('is-copied') && doc.execCommandCalls === 2);
}

// 8. anchor navigation: replaceState + scrollIntoView honored, reduced motion respected
{
  const { doc } = articleDom({ headings: 1 });
  const win = makeWin(doc, 'ok');
  win.matchMedia = q => ({ matches: q.indexOf('reduce') >= 0, media: q });
  enhance(doc, win);
  const a = doc.body.querySelector('.h-link');
  a.dispatch('click', { preventDefault() {} });
  check('click updates the hash via history.replaceState', win.history.replaceStateCalls.length === 1);
  check('click scrolls the heading into view', doc.scrollIntoViewCalls.length === 1);
}

// 9. SCOPE: bare .prose outside an .article root is NOT enhanced (the
//    enhancements are scoped to the .article component, matching the scoped
//    article.css styles). Category/static-page prose stays untouched.
{
  const doc = new MiniDoc();
  const prose = doc.createElement('div'); prose.className = 'prose';
  const t = doc.createElement('table'); prose.appendChild(t); doc.body.appendChild(prose);
  const h = doc.createElement('h2'); h.setAttribute('id', 'muc-ngoai'); h.textContent = 'Mục ngoài article'; prose.appendChild(h);
  const r = enhance(doc, makeWin(doc));
  check('bare .prose (no .article root) NOT enhanced — table stays unwrapped', r.tablesWrapped === 0 && doc.body.querySelectorAll('.table-wrap').length === 0);
  check('bare .prose (no .article root) NOT enhanced — heading gets no permalink', r.headingsLinked === 0 && doc.body.querySelectorAll('.h-link').length === 0);
}

// 10. prose INSIDE .article receives enhancements (positive scope case —
//     covered above via articleDom(), asserted explicitly here once more).
{
  const { doc } = articleDom({ tables: 1, headings: 1 });
  const r = enhance(doc, makeWin(doc));
  check('.article .prose IS enhanced (scoped selector finds it)', r.tablesWrapped === 1 && r.headingsLinked === 1);
}

console.log('\narticle-runtime: ' + passed + ' passed, ' + failed + ' failed.');
process.exit(failed ? 1 : 0);
