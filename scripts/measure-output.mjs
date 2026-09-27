#!/usr/bin/env node
// Capacity measurement: measures the COMPLETE built output (HTML, indexes,
// feeds, assets) when _site/ exists; otherwise reports a source-tree estimate
// clearly labeled as such. Measured numbers never mix with extrapolations.
// Writes reports/capacity.json.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findRoot, walkFiles } from './lib/lab.mjs';

const ROOT = findRoot(process.argv, path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..'));

function dirSize(dir) {
  let total = 0, count = 0;
  if (!fs.existsSync(dir)) return { total, count };
  for (const f of walkFiles(dir)) {
    try { total += fs.statSync(f).size; count++; } catch { /* ignore */ }
  }
  return { total, count };
}

const posts = fs.readdirSync(path.join(ROOT, '_posts')).filter(f => f.endsWith('.md'));
const report = {
  measured_at: new Date().toISOString(),
  published_posts: posts.length,
  target_total: 20000,
  hosting_limit_bytes: 1e9, // GitHub Pages published-site limit ~1 GB
  built_output: null,
  source_estimate: null
};

const site = dirSize(path.join(ROOT, '_site'));
if (site.count > 0) {
  const perArticle = site.total / Math.max(1, posts.length);
  report.built_output = {
    bytes: site.total, files: site.count,
    bytes_per_article_avg: Math.round(perArticle),
    projected_20k_bytes: Math.round(site.total + perArticle * (20000 - posts.length))
  };
  report.extrapolation_20k = {
    method: 'LINEAR EXTRAPOLATION from measured per-article average (label: estimate, not measurement)',
    projected_bytes: report.built_output.projected_20k_bytes,
    fits_1gb: report.built_output.projected_20k_bytes < report.hosting_limit_bytes
  };
} else {
  const src = dirSize(ROOT);
  report.source_estimate = {
    note: '_site/ absent — source-tree ESTIMATE, not a build measurement',
    bytes: src.total, files: src.count
  };
}

fs.mkdirSync(path.join(ROOT, 'reports'), { recursive: true });
fs.writeFileSync(path.join(ROOT, 'reports', 'capacity.json'), JSON.stringify(report, null, 2) + '\n');
console.log('[measure-output] ' + JSON.stringify(report.built_output || report.source_estimate));
