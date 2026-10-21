import { many, one, query, tx } from '../db.js';
import { isBranch, branchName } from '../branches.js';
import { hebrewFromIso, isoFromHebrew, parseIsoDate, gregText, toIso } from '../hebrew.js';
import { textKey, textSkel } from '../names.js';
import { FAMILY_KINDS, FIXED_TEXT_KINDS } from '../privacy.js';
import { categoryById } from './categories.js';
import { ValidationError } from './boys.js';

export const OCC_SELECT = `
  SELECT o.*, c.key AS cat_key, c.name AS cat_name, c.kind AS cat_kind,
         b.official_name AS boy_name, b.photo_media_id AS boy_photo, b.branch AS boy_branch,
         coalesce((SELECT array_agg(om.media_id ORDER BY om.sort_order, om.media_id) FROM occasion_media om
                   WHERE om.occasion_id = o.id), '{}') AS media_ids
  FROM occasions o
  JOIN categories c ON c.id = o.category_id
  JOIN boys b ON b.id = o.boy_id`;

export const PUBLIC_WHERE = `o.deleted_at IS NULL AND o.status = 'published' AND c.enabled AND b.deleted_at IS NULL`;

const clip = (s, n) => {
  const v = String(s ?? '').trim();
  if (v.length > n) throw new ValidationError(`א טעקסט איז צו לאנג (מאקסימום ${n} אותיות)`);
  return v || null;
};

// Searchable text for one occasion. Fields that are not public for this record are left out,
// so search can never reveal them.
function occKey(o, kind) {
  const parts = [branchName(o.branch), categoryById(o.category_id)?.name, o.heb_date_text, gregText(o.greg_date), o.greg_date];
  if (FAMILY_KINDS.has(kind) && o.show_family) parts.push(o.father_in_law_name, o.residence, o.family_details);
  if (!FIXED_TEXT_KINDS.has(kind)) parts.push(o.announcement_text);
  const s = parts.filter(Boolean).join(' ');
  return ` ${textKey(s)} | ${textSkel(s)} `;
}

// Validate input and compute Jewish date fields. Accepts either a civil date or a Hebrew date.
export function normalizeOccasionInput(input) {
  const category = categoryById(input.categoryId);
  if (!category) throw new ValidationError('ביטע קלייבט א קאטעגאריע');
  if (!isBranch(input.branch)) throw new ValidationError('ביטע קלייבט א סניף');
  let iso = input.gregDate || null;
  const afterSunset = !!input.afterSunset;
  if (!iso && input.hebYear && input.hebMonth && input.hebDay) {
    iso = isoFromHebrew(Number(input.hebYear), Number(input.hebMonth), Number(input.hebDay));
    if (!iso) throw new ValidationError('דער אידישער דאטום איז נישט גילטיג');
    if (afterSunset) { const d = parseIsoDate(iso); d.setDate(d.getDate() - 1); iso = toIso(d); }
  }
  if (!iso || !parseIsoDate(iso)) throw new ValidationError('ביטע גיט א גילטיגן דאטום');
  const y = Number(iso.slice(0, 4));
  if (y < 1950 || y > 2100) throw new ValidationError('דער דאטום איז אויסער דער ערלויבטער צייט');
  const h = hebrewFromIso(iso, afterSunset);
  return {
    boy_id: Number(input.boyId),
    branch: input.branch,
    category_id: category.id,
    kind: category.kind,
    greg_date: iso,
    after_sunset: afterSunset,
    heb_year: h.year, heb_month: h.month, heb_day: h.day, heb_date_text: h.text,
    father_in_law_name: clip(input.fatherInLaw, 160),
    residence: clip(input.residence, 160),
    family_details: clip(input.familyDetails, 400),
    show_family: input.showFamily === undefined ? true : !!input.showFamily,
    announcement_text: clip(input.announcementText, 4000),
    status: input.status === 'hidden' ? 'hidden' : 'published',
  };
}

export async function createOccasion(input, { source = 'manual', importId = null, by = null, needsReview = false, reviewNote = null, db = null } = {}) {
  const o = normalizeOccasionInput(input);
  if (!o.boy_id) throw new ValidationError('ביטע קלייבט א בחור');
  const run = async (c) => {
    const r = await c.query(
      `INSERT INTO occasions (boy_id, branch, category_id, greg_date, after_sunset, heb_year, heb_month, heb_day, heb_date_text,
         father_in_law_name, residence, family_details, show_family, announcement_text, status, source, import_id,
         needs_review, review_note, occ_key, created_by, updated_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$21) RETURNING id`,
      [o.boy_id, o.branch, o.category_id, o.greg_date, o.after_sunset, o.heb_year, o.heb_month, o.heb_day, o.heb_date_text,
        o.father_in_law_name, o.residence, o.family_details, o.show_family, o.announcement_text, o.status, source, importId,
        needsReview, reviewNote, occKey(o, o.kind), by],
    );
    const id = r.rows[0].id;
    await markDuplicate(id, c);
    return id;
  };
  return db ? run(db) : tx(run);
}

export async function updateOccasion(id, input, by = null) {
  const o = normalizeOccasionInput(input);
  if (!o.boy_id) throw new ValidationError('ביטע קלייבט א בחור');
  await tx(async (c) => {
    await c.query(
      `UPDATE occasions SET boy_id=$2, branch=$3, category_id=$4, greg_date=$5, after_sunset=$6, heb_year=$7, heb_month=$8,
         heb_day=$9, heb_date_text=$10, father_in_law_name=$11, residence=$12, family_details=$13, show_family=$14,
         announcement_text=$15, status=$16, occ_key=$17, updated_by=$18, needs_review=false, updated_at=now()
       WHERE id=$1`,
      [id, o.boy_id, o.branch, o.category_id, o.greg_date, o.after_sunset, o.heb_year, o.heb_month, o.heb_day, o.heb_date_text,
        o.father_in_law_name, o.residence, o.family_details, o.show_family, o.announcement_text, o.status, occKey(o, o.kind), by],
    );
    await c.query('UPDATE occasions SET duplicate_of = NULL WHERE id = $1', [id]);
    await markDuplicate(id, c);
  });
}

// Records for the same boy and the same category within 60 days are flagged as duplicates of the
// earliest one. They stay published (as requested) but are visible as duplicates to administrators.
// Statistics are unaffected either way because they count distinct boys.
async function markDuplicate(id, c) {
  await c.query(
    `UPDATE occasions o SET duplicate_of = d.id FROM (
       SELECT o2.id FROM occasions o1 JOIN occasions o2 ON o2.boy_id = o1.boy_id AND o2.category_id = o1.category_id
       WHERE o1.id = $1 AND o2.id <> o1.id AND o2.deleted_at IS NULL AND o2.duplicate_of IS NULL
         AND abs(o2.greg_date - o1.greg_date) <= 60 AND o2.id < o1.id
       ORDER BY o2.id LIMIT 1) d
     WHERE o.id = $1`, [id]);
}

export async function setOccasionMedia(occasionId, mediaIds, db = { query }) {
  await db.query('DELETE FROM occasion_media WHERE occasion_id=$1', [occasionId]);
  let i = 0;
  for (const m of mediaIds) {
    await db.query('INSERT INTO occasion_media (occasion_id, media_id, sort_order) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [occasionId, m, i++]);
  }
}

export async function addOccasionMedia(occasionId, mediaId, db = { query }) {
  await db.query(
    `INSERT INTO occasion_media (occasion_id, media_id, sort_order)
     VALUES ($1, $2, (SELECT coalesce(max(sort_order), -1) + 1 FROM occasion_media WHERE occasion_id = $1)) ON CONFLICT DO NOTHING`,
    [occasionId, mediaId]);
}

export async function softDeleteOccasion(id, by) {
  await query('UPDATE occasions SET deleted_at=now(), updated_by=$2, updated_at=now() WHERE id=$1', [id, by]);
  await query('UPDATE occasions SET duplicate_of=NULL WHERE duplicate_of=$1', [id]);
}

export async function restoreOccasion(id, by) {
  await query('UPDATE occasions SET deleted_at=NULL, updated_by=$2, updated_at=now() WHERE id=$1', [id, by]);
}

export async function reindexAllOccasions() {
  const rows = await many('SELECT o.*, c.kind FROM occasions o JOIN categories c ON c.id = o.category_id');
  for (const o of rows) await query('UPDATE occasions SET occ_key=$2 WHERE id=$1', [o.id, occKey(o, o.kind)]);
}

export async function getOccasion(id) {
  return one(`${OCC_SELECT} WHERE o.id = $1`, [id]);
}

export async function getPublicOccasion(id) {
  return one(`${OCC_SELECT} WHERE o.id = $1 AND ${PUBLIC_WHERE}`, [id]);
}

// Public listing with filters. All filters are parameterised.
export function buildFilters(f = {}, params = []) {
  const where = [PUBLIC_WHERE];
  const add = (sql, v) => { params.push(v); where.push(sql.replace('?', `$${params.length}`)); };
  if (f.branch && isBranch(f.branch)) add('o.branch = ?', f.branch);
  if (f.categoryKey) add('c.key = ?', f.categoryKey);
  if (f.categoryKeys?.length) add('c.key = ANY(?)', f.categoryKeys);
  if (f.boyId) add('o.boy_id = ?', Number(f.boyId));
  if (f.from) add('o.greg_date >= ?', f.from);
  if (f.to) add('o.greg_date <= ?', f.to);
  if (f.after) add('o.greg_date > ?', f.after);
  if (f.date) add('o.greg_date = ?', f.date);
  if (f.hebYear) add('o.heb_year = ?', Number(f.hebYear));
  if (f.hebMonth) add('o.heb_month = ?', Number(f.hebMonth));
  if (f.hebDay) add('o.heb_day = ?', Number(f.hebDay));
  for (const t of f.tokens || []) {
    const k = textKey(t);
    if (!k) continue;
    params.push(`%${k}%`);
    const a = `$${params.length}`;
    if (k.length >= 4) {
      params.push(`%${textSkel(t)}%`);
      const b = `$${params.length}`;
      where.push(`(o.occ_key LIKE ${a} OR b.search_key LIKE ${a} OR o.occ_key LIKE ${b} OR b.search_key LIKE ${b})`);
    } else {
      where.push(`(o.occ_key LIKE ${a} OR b.search_key LIKE ${a})`);
    }
  }
  return { where: where.join(' AND '), params };
}

export async function listPublicOccasions(f = {}, { limit = 20, offset = 0, order = 'desc' } = {}) {
  const { where, params } = buildFilters(f);
  params.push(Math.min(Number(limit) || 20, 200), Math.max(Number(offset) || 0, 0));
  const dir = order === 'asc' ? 'ASC' : 'DESC';
  return many(
    `${OCC_SELECT} WHERE ${where} ORDER BY o.greg_date ${dir}, o.after_sunset ${dir}, o.id ${dir}
     LIMIT $${params.length - 1} OFFSET $${params.length}`, params);
}

export async function countPublicOccasions(f = {}) {
  const { where, params } = buildFilters(f);
  const r = await one(`SELECT count(*)::int AS n FROM occasions o JOIN categories c ON c.id=o.category_id JOIN boys b ON b.id=o.boy_id WHERE ${where}`, params);
  return r.n;
}

// Admin list: includes hidden / deleted / review status.
export async function listAdminOccasions(f = {}, { limit = 50, offset = 0 } = {}) {
  const params = [];
  const where = ['b.id IS NOT NULL'];
  const add = (sql, v) => { params.push(v); where.push(sql.replace('?', `$${params.length}`)); };
  if (f.deleted) where.push('o.deleted_at IS NOT NULL'); else where.push('o.deleted_at IS NULL');
  if (f.branch && isBranch(f.branch)) add('o.branch = ?', f.branch);
  if (f.categoryId) add('o.category_id = ?', Number(f.categoryId));
  if (f.source) add('o.source = ?', f.source);
  if (f.review) where.push('o.needs_review');
  if (f.duplicates) where.push('o.duplicate_of IS NOT NULL');
  if (f.boyId) add('o.boy_id = ?', Number(f.boyId));
  for (const t of textKey(f.q || '').split(' ').filter(Boolean)) {
    params.push(`%${t}%`);
    where.push(`(o.occ_key LIKE $${params.length} OR b.search_key LIKE $${params.length})`);
  }
  params.push(limit, offset);
  return many(`${OCC_SELECT} WHERE ${where.join(' AND ')} ORDER BY o.created_at DESC, o.id DESC
    LIMIT $${params.length - 1} OFFSET $${params.length}`, params);
}

export async function eventsByHebrewMonth(year, month, branch) {
  const f = { hebYear: year, hebMonth: month, branch };
  const { where, params } = buildFilters(f);
  return many(`${OCC_SELECT} WHERE ${where} ORDER BY o.heb_day, o.id`, params);
}
