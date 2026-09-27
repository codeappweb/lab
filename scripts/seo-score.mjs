#!/usr/bin/env node
// Internal SEO scoring with a DOCUMENTED Vietnamese word-count method:
// syllable tokens (whitespace-split, excluding markdown syntax) — consistent
// with docs/SCHEMA-ARTICLE.md. Legacy articles (manifest_id) are exempt from
// the 1200-2000 word standard but still scored. Writes reports/seo-scores.json.
import { join } from 'node:path';
import { findRoot, discover, writeReport } from './lib/lab.mjs';

const ROOT = findRoot(process.argv);
const { posts } = discover(ROOT);
const now = new Date().toISOString().slice(0, 10);

const scores = posts.map(p => {
  const d = p.fm.data;
  const title = String(d.title || '');
  const desc = String(d.description || '');
  const body = p.fm.body || '';
  const words = (body.replace(/[#>*_`\[\]()|-]/g, ' ').split(/\s+/).filter(t => /[a-zA-Zà-ỹÀ-Ỹ0-9]/.test(t))).length;
  const links = (body.match(/\]\((\/[^)]*)\)/g) || []).length + (body.match(/relative_url/g) || []).length;
  const h2 = (body.match(/^##\s+\S/gm) || []).length;
  const legacy = Boolean(d.manifest_id);
  let score = 0;
  if (title.length >= 40 && title.length <= 70) score += 20; else score += 8;
  if (desc.length >= 120 && desc.length <= 165) score += 20; else score += 8;
  if (!legacy) { if (words >= 1200 && words <= 2000) score += 30; else if (words >= 600) score += 15; }
  else score += 30; // legacy exempt from length standard
  if (links >= 2 && links <= 8) score += 15; else if (links > 0) score += 6;
  if (h2 >= 3) score += 15; else if (h2 >= 1) score += 7;
  return {
    slug: p.slug, title, legacy,
    words_vn_syllables: words, links_internal: links, h2_count: h2,
    standard: legacy ? 'legacy-exempt' : '1200-2000 (VN syllables, body only)',
    score, max: 100, checked_at: now
  };
});
writeReport(ROOT, 'seo-scores.json', { checked_at: now, method: 'VN syllable count, body only, front matter excluded', scores });
const avg = Math.round(scores.reduce((s, x) => s + x.score, 0) / Math.max(1, scores.length));
const below = scores.filter(s => !s.legacy && s.words_vn_syllables < 1200);
console.log(`seo-score: ${scores.length} articles, avg ${avg}/100, ${below.length} new-schema articles below the 1200-word standard`);
