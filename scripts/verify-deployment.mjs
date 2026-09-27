#!/usr/bin/env node
// Post-deploy verification: requests a Pages build (token pushes do NOT
// trigger branch builds), waits for status "built", then verifies that
// representative URLs are live (200). Exit nonzero on failure.
// Usage: GH_TOKEN=... node scripts/verify-deployment.mjs [--sha <sha>] [--wait 600]
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findRoot, SITE, canonicalIndex } from './lib/lab.mjs';

const ROOT = findRoot(process.argv, path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'));
const args = process.argv.slice(2);
const waitIdx = args.indexOf('--wait');
const maxWait = waitIdx >= 0 ? parseInt(args[waitIdx + 1], 10) : 600;
const shaIdx = args.indexOf('--sha');
let sha = shaIdx >= 0 ? args[shaIdx + 1] : null;
if (!sha) { try { sha = execSync('git rev-parse HEAD', { cwd: ROOT }).toString().trim(); } catch { sha = null; } }

function gh(endpoint, method) {
  const cmd = 'gh api ' + (method ? '--method ' + method + ' ' : '') + endpoint;
  try { return execSync(cmd, { cwd: ROOT, env: process.env, encoding: 'utf8' }); }
  catch (e) { return null; }
}

async function waitForBuild() {
  const start = Date.now();
  gh('/repos/codeappweb/lab/pages/builds', 'POST'); // idempotent request
  while ((Date.now() - start) / 1000 < maxWait) {
    const out = gh('/repos/codeappweb/lab/pages');
    try {
      const s = JSON.parse(out);
      if (s && s.status === 'built') return true;
    } catch { /* retry */ }
    await new Promise(r => setTimeout(r, 20000));
  }
  return false;
}

function representativeUrls() {
  // Deterministic sample across content types: home, sitemap index, 3 newest
  // posts, 3 canonical category pages.
  const urls = [SITE + '/', SITE + '/sitemap.xml'];
  const posts = fs.readdirSync(path.join(ROOT, '_posts')).filter(f => f.endsWith('.md')).sort().slice(-3);
  for (const p of posts) urls.push(SITE + '/' + p.replace(/^\d{4}-\d{2}-\d{2}-/, '').replace(/\.md$/, '') + '/');
  const cats = Array.from(canonicalIndex(ROOT, new Date()).keys()).filter(u => u.startsWith('/danh-muc/')).slice(0, 3);
  for (const c of cats) urls.push(SITE + c);
  return urls;
}

async function head(url) {
  try { const r = await fetch(url + '?v=' + Date.now(), { redirect: 'follow' }); return r.status; }
  catch { return 0; }
}

async function main() {
  const built = await waitForBuild();
  const results = [];
  for (const u of representativeUrls()) results.push({ url: u, status: await head(u) });
  const bad = results.filter(r => r.status !== 200);
  const report = {
    verified_at: new Date().toISOString(),
    expected_sha: sha,
    pages_build_reached_built: built,
    urls: results,
    failures: bad.length
  };
  fs.mkdirSync(path.join(ROOT, 'reports'), { recursive: true });
  fs.writeFileSync(path.join(ROOT, 'reports', 'deployment-verification.json'), JSON.stringify(report, null, 2) + '\n');
  console.log('[verify-deployment] failures=' + bad.length + ' built=' + built);
  for (const r of results) console.log('  ' + r.status + ' ' + r.url);
  if (bad.length > 0 || !built) { console.error('[verify-deployment] FAILED'); process.exit(1); }
}

main().catch(e => { console.error(e); process.exit(1); });
