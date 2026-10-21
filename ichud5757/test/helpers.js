// Test harness: real Postgres test database + a local mock of the Telegram Bot API.
import http from 'node:http';
import sharp from 'sharp';

export const mockTg = { sent: [], photos: [], webhooks: [], failNextSend: 0, files: new Map() };
let tgServer;

export async function startMockTelegram() {
  tgServer = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks);
    const m = /^\/bot([^/]+)\/(\w+)$/.exec(req.url) || /^\/file\/bot([^/]+)\/(.+)$/.exec(req.url);
    const json = (o) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(o)); };
    if (!m || m[1] !== 'TEST:TOKEN') { res.statusCode = 401; return json({ ok: false, error_code: 401, description: 'Unauthorized' }); }
    if (req.url.startsWith('/file/')) { const f = mockTg.files.get(m[2]); if (!f) { res.statusCode = 404; return res.end(); } return res.end(f); }
    const method = m[2];
    const params = req.headers['content-type']?.includes('json') ? JSON.parse(body.toString() || '{}') : {};
    switch (method) {
      case 'getMe': return json({ ok: true, result: { id: 1, is_bot: true, first_name: 'Test', username: 'test_bot' } });
      case 'getFile': return json({ ok: true, result: { file_id: params.file_id, file_path: `photos/${params.file_id}.jpg`, file_size: mockTg.files.get(`photos/${params.file_id}.jpg`)?.length } });
      case 'setWebhook': mockTg.webhooks.push(params); return json({ ok: true, result: true });
      case 'deleteWebhook': return json({ ok: true, result: true });
      case 'getWebhookInfo': return json({ ok: true, result: { url: mockTg.webhooks.at(-1)?.url || '', pending_update_count: 0 } });
      case 'sendMessage':
      case 'sendPhoto': {
        if (mockTg.failNextSend > 0) { mockTg.failNextSend--; res.statusCode = 500; return json({ ok: false, error_code: 500, description: 'Internal Server Error' }); }
        const id = 5000 + mockTg.sent.length;
        mockTg.sent.push({ method, params, bodyLength: body.length, id });
        return json({ ok: true, result: { message_id: id, chat: { id: -100999 } } });
      }
      default: return json({ ok: false, error_code: 404, description: 'Not Found' });
    }
  });
  await new Promise((r) => tgServer.listen(0, r));
  return `http://127.0.0.1:${tgServer.address().port}`;
}

export async function addMockPhoto(fileId) {
  let h = 0;
  for (const ch of fileId) h = (h * 31 + ch.charCodeAt(0)) % 255;
  const buf = await sharp({ create: { width: 900, height: 600, channels: 3, background: { r: h, g: 170, b: 255 - h } } }).jpeg().toBuffer();
  mockTg.files.set(`photos/${fileId}.jpg`, buf);
  return buf;
}

export async function setupEnv() {
  const base = await startMockTelegram();
  Object.assign(process.env, {
    DATABASE_URL: process.env.TEST_DATABASE_URL || 'postgres://postgres@localhost:5432/school_test',
    TELEGRAM_BOT_TOKEN: 'TEST:TOKEN',
    TELEGRAM_API_BASE: base,
    TELEGRAM_SOURCE_CHAT_IDS: '-100111',
    TELEGRAM_CHANNEL_ID: '-100999',
    TELEGRAM_WEBHOOK_SECRET: 'whsecret',
    TELEGRAM_MODE: 'off',
    ADMIN_PIN: '123456',
    SUPER_ADMIN_PIN: '987654',
    DISABLE_BACKGROUND_JOBS: '1',
    SCHOOL_TZ: 'America/New_York',
  });
  const { pool } = await import('../src/db.js');
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  const { init, createApp } = await import('../src/server.js');
  await init();
  const app = createApp();
  const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
  const url = `http://127.0.0.1:${server.address().port}`;
  return {
    url, pool,
    async close() { server.close(); tgServer.close(); await pool.end(); },
  };
}

// Minimal cookie-keeping client for admin flows.
export function client(base) {
  let cookie = '';
  async function req(path, opts = {}) {
    const res = await fetch(base + path, { redirect: 'manual', ...opts, headers: { ...(opts.headers || {}), cookie } });
    const set = res.headers.getSetCookie?.() || [];
    for (const c of set) { const kv = c.split(';')[0]; if (kv.endsWith('=')) cookie = ''; else cookie = kv; }
    return res;
  }
  return {
    get: (p) => req(p),
    async text(p) { const r = await req(p); return { status: r.status, body: await r.text(), location: r.headers.get('location') }; },
    async post(p, data, { multipart = false } = {}) {
      let body;
      if (multipart) { body = new FormData(); for (const [k, v] of Object.entries(data)) { for (const one of [].concat(v)) body.append(k, one); } }
      else body = new URLSearchParams(Object.entries(data).flatMap(([k, v]) => [].concat(v).map((x) => [k, x])));
      const r = await req(p, { method: 'POST', body });
      return { status: r.status, body: await r.text(), location: r.headers.get('location') };
    },
    async csrf(p = '/admin') { const r = await this.text(p); return /name="_csrf" value="([^"]+)"/.exec(r.body)?.[1]; },
  };
}

let updateId = 1000, messageId = 1;
export function channelPost(text, extra = {}) {
  return {
    update_id: updateId++,
    channel_post: { message_id: messageId++, date: Math.floor(Date.parse('2026-10-20T15:00:00Z') / 1000), chat: { id: -100111, type: 'channel', title: 'ישיבה מודעות' }, text, ...extra },
  };
}

export async function postWebhook(url, update, secret = 'whsecret') {
  const r = await fetch(`${url}/telegram/webhook`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': secret }, body: JSON.stringify(update) });
  return r.status;
}
