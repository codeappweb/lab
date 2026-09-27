// Topic planning around the existing taxonomy (data/taxonomy.yml).
// Candidates are expanded per active child-category, DEDUPLICATED by slug and
// by intent-token overlap against the manifest and published posts.
// Candidates are NOT approved topics; approval moves them into the manifest.
import fs from 'node:fs';
import path from 'node:path';

export function parseTaxonomy(root) {
  const file = path.join(root, 'data', 'taxonomy.yml');
  if (!fs.existsSync(file)) return [];
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  const parents = [];
  let cur = null, ch = null;
  const val = s => s.replace(/^["']|["']$/g, '').trim();
  for (const raw of lines) {
    if (/^\s*#/.test(raw) || !raw.trim()) continue;
    let m = /^ {2}- id:\s*"?(.+?)"?\s*$/.exec(raw);
    if (m) { cur = { id: val(m[1]), children: [] }; parents.push(cur); ch = null; continue; }
    m = /^ {6}- id:\s*"?(.+?)"?\s*$/.exec(raw);
    if (m) { if (cur) { ch = { id: val(m[1]) }; cur.children.push(ch); } continue; }
    m = /^ {8}([\w-]+):\s*(.*)$/.exec(raw);
    if (m && ch) { ch[m[1]] = val(m[2]); continue; }
    m = /^ {4}([\w-]+):\s*(.*)$/.exec(raw);
    if (m && cur && !ch) { cur[m[1]] = val(m[2]); continue; }
    if (/^ {4}children:\s*$/.test(raw)) continue;
  }
  return parents;
}

function slugify(s) {
  return s.toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/[^a-z0-9\s-]/g, '').trim().replace(/\s+/g, '-').replace(/-+/g, '-');
}

function tokens(s) {
  return new Set(slugify(String(s)).split('-').filter(w => w.length > 2));
}

function intentDup(a, b) {
  const A = tokens(a), B = tokens(b);
  if (!A.size || !B.size) return 0;
  let shared = 0;
  for (const w of A) if (B.has(w)) shared++;
  return shared / Math.min(A.size, B.size);
}

export function expandCandidates(root, publishedSlugs, manifestEntries) {
  const taxonomy = parseTaxonomy(root);
  const usedSlugs = new Set(publishedSlugs);
  const usedTitles = [];
  for (const e of manifestEntries) usedTitles.push(e.title || e.primary_topic || '');
  const candidates = [];
  for (const p of taxonomy) {
    for (const c of (p.children || [])) {
      if (c.status !== 'active' && c.status !== 'in-progress') continue;
      const cands = (c.candidate_topics || '').split('|').map(s => s.trim()).filter(Boolean);
      for (const t of cands) {
        const slug = slugify(t);
        if (usedSlugs.has(slug)) continue;
        if (candidates.some(x => x.slug === slug)) continue;
        if (usedTitles.some(u => intentDup(u, t) >= 0.7)) continue;
        usedSlugs.add(slug);
        candidates.push({ slug, title: t, parent: p.id, child: c.id, status: 'candidate' });
      }
    }
  }
  return candidates;
}
