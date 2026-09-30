#!/usr/bin/env node
// validate-content-quality.test.mjs — regression tests for the content
// quality gate (node --test scripts/).
// Audit 2026-09-29: proves the documented fixes:
//   - a valid site page and a front-matter-less README are ACCEPTED
//   - real junk (underscore artifact, CJK, missing front matter on a site
//     page) is still BLOCKED
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'validate-content-quality.mjs');

function fixture(files) {
  const dir = mkdtempSync(join(tmpdir(), 'vcq-'));
  for (const [rel, content] of Object.entries(files)) {
    const p = join(dir, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, content);
  }
  return dir;
}

function run(dir) {
  return spawnSync('node', [SCRIPT], { cwd: dir, encoding: 'utf8' });
}

const VALID_PAGE = [
  '---',
  'layout: post',
  'title: "Bài viết hợp lệ"',
  'description: "Mô tả hợp lệ dùng để kiểm tra regression."',
  'permalink: /bai-viet-hop-le/',
  '---',
  '',
  'Đoạn văn hợp lệ. Dấu hiệu nhận biết viết thường, không có lỗi.',
  '',
  'Liên kết [đến trang khác](/lab/gioi-thieu/) và filter Liquid',
  '{{ \'/lab/faq/\' | relative_url }} đều không bị bắt là lỗi.',
  ''
].join('\n');

const README_NO_FM = [
  '# codeappweb/lab',
  '',
  'Tài liệu kỹ thuật. Không cần front matter.',
  '',
  '- File dữ liệu: `data/factory-state.json`',
  '- Filter Liquid: {{ \'/lab/x/\' | relative_url }}',
  '',
  '```js',
  'const some_var = { a_b: 1 }; // 中文注释 in code fence',
  '```',
  ''
].join('\n');

// README that names YAML fields and documents the validator's own
// "undefined" detection — must stay accepted (no false positives).
const README_DOCS_FIELDS = [
  '# codeappweb/lab',
  '',
  'Nguồn pháp lý ghi các trường (source_title, source_url, publisher,',
  'published_or_effective_date, fact, last_verified, applies_to).',
  'Validator phát hiện artifact "undefined" trong tên file và nội dung,',
  'thiếu description ở trang indexable, primary_keyword bị lỗi.',
  ''
].join('\n');

test('valid page + README without front matter are accepted', () => {
  const dir = fixture({
    '_posts/2026-01-01-bai-viet-hop-le.md': VALID_PAGE,
    'README.md': README_NO_FM
  });
  const r = run(dir);
  assert.equal(r.status, 0, 'expected exit 0, got:\n' + r.stdout + r.stderr);
  assert.match(r.stdout, /OK: no blocking issues/);
});

test('underscore artifact in real prose is blocked', () => {
  const bad = VALID_PAGE + '\nĐoạn rác: dau_hieu bat_thuong trong văn.\n';
  const dir = fixture({ '_posts/2026-01-01-bai-viet.md': bad });
  const r = run(dir);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /underscore artifact in prose/);
});

test('CJK artifact in real prose is blocked', () => {
  const bad = VALID_PAGE + '\nVăn rác：这里是中文文本。\n';
  const dir = fixture({ '_posts/2026-01-01-bai-viet.md': bad });
  const r = run(dir);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /CJK characters found in prose/);
});

test('site page without front matter is blocked', () => {
  const dir = fixture({ 'trang-le.md': 'Nội dung không có front matter.\n' });
  const r = run(dir);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /missing or malformed front matter/);
});

test('README with relative_url liquid filter is not flagged', () => {
  const dir = fixture({ 'README.md': README_NO_FM });
  const r = run(dir);
  assert.equal(r.status, 0, 'expected exit 0, got:\n' + r.stdout + r.stderr);
});

test('README naming YAML fields and the undefined detection is not flagged', () => {
  const dir = fixture({ 'README.md': README_DOCS_FIELDS });
  const r = run(dir);
  assert.equal(r.status, 0, 'expected exit 0, got:\n' + r.stdout + r.stderr);
});

test('CJK junk in README prose is still blocked', () => {
  const dir = fixture({ 'README.md': '# title\n\nVăn rác：这里是中文文本。\n' });
  const r = run(dir);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /CJK characters found in prose/);
});

test('underscore artifact in docs/ file prose is exempt, CJK is not', () => {
  // docs/ files are technical documentation: identifier-style words are fine
  const dir = fixture({ 'docs/ARCH.md': '# Kiến trúc\n\nTrường primary_keyword dùng cho SEO.\n' });
  const r = run(dir);
  assert.equal(r.status, 0, 'expected exit 0, got:\n' + r.stdout + r.stderr);
});
