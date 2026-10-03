#!/usr/bin/env node
// publish-verify.mjs — xac nhan transaction publish THUC SU tren origin/main
// truoc khi deploy Pages + reset staging. Neu publication commit khong nam
// tren origin/main, hoac bat ky file snapshot khong byte-identical tren
// origin/main: DIE — deploy va reset DEU BI BLOCK, staging giu nguyen,
// khong mat bai (fix root-cause cyc-c050042: reset khi publish khong len).
import { readFileSync, existsSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = process.env.LAB_ROOT ? resolve(process.env.LAB_ROOT) : resolve(join(dirname(fileURLToPath(import.meta.url)), '..'));
function git(a) { return spawnSync('git', a, { cwd: ROOT, encoding: 'utf8' }); }
function die(msg) { console.log('::error::publish-verify: ' + msg); process.exit(1); }

function main() {
  const args = process.argv.slice(2);
  const opt = (n) => { const i = args.indexOf(n); return i !== -1 ? args[i + 1] : undefined; };
  const pub = opt('--publication-sha') || '';
  const scopePath = opt('--scope') || '/tmp/scope.json';
  if (!pub) die('thieu --publication-sha');
  if (!existsSync(scopePath)) die('khong tim thay scope snapshot ' + scopePath);
  if (git(['fetch', 'origin', 'main', '--quiet']).status !== 0) die('git fetch origin main that bai');
  if (git(['merge-base', '--is-ancestor', pub, 'origin/main']).status !== 0) {
    die('publication commit ' + pub.slice(0, 8) + ' KHONG nam tren origin/main — publish chua duoc push; BLOCK deploy + reset (staging giu nguyen).');
  }
  const scope = JSON.parse(readFileSync(scopePath, 'utf8'));
  let n = 0; const bad = [];
  for (const b of scope.branches || []) {
    for (const f of [].concat(b.added || [], b.repaired || [])) {
      n++;
      const mb = ((git(['rev-parse', '--verify', 'origin/main:' + f]).stdout || '')).trim();
      const sb = ((git(['rev-parse', '--verify', b.sha + ':' + f]).stdout || '')).trim();
      if (!mb) bad.push(f + ' (THIEU tren origin/main)');
      else if (mb !== sb) bad.push(f + ' (KHAC byte so voi snapshot staging)');
    }
  }
  if (bad.length) die('publish chua integrate dung: ' + bad.length + '/' + n + ' file: ' + bad.join('; ') + ' — BLOCK deploy + reset.');
  console.log('publish-verify: commit ' + pub.slice(0, 8) + ' nam tren origin/main; ' + n + ' file snapshot deu byte-identical — cho phep deploy + reset.');
}
const INVOKED = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (INVOKED) main();
