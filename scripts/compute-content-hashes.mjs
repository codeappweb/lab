#!/usr/bin/env node
// compute-content-hashes.mjs — SHA-256 of each post body for change detection.
// Writes reports/content-hashes.json. Used to avoid rebuilding unchanged articles.
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { createHash } from 'node:crypto';

const ROOT = new URL('..', import.meta.url).pathname;
// Explicit inputs (issue #7; used by benchmark-scale.mjs so a benchmark hashes
// a FIXTURE corpus and never touches production data or the production
// report). Defaults preserve the repository behavior.
const argv = process.argv.slice(2);
const argOf = (n) => { const i = argv.indexOf(n); return i !== -1 ? argv[i + 1] : undefined; };
const postsDir = argOf('--posts-dir') || join(ROOT, '_posts');
const outPath = argOf('--out') || join(ROOT, 'reports', 'content-hashes.json');
const hashes = {};

if (existsSync(postsDir)) {
  for (const f of readdirSync(postsDir).filter(f => f.endsWith('.md')).sort()) {
    const text = readFileSync(join(postsDir, f), 'utf8');
    const body = text.slice(text.indexOf('\n---', 3) + 4);
    hashes[f] = createHash('sha256').update(body, 'utf8').digest('hex');
  }
}
const fs = await import('node:fs');
fs.mkdirSync(dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, JSON.stringify(hashes, null, 2) + '\n');
console.log('content-hashes: ' + Object.keys(hashes).length + ' articles hashed');
