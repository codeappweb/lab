#!/usr/bin/env node
// validate-writer-post.mjs — PRE-PUSH content validation cho writer output.
//   Chan TRUOC khi bai vao main: syntax garbage (token undefined, code fence
//   le), nhiem CJK (ky tu Trung/Nhat/Han — dich tieu de la tieng Viet),
//   front matter hong / thieu metadata factory, id khong khop filename,
//   sai cycle/base_sha, it link noi boi, it muc ##.
//   Cach dung:
//     --from-scope                 (publisher: doc /tmp/scope.json, git show tung snapshot)
//     --ref <sha> --base <ref>     (staging-signal: diff base...ref trong _posts/*.md)
//     --file <path>                (local: validate 1 file)
//   Fail = exit 1 RED: staging GIU NGUYEN; writer tu fix content roi push lai.
import { readFileSync, existsSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = process.env.LAB_ROOT ? resolve(process.env.LAB_ROOT) : resolve(join(dirname(fileURLToPath(import.meta.url)), '..'));
const FENCE = String.fromCharCode(96, 96, 96);
const CJK = /[\u3001-\u303f\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af\uff01-\uff60]/;
const REQUIRED_KEYS = ['layout', 'title', 'date', 'description', 'id', 'manifest_id', 'factory_writer', 'factory_cycle', 'factory_base_sha'];

function parseFrontMatter(content) {
  if (content === null || content === undefined) return { fm: null, body: '', issues: ['khong doc duoc noi dung'] };
  if (!content.startsWith('---\n')) return { fm: null, body: content, issues: ['thieu front matter opening --- dong dau'] };
  const close = content.indexOf('\n---\n', 4);
  if (close === -1) return { fm: null, body: '', issues: ['front matter khong dong bang ---'] };
  const fmText = content.slice(4, close);
  const body = content.slice(close + 5);
  const fm = {}; const issues = [];
  for (const line of fmText.split('\n')) {
    const m = /^([a-z_][a-z0-9_]*):\s*(.*)$/.exec(line);
    if (m) fm[m[1]] = m[2].replace(/^["']|["']$/g, '').trim();
    else if (line.trim()) issues.push('front matter dong khong parse duoc: ' + line.slice(0, 80));
  }
  return { fm, body, issues };
}

function validatePost(relPath, content, ctx) {
  const issues = [];
  if (content === null || content === undefined) return ['khong doc duoc noi dung tu git'];
  const base = String(relPath).split('/').pop();
  const m = /^(\d{4}-\d{2}-\d{2})-([a-z0-9-]+)\.md$/.exec(base);
  if (!m) issues.push('ten file khong dung format _posts/YYYY-MM-DD-slug.md: ' + base);
  const parsed = parseFrontMatter(content);
  issues.push(...parsed.issues);
  const fm = parsed.fm; const body = parsed.body;
  if (fm) {
    for (const k of REQUIRED_KEYS) if (!fm[k] || fm[k] === 'undefined') issues.push('front matter thieu/gia tri rong: ' + k);
    if (m && fm.id && fm.id !== m[2]) issues.push('id (' + fm.id + ') khong khop slug trong filename (' + m[2] + ')');
    if (m && fm.date && fm.date !== m[1]) issues.push('date (' + fm.date + ') khong khop ngay trong filename (' + m[1] + ')');
    if (fm.factory_base_sha && !/^[0-9a-f]{40}$/.test(fm.factory_base_sha)) issues.push('factory_base_sha khong phai sha40: ' + fm.factory_base_sha);
    if (fm.manifest_id && !/^[A-Z]\d{2}-\d{3,5}$/.test(fm.manifest_id)) issues.push('manifest_id sai format (vd C08-0021): ' + fm.manifest_id);
    const d = (fm.description || '').length;
    if (fm.description && (d < 50 || d > 400)) issues.push('description do dai ' + d + ' ngoai khoang 50-400');
    const t = (fm.title || '').length;
    if (fm.title && (t < 10 || t > 120)) issues.push('title do dai ' + t + ' ngoai khoang 10-120');
    if (ctx && ctx.cycleId && fm.factory_cycle && fm.factory_cycle !== ctx.cycleId) issues.push('factory_cycle (' + fm.factory_cycle + ') != cycle hien tai (' + ctx.cycleId + ')');
    if (ctx && ctx.baseSha && fm.factory_base_sha && fm.factory_base_sha !== ctx.baseSha) issues.push('factory_base_sha khong khop base_sha cua cycle');
    if (ctx && ctx.assignmentIds && fm.id && !ctx.assignmentIds.includes(fm.id)) issues.push('id khong nam trong assignment cua cycle: ' + fm.id);
  }
  if (CJK.test(content)) issues.push('nhiem ky tu CJK (Trung/Nhat/Han) — dich tieu de tieng Viet, khong CJK');
  if (/\bundefined\b/.test(content)) issues.push('chua token undefined (metadata/body rac)');
  const fenceLines = content.split('\n').filter((l) => l.startsWith(FENCE)).length;
  if (fenceLines % 2 !== 0) issues.push('code fence khong can (' + fenceLines + ' fence lines)');
  const h2 = body.split('\n').filter((l) => l.startsWith('## ')).length;
  if (h2 < 2) issues.push('it hon 2 muc ## (co ' + h2 + ')');
  const links = (body.match(/href="\{\{[^}]*relative_url\s*\}\}"/g) || []).length;
  if (links < 2) issues.push('it hon 2 link noi boi liquid relative_url (co ' + links + ')');
  if (content.length < 1000) issues.push('noi dung qua ngan (' + content.length + ' < 1000 ky tu)');
  return issues;
}

function loadCtx() {
  try {
    const cyc = JSON.parse(readFileSync(join(ROOT, 'data', 'factory-cycle.json'), 'utf8'));
    if (!['idle', 'complete', 'failed'].includes(cyc.phase)) {
      const ids = Object.values(cyc.assignments || {}).flat();
      return { cycleId: cyc.cycle_id, baseSha: cyc.base_sha, assignmentIds: ids };
    }
  } catch (e) {}
  return null;
}

function gitShow(spec) {
  const r = spawnSync('git', ['show', spec], { cwd: ROOT, encoding: 'utf8' });
  return r.status === 0 ? r.stdout : null;
}

function runCLI() {
  const args = process.argv.slice(2);
  const opt = (n) => { const i = args.indexOf(n); return i !== -1 ? args[i + 1] : undefined; };
  const ctx = loadCtx();
  const targets = [];
  if (args.includes('--from-scope')) {
    const scopePath = opt('--scope') || '/tmp/scope.json';
    if (!existsSync(scopePath)) { console.log('validate-writer-post: khong co scope — khong co gi de validate.'); process.exit(0); }
    const scope = JSON.parse(readFileSync(scopePath, 'utf8'));
    for (const b of scope.branches || []) {
      for (const f of [].concat(b.added || [], b.repaired || [])) targets.push({ path: f, content: gitShow(b.sha + ':' + f) });
    }
  } else if (opt('--ref')) {
    const ref = opt('--ref');
    const base = opt('--base') || 'origin/main';
    const list = spawnSync('git', ['diff', '--name-only', base + '...' + ref, '--', '_posts/*.md'], { cwd: ROOT, encoding: 'utf8' });
    if (list.status !== 0) { console.log('::error::validate-writer-post: git diff that bai'); process.exit(1); }
    for (const f of (list.stdout || '').split('\n').map((s) => s.trim()).filter(Boolean)) targets.push({ path: f, content: gitShow(ref + ':' + f) });
  } else if (opt('--file')) {
    const p = opt('--file');
    try { targets.push({ path: p, content: readFileSync(resolve(ROOT, p), 'utf8') }); } catch (e) { console.log('::error::khong doc duoc ' + p); process.exit(1); }
  } else {
    console.log('validate-writer-post: can --from-scope | --ref <sha> --base <ref> | --file <path>');
    process.exit(1);
  }
  if (targets.length === 0) { console.log('validate-writer-post: khong co file _posts moi — pass.'); process.exit(0); }
  let bad = 0;
  for (const t of targets) {
    const issues = validatePost(t.path, t.content, ctx);
    if (issues.length) { bad++; for (const i of issues) console.log('::error::' + t.path + ': ' + i); }
    else console.log('validate-writer-post: OK ' + t.path);
  }
  if (bad > 0) { console.log('::error::' + bad + '/' + targets.length + ' file KHONG hop le — BLOCK. Staging giu nguyen; writer tu fix content roi push lai.'); process.exit(1); }
  console.log('validate-writer-post: ' + targets.length + ' file hop le.');
}
const INVOKED = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (INVOKED) runCLI();

export { validatePost, parseFrontMatter };
