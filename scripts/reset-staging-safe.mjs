#!/usr/bin/env node
// reset-staging-safe.mjs — reset staging DA CHUNG CHI: mot nhanh staging chi
// duoc reset ve main HEAD khi (a) tip origin van bang sha da snapshot (khong co
// push moi cua writer), VA (b) TAT CA file snapshot da ton tai byte-identical
// tren origin/main. Neu tip da doi -> SKIP (bao ve push moi). Neu file chua
// duoc integrate -> QUARANTINE: KHONG reset, canh bao, exit 0 (bai KHONG BAO
// GIO bi xoa khi publish commit that bai — fix bug cyc-c050042: force-reset
// staging khi khong co publish commit). Doc /tmp/scope.json (collect-staging).
import { readFileSync, existsSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = process.env.LAB_ROOT ? resolve(process.env.LAB_ROOT) : resolve(join(dirname(fileURLToPath(import.meta.url)), '..'));
function git(a) { return spawnSync('git', a, { cwd: ROOT, encoding: 'utf8' }); }

function main() {
  const args = process.argv.slice(2);
  const opt = (n) => { const i = args.indexOf(n); return i !== -1 ? args[i + 1] : undefined; };
  const scopePath = opt('--scope') || '/tmp/scope.json';
  if (!existsSync(scopePath)) { console.log('reset-staging-safe: khong co scope snapshot — khong co gi de reset.'); process.exit(0); }
  const scope = JSON.parse(readFileSync(scopePath, 'utf8'));
  if (git(['fetch', 'origin', '+refs/heads/staging/*:refs/remotes/origin/staging/*', '--quiet']).status !== 0) {
    console.log('::warning::reset-staging-safe: fetch staging that bai — KHONG reset gi (an toan hon la de nguyen).'); process.exit(0);
  }
  let reset = 0, skipped = 0, quarantined = 0;
  for (const b of scope.branches || []) {
    const cur = ((git(['rev-parse', '--verify', 'refs/remotes/origin/' + b.name]).stdout || '')).trim();
    if (!cur || cur !== b.sha) {
      console.log('::warning::' + b.name + ': tip da doi (' + (cur || '?').slice(0, 8) + ' != snapshot ' + b.sha.slice(0, 8) + ') — SKIP reset (bao ve push moi cua writer).');
      skipped++; continue;
    }
    const files = [].concat(b.added || [], b.repaired || []);
    const unmerged = [];
    for (const f of files) {
      const mb = ((git(['rev-parse', '--verify', 'origin/main:' + f]).stdout || '')).trim();
      const sb = ((git(['rev-parse', '--verify', b.sha + ':' + f]).stdout || '')).trim();
      if (!mb || mb !== sb) unmerged.push(f);
    }
    if (unmerged.length) {
      console.log('::warning::QUARANTINE ' + b.name + ': ' + unmerged.length + '/' + files.length + ' file snapshot CHUA byte-identical tren origin/main — KHONG reset (giu bai writer): ' + unmerged.join(', '));
      quarantined++; continue;
    }
    const r = git(['push', '--force-with-lease=refs/heads/' + b.name + ':' + b.sha, 'origin', 'HEAD:refs/heads/' + b.name]);
    if (r.status !== 0) { console.log('::warning::reset ' + b.name + ' that bai (lease/lock) — de nguyen, chu ky sau xu ly.'); skipped++; continue; }
    console.log('reset-staging-safe: ' + b.name + ' -> main HEAD (da verify ' + files.length + ' file byte-identical tren origin/main).');
    reset++;
  }
  console.log('reset-staging-safe: ' + reset + ' reset, ' + skipped + ' skip, ' + quarantined + ' quarantine.');
}
const INVOKED = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (INVOKED) main();
