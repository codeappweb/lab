#!/usr/bin/env node
// seo-score.mjs — internal SEO quality score per article (0-100).
// INTERNAL METRIC ONLY. Not a Google ranking score.
// Writes reports/seo-scores.json: { slug, score, checks{} }.
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const postsDir = join(ROOT, '_posts');
const scores = [];

function fm(text) {
  if (!text.startsWith('---')) return {};
  const end = text.indexOf('\n---', 3);
  if (end === -1) return {};
  const o = {};
  for (const line of text.slice(3, end).split('\n')) {
    const m = line.match(/^([a-z_]+):\s*"?([^"\n]*)"?\s*$/);
    if (m) o[m[1]] = m[2];
  }
  return o;
}

if (existsSync(postsDir)) {
  for (const f of readdirSync(postsDir).filter(f => f.endsWith('.md')).sort()) {
    const text = readFileSync(join(postsDir, f), 'utf8');
    const o = fm(text);
    const body = text.slice(text.indexOf('\n---', 3) + 4);
    const words = body.trim().split(/\s+/).filter(Boolean).length;
    const h2 = (body.match(/^## /gm) || []).length;
    const h3 = (body.match(/^### /gm) || []).length;
    const internalLinks = [...body.matchAll(/\]\(\{\{[^}]+\}\}\)/g)].length;
    const title = o.title || '';
    const desc = o.description || '';
    const checks = {
      title_length: title.length >= 30 && title.length <= 70,
      description_length: desc.length >= 90 && desc.length <= 165,
      word_count: words >= 400,
      heading_structure: h2 >= 2,
      internal_links: internalLinks >= 2,
      category_declared: Boolean(o.parent_category || o.category),
      schema_complete: Boolean(o.id && o.primary_keyword && o.search_intent && o.freshness_status && o.legal_sensitivity !== undefined),
      no_h1_in_body: (body.match(/^# [^#]/gm) || []).length === 0,
      lists_or_structure: /\n- /.test(body) || h3 > 0
    };
    const score = Math.round(Object.values(checks).filter(Boolean).length / Object.keys(checks).length * 100);
    scores.push({ slug: f.replace(/^\d{4}-\d{2}-\d{2}-/, '').replace(/\.md$/, ''), score, words, checks });
  }
}

const avg = scores.length ? Math.round(scores.reduce((a, s) => a + s.score, 0) / scores.length) : 0;
const fs = await import('node:fs');
fs.mkdirSync(join(ROOT, 'reports'), { recursive: true });
fs.writeFileSync(join(ROOT, 'reports/seo-scores.json'), JSON.stringify({ average: avg, articles: scores }, null, 2) + '\n');
console.log('seo-scores: ' + scores.length + ' articles, average internal score ' + avg + '/100');
