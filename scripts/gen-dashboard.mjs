#!/usr/bin/env node
// Dashboard report aggregating all reports + google-discovery.json
// (an OBJECT with an `articles` array — never call .filter on the object).
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { findRoot, discover, isExcluded, writeReport } from './lib/lab.mjs';

const ROOT = findRoot(process.argv);
function readJson(p, fallback) {
  try { return JSON.parse(readFileSync(join(ROOT, p), 'utf8')); } catch { return fallback; }
}
const { posts } = discover(ROOT);
const published = posts.filter(p => !isExcluded(p.fm.data)).length;
const discovery = readJson('reports/google-discovery.json', { articles: [] });
const articles = discovery.articles || []; // object shape, not an array itself
const observed = articles.filter(a => a.status === 'OBSERVED').length;
const unknown = articles.filter(a => a.status === 'UNKNOWN').length;
const notObserved = articles.filter(a => a.status === 'NOT_OBSERVED').length;
const audit = readJson('reports/self-heal-audit.json', { findings: [] });
const seo = readJson('reports/seo-scores.json', { scores: [] });
const legal = readJson('reports/legal-freshness.json', { findings: [] });
const queue = readJson('data/topic-queue.json', { approved_queue_size: 0 });

const md = [
  '# Dashboard — 20K experiment', '',
  `Generated: ${new Date().toISOString()}`, '',
  '## Nội dung', `- Bài đã xuất bản: ${published}`,
  `- Hàng đợi đã duyệt: ${queue.approved_queue_size}`,
  `- Audit findings: ${audit.findings ? audit.findings.length : 0}`,
  `- Điểm SEO trung bình: ${seo.scores && seo.scores.length ? Math.round(seo.scores.reduce((s, x) => s + x.score, 0) / seo.scores.length) : 'n/a'}`,
  `- Legal-sensitive blocking: ${(legal.findings || []).filter(f => f.severity === 'CRITICAL').length}`, '',
  '## Google discovery (thủ công, không ping)', `- OBSERVED: ${observed}`,
  `- NOT_OBSERVED: ${notObserved}`, `- UNKNOWN: ${unknown}`, `- Tổng số theo dõi: ${articles.length}`, '',
  '## Điều kiện thí nghiệm', '- Search Console: KHÔNG kết nối', '- Google verification: KHÔNG',
  '- Sitemap submission: KHÔNG', ''
].join('\n');
writeReport(ROOT, 'dashboard.md', { dashboard: md });
// write real markdown (dashboard.md as text, not JSON-wrapped)
import { writeFileSync, mkdirSync } from 'node:fs';
const dir = join(ROOT, 'reports');
if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, 'dashboard.md'), md);
console.log('gen-dashboard: reports/dashboard.md written (published=' + published + ', discovery articles=' + articles.length + ')');
