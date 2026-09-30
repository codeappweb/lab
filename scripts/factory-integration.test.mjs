// scripts/factory-integration.test.mjs — integration regression tests for
// the content factory (issues #3, #5, #6, #7).
//
// Every test builds a THROWAWAY fixture repository in a temp directory,
// copies the real scripts into the fixture (so ROOT resolves to the
// fixture, never to the production checkout) and gives the fixture its own
// LOCAL BARE GIT REMOTE. Production data (_posts, _drafts, data/) is never
// used for mutation; error paths are exercised on fixtures only.
//
// Covered contracts:
//   T1 gate fail          -> publish refuses; nothing leaves _drafts
//   T2 committed promotion -> rollback refuses; finalize-publish completes
//   T3 push rejection      -> factory-push rebases, revalidates, and never
//                             pushes a tree that fails revalidation
//   T4 recover            -> interrupted committed publication completes
//                             idempotently; uncommitted promotion rolls back
//   T5 two workers        -> a fresh foreign lock blocks the second worker
//   T6 sync-manifest      -> --require-committed, ghost hard error,
//                             front-matter reconcile (needs_official_source)
//   T7 benchmark          -> processes exactly the fixture corpus and never
//                             touches production data
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, rmSync, mkdirSync, writeFileSync, cpSync,
  existsSync, readdirSync, readFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const SRC = new URL('..', import.meta.url).pathname; // production checkout (READ-ONLY here)
const COPIED = ['factory-batch.mjs', 'sync-manifest.mjs', 'factory-push.mjs'];

function git(cwd, args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, 'git ' + args.join(' ') + ' failed in ' + cwd + ':\n' + (r.stderr || ''));
  return r.stdout;
}

// deterministic draft content that satisfies qaDraft: title 30-70 chars,
// unique description 90-165 chars, >= 400 words, >= 2 '##' sections, no H1,
// >= 2 valid internal links (taxonomy slugs exist in the fixture), no CJK,
// no 'undefined', unique title/id/primary_keyword, valid parent/child pair.
function draftBody(slug, n) {
  const lines = [];
  lines.push('## Gioi thieu chung');
  for (let i = 0; i < 30; i++) lines.push('Chu de ' + slug + ' bao gom phan tu so ' + i + ' cua ' + n + ' khoi du lieu mau.');
  lines.push('Xem chuyen muc cha [phu hu](/phu-hu/) de hieu cau truc noi dung.');
  lines.push('');
  lines.push('## Ket luan va khuyen nghi');
  for (let i = 30; i < 60; i++) lines.push('Ket luan so ' + i + ' cho ' + slug + ' duoc xep hang theo thu tu ' + n + '.');
  lines.push('Bai viet lien quan [con a](/con-a/) cung cap bo luc chi tiet hon.');
  return lines.join('\n');
}

function draftFile(slug, n, opts) {
  const o = opts || {};
  const title = o.shortTitle ? 'Tieu de ngan' : 'Kien thuc chi tiet ve chu de ' + slug + ' cho ban doc so ' + n;
  let desc = 'Mo ta chi tiet va day du cho bai viet ' + slug + ' trong kho du lieu mau cua bo kiem thu tich hop. ';
  while (desc.length < 100) desc += 'Phan bo sung so ' + desc.length + ' cho mo ta. ';
  desc = desc.slice(0, 150);
  return [
    '---',
    'id: "' + slug + '"',
    'title: "' + title + '"',
    'description: "' + desc + '"',
    'date: 2026-01-1' + n,
    'category: "phu-hu"',
    'subcategory: "con-a"',
    'parent_category: "phu-hu"',
    'child_category: "con-a"',
    'primary_keyword: "tu khoa ' + slug + '"',
    'search_intent: "informational"',
    'cluster: "T"',
    'batch: "' + (o.batch || 'batch-1970-01-01') + '"',
    'created_at: "2026-01-01"',
    'updated_at: "2026-01-01"',
    'freshness_status: "evergreen"',
    'layout: "default"',
    'legal_sensitivity: "false"',
    'entities:',
    '  - "don thu ' + slug + '"',
    '  - "don thu hai ' + slug + '"',
    'related_articles:',
    '  - "/phu-hu/"',
    '  - "/con-a/"',
    '---',
    '',
    draftBody(slug, n)
  ].join('\n') + '\n';
}

function makeFixture(rowSlugs, manifestRows) {
  const root = mkdtempSync(join(tmpdir(), 'lab-it-'));
  const work = join(root, 'work');
  const bare = join(root, 'remote.git');
  mkdirSync(join(work, 'scripts'), { recursive: true });
  mkdirSync(join(work, 'data'), { recursive: true });
  mkdirSync(join(work, '_posts'), { recursive: true });
  mkdirSync(join(work, '_drafts'), { recursive: true });
  for (const f of COPIED) cpSync(join(SRC, 'scripts', f), join(work, 'scripts', f));
  writeFileSync(join(work, 'data', 'taxonomy.yml'), [
    'taxonomies:',
    '  - id: "phu-hu"',
    '    slug: "phu-hu"',
    '    children:',
    '      - id: "con-a"',
    '        slug: "con-a"',
    '      - id: "con-b"',
    '        slug: "con-b"',
    ''
  ].join('\n'));
  const rows = manifestRows || rowSlugs.map((s, i) => ({
    id: 'T-' + String(i + 1).padStart(3, '0'), slug: s, status: 'planned',
    primary_topic: 'chu de ' + s, search_intent: 'informational', cluster: 'T',
    parent_hub: '/hub/t/', entities: [], freshness: 'low',
    needs_official_source: false, similarity_group: null
  }));
  writeFileSync(join(work, 'data', 'article-manifest.jsonl'), rows.map(r => JSON.stringify(r)).join('\n') + '\n');
  writeFileSync(join(work, 'data', 'progress.json'), JSON.stringify({
    articles: { published: 0, planned: rows.length, manifest_rows: rows.length },
    manifest_rows: rows.length, posts_on_disk: 0
  }, null, 2) + '\n');
  git(work, ['init']);
  git(work, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
  git(work, ['config', 'user.email', 'it@test.local']);
  git(work, ['config', 'user.name', 'it']);
  git(work, ['add', '-A']);
  git(work, ['commit', '-m', 'fixture init']);
  git(root, ['init', '--bare', bare]);
  git(work, ['remote', 'add', 'origin', bare]);
  git(work, ['push', '-u', 'origin', 'main']);
  git(work, ['fetch', 'origin']);
  // a fresh bare repo HEAD still points at the runner's default branch
  // (often master), which breaks clones: point it at main explicitly
  git(bare, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
  return { root, work, bare };
}

function runFB(fx, args, runId) {
  return spawnSync(process.execPath, [join(fx.work, 'scripts', 'factory-batch.mjs'), ...args], {
    cwd: fx.work, encoding: 'utf8', env: { ...process.env, FACTORY_RUN_ID: runId }
  });
}
function runNodeScript(fx, script, args) {
  return spawnSync(process.execPath, [join(fx.work, 'scripts', script), ...args], {
    cwd: fx.work, encoding: 'utf8'
  });
}
function state(fx) { return JSON.parse(readFileSync(join(fx.work, 'data', 'factory-state.json'), 'utf8')); }
function history(fx) { return JSON.parse(readFileSync(join(fx.work, 'data', 'factory-history.json'), 'utf8')); }
function manifestRows(fx) {
  return readFileSync(join(fx.work, 'data', 'article-manifest.jsonl'), 'utf8')
    .split('\n').filter(Boolean).map(JSON.parse);
}
function writeDraft(fx, slug, n, opts) {
  const b = state(fx).batch;
  mkdirSync(join(fx.work, '_drafts', b), { recursive: true });
  writeFileSync(join(fx.work, '_drafts', b, slug + '.md'), draftFile(slug, n, { ...opts, batch: b }));
}
function cleanup(fx, t) { t.after(() => rmSync(fx.root, { recursive: true, force: true })); }

test('T1 gate fail: publish refuses, drafts preserved, nothing pushed', (t) => {
  const fx = makeFixture(['bai-1', 'bai-2']);
  cleanup(fx, t);
  let r = runFB(fx, ['prepare-next', '--batch-size', '2'], 'runA');
  assert.equal(r.status, 0, r.stderr);
  writeDraft(fx, 'bai-1', 1);
  writeDraft(fx, 'bai-2', 2, { shortTitle: true });
  r = runFB(fx, ['qa'], 'runA');
  assert.equal(r.status, 3, 'qa must exit 3 when a row FAILs:\n' + r.stdout + r.stderr);
  r = runFB(fx, ['assert-ready'], 'runA');
  assert.notEqual(r.status, 0, 'assert-ready must block a batch with a FAIL row');
  r = runFB(fx, ['publish'], 'runA');
  assert.notEqual(r.status, 0, 'publish must refuse a batch with a FAIL row');
  assert.ok((r.stderr || '').includes('publish refused'), r.stderr);
  assert.deepEqual(readdirSync(join(fx.work, '_posts')), [], 'no post may be promoted when the gate fails');
  const b = state(fx).batch;
  assert.ok(existsSync(join(fx.work, '_drafts', b, 'bai-1.md')), 'the PASS draft must stay in the drafts dir');
  assert.ok(existsSync(join(fx.work, '_drafts', b, 'bai-2.md')), 'the FAIL draft must stay in the drafts dir');
  // the local git remote never received anything beyond the fixture init
  assert.equal(git(fx.bare, ['rev-list', '--all', '--count']).trim(), '1');
});

test('T2 committed promotion: rollback refuses, finalize-publish completes', (t) => {
  const fx = makeFixture(['bai-1']);
  cleanup(fx, t);
  let r = runFB(fx, ['prepare-next', '--batch-size', '1'], 'runA');
  assert.equal(r.status, 0, r.stderr);
  writeDraft(fx, 'bai-1', 1);
  r = runFB(fx, ['qa'], 'runA');
  assert.equal(r.status, 0, 'T2 qa must pass the ready draft:\n' + r.stdout + r.stderr);
  r = runFB(fx, ['assert-ready'], 'runA');
  assert.equal(r.status, 0, 'T2 assert-ready must accept the ready batch:\n' + r.stdout + r.stderr);
  r = runFB(fx, ['publish'], 'runA');
  assert.equal(r.status, 0, r.stderr);
  const postRel = state(fx).rows[0].post_file;
  const postPath = join(fx.work, postRel);
  assert.ok(existsSync(postPath), 'publish promotes the draft into _posts');
  // commit and push the promoted post (the publication commit)
  git(fx.work, ['add', '_posts']);
  git(fx.work, ['commit', '-m', 'content: publish bai-1']);
  git(fx.work, ['push', 'origin', 'main']);
  const sha = git(fx.work, ['rev-parse', 'HEAD']).trim();
  // rollback must REFUSE: the post is already on origin/main
  r = runFB(fx, ['rollback', '--reason', 'test'], 'runA');
  assert.notEqual(r.status, 0, 'rollback must refuse committed content');
  assert.ok((r.stderr || '').includes('rollback refused'), r.stderr);
  assert.ok(existsSync(postPath), 'committed post must stay in _posts');
  assert.equal(state(fx).rows[0].status, 'staged');
  // finalize-publish completes the two-phase publication
  r = runFB(fx, ['finalize-publish', '--commit', sha], 'runA');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(state(fx).rows[0].status, 'published');
  assert.equal(history(fx).length, 1, 'finalize records the batch in history');
  assert.ok(!existsSync(join(fx.work, 'data', 'factory-lock.json')), 'lock released after finalize');
});

test('T3 push rejection: factory-push rebases, revalidation failure blocks the push', (t) => {
  const fx = makeFixture(['bai-1']);
  cleanup(fx, t);
  // a foreign writer advances the remote first
  const other = join(fx.root, 'other');
  git(fx.root, ['clone', fx.bare, other]);
  git(other, ['config', 'user.email', 'foreign@test.local']);
  git(other, ['config', 'user.name', 'foreign']);
  mkdirSync(join(other, 'reports'), { recursive: true });
  writeFileSync(join(other, 'reports', 'foreign.json'), '{"who":"foreign"}\n');
  git(other, ['add', 'reports']);
  git(other, ['commit', '-m', 'foreign advance']);
  git(other, ['push', 'origin', 'main']);
  // local change that must be pushed
  writeFileSync(join(fx.work, 'data', 'factory-diagnostics.json'), '{"note":"local"}\n');
  // revalidation FAILS on the rebased tree -> the push must be blocked.
  // --branch is pinned: factory-push defaults to $GITHUB_REF_NAME when set
  // (in CI that is the PR branch, and the push would silently CREATE it on
  // the fixture remote instead of being rejected against main).
  let r = runNodeScript(fx, 'factory-push.mjs', ['--message', 'diagnostics', '--revalidate', 'false', '--branch', 'main']);
  assert.notEqual(r.status, 0, 'a failing revalidation must block the push');
  const err = (r.stdout || '') + (r.stderr || '');
  assert.ok(err.includes('post-rebase validation failed'), err);
  let remoteFiles = git(fx.bare, ['ls-tree', '-r', '--name-only', 'main']);
  assert.ok(!remoteFiles.includes('data/factory-diagnostics.json'), 'origin must NOT contain the unvalidated commit');
  // drop the local-only commit and retry with a passing revalidation
  git(fx.work, ['reset', '--hard', 'HEAD~1']);
  writeFileSync(join(fx.work, 'data', 'factory-diagnostics.json'), '{"note":"local"}\n');
  r = runNodeScript(fx, 'factory-push.mjs', ['--message', 'diagnostics', '--revalidate', 'true', '--branch', 'main']);
  assert.equal(r.status, 0, (r.stdout || '') + (r.stderr || ''));
  remoteFiles = git(fx.bare, ['ls-tree', '-r', '--name-only', 'main']);
  assert.ok(remoteFiles.includes('data/factory-diagnostics.json'), 'the validated commit must reach origin');
});

test('T4 recover: interrupted committed publication completes idempotently; uncommitted promotion rolls back', (t) => {
  // A: the publication commit reached origin/main, finalize was interrupted
  const fxA = makeFixture(['bai-1']);
  cleanup(fxA, t);
  runFB(fxA, ['prepare-next', '--batch-size', '1'], 'runA');
  writeDraft(fxA, 'bai-1', 1);
  runFB(fxA, ['qa'], 'runA');
  runFB(fxA, ['assert-ready'], 'runA');
  assert.equal(runFB(fxA, ['publish'], 'runA').status, 0);
  git(fxA.work, ['add', '_posts']);
  git(fxA.work, ['commit', '-m', 'content: publish bai-1']);
  git(fxA.work, ['push', 'origin', 'main']);
  // crash before finalize-publish; recover must COMPLETE the publication
  let r = runFB(fxA, ['recover'], 'runA');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(state(fxA).rows[0].status, 'published');
  assert.equal(history(fxA).length, 1);
  assert.ok(!existsSync(join(fxA.work, 'data', 'factory-lock.json')), 'lock released after completion');
  // recover again: idempotent — no duplicate history entry
  r = runFB(fxA, ['recover'], 'runA');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(history(fxA).length, 1, 'recover must not duplicate history');
  // sync-manifest converges: write, dry-run green, second write is a no-op
  assert.equal(runNodeScript(fxA, 'sync-manifest.mjs', []).status, 0);
  const m1 = readFileSync(join(fxA.work, 'data', 'article-manifest.jsonl'), 'utf8');
  assert.equal(runNodeScript(fxA, 'sync-manifest.mjs', ['--dry-run']).status, 0, 'manifest must converge after recovery');
  assert.equal(runNodeScript(fxA, 'sync-manifest.mjs', []).status, 0);
  const m2 = readFileSync(join(fxA.work, 'data', 'article-manifest.jsonl'), 'utf8');
  assert.equal(m1, m2, 'a second sync must not change the manifest');
  assert.equal(manifestRows(fxA)[0].status, 'published');

  // B: the promotion was never committed -> recover rolls it back
  const fxB = makeFixture(['bai-1']);
  cleanup(fxB, t);
  runFB(fxB, ['prepare-next', '--batch-size', '1'], 'runA');
  writeDraft(fxB, 'bai-1', 1);
  runFB(fxB, ['qa'], 'runA');
  const rp4 = runFB(fxB, ['publish'], 'runA');
  assert.equal(rp4.status, 0, 'T4B publish must stage the ready draft:\n' + rp4.stdout + rp4.stderr);
  const postPathB = join(fxB.work, state(fxB).rows[0].post_file);
  assert.ok(existsSync(postPathB));
  r = runFB(fxB, ['recover'], 'runA');
  assert.equal(r.status, 0, r.stderr);
  assert.ok((r.stdout || '').includes('rolled back uncommitted promotion'), r.stdout);
  assert.ok(!existsSync(postPathB), 'the uncommitted post must leave _posts');
  assert.equal(state(fxB).rows[0].status, 'pass');
  const bB = state(fxB).batch;
  assert.ok(existsSync(join(fxB.work, '_drafts', bB, 'bai-1.md')), 'draft must be restored');
  assert.ok(!existsSync(join(fxB.work, 'data', 'factory-lock.json')), 'lock released after rollback');
});

test('T5 two workers: a fresh foreign lock blocks the second worker', (t) => {
  const fx = makeFixture(['bai-1', 'bai-2']);
  cleanup(fx, t);
  assert.equal(runFB(fx, ['prepare-next', '--batch-size', '2'], 'runA').status, 0);
  const before = readFileSync(join(fx.work, 'data', 'factory-state.json'), 'utf8');
  const r = runFB(fx, ['prepare-next', '--batch-size', '2'], 'runB');
  assert.notEqual(r.status, 0, 'worker B must be refused while run A holds a fresh lock');
  assert.ok((r.stderr || '').includes('valid active lock'), r.stderr);
  const after = readFileSync(join(fx.work, 'data', 'factory-state.json'), 'utf8');
  assert.equal(before, after, 'the refused worker must not touch factory state');
  // worker A keeps working under its own lock
  writeDraft(fx, 'bai-1', 1);
  writeDraft(fx, 'bai-2', 2);
  const rq5 = runFB(fx, ['qa'], 'runA');
  assert.equal(rq5.status, 0, 'the lock owner must keep working:\n' + rq5.stdout + rq5.stderr);
});

test('T6 sync-manifest: --require-committed, ghost hard error, front-matter reconcile', (t) => {
  // a) staged (working tree only) is NOT published; committed IS
  const fx = makeFixture(['bai-1']);
  cleanup(fx, t);
  writeFileSync(join(fx.work, '_posts', '2026-01-11-bai-1.md'), draftFile('bai-1', 1));
  let r = runNodeScript(fx, 'sync-manifest.mjs', ['--require-committed']);
  assert.equal(r.status, 0, r.stderr);
  assert.ok((r.stdout || '').includes('held'), 'the uncommitted post must be held, not published');
  assert.equal(manifestRows(fx)[0].status, 'planned', 'no fake published row for a staged post');
  git(fx.work, ['add', '_posts']);
  git(fx.work, ['commit', '-m', 'content: bai-1']);
  git(fx.work, ['push', 'origin', 'main']);
  r = runNodeScript(fx, 'sync-manifest.mjs', ['--require-committed']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(manifestRows(fx)[0].status, 'published', 'a post verified on origin/main is published');

  // b) a published manifest row without a post file is a hard error
  const rows = manifestRows(fx);
  rows.push({ id: 'T-901', slug: 'ma-bai-khong-ton-tai', status: 'published',
    primary_topic: 'chu de ma', search_intent: 'informational', cluster: 'T',
    parent_hub: '/hub/t/', entities: [], freshness: 'low',
    needs_official_source: false, similarity_group: null });
  writeFileSync(join(fx.work, 'data', 'article-manifest.jsonl'), rows.map(x => JSON.stringify(x)).join('\n') + '\n');
  r = runNodeScript(fx, 'sync-manifest.mjs', []);
  assert.notEqual(r.status, 0, 'a ghost published row is a hard error');
  assert.ok((r.stderr || '').includes('published but no post file exists'), r.stderr);

  // c) a real post on the remote that is missing from the manifest is
  //    reconciled from its own front matter
  const fx2 = makeFixture(['bai-1']);
  cleanup(fx2, t);
  writeFileSync(join(fx2.work, '_posts', '2026-01-12-bai-moi.md'), [
    '---',
    'title: "Bai viet da ton tai tren remote nhung thieu dong manifest"',
    'date: 2026-01-12',
    'legal_sensitivity: "true"',
    'manifest_id: "T-777"',
    '---',
    '',
    'Than phan bai viet da co tren remote.'
  ].join('\n') + '\n');
  git(fx2.work, ['add', '_posts']);
  git(fx2.work, ['commit', '-m', 'content: pre-existing post without a manifest row']);
  git(fx2.work, ['push', 'origin', 'main']);
  r = runNodeScript(fx2, 'sync-manifest.mjs', []);
  assert.equal(r.status, 0, r.stderr);
  const rec = manifestRows(fx2).find(x => x.slug === 'bai-moi');
  assert.ok(rec, 'the post must be reconciled into the manifest');
  assert.equal(rec.reconciled, true);
  assert.equal(rec.needs_official_source, true, 'legal_sensitivity propagates to needs_official_source');
  assert.equal(rec.id, 'bai-moi', 'a reconciled row takes the slug as its stable id');
  assert.equal(rec.status, 'published');
  assert.equal(runNodeScript(fx2, 'sync-manifest.mjs', ['--dry-run']).status, 0, 'reconciled manifest converges');
});

test('T7 benchmark: processes exactly the fixture corpus, never touches production data', (t) => {
  const outDir = mkdtempSync(join(tmpdir(), 'lab-bench-'));
  t.after(() => rmSync(outDir, { recursive: true, force: true }));
  const prodManifest = join(SRC, 'data', 'article-manifest.jsonl');
  const beforeManifest = readFileSync(prodManifest, 'utf8');
  const beforePosts = readdirSync(join(SRC, '_posts')).sort().join(',');
  const out = join(outDir, 'bench.json');
  const r = spawnSync(process.execPath, [join(SRC, 'scripts', 'benchmark-scale.mjs'), '--n', '30', '--out', out], {
    cwd: SRC, encoding: 'utf8'
  });
  assert.equal(r.status, 0, (r.stdout || '') + (r.stderr || ''));
  const idx = (r.stdout || '').indexOf('written:');
  const report = JSON.parse(idx === -1 ? r.stdout : r.stdout.slice(0, idx));
  const counted = report.measurements.filter(x => x.processed !== undefined);
  assert.equal(counted.length, 2, 'both child scripts must prove their processed count');
  for (const c of counted) assert.equal(c.processed, 30, 'each child must process exactly the 30 fixture articles');
  assert.ok(existsSync(out), 'the report must be written to the explicit --out path');
  JSON.parse(readFileSync(out, 'utf8'));
  // production data untouched
  assert.equal(readFileSync(prodManifest, 'utf8'), beforeManifest, 'production manifest must be untouched');
  assert.equal(readdirSync(join(SRC, '_posts')).sort().join(','), beforePosts, 'production _posts must be untouched');
});

// end of suite
