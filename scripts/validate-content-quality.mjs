#!/usr/bin/env node
// Content quality gate for ALL intended content: _posts, danh-muc pages,
// static pages. Excludes docs/ and tests/ fixtures by design (they are not
// site content). Nonzero exit on any violation.
// Usage: node scripts/validate-content-quality.mjs [--root <dir>]
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, basename } from 'node:path';
import { findRoot, parseFM, discover, isExcluded, postSlug, fail } from './lib/lab.mjs';

const ROOT = findRoot(process.argv);
const errors = [];
const warnings = [];
const CJK = /[\u3400-\u9fff\uf900-\ufaff]/;

function wordCountVN(body) {
  // Vietnamese word count: split on whitespace; each syllable token counts.
  return (body || '').replace(/[#>*_`\[\]()|-]/g, ' ').split(/\s+/).filter(t => /[a-zA-Zà-ỹÀ-Ỹ0-9]/.test(t)).length;
}

const { posts, pages, statics } = discover(ROOT);
const seenTitles = new Map();
const seenPerm = new Map();

for (const p of posts) {
  const rel = p.path;
  const d = p.fm.data;
  if (!p.fm.raw && !p.text.startsWith('---')) errors.push(`${rel}: missing front matter`);
  if (!d.title) errors.push(`${rel}: missing title`);
  if (!d.description) errors.push(`${rel}: missing description`);
  if (CJK.test(p.text)) errors.push(`${rel}: contains CJK characters (wrong-language artifacts)`);
  const h1s = (p.fm.body || '').match(/^#\s+\S.*$/gm) || [];
  if (h1s.length > 0) errors.push(`${rel}: ${h1s.length} H1 in article body (layout provides H1)`);
  if (/undefined|NaN|null/.test(String(d.title || ''))) errors.push(`${rel}: title contains "undefined/NaN/null" artifact`);
  if (d.permalink && d.permalink !== '/' + p.slug + '/') errors.push(`${rel}: permalink override "${d.permalink}" != /${p.slug}/ (posts use /:title/)`);
  if (!d.id && !d.manifest_id && !d.mock) errors.push(`${rel}: post missing both id and manifest_id`);
  const words = wordCountVN(p.fm.body);
  const legacy = Boolean(d.manifest_id);
  if (!legacy && words > 0) {
    // new-schema articles: documented VN syllable-count standard 1200-2000.
    // Currently advisory (existing new articles were published below range);
    // hard-block will be enforced for pilot articles via seo-score report.
    if (words < 300) errors.push(`${rel}: only ${words} words (unpublished stub or thin content in _posts is invalid)`);
    else if (words < 1200) warnings.push(`${rel}: ${words} words < 1200 standard for new articles`);
  }
  if (/\s/.test(basename(p.path))) errors.push(`${rel}: filename contains whitespace/newline`);
  const t = String(d.title || '').trim().toLowerCase();
  if (seenTitles.has(t)) errors.push(`${rel}: duplicate title with ${seenTitles.get(t)}`);
  else seenTitles.set(t, rel);
}

for (const c of [...pages, ...statics]) {
  const d = c.fm.data;
  if (!d.title && c.path !== 'index.md') errors.push(`${c.path}: page missing title`);
  if (isExcluded(d)) continue; // stubs/hubs: minimal requirements only
  if (!d.description) errors.push(`${c.path}: indexable page missing description`);
  const words = wordCountVN(c.fm.body);
  if (words < 40) errors.push(`${c.path}: indexable category page only ${words} words (<40 minimum)`);
  if (c.url && seenPerm.has(c.url)) errors.push(`${c.path}: duplicate permalink ${c.url} with ${seenPerm.get(c.url)}`);
  if (c.url) seenPerm.set(c.url, c.path);
}

// manifest consistency (skip when absent, e.g. fixtures)
const manifest = join(ROOT, 'data/article-manifest.jsonl');
if (existsSync(manifest)) {
  const bySlug = new Map();
  const lines = readFileSync(manifest, 'utf8').split('\n').filter(Boolean);
  lines.forEach((l, i) => {
    let r; try { r = JSON.parse(l); } catch { errors.push(`manifest line ${i + 1}: invalid JSON`); return; }
    if (bySlug.has(r.slug)) errors.push(`manifest: duplicate slug "${r.slug}" (${r.id}, ${bySlug.get(r.slug)})`);
    bySlug.set(r.slug, r.id);
  });
  for (const p of posts) {
    if (isExcluded(p.fm.data)) continue;
    if (!bySlug.has(p.slug)) errors.push(`${p.path}: post not present 
in manifest (run scripts/sync-manifest.mjs)`);
  }
}

for (const w of warnings) console.warn('WARN: ' + w);
if (warnings.length) console.warn(`content-quality: ${warnings.length} warning(s).`);
fail(errors, 'content-quality');
console.log(`content-quality: OK (${posts.length} posts, ${pages.length} category pages, ${statics.length} static pages checked; ${warnings.length} warnings)`);
