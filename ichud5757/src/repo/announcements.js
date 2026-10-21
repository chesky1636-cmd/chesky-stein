import { many, one, query } from '../db.js';
import { isBranch } from '../branches.js';
import { parseIsoDate } from '../hebrew.js';
import { ValidationError } from './boys.js';

function normalize(input) {
  const title = String(input.title || '').trim();
  const body = String(input.body || '').trim();
  if (title.length < 2 || title.length > 200) throw new ValidationError('דער קעפל מוז זיין צווישן 2 און 200 אותיות');
  if (body.length > 8000) throw new ValidationError('דער טעקסט איז צו לאנג');
  const branch = input.branch && isBranch(input.branch) ? input.branch : null;
  const eventDate = input.eventDate && parseIsoDate(input.eventDate) ? input.eventDate : null;
  return { title, body, branch, eventDate, featured: !!input.featured, published: !!input.published };
}

export async function createAnnouncement(input, by) {
  const a = normalize(input);
  const r = await one(
    `INSERT INTO announcements (title, body, branch, featured, published, event_date, media_id, created_by, updated_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8) RETURNING id`,
    [a.title, a.body, a.branch, a.featured, a.published, a.eventDate, input.mediaId || null, by]);
  return r.id;
}

export async function updateAnnouncement(id, input, by) {
  const a = normalize(input);
  await query(
    `UPDATE announcements SET title=$2, body=$3, branch=$4, featured=$5, published=$6, event_date=$7,
       media_id=coalesce($8, media_id), updated_by=$9, updated_at=now() WHERE id=$1`,
    [id, a.title, a.body, a.branch, a.featured, a.published, a.eventDate, input.mediaId || null, by]);
}

export async function removeAnnouncementPicture(id) {
  await query('UPDATE announcements SET media_id=NULL, updated_at=now() WHERE id=$1', [id]);
}

export async function deleteAnnouncement(id) {
  await query('UPDATE announcements SET deleted_at=now() WHERE id=$1', [id]);
}

export async function getAnnouncement(id) {
  return one('SELECT * FROM announcements WHERE id=$1 AND deleted_at IS NULL', [id]);
}

export async function listPublicAnnouncements({ branch = null, featuredOnly = false, limit = 12, offset = 0 } = {}) {
  // A branch page shows its own announcements plus school-wide ones (branch IS NULL).
  return many(
    `SELECT * FROM announcements WHERE deleted_at IS NULL AND published
       AND ($1::text IS NULL OR branch IS NULL OR branch = $1) AND (NOT $2 OR featured)
     ORDER BY featured DESC, created_at DESC LIMIT $3 OFFSET $4`, [branch, featuredOnly, limit, offset]);
}

export async function listAdminAnnouncements() {
  return many(
    `SELECT a.*, (SELECT status FROM telegram_outbox t WHERE t.kind='announcement' AND t.ref_id=a.id ORDER BY t.id DESC LIMIT 1) AS tg_status
     FROM announcements a WHERE deleted_at IS NULL ORDER BY created_at DESC LIMIT 200`);
}
