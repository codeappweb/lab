#!/usr/bin/env node
// factory-push.mjs — scoped commit + fail-closed push for the content factory.
// Used by BOTH content workflows so commit scoping and push semantics are
// identical everywhere.
//   1. stages ONLY the allowlisted deterministic-output paths
//   2. refuses to commit any staged path outside the allowlist
//      (unrelated files can never enter the commit path)
//   3. pushes; on rejection: fetch + rebase, then RERUNS the revalidation
//      commands on the rebased tree and re-checks scope before pushing again
//   4. exits nonzero with an accurate state report if origin/main was never
//      reached — it never reports success for a local-only commit
// Usage:
//   node scripts/factory-push.mjs --message "..." \
//     --revalidate "node scripts/validate-content-quality.mjs && node scripts/validate-sitemap.mjs" \
//     [--branch main] [--paths "data/factory-state.json,reports/factory"]
// --paths overrides the staged path set with a NARROWER scope (still checked
// against the allowlist below) — used by the factory failure path so a
// diagnostics commit can never stage _posts/_drafts content (issue #3).
import { spawnSync } from 'node:child_process';
import { writeFileSync, mkdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const DEFAULT_PATHS = ['_posts', '_drafts', 'data', 'sitemaps', 'sitemap.xml', 'reports'];
const pathsArg = arg('--paths');
const PATHS = pathsArg ? pathsArg.split(',').map(s => s.trim()).filter(Boolean) : DEFAULT_PATHS;
// git pathspecs must match existing files; a narrowed --paths may name files
// (e.g. data/factory-lock.json) that legitimately do not exist this run.
const gitPaths = PATHS.filter(pp => { try { statSync(join(ROOT, pp)); return true; } catch { return false; } });
const ALLOW_RE = /^(_posts\/|_drafts\/|data\/|sitemaps\/|sitemap\.xml$|reports\/)/;

const argv = process.argv.slice(2);
const arg = (name) => { const i = argv.indexOf(name); return i !== -1 ? argv[i + 1] : undefined; };
const message = arg('--message');
const revalidate = arg('--revalidate') || '';
const branch = arg('--branch') || process.env.GITHUB_REF_NAME || 'main';
if (!message) { console.error('factory-push: --message required'); process.exit(2); }

function git(args, opts = {}) {
  const r = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8', ...opts });
  if (r.error) { console.error('git unavailable: ' + r.error.message); process.exit(1); }
  return r;
}

function staged() {
  return git(['diff', '--cached', '--name-only']).stdout.split('\n').filter(Boolean);
}

function scopeCheck(paths, label) {

  const bad = paths.filter(p => !ALLOW_RE.test(p));
  if (bad.length) {
    console.error('::error::' + label + ': refusing out-of-scope paths:');
    for (const b of bad) console.error('  ' + b);
    process.exit(1);
  }
}

const status = { branch, state: 'prepared', staged: [], rebased: false, revalidated: false, commit: null, pushed: false };

// 1. stage only the deterministic-output paths
const add = git(['add', '-A', '--', ...gitPaths]);
if (add.status !== 0) {
  console.log('factory-push: git add exited ' + add.status + ' (tolerated only because pathspecs are re-verified below); staged scope is checked next');
}
status.staged = staged();
scopeCheck(status.staged, 'staged scope');

const nothingStaged = status.staged.length === 0;
const otherChanges = git(['status', '--short', '--', ...gitPaths]).stdout.trim();
if (nothingStaged && !otherChanges) {
  status.state = 'clean';
  console.log('factory-push: nothing to commit');
  process.exit(0);
}

// 2. commit
const cm = git(['commit', '-m', message]);
if (cm.status !== 0) { console.error('::error::commit failed:\n' + cm.stderr); process.exit(1); }
const commitSha = git(['rev-parse', 'HEAD']).stdout.trim();
status.commit = commitSha;
status.state = 'committed';
const commitFiles = git(['diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD']).stdout.split('\n').filter(Boolean);
scopeCheck(commitFiles, 'commit scope (' + commitSha.slice(0, 10) + ')');

// 3. fail-closed push with rebase + revalidation
function tryPush() {
  const r = git(['push', 'origin', branch]);
  return r.status === 0;
}

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
    const f = git(['fetch', 'origin', branch]);
    const rb = git(['rebase', 'origin/' + 
branch]);
    if (rb.status !== 0) {
      git(['rebase', '--abort']);
      status.state = 'rebase-failed';
      report(true);
      console.error('::error::rebase onto origin/' + branch + ' failed (conflict) — commit exists LOCALLY ONLY, origin/' + branch + ' was NOT updated');
      process.exit(1);
    }
    status.rebased = true;
    status.commit = git(['rev-parse', 'HEAD']).stdout.trim();
    if (!revalidateTree()) {
      status.state = 'revalidated-failed';
      report(true);
      console.error('::error::post-rebase validation failed — commit exists LOCALLY ONLY, origin/' + branch + ' was NOT updated');
      process.exit(1);
    }
    const rebaseFiles = git(['diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD']).stdout.split('\n').filter(Boolean);
    scopeCheck(rebaseFiles, 'post-rebase commit scope');
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
