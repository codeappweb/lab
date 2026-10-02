import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('../queue-refill.mjs', import.meta.url));
const CFG = { queue_refill: { low_threshold: 4, target: 6 } };
const CL = {
  C01: { name: 'c1', budget: 10, desc: 'd', hub_path: '/hub/c01/' },
  C02: { name: 'c2', budget: 10, desc: 'd', hub_path: '/hub/c02/' }
};
const row = (id, status, topic, slug, cluster, ents, intent) => JSON.stringify({
  id, cluster, status, primary_topic: topic, search_intent: intent || 'informational',
  title: '', slug, parent_hub: '/hub/' + cluster.toLowerCase() + '/',
  entities: ents, freshness: 'low', needs_official_source: false,
  similarity_group: cluster + '-core', source_plan: [], internal_links: [], published_url: null
});
const tpl = (topic, slug, intent, e1, e2) => ({ topic, slug, intent, entities: [e1, e2] });

function fixture(templates, manifest, clusters, cfg) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qr-'));
  fs.mkdirSync(path.join(root, 'data'), { recursive: true });
  fs.writeFileSync(path.join(root, 'data/factory-config.json'), JSON.stringify(cfg || CFG, null, 2));
  fs.writeFileSync(path.join(root, 'data/cluster-map.json'), JSON.stringify(clusters || CL, null, 2));
  fs.writeFileSync(path.join(root, 'data/queue-templates.json'), JSON.stringify(templates, null, 2));
  fs.writeFileSync(path.join(root, 'data/article-manifest.jsonl'), manifest);
  return root;
}
const run = (root) => {
  const r = spawnSync(process.execPath, [SCRIPT], {
    env: Object.assign({}, process.env, { LAB_ROOT: root }), encoding: 'utf8'
  });
  return { code: r.status, out: r.stdout + r.stderr };
};
const readM = (root) => fs.readFileSync(path.join(root, 'data/article-manifest.jsonl'), 'utf8');
const parseM = (root) => readM(root).split('\n').filter((l) => l !== '').map((l) => JSON.parse(l));
const report = (root) => JSON.parse(fs.readFileSync(path.join(root, 'reports/queue-refill-latest.json'), 'utf8'));

// templates dung chung
const T_C01 = [
  tpl('Thue xe ga o Hoan Kiem cho moi nguoi moi cau hoi', 'thue-xe-ga-hoan-kiem', 'informational', 'xe ga', 'Hoan Kiem'),
  tpl('Kinh nghiem kiem tra xe truoc khi thue tai Ha Noi', 'kiem-tra-xe-truoc-thue', 'how-to', 'xe may', 'kinh nghiem'),
  tpl('Gia cuoc thue xe theo ngay o quan Dong Da', 'gia-thue-xe-dong-da', 'informational', 'xe may', 'Dong Da')
];
const T_C02 = [
  tpl('Chon xe dap dien phu hop nguoi cao tuoi o Ha Noi', 'chon-xe-dap-dien-cao-tuoi', 'informational', 'xe dap dien', 'nguoi cao tuoi'),
  tpl('Luu y khi mua xe dap thong dung cho hoc sinh', 'mua-xe-dap-hoc-sinh', 'informational', 'xe dap', 'hoc sinh'),
  tpl('Bao hanh xe dap dien thoi han va dieu kien ap dung', 'bao-hanh-xe-dap-dien', 'informational', 'xe dap dien', 'bao hanh')
];

test('R1: queue >= threshold -> khong mutation, manifest byte-identical', () => {
    // 5 planned rows
  const rows5 = [];
  for (let i = 1; i <= 5; i++) rows5.push(row('C01-000' + i, 'planned', 'Chu de thue xe so ' + i + ' tai Ha Noi quan ' + i, 'chu-de-thue-' + i, 'C01', ['chu de ' + i, 'quan so ' + i]));
  const root = fixture({ C01: T_C01, C02: T_C02 }, rows5.join('\n') + '\n');
  const before = readM(root);
  const r = run(root);
  assert.equal(r.code, 0, r.out);
  assert.equal(readM(root), before);
  assert.equal(report(root).result, 'noop-ok');
});

test('R2: queue thap -> append dung den target, giu nguyen lich su', () => {
  const rows2 = [
    row('C01-0001', 'planned', 'Thue xe may quan Cau Giay theo tuan gia va dieu kien', 'thue-xe-may-cau-giay', 'C01', ['xe may', 'Cau Giay']),
    row('C02-0001', 'planned', 'Mua xe dap dien cho di hoc quan Hai Ba Trung', 'mua-xe-dap-dien-hai-ba-trung', 'C02', ['xe dap dien', 'Hai Ba Trung'])
  ];
  const root = fixture({ C01: T_C01, C02: T_C02 }, rows2.join('\n') + '\n');
  const r = run(root);
  assert.equal(r.code, 0, r.out);
  const rep = report(root);
  assert.equal(rep.result, 'refilled');
  assert.equal(rep.appended, 4);
  const all = parseM(root);
  assert.equal(all.length, 6);
  assert.equal(all[0].id, 'C01-0001');
  assert.equal(all[1].id, 'C02-0001');
  for (const nw of all.slice(2)) {
    assert.equal(nw.status, 'planned');
    assert.ok(nw.parent_hub.startsWith('/hub/'));
  }
  const ids = new Set(all.map((x) => x.id));
  const slugs = new Set(all.map((x) => x.slug));
  assert.equal(ids.size, 6); assert.equal(slugs.size, 6);
});

test('R3: manifest rong (0 planned) -> refill thay vi terminate', () => {
  const root = fixture({ C01: T_C01, C02: T_C02 }, '\n');
  const r = run(root);
  assert.equal(r.code, 0, r.out);
  const rep = report(root);
  assert.equal(rep.appended, 6);
  assert.equal(rep.result, 'refilled');
  assert.equal(rep.before, 0);
});

test('R4: ung vien trung slug/topic/near-dup bi tu choi', () => {
  const rows1 = [
    row('C01-0001', 'planned', 'Kinh nghiem kiem tra xe truoc khi thue tai pho co', 'kinh-nghiem-kiem-tra-xe', 'C01', ['xe may', 'pho co'])
  ];
  const tpls = {
    C01: [
      tpl('Kinh nghiem kiem tra xe truoc khi thue tai Ha Noi', 'giong-nhau-cau-hoi', 'informational', 'xe may', 'pho co'), // jaccard >= 0.6
      tpl('Giong het chu de: Kinh nghiem kiem tra xe truoc khi thue tai pho co', 'trung-topic', 'informational', 'xe khac', 'pho co khac'),
      tpl('Chu de that su moi ve thue xe khong can coc', 'kinh-nghiem-kiem-tra-xe', 'informational', 'xe may', 'khong coc'), // trung slug
      tpl('Cach thue xe khong can coc o Ha Noi an toan', 'thue-xe-khong-coc', 'informational', 'xe may', 'khong coc')
    ]
  };
  const root = fixture(tpls, rows1.join('\n') + '\n');
  const r = run(root);
  assert.equal(r.code, 0, r.out);
  const rep = report(root);
  assert.equal(rep.appended, 1);
  assert.equal(rep.rejected_duplicate, 3);
  const all = parseM(root);
  assert.equal(all.length, 2);
  assert.equal(all[1].slug, 'thue-xe-khong-coc');
});

test('R5: ung vien invalid bi skip, khong tao dong hong', () => {
  const rows1 = [row('C01-0001', 'planned', 'Chu de goc ve thue xe may o Ha Noi', 'chu-de-goc', 'C01', ['goc', 'Ha Noi'])];
  const tpls = { C01: [
    { topic: 'Chu de thu hai ve thue xe may dep', slug: 'BAD SLUG!', intent: 'informational', entities: ['a', 'b'] },
    { topic: 'Chu de thu ba ve thue xe may tien', slug: 'chu-de-thu-ba', intent: 'nav', entities: ['a', 'b'] },
    { topic: 'Chu de thu tu ve thue xe may hay', slug: 'chu-de-thu-tu', intent: 'informational', entities: ['a'] },
    { topic: 'Chu de thu nam hop le ve thue xe o Ha Noi', slug: 'chu-de-thu-nam', intent: 'informational', entities: ['a', 'b'] }
  ] };
  const root = fixture(tpls, rows1.join('\n') + '\n');
  const r = run(root);
  assert.equal(r.code, 0, r.out);
  const rep = report(root);
  assert.equal(rep.appended, 1);
  assert.equal(rep.rejected_invalid, 3);
  const all = parseM(root);
  assert.equal(all.length, 2);
});

test('R6: vuot budget cluster -> phan bo theo budget', () => {
  const cl = {
    C01: { name: 'c1', budget: 1, desc: 'd', hub_path: '/hub/c01/' },
    C02: { name: 'c2', budget: 1, desc: 'd', hub_path: '/hub/c02/' }
  };
  const root = fixture({ C01: T_C01, C02: T_C02 }, '\n', cl);
  const r = run(root);
  assert.equal(r.code, 0, r.out);
  const rep = report(root);
  assert.equal(rep.appended, 2);
  assert.equal(rep.result, 'partial');
  assert.equal(rep.rejected_budget, 4);
});

test('R7: manifest malformed -> exit 1, file khong doi', () => {
  const root = fixture({ C01: T_C01, C02: T_C02 }, 'khong phai json\n');
  const before = readM(root);
  const r = run(root);
  assert.equal(r.code, 1);
  assert.equal(readM(root), before);
});

test('R8: id moi tiep tu max seq hien co', () => {
  const rows1 = [row('C01-0007', 'planned', 'Chu de goc ve thue xe may o Ha Noi', 'chu-de-goc', 'C01', ['goc', 'Ha Noi'])];
  const tpls = { C01: [tpl('Chu de moi ve cach thue xe gan day', 'chu-de-moi-thue-xe', 'informational', 'a', 'b')] };
  const root = fixture(tpls, rows1.join('\n') + '\n');
  const r = run(root);
  assert.equal(r.code, 0, r.out);
  const all = parseM(root);
  assert.equal(all[all.length - 1].id, 'C01-0008');
});

test('R9: chay lan hai (queue da day) -> noop, khong doi', () => {
  const rows2 = [
    row('C01-0001', 'planned', 'Thue xe may quan Cau Giay theo tuan gia va dieu kien', 'thue-xe-may-cau-giay', 'C01', ['xe may', 'Cau Giay']),
    row('C02-0001', 'planned', 'Mua xe dap dien cho di hoc quan Hai Ba Trung', 'mua-xe-dap-dien-hai-ba-trung', 'C02', ['xe dap dien', 'Hai Ba Trung'])
  ];
  const root = fixture({ C01: T_C01, C02: T_C02 }, rows2.join('\n') + '\n');
  assert.equal(run(root).code, 0);
  const after1 = readM(root);
  assert.equal(run(root).code, 0);
  assert.equal(readM(root), after1);
  assert.equal(report(root).result, 'noop-ok');
});

test('R10: trung cap entities+intent+cluster (cannibalization) -> chi nhan mot', () => {
  const tpls = { C01: [
    tpl('Chu de A ve thue xe gan ho Guom moi ngay', 'chu-de-a', 'informational', 'xe ga', 'Ho Guom'),
    tpl('Dia chi cho thue xe gan ho Guom moi tuan', 'chu-de-b', 'informational', 'xe ga', 'Ho Guom')
  ] };
  const root = fixture(tpls, '\n');
  const r = run(root);
  assert.equal(r.code, 0, r.out);
  const rep = report(root);
  assert.equal(rep.appended, 1);
  assert.equal(rep.rejected_duplicate, 1);
});
