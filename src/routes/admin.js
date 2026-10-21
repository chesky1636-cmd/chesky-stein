// Administrative area. Every route below the login handlers requires a valid server-side session;
// super-administrator routes additionally require the 'super' role (checked on the server).
import express from 'express';
import multer from 'multer';
import { config, telegramMode } from '../config.js';
import { many, one, query } from '../db.js';
import { audit } from '../audit.js';
import {
  requireRole, checkCsrf, roleForPin, createSession, destroySession, tooManyFailures, recordFailure,
  pinsConfigured, hashPin, validPinFormat, verifyPin, revokeAllSessions,
} from '../auth.js';
import { branches, isBranch, BRANCH_IDS } from '../branches.js';
import { getSetting, setSetting } from '../settings.js';
import { storeImage, MediaError } from '../media.js';
import { monthsOfYear, today as hebToday } from '../hebrew.js';
import { publicOccasion } from '../privacy.js';
import { allCategories, categoryById, createCategory, updateCategory, moveCategory } from '../repo/categories.js';
import {
  ValidationError, createBoy, updateBoy, getBoy, getAliases, addAlias, removeAlias, setBoyPhoto, findBoyMatches,
  mergeBoys, deleteBoy, listBoysAdmin, suspectedDuplicateBoys,
} from '../repo/boys.js';
import {
  createOccasion, updateOccasion, getOccasion, listAdminOccasions, softDeleteOccasion, restoreOccasion,
  addOccasionMedia, reindexAllOccasions,
} from '../repo/occasions.js';
import {
  createAnnouncement, updateAnnouncement, getAnnouncement, listAdminAnnouncements, deleteAnnouncement, removeAnnouncementPicture,
} from '../repo/announcements.js';
import { shidduchStats } from '../repo/stats.js';
import { enqueue, announcementMessage, occasionMessage, listOutbox, retryOutbox, outgoingChatId, latestOutboxFor } from '../telegram/outbox.js';
import { reprocessImport, allowedChatIds } from '../telegram/importer.js';
import { registerWebhook } from '../telegram/runner.js';
import * as tg from '../telegram/client.js';
import { HDate } from '@hebcal/core';

export const adminRouter = express.Router();
const wrap = (fn) => (req, res, next) => fn(req, res, next).catch(next);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: config.maxUploadMb * 1024 * 1024, files: 10, fields: 80 },
  fileFilter: (_req, file, cb) => cb(null, /^image\//.test(file.mimetype)),
});

adminRouter.use((req, res, next) => {
  res.set('Cache-Control', 'no-store');
  res.set('X-Robots-Tag', 'noindex');
  res.locals.isAdminArea = true;
  next();
});

// ---------- login ----------
adminRouter.get('/login', (req, res) => {
  if (req.admin) return res.redirect('/admin');
  res.render('admin/login', { title: 'אריינגיין', error: null, configured: pinsConfigured(), next: safeNext(req.query.next) });
});

function safeNext(n) {
  return typeof n === 'string' && /^\/admin(\/[\w\-/?=&%.]*)?$/.test(n) ? n : '/admin';
}

adminRouter.post('/login', wrap(async (req, res) => {
  const render = (error, status = 401) => res.status(status).render('admin/login', { title: 'אריינגיין', error, configured: pinsConfigured(), next: safeNext(req.body.next) });
  if (await tooManyFailures(req.ip)) return render('צו פיל פרואוון. ביטע ווארט 15 מינוט און פרובירט נאכאמאל.', 429);
  const role = await roleForPin(String(req.body.pin || '').trim());
  if (!role) {
    await recordFailure(req.ip);
    await audit(req, 'login_failed');
    return render('דער פין-קאד איז נישט ריכטיג.');
  }
  await createSession(res, req, role);
  await audit({ ...req, admin: { role } }, 'login');
  res.redirect(safeNext(req.body.next));
}));

adminRouter.post('/logout', wrap(async (req, res) => {
  await destroySession(req, res);
  res.redirect('/');
}));

// ---------- everything below requires an admin session ----------
adminRouter.use(requireRole('admin'));
adminRouter.use((req, res, next) => (req.is('multipart/form-data') ? upload.any()(req, res, next) : next()));
adminRouter.use(checkCsrf);
adminRouter.use((req, res, next) => { res.locals.csrf = req.admin.csrf; next(); });
const superOnly = requireRole('super');

const arr = (v) => (v === undefined ? [] : Array.isArray(v) ? v : [v]);
const files = (req, field) => (req.files || []).filter((f) => f.fieldname === field);
const flash = (res, url, msg) => res.redirect(`${url}${url.includes('?') ? '&' : '?'}ok=${encodeURIComponent(msg)}`);

async function storeUploads(req, field, source = 'manual') {
  const ids = [];
  for (const f of files(req, field)) ids.push(await storeImage(f.buffer, source));
  return ids;
}

function userError(err) {
  return err instanceof ValidationError || err instanceof MediaError || err instanceof tg.TelegramError || err?.code === '23514';
}

// ---------- dashboard ----------
adminRouter.get('/', wrap(async (_req, res) => {
  const [counts, recentImports, recentAudit, stats] = await Promise.all([
    one(`SELECT
      (SELECT count(*) FROM occasions WHERE deleted_at IS NULL)::int AS occasions,
      (SELECT count(*) FROM boys WHERE deleted_at IS NULL)::int AS boys,
      (SELECT count(*) FROM occasions WHERE deleted_at IS NULL AND needs_review)::int AS review,
      (SELECT count(*) FROM telegram_imports WHERE status IN ('needs_review','error'))::int AS imports_open,
      (SELECT count(*) FROM telegram_imports WHERE received_at > now() - interval '7 days')::int AS imports_week,
      (SELECT count(*) FROM telegram_outbox WHERE status='failed')::int AS outbox_failed,
      (SELECT count(*) FROM telegram_outbox WHERE status IN ('pending','sending'))::int AS outbox_pending,
      (SELECT count(*) FROM announcements WHERE deleted_at IS NULL)::int AS announcements`),
    many(`SELECT id, status, raw_text, received_at, occasion_id, error FROM telegram_imports ORDER BY id DESC LIMIT 8`),
    many(`SELECT * FROM audit_log ORDER BY id DESC LIMIT 10`),
    shidduchStats(),
  ]);
  res.render('admin/dashboard', { title: 'פארוואלטונג', counts, recentImports, recentAudit, stats, tgStatus: telegramStatus() });
}));

function telegramStatus() {
  return {
    configured: tg.telegramConfigured(),
    mode: telegramMode(),
    sources: allowedChatIds(),
    outgoing: outgoingChatId(),
    publicUrl: config.publicUrl,
    ...(getSetting('telegram_status') || {}),
  };
}

// ---------- boy picker JSON (admin only; contains no extra private data) ----------
adminRouter.get('/api/boys', wrap(async (req, res) => {
  const q = String(req.query.q || '').slice(0, 120);
  if (q.trim().length < 2) return res.json({ items: [] });
  const [list, matches] = await Promise.all([listBoysAdmin({ q, limit: 10 }), findBoyMatches(q)]);
  const seen = new Set();
  const items = [];
  for (const m of [...matches.exact, ...list.map((b) => ({ ...b, via: 'search' })), ...matches.similar]) {
    if (seen.has(m.id)) continue;
    seen.add(m.id);
    items.push({ id: m.id, name: m.official_name, branch: m.branch, branchName: branches().find((b) => b.id === m.branch)?.name, via: m.via, aliases: m.alias_list || '' });
  }
  res.json({ items: items.slice(0, 12) });
}));

// Admin preview of any stored picture (including ones not publicly visible).
adminRouter.get(/^\/media\/(\d+)(\/thumb)?\.webp$/, wrap(async (req, res, next) => {
  const m = await one(`SELECT ${req.params[1] ? 'thumb' : 'data'} AS bin FROM media WHERE id=$1`, [Number(req.params[0])]);
  if (!m) return next();
  res.type('image/webp').send(m.bin);
}));

// ---------- occasions ----------
adminRouter.get('/occasions', wrap(async (req, res) => {
  const f = {
    q: String(req.query.q || ''), branch: String(req.query.branch || ''), categoryId: Number(req.query.category) || null,
    source: ['manual', 'telegram'].includes(req.query.source) ? req.query.source : null,
    review: req.query.review === '1', deleted: req.query.deleted === '1', duplicates: req.query.dups === '1',
    boyId: Number(req.query.boy) || null,
  };
  const page = Math.max(1, Number(req.query.page) || 1);
  const rows = await listAdminOccasions(f, { limit: 50, offset: (page - 1) * 50 });
  res.render('admin/occasions', { title: 'רעקארדס', rows, f, page, allCats: allCategories(), ok: req.query.ok });
}));

function formValuesFromRow(o) {
  return {
    id: o.id, boyId: o.boy_id, boyName: o.boy_name, branch: o.branch, categoryId: o.category_id, dateMode: 'greg',
    gregDate: o.greg_date, afterSunset: o.after_sunset, hebDay: o.heb_day, hebMonth: o.heb_month, hebYear: o.heb_year,
    fatherInLaw: o.father_in_law_name || '', residence: o.residence || '', familyDetails: o.family_details || '',
    showFamily: o.show_family, announcementText: o.announcement_text || '', status: o.status, source: o.source,
    importId: o.import_id, mediaIds: o.media_ids || [], duplicateOf: o.duplicate_of, needsReview: o.needs_review, reviewNote: o.review_note,
    createdAt: o.created_at, updatedAt: o.updated_at, createdBy: o.created_by, updatedBy: o.updated_by, deletedAt: o.deleted_at,
  };
}

function formValuesFromBody(b) {
  return {
    boyId: Number(b.boyId) || null, boyName: b.boyName || '', newBoyName: b.newBoyName || '', newBoyBranch: b.newBoyBranch || '',
    branch: b.branch || '', categoryId: Number(b.categoryId) || null, dateMode: b.dateMode === 'heb' ? 'heb' : 'greg',
    gregDate: b.gregDate || '', afterSunset: !!b.afterSunset, hebDay: Number(b.hebDay) || '', hebMonth: Number(b.hebMonth) || '',
    hebYear: Number(b.hebYear) || '', fatherInLaw: b.fatherInLaw || '', residence: b.residence || '', familyDetails: b.familyDetails || '',
    showFamily: !!b.showFamily, announcementText: b.announcementText || '', status: b.status === 'hidden' ? 'hidden' : 'published',
    importId: Number(b.importId) || null, sendTelegram: !!b.sendTelegram,
  };
}

async function renderOccasionForm(res, v, { error = null, suggestions = null, status = 200 } = {}) {
  const hy = new HDate().getFullYear();
  const imp = v.importId ? await one('SELECT id, raw_text, parse_result, status FROM telegram_imports WHERE id=$1', [v.importId]) : null;
  const tgLast = v.id ? await latestOutboxFor('occasion', v.id) : null;
  res.status(status).render('admin/occasion-form', {
    title: v.id ? 'רעדאקטירן רעקארד' : 'נייער רעקארד', v, error, suggestions, allCats: allCategories(), imp, tgLast,
    hebMonths: monthsOfYear(Number(v.hebYear) || hy), hebYearNow: hy, telegramReady: tg.telegramConfigured() && !!outgoingChatId(),
  });
}

adminRouter.get('/occasions/new', wrap(async (req, res) => {
  const v = formValuesFromBody({ status: 'published', showFamily: '1', gregDate: hebToday().iso });
  if (req.query.boy) {
    const b = await getBoy(Number(req.query.boy));
    if (b) Object.assign(v, { boyId: b.id, boyName: b.official_name, branch: b.branch });
  }
  if (req.query.import) {
    const imp = await one('SELECT * FROM telegram_imports WHERE id=$1', [Number(req.query.import)]);
    if (imp) {
      const p = imp.parse_result || {};
      v.importId = imp.id;
      v.gregDate = imp.message_date ? new Date(imp.message_date).toISOString().slice(0, 10) : v.gregDate;
      if (p.category?.id) v.categoryId = p.category.id;
      if (p.branchId) v.branch = p.branchId;
      if (p.boyName) v.newBoyName = p.boyName;
      if (p.fatherInLaw) v.fatherInLaw = p.fatherInLaw;
      if (p.residence) v.residence = p.residence;
    }
  }
  await renderOccasionForm(res, v);
}));

// Resolve the boy for an occasion form: existing boy, or a new one (guarded against duplicates).
async function resolveFormBoy(req, v) {
  if (v.boyId) {
    const b = await getBoy(v.boyId);
    if (!b || b.deleted_at) throw new ValidationError('דער בחור איז נישט געפונען');
    return b;
  }
  const name = String(v.newBoyName || '').trim();
  if (!name) throw new ValidationError('ביטע קלייבט א בחור אדער שרייבט א נייעם נאמען');
  const branch = isBranch(v.newBoyBranch) ? v.newBoyBranch : v.branch;
  const m = await findBoyMatches(name, branch);
  if ((m.exact.length || m.similar.length) && !req.body.confirmNewBoy) {
    const err = new ValidationError('עס זענען שוין פאראן בחורים מיט אן ענליכן נאמען. קלייבט איינעם פון זיי, אדער באשטעטיגט אז דאס איז א נייער בחור.');
    err.suggestions = [...m.exact, ...m.similar];
    throw err;
  }
  const id = await createBoy({ name, branch });
  await audit(req, 'boy_create', 'boy', id, { name });
  return getBoy(id);
}

async function saveOccasion(req, res, id) {
  const v = formValuesFromBody(req.body);
  if (id) v.id = id;
  try {
    const boy = await resolveFormBoy(req, v);
    v.boyId = boy.id;
    v.boyName = boy.official_name;
    if (!isBranch(v.branch)) v.branch = boy.branch;
    const input = {
      boyId: boy.id, branch: v.branch, categoryId: v.categoryId,
      gregDate: v.dateMode === 'greg' ? v.gregDate : null,
      hebYear: v.hebYear, hebMonth: v.hebMonth, hebDay: v.hebDay, afterSunset: v.afterSunset,
      fatherInLaw: v.fatherInLaw, residence: v.residence, familyDetails: v.familyDetails, showFamily: v.showFamily,
      announcementText: v.announcementText, status: v.status,
    };
    const newMedia = await storeUploads(req, 'pictures');
    const by = req.admin.role;
    if (id) {
      await updateOccasion(id, input, by);
      const remove = arr(req.body.removeMedia).map(Number).filter(Boolean);
      if (remove.length) await query('DELETE FROM occasion_media WHERE occasion_id=$1 AND media_id = ANY($2::bigint[])', [id, remove]);
      await query(`UPDATE telegram_imports SET status='corrected' WHERE occasion_id=$1 AND status='recognized'`, [id]);
      await audit(req, 'occasion_update', 'occasion', id);
    } else {
      id = await createOccasion(input, { source: v.importId ? 'telegram' : 'manual', importId: v.importId, by });
      if (v.importId) {
        await query(`UPDATE telegram_imports SET status='corrected', occasion_id=$2 WHERE id=$1`, [v.importId, id]);
        const imp = await one('SELECT parse_result, media_group_id, chat_id FROM telegram_imports WHERE id=$1', [v.importId]);
        if (req.body.attachImportMedia) {
          const groupMedia = imp?.media_group_id
            ? (await many('SELECT parse_result FROM telegram_imports WHERE media_group_id=$1 AND chat_id=$2', [imp.media_group_id, imp.chat_id])).map((r) => r.parse_result?.mediaId)
            : [imp?.parse_result?.mediaId];
          for (const m of groupMedia.filter(Boolean)) await addOccasionMedia(id, m);
        }
      }
      await audit(req, 'occasion_create', 'occasion', id);
    }
    for (const m of newMedia) await addOccasionMedia(id, m);
    let msg = 'אפגעהיט';
    if (v.sendTelegram) {
      try {
        const row = await getOccasion(id);
        const pub = publicOccasion(row);
        await enqueue('occasion', id, occasionMessage(pub), pub.pictures[0] ? row.media_ids[0] : null, by);
        msg += ' · געשיקט צו טעלעגראם (זעט סטאטוס)';
      } catch (err) {
        msg += ` · טעלעגראם: ${err.message}`;
      }
    }
    flash(res, `/admin/occasions/${id}/edit`, msg);
  } catch (err) {
    if (!userError(err)) throw err;
    if (id) Object.assign(v, formValuesFromRow(await getOccasion(id)), formValuesFromBody(req.body), { id });
    await renderOccasionForm(res, v, { error: err.message, suggestions: err.suggestions || null, status: 400 });
  }
}

adminRouter.post('/occasions', wrap(async (req, res) => saveOccasion(req, res, null)));

adminRouter.get('/occasions/:id/edit', wrap(async (req, res, next) => {
  const o = await getOccasion(Number(req.params.id));
  if (!o) return next();
  const v = formValuesFromRow(o);
  res.locals.ok = req.query.ok;
  await renderOccasionForm(res, v);
}));

adminRouter.post('/occasions/:id', wrap(async (req, res, next) => {
  const id = Number(req.params.id);
  if (!(await getOccasion(id))) return next();
  await saveOccasion(req, res, id);
}));

adminRouter.post('/occasions/:id/delete', wrap(async (req, res) => {
  await softDeleteOccasion(Number(req.params.id), req.admin.role);
  await audit(req, 'occasion_delete', 'occasion', req.params.id);
  flash(res, '/admin/occasions', 'דער רעקארד איז אויסגעמעקט (מען קען אים צוריקשטעלן)');
}));

adminRouter.post('/occasions/:id/restore', wrap(async (req, res) => {
  await restoreOccasion(Number(req.params.id), req.admin.role);
  await audit(req, 'occasion_restore', 'occasion', req.params.id);
  flash(res, `/admin/occasions/${req.params.id}/edit`, 'צוריקגעשטעלט');
}));

adminRouter.post('/occasions/:id/telegram', wrap(async (req, res) => {
  const id = Number(req.params.id);
  const row = await getOccasion(id);
  try {
    const pub = publicOccasion(row);
    await enqueue('occasion', id, occasionMessage(pub), pub.pictures[0] ? row.media_ids[0] : null, req.admin.role);
    await audit(req, 'telegram_send', 'occasion', id);
    flash(res, `/admin/occasions/${id}/edit`, 'געשיקט צו טעלעגראם');
  } catch (err) {
    if (!userError(err)) throw err;
    flash(res, `/admin/occasions/${id}/edit`, `טעלעגראם: ${err.message}`);
  }
}));

// ---------- boys ----------
adminRouter.get('/boys', wrap(async (req, res) => {
  const page = Math.max(1, Number(req.query.page) || 1);
  const rows = await listBoysAdmin({ q: String(req.query.q || ''), branch: String(req.query.branch || ''), limit: 60, offset: (page - 1) * 60 });
  res.render('admin/boys', { title: 'בחורים', rows, q: req.query.q || '', branchF: req.query.branch || '', page, ok: req.query.ok });
}));

adminRouter.get('/boys/new', (req, res) => res.render('admin/boy-new', { title: 'נייער בחור', v: {}, error: null, suggestions: null }));

adminRouter.post('/boys', wrap(async (req, res) => {
  const v = { name: req.body.name || '', branch: req.body.branch || '', aliases: req.body.aliases || '' };
  try {
    const m = await findBoyMatches(v.name, v.branch);
    if ((m.exact.length || m.similar.length) && !req.body.confirmNewBoy) {
      return res.status(400).render('admin/boy-new', { title: 'נייער בחור', v, error: 'עס זענען שוין פאראן בחורים מיט אן ענליכן נאמען. איז דאס א נייער בחור?', suggestions: [...m.exact, ...m.similar] });
    }
    const [photo] = await storeUploads(req, 'photo');
    const id = await createBoy({ name: v.name, branch: v.branch, aliases: String(v.aliases).split(/[,،\n]/).map((s) => s.trim()).filter(Boolean), photoMediaId: photo || null });
    await audit(req, 'boy_create', 'boy', id);
    flash(res, `/admin/boys/${id}`, 'דער בחור איז צוגעלייגט');
  } catch (err) {
    if (!userError(err)) throw err;
    res.status(400).render('admin/boy-new', { title: 'נייער בחור', v, error: err.message, suggestions: null });
  }
}));

async function renderBoy(res, id, extra = {}) {
  const boy = await getBoy(id);
  if (!boy) return false;
  const [aliases, occasions, matches] = await Promise.all([
    getAliases(id), listAdminOccasions({ boyId: id }, { limit: 200 }), findBoyMatches(boy.official_name, boy.branch),
  ]);
  const similar = [...matches.exact, ...matches.similar].filter((m) => m.id !== id);
  res.render('admin/boy', { title: boy.official_name, boy, aliases, occasions, similar, error: null, ok: res.req.query.ok, ...extra });
  return true;
}

adminRouter.get('/boys/:id', wrap(async (req, res, next) => {
  if (!(await renderBoy(res, Number(req.params.id)))) next();
}));

adminRouter.post('/boys/:id', wrap(async (req, res) => {
  const id = Number(req.params.id);
  try {
    await updateBoy(id, { name: req.body.name, branch: req.body.branch, notes: req.body.notes });
    const [photo] = await storeUploads(req, 'photo');
    if (photo) await setBoyPhoto(id, photo);
    await audit(req, 'boy_update', 'boy', id);
    flash(res, `/admin/boys/${id}`, 'אפגעהיט');
  } catch (err) {
    if (!userError(err)) throw err;
    res.status(400);
    await renderBoy(res, id, { error: err.message });
  }
}));

adminRouter.post('/boys/:id/photo/remove', wrap(async (req, res) => {
  await setBoyPhoto(Number(req.params.id), null);
  await audit(req, 'boy_photo_remove', 'boy', req.params.id);
  flash(res, `/admin/boys/${req.params.id}`, 'די בילד איז אראפגענומען');
}));

adminRouter.post('/boys/:id/aliases', wrap(async (req, res) => {
  const id = Number(req.params.id);
  try {
    await addAlias(id, req.body.alias);
    await audit(req, 'alias_add', 'boy', id, { alias: req.body.alias });
    flash(res, `/admin/boys/${id}`, 'צוגעלייגט');
  } catch (err) {
    if (!userError(err)) throw err;
    res.status(400);
    await renderBoy(res, id, { error: err.message });
  }
}));

adminRouter.post('/boys/:id/aliases/:aid/delete', wrap(async (req, res) => {
  await removeAlias(Number(req.params.id), Number(req.params.aid));
  flash(res, `/admin/boys/${req.params.id}`, 'אויסגעמעקט');
}));

adminRouter.post('/boys/:id/merge', superOnly, wrap(async (req, res) => {
  const from = Number(req.params.id), to = Number(req.body.targetId);
  try {
    await mergeBoys(from, to);
    await audit(req, 'boy_merge', 'boy', from, { into: to });
    flash(res, `/admin/boys/${to}`, 'די פראפילן זענען צוזאמגעשטעלט');
  } catch (err) {
    if (!userError(err)) throw err;
    res.status(400);
    await renderBoy(res, from, { error: err.message });
  }
}));

adminRouter.post('/boys/:id/delete', wrap(async (req, res) => {
  const id = Number(req.params.id);
  try {
    await deleteBoy(id);
    await audit(req, 'boy_delete', 'boy', id);
    flash(res, '/admin/boys', 'אויסגעמעקט');
  } catch (err) {
    if (!userError(err)) throw err;
    res.status(400);
    await renderBoy(res, id, { error: err.message });
  }
}));

// ---------- announcements ----------
adminRouter.get('/announcements', wrap(async (req, res) => {
  res.render('admin/announcements', { title: 'מודעות', rows: await listAdminAnnouncements(), ok: req.query.ok });
}));

function annValues(b) {
  return { title: b.title || '', body: b.body || '', branch: b.branch || '', eventDate: b.eventDate || '', featured: !!b.featured, published: !!b.published, sendTelegram: !!b.sendTelegram };
}

async function renderAnnForm(res, v, error = null, status = 200) {
  const tgLast = v.id ? await latestOutboxFor('announcement', v.id) : null;
  res.status(status).render('admin/announcement-form', { title: v.id ? 'רעדאקטירן מודעה' : 'נייע מודעה', v, error, tgLast, telegramReady: tg.telegramConfigured() && !!outgoingChatId() });
}

adminRouter.get('/announcements/new', wrap(async (_req, res) => renderAnnForm(res, { featured: true, published: true })));

adminRouter.get('/announcements/:id/edit', wrap(async (req, res, next) => {
  const a = await getAnnouncement(Number(req.params.id));
  if (!a) return next();
  res.locals.ok = req.query.ok;
  await renderAnnForm(res, { id: a.id, title: a.title, body: a.body, branch: a.branch || '', eventDate: a.event_date || '', featured: a.featured, published: a.published, mediaId: a.media_id });
}));

async function saveAnnouncement(req, res, id) {
  const v = annValues(req.body);
  if (id) v.id = id;
  try {
    const [mediaId] = await storeUploads(req, 'picture');
    if (id) {
      if (req.body.removePicture) await removeAnnouncementPicture(id);
      await updateAnnouncement(id, { ...v, mediaId }, req.admin.role);
      await audit(req, 'announcement_update', 'announcement', id);
    } else {
      id = await createAnnouncement({ ...v, mediaId }, req.admin.role);
      await audit(req, 'announcement_create', 'announcement', id);
    }
    let msg = 'אפגעהיט';
    // Sent to Telegram ONLY when the administrator explicitly ticked the option.
    if (v.sendTelegram) {
      try {
        const a = await getAnnouncement(id);
        await enqueue('announcement', id, announcementMessage(a), a.media_id, req.admin.role);
        await audit(req, 'telegram_send', 'announcement', id);
        msg += ' · געשיקט צו טעלעגראם';
      } catch (err) {
        msg += ` · טעלעגראם: ${err.message}`;
      }
    }
    flash(res, `/admin/announcements/${id}/edit`, msg);
  } catch (err) {
    if (!userError(err)) throw err;
    await renderAnnForm(res, v, err.message, 400);
  }
}

adminRouter.post('/announcements', wrap(async (req, res) => saveAnnouncement(req, res, null)));
adminRouter.post('/announcements/:id', wrap(async (req, res) => saveAnnouncement(req, res, Number(req.params.id))));
adminRouter.post('/announcements/:id/delete', wrap(async (req, res) => {
  await deleteAnnouncement(Number(req.params.id));
  await audit(req, 'announcement_delete', 'announcement', req.params.id);
  flash(res, '/admin/announcements', 'אויסגעמעקט');
}));

// ---------- Telegram imports & outbox ----------
adminRouter.get('/imports', wrap(async (req, res) => {
  const st = ['recognized', 'needs_review', 'ignored', 'error', 'corrected', 'echo'].includes(req.query.status) ? req.query.status : null;
  const rows = await many(
    `SELECT i.id, i.status, i.raw_text, i.received_at, i.message_date, i.chat_id, i.chat_title, i.occasion_id, i.error, i.parse_result, i.edit_count,
            o.deleted_at AS occ_deleted
     FROM telegram_imports i LEFT JOIN occasions o ON o.id = i.occasion_id
     WHERE ($1::text IS NULL OR i.status = $1) ORDER BY i.id DESC LIMIT 200`, [st]);
  const counts = await many('SELECT status, count(*)::int AS n FROM telegram_imports GROUP BY status');
  res.render('admin/imports', { title: 'טעלעגראם אימפארטן', rows, st, counts: Object.fromEntries(counts.map((c) => [c.status, c.n])), ok: req.query.ok });
}));

adminRouter.get('/imports/:id', wrap(async (req, res, next) => {
  const imp = await one('SELECT * FROM telegram_imports WHERE id=$1', [Number(req.params.id)]);
  if (!imp) return next();
  const occ = imp.occasion_id ? await getOccasion(imp.occasion_id) : null;
  res.render('admin/import', { title: `אימפארט #${imp.id}`, imp, occ, ok: req.query.ok, error: req.query.err });
}));

adminRouter.post('/imports/:id/reprocess', wrap(async (req, res) => {
  try {
    const r = await reprocessImport(Number(req.params.id));
    await audit(req, 'import_reprocess', 'import', req.params.id, { status: r.status });
    flash(res, `/admin/imports${r.importId ? '/' + r.importId : ''}`, `נאכאמאל פראצעסירט: ${r.status}`);
  } catch (err) {
    res.redirect(`/admin/imports/${req.params.id}?err=${encodeURIComponent(err.message)}`);
  }
}));

adminRouter.post('/imports/:id/ignore', wrap(async (req, res) => {
  await query(`UPDATE telegram_imports SET status='ignored' WHERE id=$1 AND occasion_id IS NULL`, [Number(req.params.id)]);
  await audit(req, 'import_ignore', 'import', req.params.id);
  flash(res, '/admin/imports', 'איגנארירט');
}));

adminRouter.get('/telegram', wrap(async (req, res) => {
  res.render('admin/telegram', { title: 'טעלעגראם', outbox: await listOutbox(100), st: telegramStatus(), ok: req.query.ok, err: req.query.err });
}));

adminRouter.post('/outbox/:id/retry', wrap(async (req, res) => {
  await retryOutbox(Number(req.params.id));
  await audit(req, 'outbox_retry', 'outbox', req.params.id);
  flash(res, '/admin/telegram', 'ווידער פרובירט');
}));

adminRouter.post('/telegram/check', superOnly, wrap(async (req, res) => {
  try {
    const me = await tg.getMe();
    let info = null;
    try { info = await tg.getWebhookInfo(); } catch { /* ignore */ }
    await setSetting('telegram_status', { ...(getSetting('telegram_status') || {}), botUsername: me.username, botName: me.first_name, checkedAt: new Date().toISOString(), lastError: info?.last_error_message || null, pendingUpdates: info?.pending_update_count ?? null, webhookUrl: info?.url || null });
    flash(res, '/admin/telegram', `פארבינדונג גוט: @${me.username}`);
  } catch (err) {
    res.redirect(`/admin/telegram?err=${encodeURIComponent(err.message)}`);
  }
}));

adminRouter.post('/telegram/webhook', superOnly, wrap(async (req, res) => {
  try {
    await registerWebhook();
    await audit(req, 'telegram_webhook_register');
    flash(res, '/admin/telegram', 'וועבהוק רעגיסטרירט');
  } catch (err) {
    res.redirect(`/admin/telegram?err=${encodeURIComponent(err.message)}`);
  }
}));

// ---------- super administrator: categories ----------
adminRouter.get('/categories', superOnly, (req, res) => {
  res.render('admin/categories', { title: 'קאטעגאריעס', cats: allCategories(), error: req.query.err || null, ok: req.query.ok });
});

adminRouter.post('/categories', superOnly, wrap(async (req, res) => {
  try {
    await createCategory({ name: req.body.name, kind: req.body.kind, keywords: req.body.keywords, countsForShidduch: !!req.body.countsForShidduch });
    await audit(req, 'category_create', 'category', null, { name: req.body.name });
    flash(res, '/admin/categories', 'צוגעלייגט');
  } catch (err) {
    res.redirect(`/admin/categories?err=${encodeURIComponent(err.message)}`);
  }
}));

adminRouter.post('/categories/:id', superOnly, wrap(async (req, res) => {
  try {
    await updateCategory(Number(req.params.id), {
      name: req.body.name, enabled: !!req.body.enabled, keywords: req.body.keywords, countsForShidduch: !!req.body.countsForShidduch, kind: req.body.kind,
    });
    await reindexAllOccasions();
    await audit(req, 'category_update', 'category', req.params.id);
    flash(res, '/admin/categories', 'אפגעהיט');
  } catch (err) {
    res.redirect(`/admin/categories?err=${encodeURIComponent(err.message)}`);
  }
}));

adminRouter.post('/categories/:id/move', superOnly, wrap(async (req, res) => {
  await moveCategory(Number(req.params.id), req.body.dir === 'up' ? 'up' : 'down');
  res.redirect('/admin/categories');
}));

// ---------- super administrator: settings, PINs, integrations ----------
adminRouter.get('/settings', superOnly, (req, res) => {
  res.render('admin/settings', {
    title: 'סיסטעם איינשטעלונגען', ok: req.query.ok, error: req.query.err || null,
    s: {
      school_name: getSetting('school_name'), school_tagline: getSetting('school_tagline'),
      telegram_auto_publish: getSetting('telegram_auto_publish') !== false, telegram_publish_pictures: getSetting('telegram_publish_pictures') !== false,
      telegram_source_chat_ids: getSetting('telegram_source_chat_ids') || '', telegram_outgoing_chat_id: getSetting('telegram_outgoing_chat_id') || '',
      env_sources: config.telegram.sourceChatIds, env_outgoing: config.telegram.outgoingChatId,
    },
    tgStatus: telegramStatus(), hasLogo: !!getSetting('logo_media_id'),
  });
});

const chatIdList = (s) => String(s || '').split(/[,\s]+/).filter(Boolean).filter((x) => /^-?\d{3,20}$|^@[A-Za-z0-9_]{4,64}$/.test(x)).join(',');

adminRouter.post('/settings', superOnly, wrap(async (req, res) => {
  const name = String(req.body.school_name || '').trim().slice(0, 120);
  if (name.length < 2) return res.redirect('/admin/settings?err=' + encodeURIComponent('דער נאמען פון דער ישיבה איז צו קורץ'));
  await setSetting('school_name', name);
  await setSetting('school_tagline', String(req.body.school_tagline || '').trim().slice(0, 200));
  await setSetting('telegram_auto_publish', !!req.body.telegram_auto_publish);
  await setSetting('telegram_publish_pictures', !!req.body.telegram_publish_pictures);
  await setSetting('telegram_source_chat_ids', chatIdList(req.body.telegram_source_chat_ids));
  await setSetting('telegram_outgoing_chat_id', chatIdList(req.body.telegram_outgoing_chat_id).split(',')[0] || '');
  const [logo] = await storeUploads(req, 'logo', 'system');
  if (logo) await setSetting('logo_media_id', logo);
  if (req.body.removeLogo) await setSetting('logo_media_id', null);
  await audit(req, 'settings_update');
  flash(res, '/admin/settings', 'אפגעהיט');
}));

adminRouter.post('/settings/branches', superOnly, wrap(async (req, res) => {
  const out = {};
  for (const id of BRANCH_IDS) {
    const name = String(req.body[`name_${id}`] || '').trim().slice(0, 60);
    if (name.length < 2) return res.redirect('/admin/settings?err=' + encodeURIComponent('יעדער סניף דארף א נאמען'));
    out[id] = {
      name,
      description: String(req.body[`desc_${id}`] || '').trim().slice(0, 500),
      keywords: String(req.body[`kw_${id}`] || '').split(/[,\n]/).map((s) => s.trim()).filter((s) => s.length >= 2).slice(0, 30),
    };
  }
  await setSetting('branches', out);
  await reindexAllOccasions();
  await audit(req, 'branches_update');
  flash(res, '/admin/settings', 'די סניפים זענען אפגעהיט');
}));

adminRouter.post('/settings/pins', superOnly, wrap(async (req, res) => {
  const { role, current, pin, pin2 } = req.body;
  const back = (msg, ok = false) => res.redirect(`/admin/settings?${ok ? 'ok' : 'err'}=${encodeURIComponent(msg)}`);
  if (!['admin', 'super'].includes(role)) return back('אומגילטיגע ראלע');
  if (!(await verifyPin(String(current || ''), getSetting('pin_super')))) return back('דער איצטיגער הויפט-פין איז נישט ריכטיג');
  if (!validPinFormat(pin)) return back('א פין-קאד מוז זיין 6 ביז 12 ציפערן');
  if (pin !== pin2) return back('די צוויי פין-קאדס שטימען נישט');
  const other = role === 'admin' ? getSetting('pin_super') : getSetting('pin_admin');
  if (await verifyPin(pin, other)) return back('די צוויי ראלעס מוזן האבן פארשידענע פין-קאדס');
  await setSetting(role === 'admin' ? 'pin_admin' : 'pin_super', await hashPin(pin));
  await revokeAllSessions(role === 'admin' ? 'admin' : 'super');
  await audit(req, 'pin_change', 'role', role);
  if (role === 'super') return res.redirect('/admin/login');
  back('דער פין-קאד איז געטוישט; אלע אדמיניסטראטארן מוזן זיך ווידער אריינלאגן', true);
}));

// ---------- super administrator: duplicates, audit, backup ----------
adminRouter.get('/duplicates', superOnly, wrap(async (req, res) => {
  const [pairs, dupOccasions] = await Promise.all([
    suspectedDuplicateBoys(),
    listAdminOccasions({ duplicates: true }, { limit: 100 }),
  ]);
  res.render('admin/duplicates', { title: 'דופליקאטן', pairs, dupOccasions, ok: req.query.ok, error: req.query.err || null });
}));

adminRouter.post('/duplicates/merge', superOnly, wrap(async (req, res) => {
  try {
    await mergeBoys(Number(req.body.fromId), Number(req.body.toId));
    await audit(req, 'boy_merge', 'boy', req.body.fromId, { into: req.body.toId });
    flash(res, '/admin/duplicates', 'צוזאמגעשטעלט');
  } catch (err) {
    res.redirect('/admin/duplicates?err=' + encodeURIComponent(err.message));
  }
}));

adminRouter.post('/duplicates/occasion/:id/hide', superOnly, wrap(async (req, res) => {
  await query(`UPDATE occasions SET status='hidden', updated_at=now(), updated_by=$2 WHERE id=$1`, [Number(req.params.id), req.admin.role]);
  await audit(req, 'occasion_hide_duplicate', 'occasion', req.params.id);
  flash(res, '/admin/duplicates', 'באהאלטן');
}));

adminRouter.post('/duplicates/occasion/:id/not-duplicate', superOnly, wrap(async (req, res) => {
  await query('UPDATE occasions SET duplicate_of=NULL WHERE id=$1', [Number(req.params.id)]);
  flash(res, '/admin/duplicates', 'אפגעצייכנט');
}));

adminRouter.get('/audit', superOnly, wrap(async (_req, res) => {
  res.render('admin/audit', { title: 'אקטיוויטעט', rows: await many('SELECT * FROM audit_log ORDER BY id DESC LIMIT 300') });
}));

adminRouter.get('/backup.json', superOnly, wrap(async (req, res) => {
  const { exportAll } = await import('../backup.js');
  const data = await exportAll({ includeMedia: req.query.media === '1' });
  await audit(req, 'backup_download', null, null, { media: req.query.media === '1' });
  res.set('Content-Disposition', `attachment; filename="school-backup-${new Date().toISOString().slice(0, 10)}.json"`);
  res.json(data);
}));

