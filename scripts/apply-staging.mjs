#!/usr/bin/env node
// apply-staging.mjs — dua cac bai da pass guard vao working tree tu staging.
// Doc /tmp/integrate.json; moi file: git checkout <sha-nhanh> -- <file>.
// KHONG commit o day — publish-loop.mjs lam transaction (derive + gate +
// build + MÔT commit).
import { readFileSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = process.env.LAB_ROOT
  ? resolve(process.env.LAB_ROOT)
  : resolve(join(dirname(fileURLToPath(import.meta.url)), '..'));

function die(msg) {
  console.error('::error::' + msg);
  process.exit(1);
}

const plan = JSON.parse(readFileSync('/tmp/integrate.json', 'utf8'));
if (plan.noop) {
  console.log('apply-staging: noop — khong co bai de tich hop.');
  process.exit(0);
}
let n = 0;
for (const a of plan.apply) {
  for (const f of a.files) {
    const r = spawnSync('git', ['checkout', a.sha, '--', f], { cwd: ROOT, stdio: 'inherit' });
    if (r.status !== 0) die('khong checkout duoc ' + f + ' tu ' + a.name);
    n++;
  }
}
console.log('apply-staging: ' + n + ' bai da dua vao working tree tu staging.');