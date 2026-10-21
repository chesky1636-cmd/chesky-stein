import express from 'express';
import crypto from 'node:crypto';
import { config } from '../config.js';
import { webhookSecret } from '../telegram/runner.js';
import { handleUpdate } from '../telegram/importer.js';

export const telegramRouter = express.Router();

// Telegram calls this URL with the secret token header that was registered via setWebhook.
telegramRouter.post('/webhook', express.json({ limit: '1mb' }), async (req, res) => {
  if (!config.telegram.token) return res.sendStatus(404);
  const got = Buffer.from(String(req.get('x-telegram-bot-api-secret-token') || ''));
  const want = Buffer.from(webhookSecret());
  if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) return res.sendStatus(401);
  try {
    await handleUpdate(req.body);
  } catch (err) {
    console.error('[telegram] webhook error', err.message);
  }
  // Always acknowledge so Telegram does not retry endlessly; failures are logged in telegram_imports.
  res.json({ ok: true });
});
