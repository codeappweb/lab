#!/usr/bin/env node
// validate-content-quality.mjs — content quality gate for codeappweb/lab.
// Run BEFORE any push: node scripts/validate-content-quality.mjs
// Exit code 1 = validation FAILED = DO NOT PUSH.
//
// Audit fixes 2026-09-29 (round 2):
//   - README.md / AGENTS.md / CONTRIBUTING.md / docs/** are technical
//     documentation, not site pages: front matter is NOT required there and
//     H1 headings are allowed. CJK junk still applies; "undefined"/
//     underscore prose patterns are exempted there because technical docs
//     legitimately name code identifiers and document the validator itself.
//   - Prose checks run on text stripped of fenced code, inline code, Liquid
//     output/tags, HTML tags, URLs and markdown link targets, so legitimate
//     Liquid filters such as `relative_url` are no longer flagged as
//     underscore artifacts while real garbage (word_word in prose) is caught.
// 2026-10-05: front matter parse dung shared parser (front-matter.mjs) — thong
// nhat voi writer/staging-signal/coordinator (goc loi run 37318644251: parser
// rieng khong doc duoc danh sach YAML). Gate giu nguyen do manh.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, basename } from 'node:path';
import { parseFrontMatter as parseFrontMatterShared } from './front-matter.mjs';

const ROOT = process.cwd();
const errors = [];
const warnings = [];

// Scoped QA qua content-index: --only a,b chỉ deep-check file liệt kê; file
// nội dung site khác chỉ được tin khi index row qa_status=passed. Full mode
// (mặc định — CI/full audit) đọc TOÀN BỘ file như cũ: KHÔNG yếu đi.
const onlyIdxQ = process.argv.indexOf('--only');
const SCOPED_Q = onlyIdxQ !== -1;
const ONLY_Q = SCOPED_Q ? (process.argv[onlyIdxQ + 1] || '').split(',').map(s => s.trim()).filter(Boolean) : null;
const isSiteContent = rel => rel.startsWith('_posts/') || rel.startsWith('danh-muc/') || rel.startsWith('hub/') || /^[a-z0-9-]+\.md$/.test(rel);
let idxRowsQ = null;
if (SCOPED_Q) {
  idxRowsQ = new Map(); // fail-closed: thiếu/hỏng cache → rỗng → mọi file cũ báo lỗi ở dưới
  try {
    // SQLite derived cache (read-only): file cũ tin theo row qa_status=passed.
    const { openReadOnly, rowsMap } = await import('./content-index-lib.mjs');
    idxRowsQ = rowsMap(await openReadOnly(ROOT));
  } catch (e) {
    errors.push('data/content-index.sqlite thiếu/hỏng (' + e.message + ') — chạy node scripts/content-index.mjs --build (fail-closed)');
  }
}

const TECH_WHITELIST = /\b(BMS|GPS|LFP|Lithium|Smartkey|CVT|LED|ABS|A1|A2|Watt|Ah|km\/h|cc)\b/;
const CJK = /[一-鿿぀-ヿ가-힯]/;
const UNDEF = /undefined/;
const PROSE_UNDERSCORE = /(^|\s)[a-zA-ZÀ-ỹ]{2,}_[a-zA-ZÀ-ỹ]{2,}($|[\s.,;:)\]])/;

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (['node_modules', '.git', '.jekyll-cache', '_site', 'vendor', '_tmpchunks'].includes(name)) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

// Dùng shared parser (thống nhất schema/parser toàn hệ thống); giữ NGUYÊN
// ngữ nghĩa cũ của gate này: null khi thiếu front matter, bỏ qua parent/
// children (chỉ dùng cho taxonomy layout), KHÔNG thêm parser issues vào
// errors (các gate dưới đây quyết định).
function parseFrontMatter(text) {
  if (!text.startsWith('---')) return null;
  const end = text.indexOf('\n---', 3);
  if (end === -1) return null;
  const padded = text.endsWith('\n') ? text : text + '\n';
  const r = parseFrontMatterShared(padded);
  if (!r.fm) return null;
  const fm = {};
  for (const [k, v] of Object.entries(r.fm)) {
    if (k === 'parent' || k === 'children') continue;
    fm[k] = Array.isArray(v) ? v.join(', ') : v;
  }
  return { fm, raw: r.raw };
}

// Technical documentation is exempt from page-level front matter rules.
function isTechnicalDoc(rel) {
  const p = rel.replace(/\\/g, '/');
  return p === 'README.md' || p === 'AGENTS.md' || p === 'CONTRIBUTING.md' || p.startsWith('docs/');
}

// Reduce a markdown body to plain prose so quality checks do not fire on
// code, Liquid or markup (e.g. relative_url is a Liquid filter, not junk).
function proseOnly(body) {
  return body
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/~~~[\s\S]*?~~~/g, ' ')
    .replace(/`[^`\n]*`/g, ' ')
    .replace(/\{\{[\s\S]*?\}\}/g, ' ')
    .replace(/\{%[\s\S]*?%\}/g, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/https?:\/\/[^\s)>]+/g, ' ')
    .replace(/\]\([^)\s]*\)/g, ']');
}

const all = walk(ROOT);
const mdFiles = all.filter(f => f.endsWith('.md'));
const slugs = new Map();

for (const f of mdFiles) {
  const rel = f.slice(ROOT.length + 1).replace(/\\/g, '/');
  const name = basename(f);

  if (UNDEF.test(name)) errors.push(rel + ': filename contains "undefined"');
  if (/\s/.test(name)) errors.push(rel + ': filename contains whitespace');

  // Scoped QA: file không nằm trong scope chu kỳ này — tin content-index
  // (fail-closed khi thiếu row / row chưa qua QA). Không đọc lại nội dung.
  if (SCOPED_Q && !ONLY_Q.includes(rel)) {
    if (isTechnicalDoc(rel) || !isSiteContent(rel)) continue;
    const r = idxRowsQ.get(rel);
    if (!r) errors.push(rel + ': không có trong content-index — rebuild index (fail-closed)');
    else if (r.qa_status !== 'passed') errors.push(rel + ': qa_status=' + r.qa_status + ' trong content-index — thay đổi chưa qua QA');
    continue;
  }

  const text = readFileSync(f, 'utf8');
  const parsed = parseFrontMatter(text);
  const bodyEnd = text.indexOf('\n---', 3);
  const body = parsed ? text.slice(bodyEnd + 4) : text;
  const prose = proseOnly(body);

  // CJK junk applies to every markdown file, technical docs included.
  if (CJK.test(prose)) errors.push(rel + ': CJK characters found in prose');

  // "undefined"/underscore artifacts are site-content checks. Technical
  // documentation (README/AGENTS/CONTRIBUTING/docs) legitimately names
  // code identifiers (source_url, primary_keyword) and documents the
  // validator's own "undefined" detection, so those two patterns are
  // exempted there; they still fire on every site page.
  if (!isTechnicalDoc(rel)) {
    if (UNDEF.test(prose)) errors.push(rel + ': "undefined" artifact in prose');
    if (PROSE_UNDERSCORE.test(prose)) errors.push(rel + ': underscore artifact in prose');
  }

  if (isTechnicalDoc(rel)) continue; // no front-matter / H1 / SEO requirements

  if (!parsed) {
    errors.push(rel + ': missing or malformed front matter');
    continue;
  }
  const { fm } = parsed;

  // H1 count in body
  const h1s = (body.match(/^# [^#]/gm) || []).length;
  if (h1s > 1) errors.push(rel + ': ' + h1s + ' H1 headings in body');

  // required front matter
  if (!fm.title) errors.push(rel + ': missing title');
  const noindex = /noindex:\s*true/.test(parsed.raw);
  if (!noindex && !fm.description) errors.push(rel + ': indexable page missing description');

  // duplicate permalink
  if (fm.permalink) {
    if (slugs.has(fm.permalink)) errors.push(rel + ': duplicate permalink ' + fm.permalink + ' (also in ' + slugs.get(fm.permalink) + ')');
    else slugs.set(fm.permalink, rel);
  }

  // empty indexable category pages
  const layout = fm.layout || '';
  if ((layout === 'parent-category' || layout === 'child-category') && !noindex) {
    const words = body.trim().split(/\s+/).filter(Boolean).length;
    if (words < 200) errors.push(rel + ': indexable ' + layout + ' has only ' + words + ' words');
    if (layout === 'parent-category' && words < 1600) warnings.push(rel + ': parent below 1600 words (' + words + ')');
  }
}

// taxonomy duplicate child slugs within each parent
try {
  const tax = readFileSync(join(ROOT, 'data/taxonomy.yml'), 'utf8');
  const seen = new Map();
  let parent = null;
  for (const line of tax.split('\n')) {
    const p = line.match(/^  - id: "(P\d+)"/); if (p) parent = p[1];
    const c = line.match(/^        slug: "(.+)"$/); if (!c) continue;
    const key = parent + '/' + c[1];
    if (seen.has(key)) errors.push('taxonomy: duplicate child slug ' + key);
    seen.set(key, true);
  }
} catch { /* taxonomy missing is reported elsewhere */ }

// JSON index templates must not emit hubs
for (const t of ['assets/search.json', 'assets/data/content-index.json']) {
  try {
    const s = readFileSync(join(ROOT, t), 'utf8');
    if (/where:\s*'layout',\s*'hub'/.test(s)) errors.push(t + ': still includes hub pages');
    if (!/c\.noindex\s*!=\s*true/.test(s)) errors.push(t + ': missing noindex filter');
  } catch { warnings.push(t + ': not found'); }
}

console.log('== Content quality validation ==');
for (const w of warnings) console.log('WARN: ' + w);
if (errors.length) {
  for (const e of errors) console.log('FAIL: ' + e);
  console.log('');
  console.log(errors.length + ' error(s). DO NOT PUSH.');
  process.exit(1);
}
console.log('OK: no blocking issues found (' + mdFiles.length + ' markdown files checked).');
process.exit(0);
