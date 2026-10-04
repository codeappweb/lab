import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { validatePost } from './validate-writer-post.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
const FENCE = String.fromCharCode(96, 96, 96);

test('production.yml: singleton publisher — mot publisher tai mot thoi diem, khong cancel giua chang', () => {
  const y = read('.github/workflows/production.yml');
  assert.match(y, /group:\s*production-coordinator/);
  assert.match(y, /cancel-in-progress:\s*false/);
});

test('production.yml: KHONG con reset staging blind — chi qua reset-staging-safe (verify truoc reset)', () => {
  const y = read('.github/workflows/production.yml');
  assert.ok(!y.includes('sh /tmp/reset-staging.sh'), 'van con lenh reset staging blind tu /tmp/reset-staging.sh');
  assert.match(y, /node scripts\/reset-staging-safe\.mjs/);
});

test('production.yml: preflight validation chay TRUOC guard (block bai hong truoc khi cham main)', () => {
  const y = read('.github/workflows/production.yml');
  const iVal = y.indexOf('validate-writer-post.mjs --from-scope');
  const iGuard = y.indexOf('node scripts/integrate-guard.mjs');
  assert.ok(iVal !== -1, 'thieu preflight validate-writer-post --from-scope');
  assert.ok(iGuard !== -1, 'thieu integrate-guard');
  assert.ok(iVal < iGuard);
});

test('production.yml: post-publish verify TRUOC deploy (block deploy + reset neu publish commit thieu)', () => {
  const y = read('.github/workflows/production.yml');
  const iVerify = y.indexOf('node scripts/publish-verify.mjs');
  const iDeploy = y.indexOf('POST /pages/builds');
  assert.ok(iVerify !== -1, 'thieu publish-verify');
  assert.ok(iDeploy !== -1);
  assert.ok(iVerify < iDeploy);
});

test('production.yml: record failure chep ca run cancelled (bug #283/#286: cancel khong ghi ledger)', () => {
  const y = read('.github/workflows/production.yml');
  assert.match(y, /if: failure\(\) \|\| cancelled\(\)/);
});

test('production.yml: pause gate (repair agent lock) truoc moi buoc production', () => {
  const y = read('.github/workflows/production.yml');
  const iPause = y.indexOf('node scripts/production-paused.mjs');
  const iCollect = y.indexOf('Collect staging snapshot');
  assert.ok(iPause !== -1, 'thieu pause gate production-paused.mjs');
  assert.ok(iCollect !== -1);
  assert.ok(iPause < iCollect);
});

test('staging-signal.yml: writer push duoc validate content (fail RED — writer tu fix roi push lai)', () => {
  const y = read('.github/workflows/staging-signal.yml');
  assert.match(y, /validate-writer-post\.mjs --ref/);
});

test('staging-signal.yml: KHONG deploy/push main tu staging context', () => {
  const y = read('.github/workflows/staging-signal.yml');
  assert.ok(!/pages\/builds|deploy-pages|git push/.test(y));
});

test('repair-agent.yml: singleton lock, KHONG poll (khong cron/schedule), trigger tu failure event', () => {
  const y = read('.github/workflows/repair-agent.yml');
  assert.match(y, /group:\s*repair-agent/);
  assert.match(y, /cancel-in-progress:\s*false/);
  assert.ok(!/^\s*schedule:/m.test(y), 'repair agent KHONG duoc poll theo lich (chi failure event)');
  assert.match(y, /workflow_run/);
});

test('repair-agent.yml: thu tu pause -> inspect -> repair -> regression -> resume; escalate giu pause', () => {
  const y = read('.github/workflows/repair-agent.yml');
  const iP = y.indexOf('--pause');
  const iI = y.indexOf('--inspect');
  const iR = y.indexOf('--repair');
  const iT = y.indexOf('node --test scripts/');
  const iV = y.indexOf('--resume');
  const iE = y.indexOf('--escalate');
  for (const x of [iI, iR, iT, iV, iE]) assert.ok(x !== -1);
  assert.ok(iP !== -1 && iP < iI && iI < iR && iR < iT && iT < iV, 'thu tu phai la pause -> inspect -> repair -> tests -> resume');
});

test('repair-playbook: mac dinh manual (unclear -> escalate, khong doan) + max 2 auto-repair cung signature', () => {
  const pb = JSON.parse(read('data/repair-playbook.json'));
  assert.equal(pb.default_class, 'manual');
  assert.equal(pb.max_auto_repair_per_signature, 2);
});

function mkPost(over) {
  over = over || {};
  const fm = {
    layout: 'post',
    title: 'Mua xe may cu vao mua he can luu y gi',
    date: '2026-10-03',
    description: 'Mua xe may cu vao mua he: nhung van de ve non lop, dong co va giay to can kiem tra ky truoc khi quyet dinh mua xe.',
    id: 'bai-mau-hop-le-cho-test',
    primary_keyword: 'mua xe may cu',
    search_intent: 'how-to',
    cluster: 'C08',
    batch: 'batch-2026-10-03',
    manifest_id: 'C08-0021',
    factory_writer: 'writer-1',
    factory_cycle: 'cyc-c050042',
    factory_base_sha: '313a243942a366ed005b514d3aacd0885450d4e4',
    created_at: '2026-10-03',
    updated_at: '2026-10-03'
  };
  Object.assign(fm, over.fm || {});
  const fmText = Object.entries(fm).map(([k, v]) => k + ': ' + (String(v).indexOf(' ') !== -1 ? JSON.stringify(v) : v)).join('\n');
  const body = (over.body !== undefined) ? over.body : [
    'Doan mo dau du do dai cho bai mau: mua xe may cu vao mua he khac voi mua dong — non nhanh mo, lop mem hon, dong co de chay qua nong. Can kiem tra ky dong co, he thong phanh, khung xe va giay to truoc khi tra tien.',
    '',
    '## Kiem tra dong co',
    '',
    'Khoi dong lan dau de nghe tieng dong co, kiem tra khi non va tieng o cam. Xem them <a href="{{ \'nhot-lap-xe-ga-thay-khi-nao-la-dung/\' | relative_url }}">nhot xe ga</a> va <a href="{{ \'lop-xe-xi-giua-duong-dung-xe-an-toan-tung-buoc/\' | relative_url }}">su co lop</a> de hieu cach bao quan phu tung.',
    '',
    '## Kiem tra giam xoc va phanh',
    '',
    'Thu xe tren duong loi nhon, dan hang, nghe tieng kim loai va kiem tra phanh khi tai nhe. Ket thuc bai viet mau hop le cho muc dich test unit.'
  ].join('\n');
  return '---\n' + fmText + '\n---\n\n' + body + '\n' + (over.tail || '');
}
const P = '_posts/2026-10-03-bai-mau-hop-le-cho-test.md';

test('validatePost: bai hop le — khong co issue', () => {
  const issues = validatePost(P, mkPost());
  assert.deepEqual(issues, []);
});
test('validatePost: nhiem CJK bi chan (khong dich may sang tieng Trung/Nhat)', () => {
  const c = mkPost({ tail: '\nMot doan rac chua ky tu CJK: 車検とバイクの整備。\n' });
  assert.ok(validatePost(P, c).some((i) => i.includes('CJK')));
});
test('validatePost: token undefined (syntax garbage) bi chan', () => {
  const c = mkPost({ tail: '\nGia tri undefined rac trong bai.\n' });
  assert.ok(validatePost(P, c).some((i) => i.includes('undefined')));
});
test('validatePost: code fence le bi chan', () => {
  const c = mkPost({ tail: '\n' + FENCE + 'js\nconst x = 1;\n' });
  assert.ok(validatePost(P, c).some((i) => i.includes('fence')));
});
test('validatePost: thieu muc ## bi chan', () => {
  const c = mkPost({ body: 'Doan mo dai du do dai cho bai mau, khong co muc ## nao trong body nay ca. <a href="{{ \'a-bai-da-xuat-ban-1/\' | relative_url }}">link 1</a> va <a href="{{ \'a-bai-da-xuat-ban-2/\' | relative_url }}">link 2</a> duoc viet dai ra de vuot nguong do dai toi thieu cua bai viet mau trong test.' });
  assert.ok(validatePost(P, c).some((i) => i.includes('## ')));
});
test('validatePost: it link noi boi bi chan', () => {
  const c = mkPost({ body: ['Doan mo dai, dong lai cho bai viet mau du do dai.', '', '## Muc mot', '', 'Khong co link nao o day.', '', '## Muc hai', '', 'Van khong co link noi boi nao trong body.'].join('\n') });
  assert.ok(validatePost(P, c).some((i) => i.includes('link noi boi')));
});
test('validatePost: sai factory_cycle so voi cycle hien tai bi chan', () => {
  const ctx = { cycleId: 'cyc-c050042', baseSha: '313a243942a366ed005b514d3aacd0885450d4e4', assignmentIds: ['C08-0021'], assignmentSlugs: ['bai-mau-hop-le-cho-test'], writerById: { 'C08-0021': 'writer-1' } };
  const c = mkPost({ fm: { factory_cycle: 'cyc-KHAC' } });
  assert.ok(validatePost(P, c, ctx).some((i) => i.includes('factory_cycle')));
});
test('validatePost: id khong khop filename bi chan', () => {
  const c = mkPost({ fm: { id: 'id-khac-filename' } });
  assert.ok(validatePost(P, c).some((i) => i.includes('khong khop slug')));
});
test('validatePost: manifest_id ngoai assignment cua cycle bi chan', () => {
  const ctx = { cycleId: 'cyc-c050042', baseSha: '313a243942a366ed005b514d3aacd0885450d4e4', assignmentIds: ['C99-9999'], assignmentSlugs: [], writerById: {} };
  assert.ok(validatePost(P, mkPost(), ctx).some((i) => i.includes('manifest_id khong nam trong assignment')));
});
test('validatePost: thieu metadata factory bi chan', () => {
  const c = mkPost({ fm: { manifest_id: '' } });
  assert.ok(validatePost(P, c).some((i) => i.includes('manifest_id')));
});

function gitIn(cwd, args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error('git ' + args.join(' ') + ' failed: ' + (r.stderr || ''));
  return (r.stdout || '').trim();
}
function mkfile(dir, rel, text) {
  const p = join(dir, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, text);
}
function setupFixture() {
  const dir = mkdtempSync(join(tmpdir(), 'rst-safe-'));
  const origin = join(dir, 'origin.git');
  const w = join(dir, 'work');
  spawnSync('git', ['init', '--bare', '-b', 'main', origin]);
  spawnSync('git', ['init', '-b', 'main', w]);
  gitIn(w, ['config', 'user.email', 'test@example.com']);
  gitIn(w, ['config', 'user.name', 'test']);
  gitIn(w, ['remote', 'add', 'origin', origin]);
  mkfile(w, '_posts/2026-10-03-co-so.md', '---\nid: co-so\n---\nbase');
  gitIn(w, ['add', '-A']);
  gitIn(w, ['commit', '-m', 'main base']);
  gitIn(w, ['push', 'origin', 'HEAD:refs/heads/main']);
  gitIn(w, ['checkout', '-b', 'staging/writer-1']);
  mkfile(w, '_posts/2026-10-03-moi.md', '---\nid: moi\n---\nwriter post');
  gitIn(w, ['add', '-A']);
  gitIn(w, ['commit', '-m', 'writer post']);
  gitIn(w, ['push', 'origin', 'HEAD:refs/heads/staging/writer-1']);
  const stagingSha = gitIn(w, ['rev-parse', 'HEAD']);
  gitIn(w, ['checkout', 'main']);
  gitIn(w, ['fetch', 'origin']);
  return { dir, w, origin, stagingSha };
}
function publishWriterFile(f) {
  gitIn(f.w, ['checkout', 'origin/staging/writer-1', '--', '_posts/2026-10-03-moi.md']);
  gitIn(f.w, ['add', '-A']);
  gitIn(f.w, ['commit', '-m', 'publish(integrated)']);
  gitIn(f.w, ['push', 'origin', 'HEAD:refs/heads/main']);
  gitIn(f.w, ['fetch', 'origin']);
}
function runSafe(w, scope) {
  const scopePath = join(w, 'scope-test.json');
  writeFileSync(scopePath, JSON.stringify({ branches: scope }));
  return spawnSync(process.execPath, [join(ROOT, 'scripts', 'reset-staging-safe.mjs'), '--scope', scopePath], { cwd: w, encoding: 'utf8', env: Object.assign({}, process.env, { LAB_ROOT: w }) });
}
const SC = (f) => [{ name: 'staging/writer-1', sha: f.stagingSha, added: ['_posts/2026-10-03-moi.md'], repaired: [] }];

test('reset-staging-safe: file DA byte-identical tren main -> reset OK', () => {
  const f = setupFixture();
  publishWriterFile(f);
  const r = runSafe(f.w, SC(f));
  assert.equal(r.status, 0, 'exit 0: ' + r.stdout + r.stderr);
  gitIn(f.w, ['fetch', 'origin']);
  const tip = gitIn(f.w, ['rev-parse', 'origin/staging/writer-1']);
  const mainTip = gitIn(f.w, ['rev-parse', 'origin/main']);
  assert.equal(tip, mainTip, 'staging phai ve main HEAD sau khi verify OK');
});
test('reset-staging-safe: file CHUA integrate -> QUARANTINE, khong reset (khong mat bai)', () => {
  const f = setupFixture();
  const r = runSafe(f.w, SC(f));
  assert.equal(r.status, 0);
  assert.match(r.stdout, /QUARANTINE/);
  gitIn(f.w, ['fetch', 'origin']);
  const tip = gitIn(f.w, ['rev-parse', 'origin/staging/writer-1']);
  assert.equal(tip, f.stagingSha, 'staging PHAI GIU NGUYEN khi bai chua integrate');
});
test('reset-staging-safe: tip da DOI (writer push moi) -> SKIP, khong clobber', () => {
  const f = setupFixture();
  publishWriterFile(f);
  gitIn(f.w, ['checkout', 'staging/writer-1']);
  mkfile(f.w, '_posts/2026-10-03-thu-hai.md', '---\nid: thu-hai\n---\nwriter push them');
  gitIn(f.w, ['add', '-A']);
  gitIn(f.w, ['commit', '-m', 'writer push moi sau snapshot']);
  gitIn(f.w, ['push', 'origin', 'HEAD:refs/heads/staging/writer-1']);

  const moved = gitIn(f.w, ['rev-parse', 'HEAD']);
  gitIn(f.w, ['checkout', 'main']);
  gitIn(f.w, ['fetch', 'origin']);
  const r = runSafe(f.w, SC(f));
  assert.equal(r.status, 0);
  assert.match(r.stdout, /SKIP/);
  gitIn(f.w, ['fetch', 'origin']);
  const tip = gitIn(f.w, ['rev-parse', 'origin/staging/writer-1']);
  assert.equal(tip, moved, 'push moi cua writer KHONG bi clobber');
});

test('production-paused: paused -> exit 1; khong -> exit 0; --is-paused dao nguoc', () => {
  const dir = mkdtempSync(join(tmpdir(), 'paused-'));
  mkfile(dir, 'data/production-state.json', JSON.stringify({ paused: true, paused_by: 'repair-agent' }));
  const run = (extra) => spawnSync(process.execPath, [join(ROOT, 'scripts', 'production-paused.mjs')].concat(extra || []), { encoding: 'utf8', env: Object.assign({}, process.env, { LAB_ROOT: dir }) });
  assert.equal(run().status, 1, 'paused phai chan production (exit 1)');
  assert.equal(run(['--is-paused']).status, 0, '--is-paused = 0 khi paused');
  writeFileSync(join(dir, 'data', 'production-state.json'), JSON.stringify({ paused: false }));
  assert.equal(run().status, 0);
  assert.equal(run(['--is-paused']).status, 1);
});

test('recovery cyc-c050042: du 18 bai verbatim, manifest_id khop assignment, metadata factory nguyen', () => {
  const rec = JSON.parse(read('recovery/cyc-c050042/posts.json'));
  const cyc = JSON.parse(read('recovery/cyc-c050042/factory-cycle.json'));
  assert.equal(cyc.cycle_id, 'cyc-c050042');
  const ids = Object.values(cyc.assignments || {}).flat();
  assert.equal(ids.length, 18);
  assert.equal(rec.posts.length, 18);
  const wa = JSON.parse(read('recovery/cyc-c050042/writer-assignments.json'));
  assert.equal(wa.cycle_id, 'cyc-c050042');
  const writerById = {}; const slugById = {};
  for (const [w, rows] of Object.entries(wa.writers || {})) {
    for (const row of rows || []) { writerById[row.id] = w; slugById[row.id] = row.slug; }
  }
  assert.equal(Object.keys(writerById).length, 18);
  const recovered = new Set();
  for (const p of rec.posts) {
    assert.ok(p.path.startsWith('_posts/2026-10-03-'), 'path le: ' + p.path);
    const slug = p.path.replace(/^_posts\/2026-10-03-/, '').replace(/\.md$/, '');
    const fmId = /\nid: ([a-z0-9-]+)\n/.exec(p.content);
    assert.ok(fmId && fmId[1] === slug, 'id front matter khong khop slug path: ' + slug);
    const mid = /manifest_id: ?\"?([A-Z]\d{2}-\d{3,5})\"?/.exec(p.content);
    assert.ok(mid, 'thieu manifest_id: ' + slug);
    assert.ok(ids.includes(mid[1]), 'manifest_id khong nam trong assignment: ' + mid[1]);
    assert.equal(slugById[mid[1]], slug, 'slug khong khop assignment ' + mid[1]);
    const w = writerById[mid[1]];
    assert.ok(w, 'khong tim thay writer cho assignment ' + mid[1]);
    assert.equal(p.writer, w, 'writer khong khop assignment: ' + slug + ' (' + p.writer + ' != ' + w + ')');
    recovered.add(mid[1]);
    assert.ok(p.content.startsWith('---\n'), 'front matter hong: ' + slug);
    assert.ok(p.content.includes('factory_cycle: cyc-c050042'), 'sai factory_cycle: ' + slug);
    assert.ok(p.content.length > 1000, 'noi dung qua ngan: ' + slug);
    assert.ok(!/[\u3400-\u4dbf\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/.test(p.content), 'nhiem CJK: ' + slug);
  }
  for (const id of ids) assert.ok(recovered.has(id), 'thieu bai recovered cho assignment ' + id);
  assert.equal(recovered.size, 18);
});
