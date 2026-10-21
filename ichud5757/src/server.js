import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import helmet from 'helmet';
import compression from 'compression';
import cookieParser from 'cookie-parser';
import { config } from './config.js';
import { pool } from './db.js';
import { migrate } from './migrate.js';
import { loadSettings, publicSettings } from './settings.js';
import { loadCategories, enabledCategories } from './repo/categories.js';
import { branches } from './branches.js';
import { bootstrapPins, loadSession, cleanupSessions } from './auth.js';
import * as hebrew from './hebrew.js';
import { publicRouter } from './routes/public.js';
import { apiRouter } from './routes/api.js';
import { adminRouter } from './routes/admin.js';
import { telegramRouter } from './routes/telegram.js';
import { startTelegram } from './telegram/runner.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

export function createApp() {
  const app = express();
  app.set('trust proxy', 1);
  app.set('view engine', 'ejs');
  app.set('views', path.join(root, 'views'));
  app.disable('x-powered-by');

  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", 'https://fonts.googleapis.com'],
        fontSrc: ["'self'", 'https://fonts.gstatic.com'],
        imgSrc: ["'self'", 'data:'],
        connectSrc: ["'self'"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
        upgradeInsecureRequests: config.isProd ? [] : null,
      },
    },
    crossOriginEmbedderPolicy: false,
  }));
  app.use(compression());
  app.use(cookieParser());
  app.use(express.urlencoded({ extended: false, limit: '200kb' }));
  app.use('/static', express.static(path.join(root, 'public'), { maxAge: config.isProd ? '7d' : 0 }));

  app.get('/healthz', async (_req, res) => {
    try { await pool.query('SELECT 1'); res.json({ ok: true }); } catch { res.status(503).json({ ok: false }); }
  });

  // Telegram webhook is mounted before session handling; it has its own secret-token check.
  app.use('/telegram', telegramRouter);

  app.use(loadSession);
  app.use((req, res, next) => {
    res.locals.settings = publicSettings();
    res.locals.branches = branches();
    res.locals.categories = enabledCategories();
    res.locals.admin = req.admin || null;
    res.locals.path = req.path;
    res.locals.query = req.query;
    res.locals.today = hebrew.today();
    res.locals.h = hebrew;
    res.locals.logoUrl = '/logo';
    res.locals.title = '';
    next();
  });

  app.use('/api', apiRouter);
  app.use('/admin', adminRouter);
  app.use('/', publicRouter);

  app.use((req, res) => {
    res.status(404).render('error', { title: 'נישט געפונען', message: 'די בלאט וואס איר זוכט עקזיסטירט נישט.' });
  });

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, _next) => {
    const status = err.status || err.statusCode || 500;
    if (status >= 500) console.error('[error]', req.method, req.originalUrl, err);
    const message = status === 413 ? 'די טעקע איז צו גרויס.' : status >= 500 ? 'א טעות איז פארגעקומען. ביטע פרובירט נאכאמאל.' : (err.publicMessage || 'אומגילטיגע בקשה.');
    if (req.originalUrl.startsWith('/api/')) return res.status(status).json({ error: message });
    res.status(status).render('error', { title: 'טעות', message });
  });
  return app;
}

export async function init() {
  await migrate();
  await loadSettings();
  await loadCategories();
  await bootstrapPins();
}

async function waitForDatabase() {
  const onRailway = !!(process.env.RAILWAY_ENVIRONMENT || process.env.RAILWAY_PROJECT_ID);
  if (onRailway && !process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is not set. In Railway: add a PostgreSQL database to the project, then in this service\'s Variables add DATABASE_URL = ${{Postgres.DATABASE_URL}}');
  }
  // The database may still be starting right after a deploy; retry for up to ~60 seconds.
  for (let i = 1; ; i++) {
    try {
      await pool.query('SELECT 1');
      return;
    } catch (err) {
      if (i >= 20) throw new Error(`cannot connect to the database (${err.code || err.message}). Check DATABASE_URL.`);
      console.log(`[db] waiting for database (${err.code || err.message}), attempt ${i}`);
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
}

async function main() {
  await waitForDatabase();
  await init();
  const app = createApp();
  const server = app.listen(config.port, () => console.log(`[server] listening on ${config.port}`));
  if (!config.disableBackgroundJobs) {
    startTelegram().catch((e) => console.error('[telegram] start failed', e.message));
    setInterval(() => cleanupSessions().catch(() => {}), 3600e3).unref();
  }
  const shutdown = () => { server.close(() => pool.end().then(() => process.exit(0))); setTimeout(() => process.exit(0), 8000).unref(); };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((err) => { console.error('[fatal]', err); process.exit(1); });
}
