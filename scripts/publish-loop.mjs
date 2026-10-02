#!/usr/bin/env node
// publish-loop.mjs — deterministic publish transaction for the 3-WRITER
// STAGED COORDINATOR of codeappweb/lab (data/factory-config.json).
// Runs in GitHub Actions (production.yml). NO AI, NO API keys, NO secrets,
// NO cron. Modes:
//   --integrate (coordinator): staged posts are already in the working tree
//     (apply-staging.mjs); this script runs the global publication validation
//     (blocking jekyll build + validate-built) with HARD thresholds
//     (telemetry.build_fail_seconds), records telemetry measured from the
//     run, merges REVIEW entries (integrate-guard /tmp/review.json) into the
//     derived checkpoint, advances cycle state, then commits posts + derived
//     allowlist + telemetry + cycle/checkpoint state in ONE publication
//     commit. Idempotent: re-run after crash produces no diff and exits 0.
//   --check (CI mode): derive + gates, then REQUIRE a clean tree — never
//     commits (legacy article PR path).
//   --dry-run / --no-git: derive + gates only (fixtures/tests).
//   legacy default: commits derived allowlist and pushes with
//     rebase + revalidation retry, never force-push.
// Rules preserved: out-of-scope pushes refused; published slugs never
// reassigned; only derived allowlist paths may be committed; never force-push.
import { readFileSync, writeFileSync, existsSync, appendFileSync } from 'node:fs';
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
  'data/factory-cycle.json',
  'data/writer-checkpoint.json',
  'data/coordinator-state.json',
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
const CHECK = process.argv.includes('--check');
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

console.log('publish-loop: scope OK — ' + added.length + ' new post(s), hard max ' + hardMax + ', mode: ' + (INTEGRATE ? 'integrate' : CHECK ? 'check' : NO_GIT ? 'dry-run' : 'legacy'));

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

// ---- 2b. INTEGRATE mode: global publication validation + telemetry -----------
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
  if (TH.build_fail_seconds && buildSeconds > TH.build_fail_seconds) {
    die('Jekyll build ' + buildSeconds.toFixed(1) + 's vuot telemetry.build_fail_seconds=' + TH.build_fail_seconds + 's — HARD FAIL, tu choi xuat ban (chua commit).');
  }
  if (TH.build_warn_seconds && buildSeconds > TH.build_warn_seconds) {
    console.log('::warning::Jekyll build ' + buildSeconds.toFixed(1) + 's vuot telemetry.build_warn_seconds=' + TH.build_warn_seconds + 's — can toi uu truoc khi tien gan hard fail.
');
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

  // ---- 2c. derive cycle + checkpoint + failure ledger truoc commit -----------
  // Tất cả state này DUOC DERIVE tu repo that: ids tu --added (da qua guard),
  // review tu /tmp/review.json (integrate-guard), main_sha chua ghi (chi
  // cycle-phase.mjs --publishing duoc ghi sau khi commit that su ton tai).
  const cyclePath = join(ROOT, 'data', 'factory-cycle.json');
  if (existsSync(cyclePath)) {
    try {
      const cyc = JSON.parse(readFileSync(cyclePath, 
'utf8'));
      if (!['complete', 'failed', 'idle'].includes(cyc.phase)) cyc.phase = 'building';
      cyc.publication = { ...(cyc.publication || {}), ids: added.map(slugOf) };
      writeFileSync(cyclePath, JSON.stringify(cyc, null, 2) + '\n');
    } catch (e) { die('data/factory-cycle.json hong: ' + e.message); }
  }
  const cpPath = join(ROOT, 'data', 'writer-checkpoint.json');
  if (existsSync(cpPath)) {
    try {
      const cp = JSON.parse(readFileSync(cpPath, 'utf8'));
      cp.status = 'publishing';
      cp.updated_at = new Date().toISOString();
      if (added.length) {
        cp.last_publication = {
          main_sha: null, // chi cycle-phase --publishing duoc dien sau khi push thanh cong
          ids: added.map(f => {
            const slug = slugOf(f);
            const row = rowsNow.find(r => r.slug === slug);
            return row ? row.id : slug;
          }),
          slugs: added.map(slugOf),
          pages_deployment_id: null,
          live_verified: false,
        };
      }
      if (existsSync('/tmp/review.json')) {
        const rev = JSON.parse(readFileSync('/tmp/review.json', 'utf8'));
        cp.review_queue = [...(cp.review_queue || []), ...rev];
      }
      writeFileSync(cpPath, JSON.stringify(cp, null, 2) + '\n');
    } catch (e) { die('data/writer-checkpoint.json hong: ' + e.message); }
  }
  const coordPath = join(ROOT, 'data', 'coordinator-state.json');
  const coord = existsSync(coordPath)
    ? JSON.parse(readFileSync(coordPath, 'utf8'))
    : { schema_version: 1, consecutive_failures: 0 };
  coord.consecutive_failures = 0; // transaction den day = run thanh cong; ledger reset trong publication commit
  coord.last_run_status = 'publishing';
  coord.updated_at = new Date().toISOString();
  writeFileSync(coordPath, JSON.stringify(coord, null, 2) + '\n');
}

// ---- 3. commit only the allowlisted derived paths ----------------------------
const status = spawnSync('git', ['status', '--porcelain'], { cwd: ROOT, encoding: 'utf8' 
});
if (status.status !== 0) die('git status failed');
// git status --porcelain v1: "XY <path>" (XY = 2 status chars + 1 space).
// NOTE: do NOT trim the line first — a leading space (e.g. " M path") is
// part of the format; trimming it eats the first character of the path.
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
  ? 'publish(integrated): ' + (ids || 'no new posts') + ' [integrated 3-writer cycle; derived state: manifest, progress, sitemap, telemetry, cycle, checkpoint]'
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
  const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' });
  console.log('publish-loop: publication commit pushed — main_sha=' + ((head.stdout || '').trim()));
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
