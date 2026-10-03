#!/usr/bin/env node
// production-paused.mjs — pause gate cho production.yml (buoc 0a). Repair
// agent giu maintenance lock qua data/production-state.json (paused=true):
//   - khong co arg   : exit 1 kem ::error:: neu dang paused (production DUNG),
//                      exit 0 neu khong (cho phep production chay binh thuong).
//   - --is-paused    : exit 0 neu paused, exit 1 neu khong (dung trong 'if',
//                      vi du: Record failure skip ghi ledger khi paused).
import { readFileSync, existsSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = process.env.LAB_ROOT ? resolve(process.env.LAB_ROOT) : resolve(join(dirname(fileURLToPath(import.meta.url)), '..'));
const p = join(ROOT, 'data', 'production-state.json');
let st = null;
if (existsSync(p)) { try { st = JSON.parse(readFileSync(p, 'utf8')); } catch (e) { st = null; } }
const isPaused = !!(st && st.paused === true);
if (process.argv.includes('--is-paused')) process.exit(isPaused ? 0 : 1);
if (isPaused) {
  console.log('::error::Production DANG PAUSED boi ' + (st.paused_by || '?') + ' (tu ' + (st.paused_at || '?') + '; reason: ' + (st.reason || 'na') + ') — repair agent dang giu maintenance lock. KHONG chay cycle moi.');
  process.exit(1);
}
console.log('production-paused: khong co maintenance lock — cho phep production.');
process.exit(0);
