import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseFrontMatter } from './front-matter.mjs';
import { validatePost } from './validate-writer-post.mjs';

// Goc loi run 37318644251: validator khong doc duoc danh sach YAML trong front
// matter. Cac test nay chinh la cac format that writer dung (block list va
// inline list) phai parse SACH — khong con RED "dong khong parse duoc".

const BODY = [
  '',
  'Doan mo bai hop le, dai du de vuot moc do dai toi thieu cua validator.',
  '',
  '## Muc mot',
  '',
  'Noi dung muc mot, tham khao bai <a href="{{ \'guidelines\' | relative_url }}">huong dan</a> va <a href="{{ \'faq\' | relative_url }}">hoi dap</a> de co them chi tiet can thiet cho nguoi doc.',
  '',
  '## Muc hai',
  '',
  'Noi dung muc hai mo rong them cho du do dai: khi mot cell pin lithium bi va manh, mang chan bi te tai diem chim hoan, dong dien noi chay ngan mach trong tich tac nhiet tai dung cho mam. Nhiet phan huy dien li sinh khi, khi lam ap suat trong vo tang, cell phong roi vo. Chay nhiet lan sang cell lan can theo hieu ung day chuyen. Chay pin lithium khong can oxy tu ngoai nhu chay xang, vi cell tu chua ca chat chay lan chat hoa oxy trong chinh no, rot nuoc chi ha nhiet duoc mot phan. Voi dam chay pin, uu tien la dap tat nhiet day chuyen va co lap, de co quan chuyen dung xu ly. Nguoi di duong thuong khong lam duoc gi hon goi cuu hoa va giu khoang cach an toan.',
  '',
  'Bo sung them phan keo dai: khi mua xe may cu, nguoi mua nen kiem tra khoang may, so km da chay, giay to phap ly va nguon goc xe. Xe da tung tai nan lon co the bi gap khung, ha che do ben va gia tri ban lai. Truyen thong den va phanh can thu tren duong that de cam nhan do ben va tieng keu bat thuong. Ac quy va he thong dien cung can do de biet xe co bi de lau khong. Mot so xuong sua gia re voi gia thap hon thi truoc nhung chat luong phu tung va bao hanh kem, tinh ve lau dai khong toi. Nguoi ban trung thuong se de ban thu xe va kiem tra giay to ngay tai cho, khong han che thoi gian. Voi nguoi moi, nen di kem nguoi co kinh nghiem hoac chon xuong uy tin co danh gia cong khai.',
  '',
].join('\n');

const FILE_BLOCK_LIST = [
  '---',
  'layout: post',
  'title: "Bai viet co danh sach YAML trong front matter"',
  'date: 2026-10-05',
  'description: "Mo ta dai du nam muoi ky tu de hop le voi validator cua writer."',
  'id: bai-viet-co-danh-sach-yaml',
  'primary_keyword: "danh sach yaml"',
  'search_intent: informational',
  'cluster: C08',
  'batch: batch-2026-10-05',
  'manifest_id: C08-0032',
  'factory_writer: writer-1',
  'factory_cycle: cyc-test-1',
  'factory_base_sha: ' + 'a'.repeat(40),
  'entities:',
  '  - "mua sam"',
  '  - "Lan Ong"',
  'related_articles: []',
  'created_at: 2026-10-05',
  'updated_at: 2026-10-05',
  'freshness_status: evergreen',
  'legal_sensitivity: false',
  '---',
].join('\n') + '\n' + BODY;

test('parseFrontMatter: doc duoc danh sach YAML block list (- item) trong front matter', () => {
  const r = parseFrontMatter(FILE_BLOCK_LIST);
  assert.deepEqual(r.fm.entities, ['mua sam', 'Lan Ong']);
  assert.equal(r.issues.length, 0, 'khong con loi parse: ' + JSON.stringify(r.issues));
});

test('parseFrontMatter: doc duoc danh sach inline [a, "b"] va list rong []', () => {
  const r = parseFrontMatter('---\nlayout: post\nentities: ["Lan Ong", "mua sam"]\nrelated_articles: []\ntitle: "Tieu de test"\n---\n\nBody.\n');
  assert.deepEqual(r.fm.entities, ['Lan Ong', 'mua sam']);
  assert.deepEqual(r.fm.related_articles, []);
  assert.equal(r.fm.title, 'Tieu de test');
  assert.equal(r.fm.layout, 'post');
});

test('parseFrontMatter: scalar giu nguyen gia tri va strip quote', () => {
  const r = parseFrontMatter('---\ntitle: "Tieu de"\nid: slug-o-day\n---\n\nBody.\n');
  assert.equal(r.fm.title, 'Tieu de');
  assert.equal(r.fm.id, 'slug-o-day');
  assert.equal(r.body.startsWith('\nBody.'), true);
});

test('parseFrontMatter: dong rac van bi bat (issues khong rong)', () => {
  const r = parseFrontMatter('---\ntitle: "OK"\nkhoong phai key: ??\n---\n\nBody.\n');
  assert.equal(r.issues.length, 1);
  assert.match(r.issues[0], /khong parse duoc/);
});

test('validatePost: bai day du dung YAML list pass — khong RED "dong khong parse duoc"', () => {
  const issues = validatePost('_posts/2026-10-05-bai-viet-co-danh-sach-yaml.md', FILE_BLOCK_LIST, null);
  assert.equal(issues.length, 0, 'expected no issues, got: ' + JSON.stringify(issues));
});

test('validatePost: bai thieu noi dung van RED (gate khong yeu di sau fix parser)', () => {
  const bad = '---\ntitle: "Qua ngan"\ndate: 2026-10-05\nid: qua-ngan\n---\n\nIt qua.\n';
  const issues = validatePost('_posts/2026-10-05-qua-ngan.md', bad, null);
  assert.ok(issues.length > 0, 'gate noi dung phai van chan bai thieu');
});
