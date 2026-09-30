#!/usr/bin/env node
// factory-push.mjs — scoped commit + fail-closed push for the content factory.
// Used by BOTH content workflows so commit scoping and push semantics are
// identical everywhere.
//   1. stages ONLY the allowlisted deterministic-output paths
//   2. REFUSES the run when anything already staged is outside the
//      requested scope (issue #3): a file someone else staged is never
//      silently committed and never unstaged — the caller keeps full
//      control of the index
//   3. verifies EVERY commit ahead of the remote before pushing (not just
//      the last one), so a narrow diagnostics push can never carry an
//      ungated local content commit along
//   4. pushes; on rejection: fetch + rebase, then RERUNS the revalidation
//      commands on the rebased tree and re-checks scope before pushing again
//   5. exits nonzero with an accurate state report if origin was never
//      reached — it never reports success for a local-only commit
// Usage:
//   node scripts/factory-push.mjs --message "..." \
//     --revalidate "node scripts/validate-content-quality.mjs && node scripts/validate-sitemap.mjs" \
//     [--branch main] [--paths "data/factory-state.json,reports/factory"]
// --paths narrows the request to EXACTLY those paths: the staged index, the
// new commit and every commit in the push range must touch nothing else
// (paths outside the allowlist are always refused). An empty --paths list
// is a usage error — it must NEVER fall back to staging the repository.
import { spawnSync } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const DEFAULT_PATHS = ['_posts', '_drafts', 'data', 'sitemaps', 'sitemap.xml', 'reports'];
const ALLOW_RE = /^(_posts\/|_drafts\/|data\/|sitemaps\/|sitemap\.xml$|reports\/)/;

const argv = process.argv.slice(2);
// NOTE: argv/arg must be declared before the first arg() call below — the
// previous order crashed with a TDZ ReferenceError on every invocation
// (regression-tested by scripts/factory-integration.test.mjs).
const arg = (name) => { const i = argv.indexOf(name); return i !== -1 ? argv[i + 1] : undefined; };

const pathsArg = arg('--paths');
const NARROW = pathsArg !== undefined;
const PATHS = NARROW ? pathsArg.split(',').map(s => s.trim()).filter(Boolean) : DEFAULT_PATHS;
if (NARROW && PATHS.length === 0) {
  console.error('::error::--paths is empty after parsing — refusing to run (an empty path list must never stage the whole repository)');
  process.exit(2);
}
const message = arg('--message');
const revalidate = arg('--revalidate') || '';
const branch = arg('--branch') || process.env.GITHUB_REF_NAME || 'main';
if (!message) { console.error('factory-push: --message required'); process.exit(2); }

function git(args, opts = {}) {
  const r = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8', ...opts });
  if (r.error) { console.error('::error::git unavailable: ' + r.error.message); process.exit(1); }
  return r;
}
const out = (args) => git(args).stdout;
const stagedFiles = () => out(['diff', '--cached', '--name-only']).split('\n').filter(Boolean);

// A scope entry matches itself and everything under it (directory prefix).
function inScope(file) {
  for (const p of PATHS) {
    if (file === p) return true;
    if (file.startsWith(p.endsWith('/') ? p : p + '/')) return true;
  }
  return false;
}

// scope = the path allowlist AND the requested paths; anything else is refused
function scopeCheck(files, label) {
  const bad = files.filter(p => !ALLOW_RE.test(p) || !inScope(p));
  if (bad.length) {
    console.error('::error::' + label + ': refusing out-of-scope paths (requested scope: ' + PATHS.join(', ') + '):');
    for (const b of bad) console.error('  ' + b);
    process.exit(1);
  }
}

const status = { branch, state: 'prepared', scope: PATHS, staged: [], rebased: false, revalidated: false, commit: null, pushed: false };

// 1. refuse anything already staged outside the requested scope BEFORE
//    touching the index (issue #3: a pre-staged ungated post must never be
//    committed by a narrow diagnostics run, and it is never unstaged here)
const preStaged = stagedFiles();
scopeCheck(preStaged, 'pre-staged index (staged before factory-push; unstage it explicitly or widen --paths)');

// 2. stage the requested paths. git add -A -- <path> also records the
//    deletion of a tracked file; a pathspec that matches NOTHING (the file
//    neither exists nor is tracked) is tolerated — every other add failure
//    stops the run rather than continuing on uncertain state.
for (const p of PATHS) {
  const a = git(['add', '-A', '--', p]);
  if (a.status === 0) continue;
  if (/did not match any|pathspec/i.test(a.stderr)) continue;
  console.error('::error::git add failed for ' + p + ' — refusing to continue on uncertain state:\n' + a.stderr);
  process.exit(1);
}
status.staged = stagedFiles();
scopeCheck(status.staged, 'staged scope');

// nothing to commit under the requested scope?
const otherChanges = out(['status', '--short', '--', ...PATHS]).trim();
if (status.staged.length === 0 && !otherChanges) {
  status.state = 'clean';
  report(false);
  console.log('factory-push: nothing to commit');
  process.exit(0);
}

// 3. commit
const cm = git(['commit', '-m', message]);
if (cm.status !== 0) { console.error('::error::commit failed:\n' + cm.stderr); process.exit(1); }
const commitSha = out(['rev-parse', 'HEAD']).trim();
status.commit = commitSha;
status.state = 'committed';
const commitFiles = out(['diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD']).split('\n').filter(Boolean);
scopeCheck(commitFiles, 'commit scope (' + commitSha.slice(0, 10) + ')');

// 4. fetch the remote, then verify EVERY commit that would be pushed — a
//    diagnostics push must never carry an ungated local content commit.
function fetchRemote() {
  const f = git(['fetch', 'origin', branch]);
  if (f.status !== 0) {
    console.error('::error::fetch origin/' + branch + ' failed — refusing to continue on uncertain state:\n' + f.stderr);
    return false;
  }
  return true;
}
function checkPushRange(label) {
  const shas = out(['rev-list', 'origin/' + branch + '..HEAD']).split('\n').filter(Boolean);
  for (const c of shas) {
    const files = out(['diff-tree', '--no-commit-id', '--name-only', '-r', c]).split('\n').filter(Boolean);
    scopeCheck(files, label + ': commit ' + c.slice(0, 10) + ' touches paths outside the requested scope');
  }
  return shas.length;
}

if (!fetchRemote()) { status.state = 'fetch-failed'; report(true); process.exit(1); }
checkPushRange('push range');

// 5. fail-closed push with rebase + revalidation
function tryPush() { return git(['push', 'origin', branch]).status === 0; }
function revalidateTree() {
  if (!revalidate) return true;
  const r = spawnSync('bash', ['-c', revalidate], { cwd: ROOT, encoding: 'utf8', stdio: 'inherit' });
  status.revalidated = true;
  if (r.status !== 0) {
    console.error('::error::revalidation FAILED on the rebased tree — not pushing');
    return false;
  }
  return true;
}

let pushed = tryPush();
if (!pushed) {
  for (let i = 0; i < 5 && !pushed; i++) {
    console.log('factory-push: push rejected — fetching and rebasing onto origin/' + branch);
    if (!fetchRemote()) { status.state = 'fetch-failed'; report(true); process.exit(1); }
    const rb = git(['rebase', 'origin/' + branch]);
    if (rb.status !== 0) {
      git(['rebase', '--abort']);
      status.state = 'rebase-failed';
      report(true);
      console.error('::error::rebase onto origin/' + branch + ' failed (conflict) — commit exists LOCALLY ONLY, origin/' + branch + ' was NOT updated');
      process.exit(1);
    }
    status.rebased = true;
    status.commit = out(['rev-parse', 'HEAD']).trim();
    if (!revalidateTree()) {
      status.state = 'revalidated-failed';
      report(true);
      console.error('::error::post-rebase validation failed — commit exists LOCALLY ONLY, origin/' + branch + ' was NOT updated');
      process.exit(1);
    }
    checkPushRange('post-rebase push range');
    pushed = tryPush();
  }
}
status.pushed = pushed;

function report(isError) {
  status.generated_at = new Date().toISOString();
  try {
    mkdirSync(join(ROOT, 'reports', 'factory'), { recursive: true });
    writeFileSync(join(ROOT, 'reports', 'factory', 'push-status.json'), JSON.stringify(status, null, 2) + '\n');
  } catch { /* report persistence best-effort */ }
  console.log('factory-push state: ' + status.state + ' | staged=' + status.staged.length +
    ' | commit=' + (status.commit || 'none') + ' | pushed=' + status.pushed +
    ' | rebased=' + status.rebased + ' | revalidated=' + status.revalidated);
}

if (!pushed) {
  status.state = 'push-failed';
  report(true);
  console.error('::error::push failed after bounded retries — commit exists LOCALLY ONLY, origin/' + branch + ' was NOT updated. Posts were NOT published to the deployed site.');
  process.exit(1);
}
status.state = 'pushed';
report(false);
console.log('factory-push: commit ' + status.commit.slice(0, 10) + ' reached origin/' + branch);
