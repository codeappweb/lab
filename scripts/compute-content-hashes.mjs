#!/usr/bin/env node
// compute-content-hashes.mjs — SHA-256 of each post body for change detection.
// Writes reports/content-hashes.json. Used to avoid rebuilding unchanged articles.
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

const ROOT = new URL('..', import.meta.url).pathname;
const postsDir = join(ROOT, '_posts');
const hashes = {};

if (existsSync(postsDir)) {
  for (const f of readdirSync(postsDir).filter(f => f.endsWith('.md')).sort()) {
    const text = readFileSync(join(postsDir, f), 'utf8');
    const body = text.slice(text.indexOf('\n---', 3) + 4);
    hashes[f] = createHash('sha256').update(body, 'utf8').digest('hex');
  }
}
const fs = await import('node:fs');
fs.mkdirSync(join(ROOT, 'reports'), { recursive: true });
fs.writeFileSync(join(ROOT, 'reports/content-hashes.json'), JSON.stringify(hashes, null, 2) + '\n');
console.log('content-hashes: ' + Object.keys(hashes).length + ' articles hashed');
