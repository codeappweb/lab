#!/usr/bin/env node
// publish-loop.mjs — deterministic publish transaction for the MICRO
// CONTINUOUS LOOP of codeappweb/lab (default chunk_size = 1 article).
// Runs in GitHub Actions on article PRs (branches article/**). NO AI,
// NO API keys, NO secrets, NO cron. The external WRITER (Mistral run)
// commits the article file(s) under _posts/ TOGETHER with the derived
// allowlist state in ONE push (prepared by scripts/prepare-article.mjs);
// this script:
//   1. refuses out-of-scope / oversized pushes
//   2. derives repository truth: sitemap shards + manifest/progress sync
//      (sync-manifest flips the row of every post on disk to `published`)
//   3. runs the blocking light QA gates
//   4. --check (CI mode): verifies the writer already committed the
//      allowlisted derived paths — CI NEVER commits, NEVER pushes
//   5. (legacy default mode) commits the allowlisted derived paths and
//      pushes with rebase + revalidation retry, never force-push
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
//   --check         derive + gates, then REQUIRE a clean tree: the writer
//                  committed the derived state — CI mode, never commits
//   LAB_ROOT=path   override repository root (tests/fixtures)
//   --integrate     coordinator mode: staged posts are already in the
//                  working tree; runs blocking jekyll build + validate-built
//                  + telemetry, then ONE commit (posts + derived + telemetry)
//   --repaired "a,b" comma-separated repaired _posts files (integrate mode)
import { readFileSync, existsSync, appendFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { changedPaths } from './porcelain.mjs';

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
  'data/production-telemetry.jsonl',
];
const POST_RE = /^_posts\/\d{4}-\d{2}-\d{2}-[a-z0-9-]+\.md$/;

const T0 = Date.now();

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

// CI check mode: the writer commits article + derived state in ONE push;
// the workflow only verifies (contents: read, no bot commits).
const CHECK = process.argv.includes('--check');

// INTEGRATE mode (coordinator on main): staged posts are already applied to
// the working tree by apply-staging.mjs; this script adds the global
// publication validation (blocking jekyll build + validate-built), records
// telemetry with values measured from the run, then commits posts + derived
// allowlist + telemetry in ONE publication commit. Never used by fixtures.
const INTEGRATE = process.argv.includes('--integrate');
const argRepaired = process.argv.find(a => a.startsWith('--repaired='));
const repaired = argRepaired
  ? argRepaired.slice('--repaired='.length).split(',').map(s => s.trim()).filter(Boolean)
  : process.argv.includes('--repaired')
    ? (process.argv[process.argv.indexOf('--repaired') + 1] || '').split(',').map(s => s.trim()).filter(Boolean)
    : [];

const cfgPath = join(ROOT, 'data', 'factory-config.json');
let hardMax = 50;
let CFG = {};
if (existsSync(cfgPath)) {
  try {
    const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
    CFG = cfg;
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
for (const f of repaired) {
  if (!POST_RE.test(f)) die('out-of-scope file in --repaired: "' + f + '" — only _posts/YYYY-MM-DD-<slug>.md files are publishable');
}
if (INTEGRATE) {
  const cap = Number.isInteger(CFG.integration_max_new_posts) && CFG.integration_max_new_posts > 0 ? CFG.integration_max_new_posts : 6;
  if (added.length > cap) {
    die(added.length + ' new post(s) exceed integration_max_new_posts=' + cap + ' — REFUSED');
  }
  for (const f of added) {
    const slug = f.replace(/^_posts\/\d{4}-\d{2}-\d{2}-/, '').replace(/\.md$/, '');
    const row = bySlug.get(slug);
    if (row && row.status === 'published') {
      die('integrate: slug "' + slug + '" is already published (row ' + row.id + ') — a published article is never reassigned (identical re-apply is skipped by integrate-guard before this point)');
    }
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

if (CHECK) {
  const st = spawnSync('git', ['status', '--porcelain'], { cwd: ROOT, encoding: 'utf8' });
  if (st.status !== 0) die('git status failed in --check mode');
  const pending = changedPaths(st.stdout);
  if (pending.length) {
    die('--check: derived state NOT committed by the writer: ' + pending.join(', ') + ' — run scripts/prepare-article.mjs <id>, then commit these files together with the article in ONE push (CI never commits)');
  }
  console.log('publish-loop --check: writer-committed tree is in sync (article + derived state verified).');
  process.exit(0);
}

if (NO_GIT) {
  console.log('publish-loop: dry-run/no-git mode — derive + gates green, commit skipped.');
  process.exit(0);
}
// ---- 2b. INTEGRATE mode: global publication validation + telemetry --------
// Moi gia tri telemetry duoc DO TU RUN (du, find, wc, git, manifest) — khong
// co so lieu bia. pages_deploy_duration_s = null khi khong quan sat duoc.
if (INTEGRATE) {
  const qaSeconds = (Date.now() - T0) / 1000;
  const buildT0 = Date.now();
  run('bundle', ['exec', 'jekyll', 'build', '--strict_front_matter', '--disable-disk-cache'], 'jekyll build (blocking, integrate)');
  const buildSeconds = (Date.now() - buildT0) / 1000;
  run('node', ['scripts/validate-built.mjs'], 'validate built _site');
  function sh(cmd) {
    const r = spawnSync('bash', ['-c', cmd], { cwd: ROOT, encoding: 'utf8' });
    return (r.stdout || '').trim();
  }
  const rowsNow = readFileSync(manifestPath, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
  const publishedCount = rowsNow.filter(r => r.status === 'published').length;
  const siteKB = Number(sh('du -sk _site 2>/dev/null | cut -f1')) || 0;
  const repoKB = Number(sh('du -sk --exclude=.git --exclude=_site --exclude=vendor . 2>/dev/null | cut -f1')) || 0;
  const filesGen = Number(sh('find _site -type f 2>/dev/null | wc -l')) || 0;
  const sitemapUrls = Number(sh("grep -o '<loc>' sitemap.xml sitemaps/*.xml 2>/dev/null | wc -l")) || 0;
  const commitsHour = Number(sh("git rev-list --count --since='1 hour ago' origin/main 2>/dev/null")) || 0;
  const TH = CFG.telemetry || {};
  if (TH.site_size_fail_mb && siteKB > TH.site_size_fail_mb * 1024) {
    die('_site ' + Math.round(siteKB / 1024) + 'MB vuot telemetry.site_size_fail_mb=' + TH.site_size_fail_mb + 'MB — tu choi xuat ban (fail closed, chua commit).');
  }
  if (TH.site_size_warn_mb && siteKB > TH.site_size_warn_mb * 1024) {
    console.log('::warning::_site ' + Math.round(siteKB / 1024) + 'MB vuot telemetry.site_size_warn_mb=' + TH.site_size_warn_mb + 'MB — can tach sitemap shard / giam kich thuoc truoc khi scale tiep.');
  }
  if (TH.build_warn_seconds && buildSeconds > TH.build_warn_seconds) {
    console.log('::warning::Jekyll build ' + buildSeconds.toFixed(1) + 's vuot telemetry.build_warn_seconds=' + TH.build_warn_seconds + 's — can toi uu truoc khi tien gan Pages timeout.');
  }
  if (TH.deploy_frequency_warn_per_hour && commitsHour + 1 > TH.deploy_frequency_warn_per_hour) {
    console.log('::warning::main se co ~' + (commitsHour + 1) + ' commit trong gio vua qua — vuot telemetry.deploy_frequency_warn_per_hour=' + TH.deploy_frequency_warn_per_hour + ', nen giam tan suat chu ky.');
  }
  const cps = Array.isArray(CFG.scale_checkpoints) ? CFG.scale_checkpoints : [];
  const crossed = cps.filter(t => publishedCount >= t);
  const slugOf = f => f.replace(/^_posts\/\d{4}-\d{2}-\d{2}-/, '').replace(/\.md$/, '');
  const teleRow = {
    ts: new Date().toISOString(),
    cycle: 'integrated',
    added: added.map(slugOf),
    repaired: repaired.map(slugOf),
    published_count: publishedCount,
    repo_size_kb: repoKB,
    site_size_kb: siteKB,
    files_generated: filesGen,
    sitemap_urls: sitemapUrls,
    jekyll_build_seconds: Number(buildSeconds.toFixed(1)),
    qa_seconds: Number(qaSeconds.toFixed(1)),
    production_seconds: Number(((Date.now() - T0) / 1000).toFixed(1)),
    pages_deploy_duration_s: null,
    main_commits_last_hour: commitsHour,
    scale_checkpoints_crossed: crossed,
  };
  appendFileSync(join(ROOT, 'data', 'production-telemetry.jsonl'), JSON.stringify(teleRow) + '\n');
  console.log('publish-loop: telemetry — published=' + publishedCount + ', _site=' + Math.round(siteKB / 1024) + 'MB, build=' + buildSeconds.toFixed(1) + 's, qa=' + qaSeconds.toFixed(1) + 's, files=' + filesGen + ', sitemap_urls=' + sitemapUrls + ', checkpoints=' + JSON.stringify(crossed));
}

// ---- 3. commit only the allowlisted derived paths ----------------------------
const status = spawnSync('git', ['status', '--porcelain'], { cwd: ROOT, encoding: 'utf8' });
if (status.status !== 0) die('git status failed');
// git status --porcelain v1: "XY <path>" (XY = 2 status chars + 1 space).
// NOTE: do NOT trim the line first — a leading space (e.g. " M path") is
// part of the format; trimming it eats the first character of the path
// and made every derived file look out-of-scope (bug fixed 2026-09-30).
const changed = changedPaths(status.stdout);
if (changed.length === 0) {
  console.log('publish-loop: nothing to publish — derived state already in sync (idempotent re-run).');
  process.exit(0);
}
const outOfScope = changed.filter(p => !DERIVED_ALLOWLIST.includes(p) && !p.startsWith('sitemaps/') && !(INTEGRATE && (added.includes(p) || repaired.includes(p))));
if (outOfScope.length) {
  die('out-of-scope working-tree changes present (only derived allowlist files may be committed): ' + outOfScope.join(', '));
}
console.log('publish-loop: committing derived state — ' + changed.join(', '));
run('git', ['config', 'user.name', INTEGRATE ? 'lab-factory' : 'lab-publish-bot'], 'git config user.name');
run('git', ['config', 'user.email', 'codeappweb@users.noreply.github.com'], 'git config user.email');
run('git', ['add', ...changed], 'git add (explicit allowlist, never -A)');
const ids = added.map(f => f.replace(/^_posts\/\d{4}-\d{2}-\d{2}-/, '').replace(/\.md$/, '')).join(', ');
const msg = INTEGRATE
  ? 'publish(integrated): ' + (ids || 'no new posts') + ' [integrated 3-writer cycle; derived state: manifest, progress, sitemap, telemetry]'
  : 'publish(micro-loop): ' + (ids || 'no new posts') + ' [derived state: manifest, progress, sitemap]';
run('git', ['commit', '-m', msg], 'git commit');

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