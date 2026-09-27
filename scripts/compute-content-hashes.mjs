#!/usr/bin/env node
// Content body hashes — the basis for resumability: unchanged articles are
// skipped; changed ones are re-processed by the engine/audits. Stable ordering.
import { createHash } from 'node:crypto';
import { findRoot, discover, writeReport } from './lib/lab.mjs';

const ROOT = findRoot(process.argv);
const { posts, pages, statics } = discover(ROOT);
const hashes = {};
for (const it of [...posts, ...pages, ...statics]) {
  const key = it.path;
  const body = it.fm.body || it.text;
  hashes[key] = createHash('sha256').update(body).digest('hex').slice(0, 16);
}
writeReport(ROOT, 'content-hashes.json', { generated_at: new Date().toISOString(), algorithm: 'sha256(body)[0:16]', files: hashes });
console.log('compute-content-hashes: ' + Object.keys(hashes).length + ' files hashed');
