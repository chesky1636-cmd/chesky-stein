// Non-secret, system-wide settings stored in the database with an in-memory cache.
// Secrets (bot token, DATABASE_URL) are never stored here; PIN hashes are, and are never sent to views.
import { many, query } from './db.js';

const DEFAULTS = {
  school_name: 'די ישיבה',
  school_tagline: 'שמחות, ידיעות און סטאטיסטיק פון אלע פיר סניפים',
  telegram_auto_publish: true,
  telegram_publish_pictures: true,
  telegram_source_chat_ids: '',
  telegram_outgoing_chat_id: '',
  logo_media_id: null,
  branches: {},
};

const SECRET_KEYS = new Set(['pin_admin', 'pin_super']);
let cache = new Map();

export async function loadSettings() {
  const rows = await many('SELECT key, value FROM settings');
  cache = new Map(rows.map((r) => [r.key, r.value]));
}

export function getSetting(key) {
  if (cache.has(key)) return cache.get(key);
  return DEFAULTS[key] ?? null;
}

export async function setSetting(key, value) {
  await query(
    `INSERT INTO settings (key, value, updated_at) VALUES ($1, $2::jsonb, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [key, JSON.stringify(value)],
  );
  cache.set(key, value);
}

// Settings that are safe to render in pages.
export function publicSettings() {
  const out = {};
  for (const k of Object.keys(DEFAULTS)) if (!SECRET_KEYS.has(k)) out[k] = getSetting(k);
  return out;
}
