#!/usr/bin/env node
// Crawlable archive pagination: danh-muc/<parent>/trang-NN.md (48 posts/page).
// Content is fully precomputed literal HTML — O(1) render, no site.posts scans.
// Existing category URLs are untouched; archive pages are plain additions.
// Stale pages beyond the current count are removed safely.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findRoot } from './lib/lab.mjs';

const ROOT = findRoot(process.argv, path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'));
const PER_PAGE = 48;
const BASE = '/lab'; // Pages baseurl prefix for literal content links
const members = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'category-members.json'), 'utf8'));
const taxRaw = fs.readFileSync(path.join(ROOT, 'data', 'taxonomy.yml'), 'utf8');

const slugToName = {};
{
  let cur = null;
  for (const raw of taxRaw.split('\n')) {
    let m = /^ {2}- id: "(P\d+)"/.exec(raw);
    if (m) { cur = m[1]; continue; }
    m = /^ {4}name: (.+)$/.exec(raw);
    if (m && cur && !(cur in slugToName)) slugToName['#n' + cur] = m[1].replace(/^["']|["']$/g, '');
    m = /^ {4}slug: (.+)$/.exec(raw);
    if (m && cur) slugToName[m[1].replace(/^["']|["']$/g, '')] = slugToName['#n' + cur];
  }
}

let written = 0, removed = 0;
// Generated-file manifest (ownership rule): every file this run leaves in
// place is listed in data/generated-archives.json. The engine's persistState()
// stages EXACTLY the manifest-listed files (plus trang-N.md deletions shown by
// git status) with the state commit — never the whole danh-muc tree, so
// unrelated editorial edits to category pages can never ride along.
const manifestFiles = [];
for (const [pslug, cards] of Object.entries(members.parents || {})) {
  if (!cards.length) continue;
  const dir = path.join(ROOT, 'danh-muc', pslug);
  const totalPages = Math.max(1, Math.ceil(cards.length / PER_PAGE));
  for (let n = totalPages + 1; ; n++) {
    const f = path.join(dir, 'trang-' + n + '.md');
    if (!fs.existsSync(f)) break;
    fs.rmSync(f); removed++;
  }
  const pname = slugToName[pslug] || pslug;
  for (let n = 1; n <= totalPages; n++) {
    const slice = cards.slice((n - 1) * PER_PAGE, n * PER_PAGE);
    const items = slice.map(c =>
      '      <li><a href="' + BASE + c.url + '">' + String(c.title).replace(/&/g, '&amp;').replace(/</g, '&lt;') + '</a><span>' + c.date + '</span></li>'
    ).join('\n');
    const prev = n > 1 ? 'trang-' + (n - 1) : null;
    const next = n < totalPages ? 'trang-' + (n + 1) : null;
    const fm = [
      '---',
      'layout: archive',
      'title: "Tất cả bài trong ' + pname + ' — trang ' + n + '"',
      'description: "Trang ' + n + '/' + totalPages + ' — danh sách ' + slice.length + ' bài trong danh mục ' + pname + '."',
      'permalink: /danh-muc/' + pslug + '/trang-' + n + '/',
      'parent: ' + pslug,
      'page_num: ' + n,
      'total_pages: ' + totalPages,
      'sitemap: true',
      '---',
      '',
      '<nav class="archive-list">',
      '  <ul>',
      items,
      '  </ul>',
      '</nav>',
      '',
      '<nav class="archive-pager" aria-label="Trang lưu trữ">',
      prev ? '  <a href="' + BASE + '/danh-muc/' + pslug + '/' + prev + '/">← Trang trước</a>' : '  <span></span>',
      '  <span>Trang ' + n + ' / ' + totalPages + '</span>',
      next ? '  <a href="' + BASE + '/danh-muc/' + pslug + '/' + next + '/">Trang sau →</a>' : '  <span></span>',
      '</nav>',
      ''
    ].join('\n');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'trang-' + n + '.md'), fm);
    manifestFiles.push('danh-muc/' + pslug + '/trang-' + n + '.md');
    written++;
  }
}
manifestFiles.sort();
fs.mkdirSync(path.join(ROOT, 'data'), { recursive: true });
fs.writeFileSync(path.join(ROOT, 'data', 'generated-archives.json'), JSON.stringify({
  generated_at: new Date().toISOString(),
  generator: 'scripts/gen-archive-pages.mjs',
  per_page: PER_PAGE,
  ownership: 'Every file listed here is engine-OWNED generated output (danh-muc/<parent>/trang-<N>.md). persistState() stages exactly these files (plus trang-N.md deletions); every other danh-muc file is editorial and never staged by the engine.',
  parents: Object.fromEntries(Object.entries(members.parents || {}).filter(([, cards]) => cards.length)
    .map(([pslug, cards]) => [pslug, Math.max(1, Math.ceil(cards.length / PER_PAGE))])),
  files: manifestFiles
}, null, 2) + '\n');
console.log('[gen-archive-pages] written=' + written + ' removed_stale=' + removed + ' manifest=' + manifestFiles.length);
