// Starts Telegram intake in webhook or polling mode and keeps status information for the admin panel.
import crypto from 'node:crypto';
import { config, telegramMode } from '../config.js';
import { getSetting, setSetting } from '../settings.js';
import * as tg from './client.js';
import { handleUpdate } from './importer.js';
import { processOutbox } from './outbox.js';

export function webhookSecret() {
  if (config.telegram.webhookSecret) return config.telegram.webhookSecret;
  // Derived from the token so it is stable and secret without extra configuration.
  return crypto.createHmac('sha256', config.telegram.token || 'none').update('webhook-secret').digest('hex').slice(0, 48);
}

async function status(patch) {
  await setSetting('telegram_status', { ...(getSetting('telegram_status') || {}), ...patch });
}

let polling = false;
let stopRequested = false;

async function pollLoop() {
  polling = true;
  let offset = Number(getSetting('telegram_offset') || 0);
  while (!stopRequested) {
    try {
      const updates = await tg.getUpdates(offset || undefined, 25);
      for (const u of updates) {
        await handleUpdate(u);
        offset = u.update_id + 1;
        await setSetting('telegram_offset', offset);
      }
      await status({ pollingOkAt: new Date().toISOString() });
    } catch (err) {
      await status({ lastError: err.message, lastErrorAt: new Date().toISOString() }).catch(() => {});
      await new Promise((r) => setTimeout(r, 10000));
    }
  }
  polling = false;
}

export async function startTelegram() {
  const mode = telegramMode();
  await status({ mode, startedAt: new Date().toISOString() }).catch(() => {});
  if (mode === 'off') return;
  try {
    const me = await tg.getMe();
    await status({ botUsername: me.username, botName: me.first_name, lastError: null });
  } catch (err) {
    await status({ lastError: err.message, lastErrorAt: new Date().toISOString() });
  }
  if (mode === 'webhook') {
    await registerWebhook().catch(() => {});
  } else if (mode === 'polling') {
    await tg.deleteWebhook().catch(() => {});
    pollLoop();
  }
  setInterval(() => processOutbox().catch(() => {}), 30000).unref();
}

export async function registerWebhook() {
  if (!config.publicUrl) throw new tg.TelegramError('PUBLIC_URL / RAILWAY_PUBLIC_DOMAIN איז נישט באשטימט');
  const url = `${config.publicUrl}/telegram/webhook`;
  try {
    await tg.setWebhook(url, webhookSecret());
    await status({ webhookUrl: url, webhookSetAt: new Date().toISOString(), lastError: null });
  } catch (err) {
    await status({ lastError: err.message, lastErrorAt: new Date().toISOString() });
    throw err;
  }
}

export function stopTelegram() {
  stopRequested = true;
}

export function isPolling() {
  return polling;
}
