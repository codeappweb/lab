#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
const ROOT = new URL('..', import.meta.url).pathname;
const recs = readFileSync(ROOT + 'data/article-manifest.jsonl', 'utf8').split('\n').filter(Boolean).map(JSON.parse);
const urls = ['/', ...Array.from({length: 12}, (_, i) => `/hub/c${String(i+1).padStart(2,'0')}/`),
  ...recs.filter(r => r.status === 'published' && r.published_url).map(r => r.published_url)];
const xml = '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
  urls.map(u => `  <url><loc>${u}</loc></url>`).join('\n') + '\n</urlset>\n';
writeFileSync(ROOT + 'sitemap.xml', xml);
console.log(`sitemap: ${urls.length} urls`);
