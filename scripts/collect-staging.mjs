#!/usr/bin/env node
// collect-staging.mjs — snapshot cac nhanh staging/writer-K (READ-ONLY),
// kem che do --wait-for: cho du output cac writer cua cycle thay vi hard-code
// "sleep 30" (heuristic cu). Chay trong coordinator (production.yml) SAU khi
// da git fetch origin.
//
// --wait-for writer-1,writer-2 [--timeout <giay>]
//   Poll: git fetch origin roi kiem tra moi writer trong danh sach da co
//   thay doi _posts/*.md so voi origin/main. Ket thuc khi TAT CA writer da
//   push, hoac khi het timeout (mac dinh writer_wait_timeout_minutes tu
//   data/factory-config.json, 10 phut). TIMEOUT KHONG THE: tiep tuc voi cac
//   writer da kip push (partial-success policy) + canh bao; assignment cua
//   writer tre se duoc cap lai o chu ky sau (row khong bao gio bi danh
//   COMPLETE khi chua publish).
//
// Snapshot (voi moi writer-K co thay doi so voi origin/main, chi _posts/*.md):
//   - diff BA-CHAM (origin/main...sha = thay doi RIENG nhanh staging tu merge-base):
//     file giong het main KHONG dem; added = moi tren main, repaired = sua.
//   - Contamination guard: writer branch khac main CHI qua _posts/*.md,
//     bat ky file nao ngoai _posts/*.md => DIE (fail closed).
//   - Staging age: tip commit lon hon telemetry.staging_age_warn_minutes =>
//     ::warning:: (staging lau khong duoc reset/co writer tre).
// Ghi:
//   /tmp/scope.json       — { branches: [{name, sha, added:[], repaired:[]}] }
//   /tmp/reset-staging.sh — reset staging ve main HEAD sau khi publish, dung
//                           force-with-lease voi sha DA snapshot (khong bao
//                           gio clobber push moi cua writer).
// Xuat GITHUB_OUTPUT: noop=true khi khong nhanh nao co bai (idempotent).
import { readFileSync, existsSync, writeFileSync, appendFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = process.env.LAB_ROOT
  ? resolve(process.env.LAB_ROOT)
  : resolve(join(dirname(fileURLToPath(import.meta.url)), '..'));

function die(msg) {
  console.error('::error::' + msg);
  process.exit(1);
}
function git(args) {
  return spawnSync('git', args, { cwd: ROOT, encoding: 'utf8' });
}

let writers = 3;
let waitTimeoutSec = 600;
let ageWarnMin = 30;
const cfgPath = join(ROOT, 'data', 'factory-config.json');
if (existsSync(cfgPath)) {
  try {
    const c = JSON.parse(readFileSync(cfgPath, 'utf8'));
    if (Number.isInteger(c.writers) && c.writers > 0) writers = c.writers;
    if (Number.isInteger(c.writer_wait_timeout_minutes) && c.writer_wait_timeout_minutes > 0) {
      waitTimeoutSec = c.writer_wait_timeout_minutes * 60;
    }
    if (c.telemetry && Number.isInteger(c.telemetry.staging_age_warn_minutes) && c.telemetry.staging_age_warn_minutes > 0) {
      ageWarnMin = c.telemetry.staging_age_warn_minutes;
    }
  } catch (e) {
    die('data/factory-config.json khong hop le: ' + e.message);
  }
}

// ---- args ------------------------------------------------------------------
const args = process.argv.slice(2);
function opt(name) {
  const i = args.indexOf(name);
  return i !== -1 ? args[i + 1] : undefined;
}
const waitFor = opt('--wait-for');
const timeoutOpt = opt('--timeout');
if (timeoutOpt !== undefined) {
  const t = Number.parseInt(timeoutOpt, 10);
  if (!Number.isInteger(t) || t < 0) die('--timeout phai la so giay >= 0');
  waitTimeoutSec = t;
}

function writerHasPosts(name) {
  const rev = git(['rev-parse', '--verify', 'refs/remotes/origin/' + name]);
  if (rev.status !== 0) return false;
  const sha = (rev.stdout || '').trim();
  const changed = git(['diff', '--name-only', 'origin/main...' + sha, '--', '_posts/*.md']);
  if (changed.status !== 0) die('git diff that bai cho ' + name);
  return (changed.stdout || '').split('\n').map(s => s.trim()).filter(Boolean).length > 0;
}

// ---- optional wait for all expected writers ---------------------------------
if (waitFor !== undefined) {
  const expected = waitFor.split(',').map(s => s.trim()).filter(Boolean);
  const t0 = Date.now();
  let pending = expected.filter(w => !writerHasPosts(w));
  while (pending.length > 0 && (Date.now() - t0) / 1000 < waitTimeoutSec) {
    console.log('collect-staging: cho ' + pending.join(', ') + ' push bai len staging... (' +
      Math.round((Date.now() - t0) / 1000) + 's/' + waitTimeoutSec + 's)');
    spawnSync('git', ['fetch', 'origin', '--quiet'], { cwd: ROOT, stdio: 'ignore' });
    const sleep = spawnSync('sleep', ['15']);
    if (sleep.status !== 0) die('sleep that bai');
    pending = expected.filter(w => !writerHasPosts(w));
  }
  if (pending.length > 0) {
    console.log('::warning::het timeout ' + waitTimeoutSec + 's van thieu output: ' + pending.join(', ') +
      ' — tiep tuc voi cac writer da kip push (partial-success); assignment thieu duoc cap lai chu ky sau.');
  } else {
    console.log('collect-staging: du ' + expected.length + '/' + expected.length + ' writer push theo cycle (' +
      Math.round((Date.now() - t0) / 1000) + 's).');
  }
}

// ---- snapshot ---------------------------------------------------------------
const branches = [];
for (let k = 1; k <= writers; k++) {
  const name = 'staging/writer-' + k;
  const rev = git(['rev-parse', '--verify', 'refs/remotes/origin/' + name]);
  if (rev.status !== 0) continue; // nhanh chua ton tai — khong loi
  const sha = (rev.stdout || '').trim();
  // Staging age telemetry (do thuc te tu committer date cua tip).
  const ct = git(['show', '-s', '--format=%ct', sha]);
  if (ct.status === 0) {
    const ageSec = Math.floor(Date.now() / 1000) - Number((ct.stdout || '').trim());
    if (Number.isFinite(ageSec) && ageSec > ageWarnMin * 60) {
      console.log('::warning::' + name + ' tip (' + sha.slice(0, 8) + ') da ' + Math.round(ageSec / 60) +
        ' phut tuoi — vuot staging_age_warn_minutes=' + ageWarnMin + '; kiem tra writer tre hoac staging chua reset.');
    }
  }
  // Contamination guard: writer's OWN commits (tu merge-base) chi duoc cham _posts/*.md.
  // Ba-cham quan trong: staging o sau main (vd main co commit trigger/state moi)
  // KHONG bi coi la contamination — hai-cham truoc day lam coordinator fail khi
  // main di truoc staging (bug run 37017663482).
  const all = git(['diff', '--name-only', 'origin/main...' + sha]);
  if (all.status !== 0) die('git diff that bai cho ' + name);
  const stray = (all.stdout || '').split('\n').map(s => s.trim()).filter(Boolean).filter(p => !/^_posts\/[a-z0-9-]+\.md$/.test(p));
  if (stray.length) die('staging contamination tren ' + name + ': file ngoai _posts/*.md khac main (' + stray.join(', ') + ') — writer KHONG DUOC sua .github/scripts/data/sitemap; reset nhanh ve main HEAD truoc khi day bai.');
  // Ba-cham: chi file ma nhanh staging THUC SU tao/sua tu merge-base moi tinh.
  const changed = git(['diff', '--name-only', 'origin/main...' + sha, '--', '_posts/*.md']);
  if (changed.status !== 0) die('git diff that bai cho ' + name);
  const added = [];
  const repaired = [];
  for (const f of (changed.stdout || '').split('\n').map(s => s.trim()).filter(Boolean)) {
    const onMain = spawnSync('git', ['cat-file', '-e', 'origin/main:' + f], { cwd: ROOT }).status === 0;
    if (onMain) repaired.push(f); else added.push(f);
  }
  if (added.length || repaired.length) branches.push({ name, sha, added, repaired });
}

const noop = branches.length === 0;
writeFileSync('/tmp/scope.json', JSON.stringify({ branches }, null, 2) + '\n');
let sh = '#!/bin/sh\n# generated by collect-staging.mjs — reset staging da snapshot ve main HEAD\nset -eu\n';
for (const b of branches) {
  sh += 'echo "reset ' + b.name + ' (lease ' + b.sha.slice(0, 8) + ')..."\n';
  sh += 'git push --force-with-lease=refs/heads/' + b.name + ':' + b.sha + ' origin HEAD:refs/heads/' + b.name + '\n';
}
writeFileSync('/tmp/reset-staging.sh', sh);
if (process.env.GITHUB_OUTPUT) {
  appendFileSync(process.env.GITHUB_OUTPUT, 'noop=' + (noop ? 'true' : 'false') + '\n');
}
console.log('collect-staging: ' + (noop ? 'khong co bai tren staging — noop.' : branches.map(b => b.name + ' +' + b.added.length + ' moi, ~' + b.repaired.length + ' sua, @' + b.sha.slice(0, 8)).join(' | ')));
