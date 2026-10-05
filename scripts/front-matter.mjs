#!/usr/bin/env node
// front-matter.mjs — SHARED front matter parser cho writer / staging-signal /
// coordinator (goc loi run 37318644251: tung validator co parser rieng, khong
// doc duoc danh sach YAML trong front matter -> RED lan tra ve "front matter
// dong khong parse duoc: - ..." roi repair-agent classify "unclassified").
// MỘT parser duy nhat cho tat ca cac gate:
//   - scalar      : key: value (quote hai dau bi strip)
//   - inline list : key: [a, "b", c]        -> array string
//   - block list  : key:                                   -> array string
//                     - "item"
//   - dong khong parse duoc -> issues (caller quyet dinh RED hay chi canh bao)
// KHONG yeu cau dependency nao — dung chung cho validate-writer-post.mjs
// (staging-signal + production preflight) va validate-content-quality.mjs.
function stripQuotes(v) {
  return v.replace(/^["']|["']$/g, '');
}
function splitListItems(inner) {
  const out = [];
  let cur = '';
  let q = null;
  for (let k = 0; k < inner.length; k++) {
    const ch = inner[k];
    if (q) { if (ch === q) q = null; else cur += ch; continue; }
    if (ch === '"' || ch === "'") { q = ch; continue; }
    if (ch === ',') { out.push(cur.trim()); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim() !== '') out.push(cur.trim());
  return out;
}
export function parseFrontMatter(content) {
  if (content === null || content === undefined) return { fm: null, raw: '', body: '', issues: ['khong doc duoc noi dung'] };
  if (!content.startsWith('---\n')) return { fm: null, raw: '', body: content, issues: ['thieu front matter opening --- dong dau'] };
  const close = content.indexOf('\n---\n', 4);
  if (close === -1) return { fm: null, raw: '', body: '', issues: ['front matter khong dong bang ---'] };
  const fmText = content.slice(4, close);
  const body = content.slice(close + 5);
  const fm = {};
  const issues = [];
  const lines = fmText.split('\n');
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    const m = /^([a-z_][a-z0-9_]*):\s*(.*)$/.exec(line);
    if (!m) { issues.push('front matter dong khong parse duoc: ' + line.slice(0, 80)); i++; continue; }
    const key = m[1];
    const val = m[2].trim();
    if (val.startsWith('[') && val.endsWith(']')) {
      const inner = val.slice(1, -1).trim();
      fm[key] = inner === '' ? [] : splitListItems(inner);
      i++;
      continue;
    }
    if (val === '' || val === '|' || val === '>') {
      const items = [];
      let j = i + 1;
      while (j < lines.length) {
        const lm = /^(\s*)-\s+(.+)$/.exec(lines[j]);
        if (!lm) break;
        items.push(stripQuotes(lm[2].trim()));
        j++;
      }
      if (items.length) { fm[key] = items; i = j; continue; }
    }
    fm[key] = stripQuotes(val);
    i++;
  }
  return { fm, raw: fmText, body, issues };
}
export default parseFrontMatter;
