#!/usr/bin/env node
// benchmark-scale.mjs — HONEST scale measurement for the 20,000-article goal.
// Generates a synthetic corpus in a temporary directory (never committed,
// never published) and measures the expensive full-corpus operations.
//
// Audit fix 2026-09-30 (issue #7):
//   - fixture paths are passed to the child scripts EXPLICITLY, so the
//     benchmark can never read or write production data
//   - every child exit code is checked and the child's own output must
//     prove it processed exactly N fixture articles
//   - child peak RAM is measured with GNU time -v ('Maximum resident set
//     size'), never the parent's RSS; reported as null when unavailable
//   - --out accepts a real path (never parsed as a number) and never
//     defaults into the repository reports/ tree
//   - --worst generates the inverted-index worst case: every
//     primary_topic shares one popular token
//
// Measured numbers only — no extrapolation. This benchmark measures
// full-corpus SCANS (duplicate detection, hashing, manifest load, QA
// index build). It does NOT measure Jekyll build/render time at scale;
// no '20K-ready' claim may be derived from a scan alone.
//
// Usage: node scripts/benchmark-scale.mjs [--n 1000] [--worst] [--out PATH]
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync, readdirSync, mkdtempSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';

const argv = process.argv.slice(2);
const argOf = (n, d) => { const i = argv.indexOf(n); return i !== -1 ? argv[i + 1] : d; };
const N = parseInt(argOf('--n', '1000'), 10);
const WORST = argv.includes('--worst');
const OUT = argOf('--out', null); // explicit output file (never the repo reports/ tree)
const SCRIPTS = new URL('..', import.meta.url).pathname;
if (!Number.isInteger(N) || N < 1) { console.error('invalid --n'); process.exit(2); }
const tmp = mkdtempSync(join(tmpdir(), 'lab-benchmark-'));

// deterministic pseudo-random content (seeded LCG — reproducible)
let seed = 42;
const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
const vocab = [];
for (let i = 0; i < 5000; i++) vocab.push('w' + i);
const COMMON = 'phobien'; // worst-case shared token (--worst)

mkdirSync(join(tmp, 'data'), { recursive: true });
mkdirSync(join(tmp, '_posts'), { recursive: true });
const rows = [];
for (let i = 0; i < N; i++) {
  const slug = 'bai-' + String(i).padStart(5, '0');
  const random = Array.from({ length: 8 }, () => vocab[Math.floor(rnd() * vocab.length)]).join(' ');
  const title = (WORST ? COMMON + ' ' : '') + random;
  rows.push(JSON.stringify({
    id: 'B-' + String(i).padStart(5, '0'), cluster: 'B', status: i < Math.min(100, N) ? 'published' : 'planned',
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

const results = {
  corpus: { articles: N, mode: WORST ? 'worst-case: every primary_topic shares the token ' + COMMON : 'representative random corpus', generated_in: 'temp dir (never committed, never published)' },
  measurements: [],
  notes: [
    'Measured results only — no extrapolation. Synthetic articles were generated in a temp dir and deleted; nothing was committed or published.',
    'Child peak RAM is measured with GNU time -v when available; the parent benchmark process never reports its own RSS as a child measurement.',
    'The --worst mode exercises the inverted token index worst case (many rows sharing one popular token) of detect-duplicates.mjs; at large N this is intentionally expensive.',
    'Jekyll build/render cost at this scale is NOT measured here; do not claim 20K-readiness from scan numbers alone.'
  ]
};

function peakRssMb(stderr) {
  const m = (stderr || '').match(/Maximum resident set size \(kbytes\): (\d+)/);
  return m ? Math.round((parseInt(m[1], 10) / 1024) * 100) / 100 : null;
}

const timeProbe = spawnSync('/usr/bin/time', ['--version'], { encoding: 'utf8' });
const hasTime = !timeProbe.error && timeProbe.status === 0;

// Run a child script against the FIXTURE with explicit paths; the exit
// code is mandatory and the child's own output must prove it processed
// exactly N fixture articles.
function measureChild(label, args, countProofRe) {
  const t0 = process.hrtime.bigint();
  const r = hasTime
    ? spawnSync('/usr/bin/time', ['-v', 'node', args[0], ...args.slice(1)], { encoding: 'utf8' })
    : spawnSync('node', args, { encoding: 'utf8' });
  const ms = Math.round(Number(process.hrtime.bigint() - t0) / 1e6);
  if (r.status !== 0) {
    console.error('::error::' + label + ' failed (exit ' + r.status + '):\n' + String(r.stderr || r.error || '').slice(0, 2000));
    rmSync(tmp, { recursive: true, force: true });
    process.exit(1);
  }
  const m = String(r.stdout || '').match(countProofRe);
  const proved = m ? parseInt(m[1], 10) : -1;
  if (proved !== N) {
    console.error('::error::' + label + ' processed ' + proved + ' of ' + N + ' fixture articles — benchmark invalid (child must prove its processed count)');
    rmSync(tmp, { recursive: true, force: true });
    process.exit(1);
  }
  return {
    label, ms,
    child_exit: 0,
    processed: proved,
    child_peak_rss_mb: hasTime ? peakRssMb(r.stderr) : null,
    peak_rss_method: hasTime ? 'GNU time -v (Maximum resident set size)' : 'unavailable (/usr/bin/time missing) — child peak RAM NOT measured'
  };
}

// 1. manifest load (in-process: measuring this process's own RSS is correct here)
function timedInProcess(label, fn) {
  const t0 = process.hrtime.bigint();
  const mem0 = process.memoryUsage().rss;
  const result = fn();
  const ms = Math.round(Number(process.hrtime.bigint() - t0) / 1e6);
  return { label, ms, result, in_process_peak_rss_mb: Math.round(Math.max(process.memoryUsage().rss, mem0) / 1048576 * 100) / 100 };
}

results.measurements.push(timedInProcess('manifest load (' + N + ' rows JSONL)', () => {
  readFileSync(join(tmp, 'data', 'article-manifest.jsonl'), 'utf8').split('\n').filter(Boolean).map(JSON.parse).length;
}));

// 2. duplicate detection — REAL script, FIXTURE manifest (explicit path, issue #7)
results.measurements.push(measureChild(
  'detect-duplicates.mjs on ' + N + ' fixture rows',
  [join(SCRIPTS, 'detect-duplicates.mjs'), join(tmp, 'data', 'article-manifest.jsonl')],
  /checked (\d+) active records/
));

// 3. controller QA seen-index + shingle build (the per-row full-corpus scan)
results.measurements.push(timedInProcess('QA seen+shingle index over ' + N + ' fixture posts', () => {
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

// 4. content hashes — REAL script, FIXTURE posts and FIXTURE output (issue #7)
results.measurements.push(measureChild(
  'compute-content-hashes.mjs over ' + N + ' fixture posts',
  [join(SCRIPTS, 'compute-content-hashes.mjs'), '--posts-dir', join(tmp, '_posts'), '--out', join(tmp, 'content-hashes.json')],
  /content-hashes: (\d+) articles hashed/
));

rmSync(tmp, { recursive: true, force: true });
const json = JSON.stringify(results, null, 2) + '\n';
console.log(json);
if (OUT) {
  // Explicit user-chosen output path only. The benchmark never writes
  // into the repository reports/ tree on its own (issue #7).
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, json);
  console.log('written: ' + OUT);
}
