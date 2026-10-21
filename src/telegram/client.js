// Minimal Telegram Bot API client. The bot token is used only here, on the server. Error messages
// are built from Telegram's `description` field and never include the request URL (which holds the token).
import { config } from '../config.js';

export class TelegramError extends Error {
  constructor(message, { code = null, retryAfter = null } = {}) {
    super(message);
    this.code = code;
    this.retryAfter = retryAfter;
  }
}

export function telegramConfigured() {
  return !!config.telegram.token;
}

async function call(method, { json, form, timeoutMs = 20000 } = {}) {
  if (!config.telegram.token) throw new TelegramError('טעלעגראם איז נישט קאנפיגורירט (TELEGRAM_BOT_TOKEN פעלט)');
  const url = `${config.telegram.apiBase}/bot${config.telegram.token}/${method}`;
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: json ? { 'content-type': 'application/json' } : undefined,
      body: json ? JSON.stringify(json) : form,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    throw new TelegramError(`קיין פארבינדונג מיט טעלעגראם (${err.name === 'TimeoutError' ? 'timeout' : 'network'})`);
  }
  let data;
  try { data = await res.json(); } catch { throw new TelegramError(`אומגילטיגער ענטפער פון טעלעגראם (HTTP ${res.status})`, { code: res.status }); }
  if (!data.ok) {
    throw new TelegramError(String(data.description || `HTTP ${res.status}`).replace(config.telegram.token, '***'), {
      code: data.error_code, retryAfter: data.parameters?.retry_after ?? null,
    });
  }
  return data.result;
}

export const getMe = () => call('getMe');
export const getWebhookInfo = () => call('getWebhookInfo');
export const setWebhook = (url, secret) => call('setWebhook', {
  json: { url, secret_token: secret, allowed_updates: ['channel_post', 'edited_channel_post', 'message', 'edited_message'], drop_pending_updates: false },
});
export const deleteWebhook = () => call('deleteWebhook', { json: { drop_pending_updates: false } });
export const getUpdates = (offset, timeout = 25) => call('getUpdates', {
  json: { offset, timeout, allowed_updates: ['channel_post', 'edited_channel_post', 'message', 'edited_message'] },
  timeoutMs: (timeout + 10) * 1000,
});

export async function sendMessage(chatId, text) {
  return call('sendMessage', { json: { chat_id: chatId, text, parse_mode: 'HTML', link_preview_options: { is_disabled: true } } });
}

export async function sendPhoto(chatId, buffer, caption) {
  const form = new FormData();
  form.append('chat_id', String(chatId));
  form.append('caption', caption);
  form.append('parse_mode', 'HTML');
  form.append('photo', new Blob([buffer], { type: 'image/jpeg' }), 'photo.jpg');
  return call('sendPhoto', { form, timeoutMs: 60000 });
}

export async function downloadFile(fileId, maxBytes = 20 * 1024 * 1024) {
  const f = await call('getFile', { json: { file_id: fileId } });
  if (!f.file_path) throw new TelegramError('טעלעגראם האט נישט געגעבן קיין טעקע');
  if (f.file_size && f.file_size > maxBytes) throw new TelegramError('די בילד איז צו גרויס');
  let res;
  try {
    res = await fetch(`${config.telegram.apiBase}/file/bot${config.telegram.token}/${f.file_path}`, { signal: AbortSignal.timeout(60000) });
  } catch {
    throw new TelegramError('די בילד האט זיך נישט געלאזט אראפלאדן');
  }
  if (!res.ok) throw new TelegramError(`די בילד האט זיך נישט געלאזט אראפלאדן (HTTP ${res.status})`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > maxBytes) throw new TelegramError('די בילד איז צו גרויס');
  return buf;
}
