// Public JSON API. Everything here passes through the privacy serializers in privacy.js.
import express from 'express';
import rateLimit from 'express-rate-limit';
import { isBranch } from '../branches.js';
import { publicOccasion, publicBoy } from '../privacy.js';
import { listPublicOccasions } from '../repo/occasions.js';
import { categoryByKey } from '../repo/categories.js';
import { shidduchStats } from '../repo/stats.js';
import { search } from '../repo/search.js';
import { calendarMonth } from '../calendar.js';
import { parseIsoDate } from '../hebrew.js';
import { one } from '../db.js';

export const apiRouter = express.Router();
apiRouter.use(rateLimit({ windowMs: 60_000, limit: 120, standardHeaders: 'draft-7', legacyHeaders: false, message: { error: 'צו פיל בקשות, ווארט א מינוט' } }));
const wrap = (fn) => (req, res, next) => fn(req, res, next).catch(next);
const q = (req, k) => (typeof req.query[k] === 'string' ? req.query[k] : '');
const br = (req) => (isBranch(q(req, 'branch')) ? q(req, 'branch') : null);

apiRouter.get('/stats', wrap(async (_req, res) => res.json(await shidduchStats())));

apiRouter.get('/occasions', wrap(async (req, res) => {
  const cat = categoryByKey(q(req, 'category'));
  const rows = await listPublicOccasions(
    { branch: br(req), categoryKey: cat?.key, from: parseIsoDate(q(req, 'from')) ? q(req, 'from') : undefined, to: parseIsoDate(q(req, 'to')) ? q(req, 'to') : undefined },
    { limit: Math.min(Number(q(req, 'limit')) || 20, 100), offset: Number(q(req, 'offset')) || 0 });
  res.json({ items: rows.map((r) => publicOccasion(r, res.locals.today.iso)) });
}));

apiRouter.get('/day', wrap(async (req, res) => {
  const date = q(req, 'date');
  if (!parseIsoDate(date)) return res.status(400).json({ error: 'אומגילטיגער דאטום' });
  const rows = await listPublicOccasions({ branch: br(req), date }, { limit: 100 });
  res.json({ date, items: rows.map((r) => publicOccasion(r, res.locals.today.iso)) });
}));

apiRouter.get('/calendar', wrap(async (req, res) => {
  res.json(await calendarMonth({ year: q(req, 'y'), month: q(req, 'm'), branch: br(req), todayIso: res.locals.today.iso }));
}));

apiRouter.get('/search', wrap(async (req, res) => {
  const r = await search(q(req, 'q').slice(0, 200), { branch: br(req) || undefined }, { limit: 8 });
  res.json({
    boys: r.boys.slice(0, 6).map(publicBoy),
    occasions: r.occasions.map((o) => publicOccasion(o, res.locals.today.iso)),
    total: r.total,
  });
}));

apiRouter.get('/boys/:id', wrap(async (req, res) => {
  const id = Number(req.params.id);
  const boy = Number.isInteger(id) ? await one('SELECT * FROM boys WHERE id=$1 AND deleted_at IS NULL', [id]) : null;
  if (!boy) return res.status(404).json({ error: 'נישט געפונען' });
  const rows = await listPublicOccasions({ boyId: id }, { limit: 200, order: 'asc' });
  res.json({ boy: publicBoy(boy), timeline: rows.map((r) => publicOccasion(r, res.locals.today.iso)) });
}));
