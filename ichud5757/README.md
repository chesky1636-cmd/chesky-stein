# Yiddish School Database (שמחות דאטנבאזע)

A public, fully right-to-left Yiddish website for the school's four branches. It covers shidduchim, tena'im, weddings, births of boys, upsheren and other occasions, plus a Jewish calendar, shidduch statistics, Telegram import and optional Telegram sending, and strict privacy rules.

## Stack

- **Node.js 20+ / Express**, with server-rendered EJS pages and a little progressive-enhancement JS. Every page also works without JavaScript.
- **PostgreSQL** (Railway's managed database). All records and all **pictures** are stored in Postgres, so they survive redeploys and are included in database backups.
- **@hebcal/core** for Jewish dates: leap years, Adar I/II, holidays, and sunset for the configured location.
- **sharp** for picture optimisation: auto-rotate, strip EXIF, WebP, 1600px main image plus a 480px thumbnail.

## Main features

| Area | Where |
|---|---|
| Four fixed branches (cannot be added or removed; DB `CHECK` constraints) | `src/branches.js` |
| Privacy rules (the only path from DB rows to public output) | `src/privacy.js` |
| Shidduch statistics (distinct boys; never double counts) | `src/repo/stats.js` |
| Telegram recognition and import | `src/telegram/parser.js`, `src/telegram/importer.js` |
| Outgoing Telegram (only when the admin ticks "send") | `src/telegram/outbox.js` |
| Admin / super-admin (hashed PINs, sessions, CSRF, rate limit) | `src/auth.js`, `src/routes/admin.js` |
| Migrations | `src/migrations/*.sql` (applied automatically on start) |

### Privacy guarantees

- No field exists for a wife's name or picture, and none is ever output.
- **Birth (בן זכר):** the public page shows only "… האט געהאט א בן זכר" and the date. The stored text and pictures of birth records are never shown, never searchable, and never served at `/media/...`.
- **Upsheren:** fixed text with no child name and no family details.
- The wife's father and the residence are shown only for shidduch, tena'im and wedding records, and only if "show family details" is ticked.
- **Telegram imports:** the public text is *generated* from the recognised fields. The original post (which may contain the bride's or baby's name) is visible to admins only.
- A picture is served publicly only while a public record references it.

## Deploying on Railway

1. Create a new Railway project from this GitHub repo. The app lives in the `ichud5757` folder, so in the service's Settings → Source set **Root Directory** to `/ichud5757`.
2. Add a **PostgreSQL** database to the project. In the web service's Variables, set `DATABASE_URL=${{Postgres.DATABASE_URL}}`.
3. Under Settings → Networking, generate a public domain. Railway then sets `RAILWAY_PUBLIC_DOMAIN`, which the app uses for the Telegram webhook.
4. Set these variables:

| Variable | Required | Notes |
|---|---|---|
| `DATABASE_URL` | yes | reference to the Railway Postgres |
| `NODE_ENV` | yes | `production` |
| `ADMIN_PIN` | yes | 4–12 digits; hashed into the DB on first start |
| `SUPER_ADMIN_PIN` | yes | must differ from `ADMIN_PIN` |
| `TELEGRAM_BOT_TOKEN` | for Telegram | from @BotFather. **Only ever set here.** |
| `TELEGRAM_SOURCE_CHAT_IDS` | for imports | comma-separated chat IDs to import from (also editable in the admin settings) |
| `TELEGRAM_CHANNEL_ID` | for sending | channel to post to (also editable in the admin settings) |
| `TELEGRAM_WEBHOOK_SECRET` | optional | otherwise derived from the token |
| `SCHOOL_LATITUDE` / `SCHOOL_LONGITUDE` / `SCHOOL_TZ` | recommended | used for sunset; defaults to Brooklyn, `America/New_York` |
| `RESET_PINS` | recovery only | `true` re-seeds both PINs from the variables; remove it afterwards |

Healthcheck: `/healthz` (configured in `railway.json`). Migrations run automatically at startup, guarded by an advisory lock.

### Telegram setup

1. Create a bot with @BotFather and put the token in `TELEGRAM_BOT_TOKEN`.
2. Add the bot as an **administrator** of the school announcement channel. It needs permission to post if you want outgoing announcements.
3. Post anything in the channel. On **Admin → טעלעגראם סטאטוס**, "last incoming" shows the channel's chat ID (for example `-1001234567890`). Put that ID into `TELEGRAM_SOURCE_CHAT_IDS` and/or `TELEGRAM_CHANNEL_ID`, or enter it in the super-admin settings.
4. On a public domain the bot uses a webhook (`/telegram/webhook`, protected by Telegram's secret-token header). Without one it falls back to long polling.

Posts are recognised either as free text ("מזל טוב! הבה"ח … לרגל אירוסיו עב"ג בת ר' …") or in a labelled format:

```
קאטעגאריע: שידוך
נאמען: יואל משה פריעדמאן
סניף: בארא פארק
שווער: ר' אברהם גרין
וואוינונג: וויליאמסבורג
דאטום: כ"ה תשרי תשפ"ז
```

Recognised posts are published automatically. Unrecognised posts wait under **טעלעגראם אימפארטן**, where an admin can create the record from them in one click. Super admins can extend recognition with category keywords and branch keywords.

### Backups

- Railway Postgres has its own backups. Enable them on the database service.
- In addition, the super admin can download a JSON export from **Settings → באקאפ**, with or without pictures.
- From the command line: `npm run backup` (includes pictures) and `npm run restore backup.json` (into an empty database).

## Development

```bash
cp .env.example .env          # set DATABASE_URL, ADMIN_PIN, SUPER_ADMIN_PIN
npm install
node --env-file=.env src/server.js
npm test                      # needs a Postgres database named school_test (or TEST_DATABASE_URL)
```

The tests use a real Postgres database and a local mock of the Telegram Bot API. They cover imports, duplicate deliveries, reposts, spelling variants, albums, edits, echo suppression, outgoing sends with retries, privacy in every public output, statistics, calendar, search, PIN hashing, CSRF, role enforcement and rate limiting.

## After deploying, set

- The real **branch names** and the **school name**, and upload the **official logo**, under Admin → איינשטעלונגען. The branches start as סניף א׳–ד׳.
