// Outgoing announcements. Something is sent to Telegram ONLY when an administrator explicitly ticks
// "send to Telegram"; that creates an outbox row which is delivered with retries and full status logging.
import { config } from '../config.js';
import { many, one, query } from '../db.js';
import { getSetting } from '../settings.js';
import { sendMessage, sendPhoto, telegramConfigured, TelegramError } from './client.js';
import sharp from 'sharp';

const BACKOFF_MIN = [1, 5, 15, 60];
const MAX_ATTEMPTS = 5;

export const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function outgoingChatId() {
  return String(getSetting('telegram_outgoing_chat_id') || config.telegram.outgoingChatId || '').trim();
}

export function announcementMessage(a) {
  const link = config.publicUrl ? `\n\n${config.publicUrl}/announcement/${a.id}` : '';
  return `<b>${esc(a.title)}</b>${a.body ? `\n\n${esc(a.body)}` : ''}${link}`;
}

export function occasionMessage(pub) {
  const link = config.publicUrl ? `\n\n${config.publicUrl}${pub.url}` : '';
  return `<b>${esc(pub.category.name)}</b> · ${esc(pub.branch.name)}\n${esc(pub.text)}\n${esc(pub.date.hebrew)}${link}`;
}

export async function enqueue(kind, refId, text, mediaId, by) {
  const chatId = outgoingChatId();
  if (!telegramConfigured()) throw new TelegramError('טעלעגראם איז נישט קאנפיגורירט אויפן סערווער');
  if (!chatId) throw new TelegramError('קיין ציל-קאנאל איז נישט באשטימט (טעלעגראם קאנאל ID)');
  const row = await one(
    `INSERT INTO telegram_outbox (kind, ref_id, chat_id, text, media_id, created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
    [kind, refId, chatId, text.slice(0, 4000), mediaId || null, by]);
  processOutbox().catch((e) => console.error('[outbox]', e.message));
  return row.id;
}

async function deliver(item) {
  if (item.media_id) {
    const m = await one('SELECT data FROM media WHERE id=$1', [item.media_id]);
    if (m) {
      const jpeg = await sharp(m.data).jpeg({ quality: 88 }).toBuffer();
      if (item.text.length <= 1000) return sendPhoto(item.chat_id, jpeg, item.text);
      await sendPhoto(item.chat_id, jpeg, '');
    }
  }
  return sendMessage(item.chat_id, item.text);
}

let running = false;
export async function processOutbox() {
  if (running) return;
  running = true;
  try {
    for (;;) {
      const item = await one(
        `UPDATE telegram_outbox SET status='sending', attempts=attempts+1 WHERE id = (
           SELECT id FROM telegram_outbox WHERE status='pending' AND next_attempt_at <= now() ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED)
         RETURNING *`);
      if (!item) break;
      try {
        const res = await deliver(item);
        await query(`UPDATE telegram_outbox SET status='sent', sent_at=now(), error=NULL, telegram_message_id=$2 WHERE id=$1`, [item.id, res?.message_id ?? null]);
      } catch (err) {
        const final = item.attempts >= MAX_ATTEMPTS || (err.code && err.code >= 400 && err.code < 500 && err.code !== 429);
        const waitMin = err.retryAfter ? Math.ceil(err.retryAfter / 60) : BACKOFF_MIN[Math.min(item.attempts - 1, BACKOFF_MIN.length - 1)];
        await query(
          `UPDATE telegram_outbox SET status=$2, error=$3, next_attempt_at=now() + ($4 || ' minutes')::interval WHERE id=$1`,
          [item.id, final ? 'failed' : 'pending', String(err.message).slice(0, 500), String(waitMin)]);
      }
    }
    // Rows stuck in 'sending' (e.g. after a crash) go back to the queue.
    await query(`UPDATE telegram_outbox SET status='pending' WHERE status='sending' AND next_attempt_at < now() - interval '10 minutes'`);
  } finally {
    running = false;
  }
}

export async function retryOutbox(id) {
  await query(`UPDATE telegram_outbox SET status='pending', next_attempt_at=now(), attempts=0 WHERE id=$1 AND status='failed'`, [id]);
  processOutbox().catch(() => {});
}

export async function listOutbox(limit = 100) {
  return many('SELECT id, kind, ref_id, chat_id, text, status, attempts, error, telegram_message_id, created_by, created_at, sent_at FROM telegram_outbox ORDER BY id DESC LIMIT $1', [limit]);
}

export async function latestOutboxFor(kind, refId) {
  return one('SELECT * FROM telegram_outbox WHERE kind=$1 AND ref_id=$2 ORDER BY id DESC LIMIT 1', [kind, refId]);
}
