import { many, one, query } from '../db.js';

let cache = null;

export async function loadCategories() {
  cache = await many('SELECT * FROM categories ORDER BY sort_order, id');
  return cache;
}

export function allCategories() {
  return cache || [];
}

export function enabledCategories() {
  return allCategories().filter((c) => c.enabled);
}

export function categoryByKey(key) {
  return allCategories().find((c) => c.key === key) || null;
}

export function categoryById(id) {
  return allCategories().find((c) => c.id === Number(id)) || null;
}

export function categoryByKind(kind) {
  return allCategories().find((c) => c.kind === kind && c.enabled) || null;
}

const KINDS = ['shidduch', 'tenaim', 'wedding', 'birth_boy', 'upsheren', 'other'];

function cleanKeywords(s) {
  return String(s || '').split(/[,\n]/).map((k) => k.trim()).filter((k) => k.length >= 2).slice(0, 40);
}

export async function createCategory({ name, kind, keywords, countsForShidduch }) {
  name = String(name || '').trim();
  if (name.length < 2 || name.length > 60) throw new Error('דער נאמען מוז זיין צווישן 2 און 60 אותיות');
  if (!KINDS.includes(kind)) kind = 'other';
  const key = 'c' + Date.now().toString(36);
  const max = await one('SELECT coalesce(max(sort_order), 0) + 10 AS n FROM categories');
  await query(
    `INSERT INTO categories (key, name, kind, sort_order, counts_for_shidduch, keywords) VALUES ($1,$2,$3,$4,$5,$6)`,
    [key, name, kind, max.n, !!countsForShidduch, cleanKeywords(keywords)],
  );
  await loadCategories();
}

export async function updateCategory(id, { name, enabled, keywords, countsForShidduch, kind }) {
  const cat = categoryById(id);
  if (!cat) throw new Error('קאטעגאריע נישט געפונען');
  name = String(name || '').trim();
  if (name.length < 2 || name.length > 60) throw new Error('דער נאמען מוז זיין צווישן 2 און 60 אותיות');
  // The behaviour (kind) of the six original categories is fixed so privacy rules can't be switched off.
  const isSystem = ['shidduch', 'tenaim', 'wedding', 'birth', 'upsheren', 'other'].includes(cat.key);
  const newKind = isSystem || !KINDS.includes(kind) ? cat.kind : kind;
  await query(
    `UPDATE categories SET name=$2, enabled=$3, keywords=$4, counts_for_shidduch=$5, kind=$6, updated_at=now() WHERE id=$1`,
    [id, name, !!enabled, cleanKeywords(keywords), !!countsForShidduch, newKind],
  );
  await loadCategories();
}

export async function moveCategory(id, direction) {
  const list = allCategories();
  const i = list.findIndex((c) => c.id === Number(id));
  const j = direction === 'up' ? i - 1 : i + 1;
  if (i < 0 || j < 0 || j >= list.length) return;
  const order = list.map((c) => c.id);
  [order[i], order[j]] = [order[j], order[i]];
  for (let k = 0; k < order.length; k++) await query('UPDATE categories SET sort_order=$2 WHERE id=$1', [order[k], (k + 1) * 10]);
  await loadCategories();
}
