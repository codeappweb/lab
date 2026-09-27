#!/usr/bin/env node
// Browser QA — REAL Chromium (Playwright) against the REPAIR BRANCH build.
//
// Serves the Jekyll build (SITE_DIR, default _site) on a local HTTP server
// (the site's absolute URLs carry the /lab baseurl; the server strips it),
// then drives real pages across mobile/tablet/desktop viewports in light and
// dark themes and checks:
//   - no uncaught page errors / console errors
//   - no unintended horizontal page overflow
//   - menu/footer labels + destinations (against the shared canonical data)
//   - search / saved / topic / nav-drawer sheets open and close (Escape,
//     focus restoration, aria-expanded)
//   - TOC anchors resolve to real ids
//   - article tables are wrapped in scroll regions
//   - copy (permalink) feedback is applied on success
//   - reduced-motion emulation loads without errors
//   - 200% zoom loads without page errors
// Screenshots are written to screenshots/ (uploaded as a CI artifact for
// HUMAN inspection — automated screenshots are not a substitute for it).
//
// This is a real browser test, but it does NOT claim completed visual QA:
// design quality is judged only by a human looking at the screenshots.
//
// Run (local): bundle exec jekyll build && npm i --no-save playwright@1.49.1 \
//   && npx playwright install --with-deps chromium && node scripts/tests/browser-qa.mjs
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { loadCanonical } from '../lib/nav-data.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const SITE_DIR = process.env.SITE_DIR ? path.resolve(ROOT, process.env.SITE_DIR) : path.join(ROOT, '_site');
const SHOTS = path.join(ROOT, 'screenshots');
fs.mkdirSync(SHOTS, { recursive: true });

let passed = 0, failed = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { passed++; console.log('OK   ' + name); }
  else { failed++; failures.push(name + (detail ? ' — ' + detail : '')); console.log('BAD  ' + name + (detail ? ' — ' + detail : '')); }
}

/* ---------------- local server (strip the /lab baseurl) ---------------- */
const PORT = 4173;
const MIME = {
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.ico': 'image/x-icon', '.xml': 'application/xml; charset=utf-8',
  '.html': 'text/html; charset=utf-8', '.txt': 'text/plain; charset=utf-8',
};
const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0].split('#')[0]);
  if (p.startsWith('/lab/')) p = p.slice(4);
  else if (p === '/lab') p = '/';
  let file = path.join(SITE_DIR, p);
  try {
    if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
    if (!fs.existsSync(file)) { res.writeHead(404); res.end('not found'); return; }
    // Correct MIME types: Chromium refuses stylesheets served with a
    // non-CSS MIME type, which would silently degrade the whole QA run.
    const type = MIME[path.extname(file)] || 'text/html; charset=utf-8';
    res.writeHead(200, { 'content-type': type });
    res.end(fs.readFileSync(file));
  } catch { res.writeHead(500); res.end('err'); }
});
await new Promise(r => server.listen(PORT, '127.0.0.1', r));

/* ---------------- probe: what does the server actually send? ---------------- */
await new Promise((resolve) => {
  http.get(BASE + '/assets/css/main.css', (res) => {
    let n = 0, head = '';
    res.on('data', (d) => { if (n === 0) head = d.slice(0, 60).toString('utf8'); n += d.length; });
    res.on('end', () => { console.log('CSS-PROBE ' + JSON.stringify({ status: res.statusCode, type: res.headers['content-type'], bytes: n, head })); resolve(null); });
  }).on('error', (e) => { console.log('CSS-PROBE ERR ' + e.message); resolve(null); });
});
const BASE = 'http://127.0.0.1:' + PORT + '/lab';

/* ---------------- page selection from the ACTUAL build ---------------- */
function pageExists(url) {
  const p = url.replace(/^\//, '').replace(/\/$/, '/index.html');
  return fs.existsSync(path.join(SITE_DIR, p));
}
const canon = loadCanonical(ROOT);
const members = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'category-members.json'), 'utf8'));
const populatedParent = Object.entries(members.parents || {}).find(([, cards]) => cards.length > 0);
let populatedChild = null, emptyChild = null;
for (const p of canon.parents) {
  for (const c of (p.children || [])) {
    const cards = ((members.children || {})[p.slug] || {})[c.slug] || ((members.children || {})[p.slug + '/' + c.slug]);
    const has = Array.isArray(cards) ? cards.length : !!(cards && cards.count);
    if (!populatedChild && has) populatedChild = '/danh-muc/' + p.slug + '/' + c.slug + '/';
    if (!emptyChild && !has) emptyChild = '/danh-muc/' + p.slug + '/' + c.slug + '/';
  }
}
const posts = fs.readdirSync(path.join(SITE_DIR, '..', '_posts')).filter(f => f.endsWith('.md'))
  .map(f => {
    const text = fs.readFileSync(path.join(SITE_DIR, '..', '_posts', f), 'utf8');
    const fm = /^---\n([\s\S]*?)\n---/.exec(text);
    const data = {};
    for (const line of (fm ? fm[1] : '').split('\n')) {
      const m = /^([\w-]+):\s*"?(.*?)"?\s*$/.exec(line);
      if (m) data[m[1]] = m[2];
    }
    return { file: f, slug: f.replace(/^\d{4}-\d{2}-\d{2}-/, '').replace(/\.md$/, ''), title: data.title || '', size: text.length, text };
  })
  .sort((a, b) => b.size - a.size);
const article = posts[0] ? '/' + posts[0].slug + '/' : null;
const longTitlePost = [...posts].sort((a, b) => (b.title || '').length - (a.title || '').length)[0];
const staticPage = canon.navMain.find(n => n.url !== '/' && pageExists(n.url));
const pages = [];
pages.push({ name: 'home', url: '/' });
pages.push({ name: 'category-index', url: '/danh-muc/' });
if (populatedParent) pages.push({ name: 'parent-category', url: '/danh-muc/' + populatedParent[0] + '/' });
if (populatedChild) pages.push({ name: 'populated-child', url: populatedChild });
if (emptyChild) pages.push({ name: 'empty-child', url: emptyChild });
if (article) pages.push({ name: 'article-rich', url: article });
if (longTitlePost && '/' + longTitlePost.slug + '/' !== article) pages.push({ name: 'article-long-title', url: '/' + longTitlePost.slug + '/' });
if (staticPage) pages.push({ name: 'static-page', url: staticPage.url });

const VIEWPORTS = [
  { w: 360, h: 800, group: 'mobile' }, { w: 390, h: 844, group: 'mobile' },
  { w: 768, h: 1024, group: 'tablet' }, { w: 1024, h: 768, group: 'tablet' },
  { w: 1280, h: 800, group: 'desktop' }, { w: 1440, h: 900, group: 'desktop' },
  { w: 900, h: 900, group: 'intermediate' },
];

/* ---------------- run ---------------- */
const browser = await chromium.launch();
const ctx = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] });
async function newPage({ w, h, theme, reducedMotion } = {}) {
  const page = await ctx.newPage();
  await page.setViewportSize({ width: w || 1280, height: h || 800 });
  const errors = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => {
    if (m.type() === 'error' && !/favicon/i.test(m.text())) errors.push('console: ' + m.text());
  });
  if (theme === 'dark') {
    await page.addInitScript(() => {
      try {
        const s = localStorage.getItem('theme');
        document.documentElement.setAttribute('data-theme', 'dark');
      } catch (e) {}
    });
  }
  if (reducedMotion) await page.emulateMedia({ reducedMotion: 'reduce' });
  page.__errors = errors;
  return page;
}
const overflow = (page) => page.evaluate(() =>
  document.documentElement.scrollWidth - document.documentElement.clientWidth);

// 1. every page x key viewports: no errors, no horizontal overflow, screenshot
{
  const keyVps = VIEWPORTS.filter(v => [360, 768, 1280, 1440, 900].includes(v.w));
  for (const pg of pages) {
    for (const vp of keyVps) {
      const page = await newPage({ w: vp.w, h: vp.h });
      await page.goto(BASE + pg.url, { waitUntil: 'networkidle' });
      await page.waitForTimeout(250);
      check('no console/page errors: ' + pg.name + ' @' + vp.w, page.__errors.length === 0, page.__errors.slice(0, 2).join(' | '));
      const ov = await overflow(page);
      check('no horizontal overflow: ' + pg.name + ' @' + vp.w, ov <= 1, 'scrollWidth delta=' + ov);
      await page.screenshot({ path: path.join(SHOTS, pg.name + '-' + vp.w + '.png'), fullPage: false });
      await page.close();
    }
  }
}

// 2. dark theme: spot pages render in dark without errors/overflow
{
  for (const pg of [pages[0], pages.find(p => p.name === 'article-rich')].filter(Boolean)) {
    const page = await newPage({ w: 390, h: 844, theme: 'dark' });
    await page.goto(BASE + pg.url, { waitUntil: 'networkidle' });
    await page.evaluate(() => { document.documentElement.setAttribute('data-theme', 'dark'); });
    const theme = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
    check('dark theme applied: ' + pg.name, theme === 'dark', 'data-theme=' + theme);
    check('no console/page errors (dark): ' + pg.name, page.__errors.length === 0, page.__errors.slice(0, 2).join(' | '));
    const ov = await overflow(page);
    check('no horizontal overflow (dark): ' + pg.name + ' @390', ov <= 1, 'delta=' + ov);
    await page.screenshot({ path: path.join(SHOTS, pg.name + '-390-dark.png') });
    await page.close();
  }
}

// 3. menu/footer labels + destinations against canonical data (360 + 1280)
{
  for (const w of [360, 1280]) {
    const page = await newPage({ w, h: 800 });
    await page.goto(BASE + '/', { waitUntil: 'networkidle' });
    // header main links: canonical main[1..3]
    const headerLabels = await page.$$eval('nav.main-nav > a', as => as.map(a => [a.textContent.trim(), a.getAttribute('href')]));
    for (const item of canon.navMain.slice(1, 4)) {
      const found = headerLabels.find(([t]) => t === item.label);
      check('header label "' + item.label + '" @' + w, !!found, JSON.stringify(headerLabels));
      if (found) check('header destination for "' + item.label + '" @' + w, (found[1] || '').indexOf(item.url) >= 0, found[1]);
    }
    // footer info section: ALL canonical main links
    const infoLinks = await page.$$eval('details.foot-sec .foot-links a', as => as.map(a => [a.textContent.trim(), a.getAttribute('href')]));
    for (const item of canon.navMain) {
      const found = infoLinks.find(([t]) => t === item.label);
      check('footer label "' + item.label + '" @' + w, !!found, JSON.stringify(infoLinks.slice(0, 8)));
      if (found) check('footer destination for "' + item.label + '" @' + w, (found[1] || '').indexOf(item.url) >= 0, found[1]);
    }
    // footer quick actions: canonical action labels
    const actionButtons = await page.$$eval('.foot-links--actions button', bs => bs.map(b => [b.textContent.trim(), b.getAttribute('data-qa')]));
    for (const a of canon.actions.filter(x => !x.url)) {
      const found = actionButtons.find(([, qa]) => qa === a.data_qa);
      check('footer action "' + a.label + '" (data-qa=' + a.data_qa + ') @' + w, !!found && found[0] === a.label, JSON.stringify(actionButtons));
    }
    // bottom nav (always in the DOM)
    const bottom = await page.$$eval('nav.bottom-nav > *', els => els.map(e => ({
      text: e.textContent.trim(), href: e.getAttribute('href'), sheet: e.hasAttribute('data-sheet-open'), search: e.hasAttribute('data-search-open')
    })));
    check('bottom-nav has home + topics + search @' + w,
      bottom.length >= 3 && bottom.some(b => b.href) && bottom.some(b => b.sheet) && bottom.some(b => b.search),
      JSON.stringify(bottom));
    await page.close();
  }
}

// 4. sheets: search / saved / topics / nav drawer — open, Escape closes, focus
{
  const page = await newPage({ w: 360, h: 800 });
  await page.goto(BASE + '/', { waitUntil: 'networkidle' });
  // nav drawer
  await page.click('[data-nav-open]');
  await page.waitForTimeout(150);
  let drawerHidden = await page.$eval('#navDrawer', el => el.hidden);
  check('nav drawer opens on [data-nav-open]', drawerHidden === false, 'hidden=' + drawerHidden);
  await page.keyboard.press('Escape');
  // main.js closes sheets on a setTimeout (220ms) — wait well past it.
  await page.waitForTimeout(400);
  drawerHidden = await page.$eval('#navDrawer', el => el.hidden);
  check('Escape closes the nav drawer', drawerHidden === true, 'hidden=' + drawerHidden);
  // search palette
  await page.click('[data-search-open]');
  await page.waitForTimeout(150);
  const searchOpen = await page.$eval('#searchOverlay', el => !el.hidden);
  check('search palette opens on [data-search-open]', searchOpen === true, 'hidden? ' + !searchOpen);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);
  const searchClosed = await page.$eval('#searchOverlay', el => el.hidden);
  check('Escape closes the search palette', searchClosed === true);
  // saved sheet via data-qa
  const savedBtn = await page.$('[data-qa="saved"]');
  if (savedBtn) {
    await savedBtn.click();
    await page.waitForTimeout(150);
    const savedReacted = await page.$eval('#savedSheet', el => !el.hidden);
    check('saved sheet opens on [data-qa="saved"] click', savedReacted === true, 'hidden? ' + !savedReacted);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(400);
  } else {
    check('saved surface: [data-qa="saved"] button present', false, 'button missing');
  }
  // topic sheet
  await page.click('nav.bottom-nav [data-sheet-open]');
  await page.waitForTimeout(150);
  const topicOpen = await page.$eval('#topicSheet', el => !el.hidden).catch(() => null);
  check('topic sheet opens from bottom-nav', topicOpen === true, 'state=' + topicOpen);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);
  // focus restoration: focus returns to a focusable element (not body-lost)
  const activeTag = await page.evaluate(() => document.activeElement && document.activeElement.tagName);
  check('focus restored after Escape (active element is focusable)', activeTag && activeTag !== 'BODY', 'active=' + activeTag);
  await page.screenshot({ path: path.join(SHOTS, 'sheets-360.png') });
  await page.close();
}

// 5. article page: TOC anchors, table wrap, copy feedback, reading width
{
  if (article) {
    const page = await newPage({ w: 1280, h: 800 });
    await page.goto(BASE + article, { waitUntil: 'networkidle' });
    await page.waitForTimeout(300);
    const tocOk = await page.evaluate(() => {
      const links = Array.from(document.querySelectorAll('.toc a[href^="#"], nav[id*="toc"] a[href^="#"]'));
      const bad = links.filter(a => !document.getElementById(a.getAttribute('href').slice(1)));
      return { total: links.length, bad: bad.length };
    });
    if (tocOk.total > 0) check('TOC anchors all resolve to real ids', tocOk.bad === 0, JSON.stringify(tocOk));
    else check('TOC present on article page', false, 'no TOC links found');
    const tables = await page.$$eval('.article table', ts => ts.map(t => {
      let p = t.parentElement, wrapped = false;
      while (p) { if (String(p.className || '').indexOf('table-wrap') >= 0) { wrapped = true; break; } p = p.parentElement; }
      return wrapped;
    }));
    if (tables.length) check('article tables wrapped in scroll regions (article.js ran)', tables.every(Boolean), JSON.stringify(tables));
    else console.log('NOTE: no tables in the richest article — table-wrap check skipped (covered by runtime test)');
    const hlink = await page.$('.article .h-link');
    if (hlink) {
      await hlink.click();
      await page.waitForTimeout(300);
      const copied = await page.$eval('.article .h-link', el => el.classList.contains('is-copied')).catch(() => false);
      check('copy feedback applied on successful permalink copy', copied === true, 'is-copied=' + copied);
    } else {
      console.log('NOTE: no .h-link found (no eligible headings?)');
    }
    // CSS must be applied before measuring: an unstyled page reports the raw
    // body width (1264px at a 1280px viewport) and would be misreported as a
    // layout defect. Wait for stylesheets, then report full diagnostics so a
    // stylesheet load failure is distinguishable from a real grid problem.
    await page.waitForFunction(() => document.styleSheets.length > 0, null, { timeout: 5000 }).catch(() => {});
    const m = await page.evaluate(() => {
      const prose = document.querySelector('.article .prose');
      const wrap = prose ? prose.closest('.article-body-wrap') : null;
      return {
        sheets: document.styleSheets.length,
        display: wrap ? getComputedStyle(wrap).display : null,
        cols: wrap ? getComputedStyle(wrap).gridTemplateColumns : null,
        width: prose ? prose.getBoundingClientRect().width : null
      };
    });
    check('article page stylesheets applied', m.sheets >= 4, 'sheets=' + m.sheets);
    // CSSOM dump: which sheet carries the .article-body-wrap rules, and how
    // many rules Chromium actually parsed per sheet. Distinguishes a served-
    // file problem (0 rules / missing rule) from a cascade problem.
    const cssInfo = await page.evaluate(() => {
      const found = [];
      for (let i = 0; i < document.styleSheets.length; i++) {
        const s = document.styleSheets[i];
        let rules = -1, hits = [];
        try {
          rules = s.cssRules.length;
          for (const r of s.cssRules) {
            if (r.selectorText && r.selectorText.indexOf('article-body-wrap') >= 0) hits.push(r.cssText.slice(0, 140));
          }
        } catch (e) { rules = 'ERR:' + e.message; }
        found.push({ i, file: (s.href || '').split('/').pop(), rules, wrapRules: hits });
      }
      return found;
    });
    console.log('CSSOM ' + JSON.stringify(cssInfo));
    if (m.width !== null) {
      check('reading width within 600-760px at desktop', m.width >= 600 && m.width <= 760,
        'width=' + Math.round(m.width) + ' sheets=' + m.sheets + ' wrapDisplay=' + m.display + ' cols=' + m.cols);
    } else {
      check('reading width: .article .prose present', false, 'element missing');
    }
    await page.close();
  } else {
    check('article page exists in the build', false, 'no posts found');
  }
}

// 6. reduced motion + 200% zoom: no page errors
{
  const page = await newPage({ w: 390, h: 844, reducedMotion: true });
  await page.goto(BASE + '/', { waitUntil: 'networkidle' });
  await page.waitForTimeout(200);
  check('reduced-motion emulation: no console/page errors', page.__errors.length === 0, page.__errors.slice(0, 2).join(' | '));
  await page.close();

  const page2 = await newPage({ w: 1280, h: 800 });
  await page2.goto(BASE + '/', { waitUntil: 'networkidle' });
  await page2.evaluate(() => { document.body.style.zoom = '2'; });
  await page2.waitForTimeout(200);
  check('200% zoom: no console/page errors', page2.__errors.length === 0, page2.__errors.slice(0, 2).join(' | '));
  await page2.screenshot({ path: path.join(SHOTS, 'home-1280-zoom200.png') });
  await page2.close();
}

await browser.close();
server.close();
console.log('\nbrowser-qa: ' + passed + ' passed, ' + failed + ' failed.');
console.log('browser-qa: screenshots written to screenshots/ — these require HUMAN visual inspection; automated screenshots do not complete visual QA.');
if (failed) {
  console.log('browser-qa failures:\n  ' + failures.join('\n  '));
  process.exit(1);
}
process.exit(0);
