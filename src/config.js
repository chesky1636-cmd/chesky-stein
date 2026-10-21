// All deployment-specific configuration comes from environment variables.
// Secrets (Telegram token, PIN seeds, DATABASE_URL) are read here only and never sent to the browser.
const env = process.env;

function bool(v, dflt = false) {
  if (v === undefined || v === '') return dflt;
  return ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase());
}

const publicDomain = env.PUBLIC_URL
  ? env.PUBLIC_URL.replace(/\/+$/, '')
  : env.RAILWAY_PUBLIC_DOMAIN
    ? `https://${env.RAILWAY_PUBLIC_DOMAIN}`
    : '';

export const config = {
  port: Number(env.PORT) || 3000,
  isProd: env.NODE_ENV === 'production',
  databaseUrl: env.DATABASE_URL || 'postgres://postgres@localhost:5432/school',
  databaseSsl: bool(env.DATABASE_SSL, false),
  publicUrl: publicDomain,
  sessionSecret: env.SESSION_SECRET || '',
  adminPinSeed: env.ADMIN_PIN || '',
  superPinSeed: env.SUPER_ADMIN_PIN || '',
  resetPins: bool(env.RESET_PINS, false),
  telegram: {
    token: env.TELEGRAM_BOT_TOKEN || '',
    apiBase: (env.TELEGRAM_API_BASE || 'https://api.telegram.org').replace(/\/+$/, ''),
    webhookSecret: env.TELEGRAM_WEBHOOK_SECRET || '',
    // 'webhook' | 'polling' | 'off'. Default: webhook when a public URL is known, else polling.
    mode: env.TELEGRAM_MODE || '',
    sourceChatIds: env.TELEGRAM_SOURCE_CHAT_IDS || '',
    outgoingChatId: env.TELEGRAM_CHANNEL_ID || '',
  },
  location: {
    latitude: Number(env.SCHOOL_LATITUDE || 40.6782),
    longitude: Number(env.SCHOOL_LONGITUDE || -73.9442),
    tz: env.SCHOOL_TZ || 'America/New_York',
  },
  maxUploadMb: Number(env.MAX_UPLOAD_MB || 12),
  disableBackgroundJobs: bool(env.DISABLE_BACKGROUND_JOBS, false),
};

export function telegramMode() {
  if (!config.telegram.token) return 'off';
  if (config.telegram.mode) return config.telegram.mode;
  return config.publicUrl ? 'webhook' : 'polling';
}
