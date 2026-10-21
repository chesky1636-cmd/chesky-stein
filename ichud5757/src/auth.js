// Two administrative roles, each with its own PIN. PINs are stored only as scrypt hashes.
// Authorization is enforced on the server for every admin route (requireRole), never by hiding buttons.
import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { config } from './config.js';
import { one, query } from './db.js';
import { getSetting, setSetting } from './settings.js';

const scrypt = promisify(crypto.scrypt);
const SESSION_HOURS = 12;
const COOKIE = 'adm';
const MAX_FAILS_PER_IP = 5;
const MAX_FAILS_GLOBAL = 40;
const WINDOW_MIN = 15;

export const ROLE_NAMES = { admin: 'אדמיניסטראטאר', super: 'הויפט-אדמיניסטראטאר' };

export async function hashPin(pin) {
  const salt = crypto.randomBytes(16);
  const hash = await scrypt(String(pin), salt, 64, { N: 16384, r: 8, p: 1 });
  return { algo: 'scrypt', salt: salt.toString('base64'), hash: hash.toString('base64') };
}

export async function verifyPin(pin, stored) {
  if (!stored?.salt || !stored?.hash) return false;
  const hash = await scrypt(String(pin), Buffer.from(stored.salt, 'base64'), 64, { N: 16384, r: 8, p: 1 });
  const expected = Buffer.from(stored.hash, 'base64');
  return expected.length === hash.length && crypto.timingSafeEqual(expected, hash);
}

export function validPinFormat(pin) {
  return /^\d{6,12}$/.test(String(pin || ''));
}

// On boot: seed PIN hashes from env if none stored yet (or when RESET_PINS=true for recovery).
export async function bootstrapPins() {
  for (const [key, seed] of [['pin_admin', config.adminPinSeed], ['pin_super', config.superPinSeed]]) {
    if (!seed) continue;
    if (getSetting(key) && !config.resetPins) continue;
    if (!/^\d{4,12}$/.test(seed)) {
      console.error(`[auth] ${key === 'pin_admin' ? 'ADMIN_PIN' : 'SUPER_ADMIN_PIN'} must be 4-12 digits; ignored`);
      continue;
    }
    await setSetting(key, await hashPin(seed));
    console.log(`[auth] ${key} initialised from environment`);
  }
}

export function pinsConfigured() {
  return { admin: !!getSetting('pin_admin'), super: !!getSetting('pin_super') };
}

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

export async function tooManyFailures(ip) {
  const r = await one(
    `SELECT count(*) FILTER (WHERE ip = $1) AS mine, count(*) AS total FROM login_failures
     WHERE at > now() - ($2 || ' minutes')::interval`,
    [ip, String(WINDOW_MIN)],
  );
  return Number(r.mine) >= MAX_FAILS_PER_IP || Number(r.total) >= MAX_FAILS_GLOBAL;
}

export async function recordFailure(ip) {
  await query('INSERT INTO login_failures (ip) VALUES ($1)', [ip]);
  await query("DELETE FROM login_failures WHERE at < now() - interval '1 day'");
}

// Returns the role matching the PIN, or null. The super PIN is checked first.
export async function roleForPin(pin) {
  if (!/^\d{4,12}$/.test(String(pin || ''))) return null;
  if (await verifyPin(pin, getSetting('pin_super'))) return 'super';
  if (await verifyPin(pin, getSetting('pin_admin'))) return 'admin';
  return null;
}

export async function createSession(res, req, role) {
  const token = crypto.randomBytes(32).toString('base64url');
  await query(
    `INSERT INTO admin_sessions (token_hash, role, ip, user_agent, expires_at)
     VALUES ($1, $2, $3, $4, now() + ($5 || ' hours')::interval)`,
    [sha(token), role, req.ip, String(req.get('user-agent') || '').slice(0, 300), String(SESSION_HOURS)],
  );
  res.cookie(COOKIE, token, {
    httpOnly: true, sameSite: 'strict', secure: config.isProd, maxAge: SESSION_HOURS * 3600e3, path: '/',
  });
}

export async function destroySession(req, res) {
  const token = req.cookies?.[COOKIE];
  if (token) await query('DELETE FROM admin_sessions WHERE token_hash = $1', [sha(token)]);
  res.clearCookie(COOKIE, { path: '/' });
}

export async function revokeAllSessions(role) {
  await query('DELETE FROM admin_sessions WHERE role = $1', [role]);
}

// Attaches req.admin = {role, csrf} when a valid session cookie is present.
export async function loadSession(req, _res, next) {
  try {
    const token = req.cookies?.[COOKIE];
    if (token && token.length < 100) {
      const s = await one('SELECT role FROM admin_sessions WHERE token_hash = $1 AND expires_at > now()', [sha(token)]);
      if (s) {
        const csrf = crypto.createHmac('sha256', token).update('csrf').digest('base64url');
        req.admin = { role: s.role, roleName: ROLE_NAMES[s.role], csrf, isSuper: s.role === 'super' };
      }
    }
    next();
  } catch (err) {
    next(err);
  }
}

export function requireRole(role) {
  return (req, res, next) => {
    if (!req.admin) {
      if (req.path.startsWith('/api/') || req.xhr) return res.status(401).json({ error: 'נישט אריינגעלאגט' });
      return res.redirect('/admin/login?next=' + encodeURIComponent(req.originalUrl));
    }
    if (role === 'super' && req.admin.role !== 'super') {
      return res.status(403).render('error', { title: 'נישט ערלויבט', message: 'די בלאט איז נאר פאר א הויפט-אדמיניסטראטאר.' });
    }
    next();
  };
}

// CSRF protection for all state-changing admin requests.
export function checkCsrf(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const sent = req.body?._csrf || req.get('x-csrf-token');
  if (!req.admin || !sent || sent !== req.admin.csrf) {
    return res.status(403).render('error', { title: 'זיכערהייט טעות', message: 'די בלאט איז אויסגעגאנגען. ביטע לאדט איבער און פרובירט נאכאמאל.' });
  }
  next();
}

export async function cleanupSessions() {
  await query('DELETE FROM admin_sessions WHERE expires_at < now()');
}
