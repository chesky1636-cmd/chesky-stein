// Public search across boys and occasions. Recognises dates (civil and Jewish), category names,
// branch names, official names, alternate spellings and free keywords. Results go through privacy.js.
import { many } from '../db.js';
import { branches } from '../branches.js';
import { parseGregDate, parseHebrewDate } from '../hebrew.js';
import { textKey, textSkel } from '../names.js';
import { enabledCategories } from './categories.js';
import { listPublicOccasions, countPublicOccasions } from './occasions.js';

export function parseQuery(q, extra = {}) {
  let rest = String(q || '').slice(0, 200);
  const f = { ...extra };
  const greg = parseGregDate(rest);
  if (greg) { f.date = greg; rest = rest.replace(/\d{4}-\d{1,2}-\d{1,2}|\d{1,2}[./-]\d{1,2}[./-]\d{4}/, ' '); }
  const heb = parseHebrewDate(rest);
  if (heb) {
    f.hebMonth = heb.month; f.hebDay = heb.day;
    if (heb.explicitYear) f.hebYear = heb.year;
    rest = '';
  }
  let key = ` ${textKey(rest)} `;
  if (!f.categoryKey) {
    for (const c of enabledCategories()) {
      const ck = ` ${textKey(c.name)} `;
      if (ck.trim() && key.includes(ck)) { f.categoryKey = c.key; key = key.replace(ck, ' '); break; }
    }
  }
  if (!f.branch) {
    for (const b of branches()) {
      const bk = ` ${textKey(b.name)} `;
      if (bk.trim() && key.includes(bk)) { f.branch = b.id; key = key.replace(bk, ' '); break; }
    }
  }
  f.tokens = key.split(' ').filter((t) => t.length >= 2 && !['מזל', 'טוב', 'פון', 'דער', 'די', 'דאס', 'און'].includes(t));
  return f;
}

export async function searchBoys(tokens, branch) {
  if (!tokens.length) return [];
  const params = [];
  const where = ['b.deleted_at IS NULL', 'b.merged_into IS NULL'];
  for (const t of tokens) {
    params.push(`%${textKey(t)}%`);
    const a = `$${params.length}`;
    if (t.length >= 4) { params.push(`%${textSkel(t)}%`); where.push(`(b.search_key LIKE ${a} OR b.search_key LIKE $${params.length})`); }
    else where.push(`b.search_key LIKE ${a}`);
  }
  if (branch) { params.push(branch); where.push(`b.branch = $${params.length}`); }
  return many(
    `SELECT b.id, b.official_name, b.branch, b.photo_media_id,
       (SELECT count(*) FROM occasions o JOIN categories c ON c.id=o.category_id
        WHERE o.boy_id=b.id AND o.deleted_at IS NULL AND o.status='published' AND c.enabled) AS occasion_count
     FROM boys b WHERE ${where.join(' AND ')} ORDER BY b.official_name LIMIT 30`, params);
}

export async function search(q, extra = {}, { limit = 30, offset = 0 } = {}) {
  const f = parseQuery(q, extra);
  const hasCriteria = f.tokens.length || f.date || f.hebMonth || f.categoryKey || f.branch || f.from || f.to;
  if (!hasCriteria) return { filters: f, boys: [], occasions: [], total: 0 };
  const [boys, occasions, total] = await Promise.all([
    f.date || f.hebMonth ? [] : searchBoys(f.tokens, f.branch),
    listPublicOccasions(f, { limit, offset }),
    countPublicOccasions(f),
  ]);
  return { filters: f, boys, occasions, total };
}
