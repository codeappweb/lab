#!/usr/bin/env node
// Content quality gate for codeappweb/lab.
// Run BEFORE any push: node scripts/validate-content-quality.mjs
// Exit code 1 = validation FAILED = DO NOT PUSH.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, basename } from 'node:path';

const ROOT = process.cwd();
const errors = [];
const warnings = [];

// Legitimate technical terms allowed inside Vietnamese prose.
const TECH_WHITELIST = /(BMS|GPS|LFP|Lithium|Smartkey|CVT|LED|ABS|A1|A2|Watt|Ah|km|h|km/h|cc)/;

const CJK = /[一-鿿぀-ヿ가-힯]/;
const UNDEF = /undefined/;
const PROSE_UNDERSCORE = /(^|s)[a-zA-ZÀ-ỹ]{2,}_[a-zA-ZÀ-ỹ]{2,}($|[s.,;:)]]])/;

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (['node_modules', '.git', '.jekyll-cache', '_site', 'vendor'].includes(name)) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

function parseFrontMatter(text) {
  if (!text.startsWith('---')) return null;
  const end = text.indexOf('
---', 3);
  if (end === -1) return null;
  const raw = text.slice(3, end).trim();
  const fm = {};
  let ok = true;
  for (const line of raw.split('
')) {
    const m = line.match(/^([a-z_]+):s*"?(.*?)"?s*$/);
    if (m && m[1] !== 'parent' && m[1] !== 'children') fm[m[1]] = m[2];
  }
  return { fm, raw, ok };
}

const all = walk(ROOT);
const mdFiles = all.filter(f => f.endsWith('.md') && !f.includes('_posts/'));
const slugs = new Map();
const canon = new Map();

for (const f of mdFiles) {
  const rel = f.slice(ROOT.length + 1);
  const name = basename(f);

  // filename hygiene
  if (UNDEF.test(name)) errors.push(`${rel}: filename contains "undefined"`);
  if (/s/.test(name)) errors.push(`${rel}: filename contains whitespace`);

  const text = readFileSync(f, 'utf8');
  const parsed = parseFrontMatter(text);
  if (!parsed) {
    errors.push(`${rel}: missing or malformed front matter`);
    continue;
  }
  const { fm } = parsed;

  // body = content after front matter
  const bodyEnd = text.indexOf('
---', 3);
  const body = text.slice(bodyEnd + 4);

  // CJK / mixed-language artifacts in body prose
  if (CJK.test(body)) errors.push(`${rel}: CJK characters found in body`);
  if (UNDEF.test(body)) errors.push(`${rel}: "undefined" artifact in body`);
  const prose = body.replace(/([^)]*)|[[^]]*]([^)]*)|https?://S+/g, ' ');
  if (PROSE_UNDERSCORE.test(prose)) errors.push(`${rel}: underscore artifact in prose`);

  // H1 count in body
  const h1s = (body.match(/^# [^#]/gm) || []).length;
  if (h1s > 1) errors.push(`${rel}: ${h1s} H1 headings in body`);

  // required front matter
  if (!fm.title) errors.push(`${rel}: missing title`);
  const noindex = /noindex:s*true/.test(parsed.raw);
  if (!noindex && !fm.description) errors.push(`${rel}: indexable page missing description`);

  // duplicate permalink / canonical
  if (fm.permalink) {
    if (slugs.has(fm.permalink)) errors.push(`${rel}: duplicate permalink ${fm.permalink} (also in ${slugs.get(fm.permalink)})`);
    else slugs.set(fm.permalink, rel);
  }

  // empty indexable category pages
  const layout = fm.layout || '';
  if ((layout === 'parent-category' || layout === 'child-category') && !noindex) {
    const words = body.trim().split(/s+/).filter(Boolean).length;
    if (words < 200) errors.push(`${rel}: indexable ${layout} has only ${words} words`);
    if (layout === 'parent-category' && words < 1600) warnings.push(`${rel}: parent below 1600 words (${words})`);
  }
}

// taxonomy duplicate child slugs within each parent
try {
  const tax = readFileSync(join(ROOT, 'data/taxonomy.yml'), 'utf8');
  const seen = new Map(); const perParent = new Map(); let parent = null;
  for (const line of tax.split('
')) {
    const p = line.match(/^  - id: "(Pd+)"/); if (p) parent = p[1];
    const c = line.match(/^        slug: "(.+)"$/); if (!c) continue;
    const key = parent + '/' + c[1];
    if (seen.has(key)) errors.push(`taxonomy: duplicate child slug ${key}`);
    seen.set(key, true);
  }
} catch { /* taxonomy missing is reported elsewhere */ }

// JSON index templates must not emit hubs
for (const t of ['assets/search.json', 'assets/data/content-index.json']) {
  try {
    const s = readFileSync(join(ROOT, t), 'utf8');
    if (/where:s*'layout',s*'hub'/.test(s)) errors.push(`${t}: still includes hub pages`);
    if (!/c.noindexs*!=s*true/.test(s)) errors.push(`${t}: missing noindex filter`);
  } catch { warnings.push(`${t}: not found`); }
}

console.log('== Content quality validation ==');
for (const w of warnings) console.log('WARN: ' + w);
if (errors.length) {
  for (const e of errors) console.log('FAIL: ' + e);
  console.log(`
${errors.length} error(s). DO NOT PUSH.`);
  process.exit(1);
}
console.log('OK: no blocking issues found.');
process.exit(0);
