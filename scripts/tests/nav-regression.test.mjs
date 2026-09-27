#!/usr/bin/env node
// Navigation validation REGRESSION FIXTURE TEST.
//
// Reproduces the original defect class end-to-end: a fixture with a WRONG
// HOME LABEL consistently in BOTH header and footer used to pass with zero
// errors, because the old validator only compared labels ACROSS surfaces.
// The v2 validator compares every rendered label against CANONICAL data
// (shared via scripts/lib/nav-data.mjs), so a wrong-everywhere label fails.
//
// The fixture renders a synthetic site page from the SAME canonical data
// (data/navigation.yml, data/actions.yml, data/taxonomy.yml, data/menu-cats.yml)
// that the real includes render from — no duplicated hardcoded labels — then
// runs scripts/validate-navigation.mjs against it and asserts:
//   - the OK fixture passes,
//   - each defect variant FAILS:
//       wrong home label everywhere, wrong label on one surface only,
//       wrong action-button label, wrong button identity (data-qa),
//       wrong destination, missing required surface, missing required item,
//   - the documented exceptions pass:
//       brand wordmark (logo/site-name link), "Tất cả <label>" groupings.
//
// Run: node scripts/tests/nav-regression.test.mjs
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync, mkdirSync, cpSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { loadCanonical } from '../lib/nav-data.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const VALIDATOR = path.join(REPO, 'scripts', 'validate-navigation.mjs');

let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log('OK   ' + name); }
  else { failed++; console.log('BAD  ' + name + (detail ? ' — ' + detail : '')); }
}

// ---------- fixture scaffold ----------
function mkFixture() {
  const dataRoot = mkdtempSync(join(tmpdir(), 'nav-fx-data-'));
  const siteDir = mkdtempSync(join(tmpdir(), 'nav-fx-site-'));
  mkdirSync(join(dataRoot, 'data'), { recursive: true });
  for (const f of ['navigation.yml', 'actions.yml', 'taxonomy.yml', 'menu-cats.yml']) {
    cpSync(join(REPO, 'data', f), join(dataRoot, 'data', f));
  }
  return { dataRoot, siteDir, canon: loadCanonical(dataRoot) };
}

function join(...segs) { return path.join(...segs); }
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');

// Render a synthetic site page mirroring the includes' Liquid loops.
// mut: (rendered) => void — post-render mutation of the HTML string.
// dataMut: (canon) => void — mutation of the canonical data BEFORE rendering
// (the validator loads the SAME mutated files, so wrong-everywhere is caught
// by canonical sanity; a mutation that keeps canonical data intact catches
// single-surface drift).
function renderPage(canon, dataMut, mut) {
  if (dataMut) dataMut(canon);
  const parents = canon.parents;
  const main = canon.navMain;
  const mainMid = main.slice(1, 4);
  const actions = canon.actions;
  const H = [];
  H.push('<!DOCTYPE html><html lang="vi"><body>');
  // header (mirrors _includes/header.html)
  H.push('<header class="app-bar" id="appBar"><div class="container app-bar__inner">');
  H.push('<a class="logo" href="/">Xe &amp; Di Chuyển</a>'); // brand wordmark exception
  H.push('<nav class="main-nav" aria-label="Điều hướng chính">');
  for (const it of mainMid) H.push('<a href="' + it.url + '">' + esc(it.label) + '</a>');
  H.push('<div class="mega-wrap"><button type="button" class="mega-trigger" aria-haspopup="true">Danh mục</button>');
  H.push('<div class="mega" role="group">');
  for (const p of parents) {
    H.push('<div class="mega__col"><span class="mega__group">' + esc(p.name) + '</span>');
    H.push('<a class="mega__parent" href="/danh-muc/' + p.slug + '/">' + esc(p.name) + '</a>');
    for (const c of (p.children || [])) H.push('<a class="mega__child" href="/danh-muc/' + p.slug + '/' + c.slug + '/">' + esc(c.name) + '</a>');
    H.push('</div>');
  }
  H.push('</div></div></nav>');
  H.push('<div class="app-bar__actions">');
  H.push('<button type="button" class="icon-btn" data-search-open aria-label="Tìm kiếm (Ctrl K)"><svg></svg></button>');
  H.push('<button type="button" class="icon-btn" data-qa="assistant" aria-label="Trợ lý AI"><svg></svg><span class="icon-btn__label">AI</span></button>');
  H.push('<button type="button" class="icon-btn" data-qa="saved" aria-label="Bài đã lưu"><svg></svg><span class="icon-btn__label">Đã lưu</span></button>');
  H.push('<button type="button" class="theme-toggle" data-theme-toggle aria-pressed="false"><span class="sun"></span></button>');
  H.push('<button type="button" class="menu-btn" data-nav-open aria-controls="navDrawer"><svg></svg></button>');
  H.push('</div></div></header>');
  // footer (mirrors _includes/footer.html — actions from data/actions.yml)
  H.push('<footer class="site-footer"><div class="container footer-grid">');
  H.push('<div class="foot-brand"><a class="foot-brand__link" href="/">Xe &amp; Di Chuyển</a></div>');
  H.push('<details class="foot-sec"><summary class="foot-sec__h">Truy cập nhanh</summary>');
  H.push('<div class="foot-links foot-links--actions">');
  for (const a of actions) {
    if (a.url) H.push('<a class="foot-act" href="' + a.url + '">' + esc(a.label) + '</a>');
    else H.push('<button type="button" class="foot-act" data-qa="' + a.data_qa + '">' + esc(a.label) + '</button>');
  }
  H.push('</div></details>');
  H.push('<details class="foot-sec foot-sec--discover"><summary class="foot-sec__h">Khám phá</summary>');
  H.push('<div class="foot-discover"><div class="foot-links">');
  for (const s of [...(canon.menuCats.primary || []), ...(canon.menuCats.more || [])]) {
    const p = parents.find(x => x.slug === s);
    H.push('<a href="/danh-muc/' + p.slug + '/">' + esc(p.name) + '</a>');
  }
  H.push('</div></div></details>');
  H.push('<details class="foot-sec"><summary class="foot-sec__h">Thông tin</summary>');
  H.push('<div class="foot-links">');
  for (const it of main) H.push('<a href="' + it.url + '">' + esc(it.label) + '</a>');
  H.push('</div></details>');
  H.push('</div></footer>');
  // nav drawer (mirrors _includes/nav-drawer.html)
  H.push('<div class="sheet-backdrop" id="navBackdrop" hidden></div>');
  H.push('<aside class="nav-drawer" id="navDrawer" hidden><div class="nav-drawer__body">');
  H.push('<div class="nav-scr" id="navScrHome">');
  H.push('<div class="nav-actions" aria-label="Truy cập nhanh">');
  for (const a of actions) {
    if (a.url) H.push('<a class="nav-action" href="' + a.url + '"><span>' + esc(a.label) + '</span></a>');
    else H.push('<button type="button" class="nav-action" data-qa="' + a.data_qa + '"><span>' + esc(a.label) + '</span></button>');
  }
  H.push('</div>');
  H.push('<div class="nav-cats" aria-label="Khám phá danh mục">');
  for (const s of [...(canon.menuCats.primary || []), ...(canon.menuCats.more || [])]) {
    const p = parents.find(x => x.slug === s);
    H.push('<button type="button" class="nav-cat" data-nav-cat="' + p.slug + '"><span class="nav-cat__label">' + esc(p.name) + '</span></button>');
  }
  H.push('</div>');
  H.push('<nav class="nav-info" aria-label="Thông tin">');
  for (const it of main) H.push('<a href="' + it.url + '">' + esc(it.label) + '</a>');
  H.push('</nav></div>');
  for (const p of parents) {
    H.push('<div class="nav-scr" id="navScr-' + p.slug + '" hidden><div class="nav-kids">');
    H.push('<a class="nav-kid nav-kid--all" href="/danh-muc/' + p.slug + '/">Tất cả ' + esc(p.name) + '</a>');
    for (const c of (p.children || [])) H.push('<a class="nav-kid" href="/danh-muc/' + p.slug + '/' + c.slug + '/">' + esc(c.name) + '</a>');
    H.push('</div></div>');
  }
  H.push('</div></aside>');
  // topic sheet (mirrors _includes/topic-sheet.html)
  H.push('<aside class="sheet" id="topicSheet" hidden>');
  H.push('<nav class="sheet__nav" aria-label="Danh mục chủ đề">');
  for (const p of parents) {
    H.push('<details class="topic-group"><summary><span class="topic-group__name">' + esc(p.name) + '</span></summary>');
    H.push('<div class="topic-group__children">');
    H.push('<a class="topic-group__all" href="/danh-muc/' + p.slug + '/">Tất cả ' + esc(p.name) + '</a>');
    for (const c of (p.children || [])) H.push('<a href="/danh-muc/' + p.slug + '/' + c.slug + '/">' + esc(c.name) + '</a>');
    H.push('</div></details>');
  }
  H.push('</nav></aside>');
  // bottom nav (mirrors _layouts/default.html)
  H.push('<nav class="bottom-nav" aria-label="Điều hướng nhanh">');
  H.push('<a href="/">Trang chủ</a>');
  H.push('<button type="button" data-sheet-open><span>Chủ đề</span></button>');
  H.push('<button type="button" data-search-open><span>Tìm kiếm</span></button>');
  H.push('</nav>');
  H.push('</body></html>');
  let html = H.join('\n');
  if (mut) html = mut(html, canon);
  return html;
}

// Stub target files for every canonical URL (URL-resolution checks).
function stubUrls(fx, canon) {
  const urls = new Set(['/']);
  for (const n of canon.navMain) urls.add(n.url);
  for (const p of canon.parents) {
    urls.add('/danh-muc/' + p.slug + '/');
    for (const c of (p.children || [])) urls.add('/danh-muc/' + p.slug + '/' + c.slug + '/');
  }
  for (const a of canon.actions) if (a.url) urls.add(a.url);
  for (const u of urls) {
    if (!u.startsWith('/')) continue;
    const f = join(fx.siteDir, u.replace(/\/$/, ''), 'index.html');
    mkdirSync(path.dirname(f), { recursive: true });
    writeFileSync(f, '<!DOCTYPE html><html><body>stub</body></html>');
  }
}

function runValidator(fx) {
  return spawnSync(process.execPath, [VALIDATOR, '--site', fx.siteDir, '--data-root', fx.dataRoot], { encoding: 'utf8' });
}

// ---------- cases ----------
function caseExpect(label, dataMut, mut, expectFail) {
  const fx = mkFixture();
  stubUrls(fx, fx.canon);
  const html = renderPage(fx.canon, dataMut, mut);
  writeFileSync(join(fx.siteDir, 'index.html'), html);
  const r = runValidator(fx);
  const ok = expectFail ? r.status !== 0 : r.status === 0;
  check(label, ok, 'exit=' + r.status + ' :: ' + (r.stderr || r.stdout || '').split('\n').filter(l => /NAV ERROR/.test(l)).slice(0, 3).join(' | '));
  rmSync(fx.dataRoot, { recursive: true, force: true });
  rmSync(fx.siteDir, { recursive: true, force: true });
  return r;
}

// 1. The reproduced original defect: WRONG HOME LABEL on BOTH surfaces.
//    Canonical data is wrong too (this is what "consistent everywhere" means
//    when the wrong value propagated into the source) — canonical sanity must
//    reject it, and the rendered labels must not match "Trang chủ".
caseExpect('fixture FAILS: wrong home label everywhere (header + footer + drawer)',
  (c) => { c.navMain[0].label = 'WRONG HOME LABEL'; },
  null, true);

// 2. Same wrong label everywhere WITHOUT touching canonical data: the
//    renderer drifts but the source stays right — identity check must fail.
caseExpect('fixture FAILS: wrong home label on ONE surface only (footer.info)',
  null,
  (html) => html.replace('<details class="foot-sec"><summary class="foot-sec__h">Thông tin</summary><div class="foot-links"><a href="/">Trang chủ</a>', '<details class="foot-sec"><summary class="foot-sec__h">Thông tin</summary><div class="foot-links"><a href="/">Trang chu</a>'),
  true);

// 3. Wrong action-button label on one surface (footer search button).
caseExpect('fixture FAILS: wrong action-button label (footer Tìm kiếm)',
  null,
  (html) => html.replace('<button type="button" class="foot-act" data-qa="search">Tìm kiếm</button>', '<button type="button" class="foot-act" data-qa="search">Tìm kiem</button>'),
  true);

// 4. Wrong action identity: the data-qa no longer identifies the action.
caseExpect('fixture FAILS: wrong action identity (data-qa tampered)',
  null,
  (html) => html.replace('data-qa="search"', 'data-qa="search-x"'),
  true);

// 5. Wrong destination for a canonical link (footer Danh mục link).
caseExpect('fixture FAILS: wrong destination (footer Danh mục link)',
  null,
  (html) => html.replace('<a class="foot-act" href="/danh-muc/">Danh mục</a>', '<a class="foot-act" href="/danh-muc-x/">Danh mục</a>'),
  true);

// 6. Missing required surface (nav drawer entirely absent).
caseExpect('fixture FAILS: missing required surface (nav drawer)',
  null,
  (html) => html.replace(/<aside class="nav-drawer"[\s\S]*?<\/aside>/, ''),
  true);

// 7. Missing required item (one footer action button removed).
caseExpect('fixture FAILS: missing required item (footer action topics removed)',
  null,
  (html) => html.replace('<button type="button" class="foot-act" data-qa="topics">Chủ đề</button>', ''),
  true);

// 8. The OK fixture passes, INCLUDING the documented exceptions:
//    brand wordmark link and "Tất cả <label>" groupings (both rendered above).
caseExpect('fixture PASSES: canonical page with brand wordmark + "Tất cả" groupings',
  null, null, false);

// 9. Missing required item: a nav-drawer parent screen loses one child.
caseExpect('fixture FAILS: missing child item on a drawer parent screen',
  null,
  (html) => {
    const m = /<div class="nav-scr" id="navScr-([a-z-]+)" hidden><div class="nav-kids">([\s\S]*?)<\/div><\/div>/.exec(html);
    if (!m) return html;
    const kids = m[2].replace(/<a class="nav-kid"[\s\S]*?<\/a>/, '');
    return html.replace(m[0], '<div class="nav-scr" id="navScr-' + m[1] + '" hidden><div class="nav-kids">' + kids + '</div></div>');
  },
  true);

// 10. Wrong label propagated into the CANONICAL DATA FILE itself: the
//     canonical sanity check must reject a wrong home label even in
//     canonical-only mode (no rendered site needed).
{
  const fx = mkFixture();
  const nav = readFileSync(join(fx.dataRoot, 'data', 'navigation.yml'), 'utf8');
  writeFileSync(join(fx.dataRoot, 'data', 'navigation.yml'), nav.replace('label: "Trang chủ"', 'label: "WRONG HOME LABEL"'));
  const r = spawnSync(process.execPath, [VALIDATOR, '--data-root', fx.dataRoot], { encoding: 'utf8' });
  check('fixture FAILS: wrong home label in canonical data itself', r.status !== 0, 'exit=' + r.status + ' :: ' + (r.stderr || ''));
  rmSync(fx.dataRoot, { recursive: true, force: true });
  rmSync(fx.siteDir, { recursive: true, force: true });
}

console.log('\nnav-regression: ' + passed + ' passed, ' + failed + ' failed.');
process.exit(failed ? 1 : 0);
