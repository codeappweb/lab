// Shared canonical navigation/action data — SINGLE SOURCE for every surface
// that renders menus, buttons or action labels (header, footer, drawer,
// topic sheet, bottom nav) and for the validators that check them.
// Both scripts/validate-navigation.mjs and scripts/tests/nav-regression.test.mjs
// import these parsers, so the fixture test renders from the SAME canonical
// data the real site renders from — repeated action labels are never
// duplicated as separate hardcoded strings.
import fs from 'node:fs';
import path from 'node:path';

export const unq = (s) => s.replace(/^["']|["']$/g, '');

// data/navigation.yml -> [ { label, url } ] (main list only)
export function parseNavMain(text) {
  const out = [];
  let cur = null;
  for (const raw of text.split('\n')) {
    let m = /^ {2}- label:\s*(.+?)\s*$/.exec(raw);
    if (m) { cur = { label: unq(m[1]) }; out.push(cur); continue; }
    m = /^ {4}url:\s*(.+?)\s*$/.exec(raw);
    if (m && cur) { cur.url = unq(m[1]); continue; }
  }
  return out.filter(x => x.label && x.url);
}

// data/actions.yml -> [ { id, label, url?, data_qa? } ] (quick list only)
export function parseActionsYml(text) {
  const out = [];
  let cur = null;
  for (const raw of text.split('\n')) {
    let m = /^ {2}- id:\s*"?([\w-]+)"?\s*$/.exec(raw);
    if (m) { cur = { id: m[1] }; out.push(cur); continue; }
    m = /^ {4}([\w-]+):\s*(.+?)\s*$/.exec(raw);
    if (m && cur) { cur[m[1]] = unq(m[2]); continue; }
  }
  return out.filter(a => a.id && a.label);
}

// data/taxonomy.yml -> [ { id, name, slug, children: [{ id, name, slug }] } ]
export function parseTaxonomy(text) {
  const parents = [];
  let cur = null, child = null;
  for (const raw of text.split('\n')) {
    let m = /^ {2}- id:\s*"?([^"\n]*)"?\s*$/.exec(raw);
    if (m) { cur = { id: m[1] }; parents.push(cur); child = null; continue; }
    // Child items appear at BOTH indent styles in the wild (4-space and the
    // 6-space style data/taxonomy.yml actually uses, with 8-space fields).
    // Both must parse — missing the 6-space style silently emptied every
    // parent's children list and disabled all child-item validation.
    m = /^ {6}- id:\s*"?([^"\n]*)"?\s*$/.exec(raw) || /^ {4}- id:\s*"?([^"\n]*)"?\s*$/.exec(raw);
    if (m && cur) { child = { id: m[1] }; cur.children = cur.children || []; cur.children.push(child); continue; }
    m = /^ {4}([\w-]+):\s*(.+)$/.exec(raw);
    if (m && cur && !child) { cur[m[1]] = unq(m[2]); continue; }
    m = /^ {6}([\w-]+):\s*(.+)$/.exec(raw) || /^ {8}([\w-]+):\s*(.+)$/.exec(raw);
    if (m && child) { child[m[1]] = unq(m[2]); continue; }
  }
  return parents.filter(p => p.slug);
}

// data/menu-cats.yml -> { primary: [slug], more: [slug] }
export function parseListYaml(text) {
  const out = {};
  let curKey = null;
  for (const raw of text.split('\n')) {
    let m = /^([\w-]+):\s*$/.exec(raw);
    if (m) { curKey = m[1]; out[curKey] = []; continue; }
    m = /^-\s*(.+?)\s*$/.exec(raw);
    if (m && curKey) { out[curKey].push(unq(m[1])); continue; }
  }
  return out;
}

export function loadCanonical(dataRoot) {
  const read = (p) => fs.readFileSync(path.join(dataRoot, p), 'utf8');
  return {
    navMain: parseNavMain(read('data/navigation.yml')),
    actions: parseActionsYml(read('data/actions.yml')),
    parents: parseTaxonomy(read('data/taxonomy.yml')),
    menuCats: parseListYaml(read('data/menu-cats.yml')),
  };
}
