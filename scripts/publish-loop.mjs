#!/usr/bin/env node
// publish-loop.mjs — deterministic publish transaction for the MICRO
// CONTINUOUS LOOP of codeappweb/lab (default chunk_size = 1 article).
// Runs in GitHub Actions on article PRs (branches article/**). NO AI,
// NO API keys, NO secrets, NO cron. The external WRITER (Mistral run)
// only adds the article file(s) under _posts/; this script:
//   1. refuses out-of-scope / oversized pushes
//   2. derives repository truth: sitemap shards + manifest/progress sync
//      (sync-manifest flips the row of every post on disk to `published`)
//   3. runs the blocking light QA gates
//   4. commits ONLY the allowlisted derived paths to the PR branch
//      (never `git add -A`; empty change set = no-op success)
//   5. pushes with rebase + revalidation retry, never force-push
// A failing gate means: nothing is committed, nothing is pushed, the PR
// shows red, and the article never reaches main (GitHub Pages builds
// from main only, so a failing article never becomes a public URL).
// Idempotent: a re-run after a successful run produces no diff and exits 0.
//
// Usage:
//   node scripts/publish-loop.mjs --added _posts/2026-09-30-slug.md
//   node scripts/publish-loop.mjs --added ""            # re-run / no new posts
// Flags:
//   --added "a,b"   comma-separated added article files (required, may be empty)
//   --dry-run       derive + gates only, no git commit/push
//   --no-git        same as --dry-run (for fixtures/tests)
//   LAB_ROOT=path   override repository root (tests/fixtures)
import { readFileSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = process.env.LAB_ROOT
  ? resolve(process.env.LAB_ROOT)
  : resolve(join(dirname(fileURLToPath(import.meta.url)), '..'));

// Derived state written by this transaction — nothing else may be committed.
const DERIVED_ALLOWLIST = [
  'data/article-manifest.jsonl',
  'data/progress.json',
  'data/sitemap-shards.json',
  'sitemap.xml',
  'sitemaps/articles-001.xml',
  'sitemaps/categories.xml',
  'sitemaps/static.xml',
];
const POST_RE = /^_posts\/\d{4}-\d{2}-\d{2}-[a-z0-9-]+\.md$/;

function die(msg) {
  console.error('::error::' + msg);
  console.error('publish-loop: REFUSED/FAILED — nothing committed, nothing pushed.');
  process.exit(1);
}

function run(cmd, args, label) {
  const r = spawnSync(cmd, args, { cwd: ROOT, stdio: 'inherit' });
  if (r.status !== 0) die('STEP FAILED: ' + label);
  return r;
}

// ---- 0. arguments & scope ---------------------------------------------------
const argAdded = process.argv.find(a => a.startsWith('--added='));
const added = argAdded
  ? argAdded.slice('--added='.length).split(',').map(s => s.trim()).filter(Boolean)
  : process.argv.includes('--added')
    ? process.argv[process.argv.indexOf('--added') + 1]?.split(',').map(s => s.trim()).filter(Boolean) || []
    : null;
if (added === null) die('usage: publish-loop.mjs --added "<comma-separated added post files>"');

const NO_GIT = process.argv.includes('--dry-run') || process.argv.includes('--no-git');

const cfgPath = join(ROOT, 'data', 'factory-config.json');
let hardMax = 50;
if (existsSync(cfgPath)) {
  try {
    const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
    if (Number.isInteger(cfg.hard_max_new_posts_per_push) && cfg.hard_max_new_posts_per_push > 0) {
      hardMax = cfg.hard_max_new_posts_per_push;
    }
  } catch (e) {
    die('data/factory-config.json is not valid JSON: ' + e.message);
  }
}

for (const f of added) {
  if (!POST_RE.test(f)) die('out-of-scope file in --added: "' + f + '" — only new _posts/YYYY-MM-DD-<slug>.md files are publishable');
}
if (added.length > hardMax) {
  die(added.length + ' new post(s) exceed hard_max_new_posts_per_push=' + hardMax + ' — REFUSED');
}

// The manifest row of an added post must not already be published
// (protects against a second writer re-publishing the same article).
const manifestPath = join(ROOT, 'data', 'article-manifest.jsonl');
const rows = readFileSync(manifestPath, 'utf8').split('\n').filter(Boolean).map(l => {
  try { return JSON.parse(l); } catch (e) { die('manifest line is not valid JSON: ' + e.message); }
});
const bySlug = new Map(rows.map(r => [r.slug, r]));
for (const f of added) {
  const slug = f.replace(/^_posts\/\d{4}-\d{2}-\d{2}-/, '').replace(/\.md$/, '');
  const row = bySlug.get(slug);
  if (row && row.status === 'published' && !existsSync(join(ROOT, f))) {
    die('slug "' + slug + '" is already published (row ' + row.id + ') but its file is missing — a published article is never claimed again');
  }
}

console.log('publish-loop: scope OK — ' + added.length + ' new post(s), hard max ' + hardMax + ', chunk_size default 1 (config: data/factory-config.json)');

// ---- 1. derive repository truth ----------------------------------------------
run('node', ['scripts/gen-sitemap-shards.mjs'], 'regenerate sitemap shards');
run('node', ['scripts/sync-manifest.mjs'], 'sync manifest + progress with repository truth');

// ---- 2. blocking light QA gates ----------------------------------------------
run('node', ['scripts/validate-content.mjs'], 'manifest + posts validation');
run('node', ['scripts/validate-content-quality.mjs'], 'content quality gate');
run('node', ['scripts/detect-duplicates.mjs'], 'duplicate detection gate');
run('node', ['scripts/check-links.mjs'], 'internal link gate');
run('node', ['scripts/validate-sitemap.mjs'], 'sitemap integrity gate');
run('node', ['scripts/sync-manifest.mjs', '--dry-run'], 'manifest dry-run (in-sync proof)');

if (NO_GIT) {
  console.log('publish-loop: dry-run/no-git mode — derive + gates green, commit skipped.');
  process.exit(0);
}

// ---- 3. commit only the allowlisted derived paths ----------------------------
const status = spawnSync('git', ['status', '--porcelain'], { cwd: ROOT, encoding: 'utf8' });
if (status.status !== 0) die('git status failed');
const changed = status.stdout.split('\n').map(l => l.trim()).filter(Boolean).map(l => l.slice(3).trim());
if (changed.length === 0) {
  console.log('publish-loop: nothing to publish — derived state already in sync (idempotent re-run).');
  process.exit(0);
}
const outOfScope = changed.filter(p => !DERIVED_ALLOWLIST.includes(p) && !p.startsWith('sitemaps/'));
if (outOfScope.length) {
  die('out-of-scope working-tree changes present (only derived allowlist files may be committed): ' + outOfScope.join(', '));
}
console.log('publish-loop: committing derived state — ' + changed.join(', '));
run('git', ['config', 'user.name', 'lab-publish-bot'], 'git config user.name');
run('git', ['config', 'user.email', 'codeappweb@users.noreply.github.com'], 'git config user.email');
run('git', ['add', ...changed], 'git add (explicit allowlist, never -A)');
const ids = added.map(f => f.replace(/^_posts\/\d{4}-\d{2}-\d{2}-/, '').replace(/\.md$/, '')).join(', ');
run('git', ['commit', '-m', 'publish(micro-loop): ' + (ids || 'no new posts') + ' [derived state: manifest, progress, sitemap]'], 'git commit');

// ---- 4. push with rebase + revalidation retry (never force) -------------------
function currentBranch() {
  const r = spawnSync('git', ['branch', '--show-current'], { cwd: ROOT, encoding: 'utf8' });
  const b = (r.stdout || '').trim();
  return b || process.env.GITHUB_HEAD_REF || 'HEAD';
}
const BRANCH = currentBranch();
function pushOnce() {
  const r = spawnSync('git', ['push', 'origin', 'HEAD:' + BRANCH], { cwd: ROOT, stdio: 'inherit' });
  return r.status === 0;
}
if (pushOnce()) {
  console.log('publish-loop: derived state pushed to PR branch.');
  process.exit(0);
}
console.log('publish-loop: push rejected — fetching, rebasing, re-running gates before retry (no force-push).');
run('git', ['fetch', 'origin'], 'git fetch origin');
run('git', ['pull', '--rebase', 'origin', BRANCH], 'git pull --rebase');
// revalidate the exact tree that will be pushed
run('node', ['scripts/sync-manifest.mjs', '--dry-run'], 're-validate manifest after rebase');
run('node', ['scripts/validate-sitemap.mjs'], 're-validate sitemap after rebase');
if (pushOnce()) {
  console.log('publish-loop: derived state pushed after rebase + revalidation.');
  process.exit(0);
}
die('push still rejected after rebase + revalidation — stopping (no force-push); diagnostics are in the workflow artifact.');
