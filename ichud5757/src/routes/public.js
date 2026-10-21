import express from 'express';
import { isBranch, branch as getBranch } from '../branches.js';
import { one, many } from '../db.js';
import { getSetting } from '../settings.js';
import { publicOccasion, publicBoy, publicAnnouncement } from '../privacy.js';
import { listPublicOccasions, countPublicOccasions, getPublicOccasion } from '../repo/occasions.js';
import { listPublicAnnouncements, getAnnouncement } from '../repo/announcements.js';
import { categoryByKey, enabledCategories } from '../repo/categories.js';
import { shidduchStats, categoryCounts } from '../repo/stats.js';
import { search } from '../repo/search.js';
import { getAliases } from '../repo/boys.js';
import { isPublicMedia } from '../media.js';
import { calendarMonth } from '../calendar.js';
import { parseIsoDate } from '../hebrew.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const publicRouter = express.Router();
const wrap = (fn) => (req, res, next) => fn(req, res, next).catch(next);
const defaultLogo = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '../../public/img/logo.svg'));

const pick = (req, key) => (typeof req.query[key] === 'string' ? req.query[key] : '');
const branchParam = (req) => (isBranch(pick(req, 'branch')) ? pick(req, 'branch') : null);
const dateParam = (req, k) => (parseIsoDate(pick(req, k)) ? pick(req, k) : null);

async function dashboardData(branchId, todayIso, calQuery) {
  const sections = await Promise.all(enabledCategories().map(async (c) => ({
    category: c,
    items: (await listPublicOccasions({ branch: branchId, categoryKey: c.key }, { limit: 4 })).map((r) => publicOccasion(r, todayIso)),
  })));
  const [announcements, feed, todays, upcoming, stats, counts, cal] = await Promise.all([
    listPublicAnnouncements({ branch: branchId, featuredOnly: true, limit: 6 }),
    listPublicOccasions({ branch: branchId }, { limit: 12 }),
    listPublicOccasions({ branch: branchId, date: todayIso }, { limit: 20 }),
    listPublicOccasions({ branch: branchId, after: todayIso }, { limit: 8, order: 'asc' }),
    shidduchStats(),
    categoryCounts(branchId),
    calendarMonth({ ...calQuery, branch: branchId, todayIso }),
  ]);
  return {
    sections,
    announcements: announcements.map(publicAnnouncement),
    feed: feed.map((r) => publicOccasion(r, todayIso)),
    todays: todays.map((r) => publicOccasion(r, todayIso)),
    upcoming: upcoming.map((r) => publicOccasion(r, todayIso)),
    stats, counts, cal,
  };
}

async function selectedDay(req, branchId, todayIso) {
  const date = dateParam(req, 'date');
  if (!date) return null;
  const rows = await listPublicOccasions({ branch: branchId, date }, { limit: 50 });
  return { iso: date, events: rows.map((r) => publicOccasion(r, todayIso)) };
}

publicRouter.get('/', wrap(async (req, res) => {
  const branchId = branchParam(req);
  const todayIso = res.locals.today.iso;
  const data = await dashboardData(branchId, todayIso, { year: pick(req, 'y'), month: pick(req, 'm'), selected: dateParam(req, 'date') });
  res.render('home', { ...data, branchId, day: await selectedDay(req, branchId, todayIso), title: '' });
}));

publicRouter.get('/branch/:id', wrap(async (req, res, next) => {
  if (!isBranch(req.params.id)) return next();
  const b = getBranch(req.params.id);
  const todayIso = res.locals.today.iso;
  const data = await dashboardData(b.id, todayIso, { year: pick(req, 'y'), month: pick(req, 'm'), selected: dateParam(req, 'date') });
  const boys = await many(
    `SELECT b.id, b.official_name, b.branch, b.photo_media_id,
       (SELECT count(*) FROM occasions o JOIN categories c ON c.id=o.category_id WHERE o.boy_id=b.id AND o.deleted_at IS NULL AND o.status='published' AND c.enabled) AS occasion_count
     FROM boys b WHERE b.branch=$1 AND b.deleted_at IS NULL AND b.merged_into IS NULL ORDER BY b.official_name LIMIT 500`, [b.id]);
  res.render('branch', { ...data, branch: b, branchId: b.id, boys: boys.map(publicBoy), day: await selectedDay(req, b.id, todayIso), title: b.name });
}));

publicRouter.get('/boy/:id', wrap(async (req, res, next) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) return next();
  const boy = await one('SELECT * FROM boys WHERE id=$1', [id]);
  if (!boy) return next();
  if (boy.merged_into) return res.redirect(301, `/boy/${boy.merged_into}`);
  if (boy.deleted_at) return next();
  const todayIso = res.locals.today.iso;
  const rows = await listPublicOccasions({ boyId: id }, { limit: 200, order: 'asc' });
  const aliases = await getAliases(id);
  res.render('boy', {
    boy: publicBoy(boy), aliases: aliases.map((a) => a.alias), timeline: rows.map((r) => publicOccasion(r, todayIso)), title: boy.official_name,
  });
}));

publicRouter.get('/occasion/:id', wrap(async (req, res, next) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) return next();
  const row = await getPublicOccasion(id);
  if (!row) return next();
  const occ = publicOccasion(row, res.locals.today.iso);
  res.render('occasion', { occ, title: `${occ.category.name} – ${occ.boy.name}` });
}));

publicRouter.get('/feed', wrap(async (req, res) => {
  const branchId = branchParam(req);
  const cat = categoryByKey(pick(req, 'category'));
  const page = Math.max(1, Math.min(Number(pick(req, 'page')) || 1, 1000));
  const per = 24;
  const f = { branch: branchId, categoryKey: cat?.enabled ? cat.key : undefined, from: dateParam(req, 'from'), to: dateParam(req, 'to') };
  const [rows, total] = await Promise.all([listPublicOccasions(f, { limit: per, offset: (page - 1) * per }), countPublicOccasions(f)]);
  res.render('feed', {
    items: rows.map((r) => publicOccasion(r, res.locals.today.iso)), total, page, pages: Math.max(1, Math.ceil(total / per)),
    branchId, category: cat?.enabled ? cat : null, from: f.from, to: f.to, title: cat ? cat.name : 'אלע שמחות',
  });
}));

publicRouter.get('/category/:key', (req, res) => res.redirect(`/feed?category=${encodeURIComponent(req.params.key)}`));

publicRouter.get('/calendar', wrap(async (req, res) => {
  const branchId = branchParam(req);
  const todayIso = res.locals.today.iso;
  const cal = await calendarMonth({ year: pick(req, 'y'), month: pick(req, 'm'), branch: branchId, todayIso, selected: dateParam(req, 'date') });
  res.render('calendar', { cal, branchId, day: await selectedDay(req, branchId, todayIso), title: 'אידישער קאלענדאר' });
}));

// HTML fragment for in-page calendar navigation (progressive enhancement).
publicRouter.get('/calendar/fragment', wrap(async (req, res) => {
  const branchId = branchParam(req);
  const todayIso = res.locals.today.iso;
  const cal = await calendarMonth({ year: pick(req, 'y'), month: pick(req, 'm'), branch: branchId, todayIso, selected: dateParam(req, 'date') });
  res.render('partials/calendar', { cal, branchId, day: await selectedDay(req, branchId, todayIso), base: pick(req, 'base') === 'calendar' ? '/calendar' : (branchId && pick(req, 'base') === 'branch' ? `/branch/${branchId}` : '/'), fragment: true });
}));

publicRouter.get('/search', wrap(async (req, res) => {
  const q = pick(req, 'q').slice(0, 200);
  const branchId = branchParam(req);
  const cat = categoryByKey(pick(req, 'category'));
  const page = Math.max(1, Math.min(Number(pick(req, 'page')) || 1, 500));
  const per = 30;
  const extra = { branch: branchId || undefined, categoryKey: cat?.enabled ? cat.key : undefined, from: dateParam(req, 'from') || undefined, to: dateParam(req, 'to') || undefined };
  const r = await search(q, extra, { limit: per, offset: (page - 1) * per });
  res.render('search', {
    q, branchId, category: cat?.enabled ? cat : null, from: extra.from, to: extra.to, page, pages: Math.max(1, Math.ceil(r.total / per)),
    boys: r.boys.map(publicBoy), occasions: r.occasions.map((o) => publicOccasion(o, res.locals.today.iso)), total: r.total,
    searched: !!(q || extra.branch || extra.categoryKey || extra.from || extra.to), title: q ? `זוכן: ${q}` : 'זוכן',
  });
}));

publicRouter.get('/announcements', wrap(async (req, res) => {
  const branchId = branchParam(req);
  const rows = await listPublicAnnouncements({ branch: branchId, limit: 100 });
  res.render('announcements', { items: rows.map(publicAnnouncement), branchId, title: 'מודעות' });
}));

publicRouter.get('/announcement/:id', wrap(async (req, res, next) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) return next();
  const a = await getAnnouncement(id);
  if (!a || !a.published) return next();
  res.render('announcement', { a: publicAnnouncement(a), title: a.title });
}));

publicRouter.get('/boys', wrap(async (req, res) => {
  const branchId = branchParam(req);
  const rows = await many(
    `SELECT b.id, b.official_name, b.branch, b.photo_media_id,
       (SELECT count(*) FROM occasions o JOIN categories c ON c.id=o.category_id WHERE o.boy_id=b.id AND o.deleted_at IS NULL AND o.status='published' AND c.enabled) AS occasion_count
     FROM boys b WHERE b.deleted_at IS NULL AND b.merged_into IS NULL AND ($1::text IS NULL OR b.branch=$1)
     ORDER BY b.official_name LIMIT 2000`, [branchId]);
  res.render('boys', { boys: rows.map(publicBoy), branchId, title: 'בחורים' });
}));

publicRouter.get('/logo', wrap(async (_req, res) => {
  const id = getSetting('logo_media_id');
  if (id) {
    const m = await one('SELECT data FROM media WHERE id=$1', [id]);
    if (m) { res.set('Cache-Control', 'public, max-age=300'); return res.type('image/webp').send(m.data); }
  }
  res.set('Cache-Control', 'public, max-age=300');
  res.type('image/svg+xml').send(defaultLogo);
}));

publicRouter.get(/^\/media\/(\d+)(\/thumb)?\.webp$/, wrap(async (req, res, next) => {
  const id = Number(req.params[0]);
  const thumb = !!req.params[1];
  if (!(await isPublicMedia(id))) return next();
  const m = await one(`SELECT ${thumb ? 'thumb' : 'data'} AS bin, sha256 FROM media WHERE id=$1`, [id]);
  if (!m) return next();
  // Short cache: if a picture is removed from a record it stops being served soon afterwards.
  res.set('Cache-Control', 'public, max-age=600');
  res.set('ETag', `"${m.sha256.slice(0, 16)}${thumb ? 't' : ''}"`);
  if (req.fresh) return res.status(304).end();
  res.type('image/webp').send(m.bin);
}));
