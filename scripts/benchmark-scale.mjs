#!/usr/bin/env node
// benchmark-scale.mjs — HONEST scale verification for the 20,000-article goal.
// Generates a REPRESENTATIVE SYNTHETIC corpus in a temporary directory
// (never committed, never published) and measures the expensive full-corpus
// scans: duplicate detection, controller QA (seen-index + shingle build)
// and manifest loading. Reports measured runtime, peak RSS and corpus size.
// The Jekyll build cost is measured separately in the CI job that runs a
// real production build over a synthetic _posts copy (also never published).
// Usage: node scripts/benchmark-scale.mjs [--n 1000] [--out reports/scale-benchmark.json]
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';

const argv = process.argv.slice(2);
const argOf = (n, d) => { const i = argv.indexOf(n); return i !== -1 ? parseInt(argv[i + 1], 10) : d; };
const N = argOf('--n', 1000);
const OUT = argOf('--out', 0) ? argv[argv.indexOf('--out') + 1] : null;
const SCRIPTS = new URL('..', import.meta.url).pathname;
const tmp = mkdtempSync(join(tmpdir(), 'lab-benchmark-'));

// deterministic pseudo-random content (seeded LCG — reproducible)
let seed = 42;
const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
const vocab = [];
for (let i = 0; i < 5000; i++) vocab.push('w' + i);

mkdirSync(join(tmp, 'data'), { recursive: true });
mkdirSync(join(tmp, '_posts'), { recursive: true });
const rows = [];
for (let i = 0; i < N; i++) {
  const slug = 'bai-' + String(i).padStart(5, '0');
  const title = Array.from({ length: 8 }, () => vocab[Math.floor(rnd() * vocab.length)]).join(' ');
  rows.push(JSON.stringify({
    id: 'B-' + String(i).padStart(5, '0'), cluster: 'B', status: i < 100 ? 'published' : 'planned',
    primary_topic: title, search_intent: 'informational', title, slug,
    parent_hub: '/hub/b/', entities: [], freshness: 'low',
    needs_official_source: false, similarity_group: null, source_plan: [], internal_links: [], published_url: null
  }));
  const words = Array.from({ length: 600 }, () => vocab[Math.floor(rnd() * vocab.length)]).join(' ');
  writeFileSync(join(tmp, '_posts', '2026-01-01-' + slug + '.md'),
    '---\nlayout: post\ntitle: "' + title + '"\ndate: 2026-01-01\ndescription: "' + title + '"\nid: ' + slug +
    '\ncluster: B\nbatch: bench\nfreshness_status: evergreen\nlegal_sensitivity: false\n---\n\n' + words + '\n');
}
writeFileSync(join(tmp, 'data', 'article-manifest.jsonl'), rows.join('\n') + '\n');

function timed(label, fn) {
  const t0 = process.hrtime.bigint();
  const mem0 = process.memoryUsage().rss;
  const result = fn();
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  return { label, ms, peak_rss_mb: Math.max(process.memoryUsage().rss, mem0) / 1048576, result };
}

const results = { corpus: { articles: N, generated_in: 'temp dir (never committed, never published)' }, measurements: [] };

// 1. manifest load
results.measurements.push(timed('manifest load (' + N + ' rows JSONL)', () => {
  readFileSync(join(tmp, 'data', 'article-manifest.jsonl'), 'utf8').split('\n').filter(Boolean).map(JSON.parse).length;
}));

// 2. duplicate detection (real script, real corpus)
results.measurements.push(timed('detect-duplicates.mjs on ' + N + ' rows', () => {
  spawnSync('node', [join(SCRIPTS, 'detect-duplicates.mjs')], { cwd: tmp, encoding: 'utf8' });
}));

// 3. controller QA seen-index + shingle build (the per-row full-corpus scan)
results.measurements.push(timed('QA seen+shingle index over ' + N + ' posts', () => {
  const seen = new Map(); const shingles = new Map();
  for (const f of readdirSync(join(tmp, '_posts'))) {
    const text = readFileSync(join(tmp, '_posts', f), 'utf8');
    const fmEnd = text.indexOf('\n---', 3);
    const body = text.slice(fmEnd + 4);
    const fm = {};
    for (const line of text.slice(3, fmEnd).split('\n')) {
      const m = line.match(/^([a-z_]+):\s*"?(.*?)"?\s*$/); if (m) fm[m[1]] = m[2];
    }
    seen.set('title:' + (fm.title || '').toLowerCase(), f);
    const words = body.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
    const sh = new Set();
    for (let i = 0; i + 2 < words.length; i++) sh.add(words[i] + words[i + 1] + words[i + 2]);
    shingles.set(f, sh);
  }
  return seen.size;
}));

// 4. content hashes over N posts
results.measurements.push(timed('compute-content-hashes over ' + N + ' posts', () => {
  spawnSync('node', [join(SCRIPTS, 'compute-content-hashes.mjs')], { cwd: tmp, encoding: 'utf8', env: { ...process.env, LAB_BENCH_POSTS: join(tmp, '_posts') } });
}));

rmSync(tmp, { recursive: true, force: true });
results.notes = [
  'Measured results only — no extrapolation. Synthetic articles were generated in a temp dir and deleted; nothing was committed or published.',
  'The O(n^2) similarity scan in detect-duplicates.mjs is the known bottleneck for a 20,000-row manifest; measure again at 5k and 20k before enabling production.',
  'Jekyll build cost is measured by the CI benchmark job (real production build over a synthetic _posts copy, also never published).'
];
console.log(JSON.stringify(results, null, 2));
if (OUT) {
  mkdirSync(join(SCRIPTS, '..', 'reports'), { recursive: true });
  writeFileSync(join(SCRIPTS, '..', OUT), JSON.stringify(results, null, 2) + '\n');
  console.log('written: ' + OUT);
}
