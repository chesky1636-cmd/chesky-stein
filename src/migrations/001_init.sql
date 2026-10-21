-- Initial schema. Branches are fixed in code (src/branches.js); the CHECK constraints below
-- make it impossible for any code path to store a fifth branch.

CREATE TABLE settings (
  key        text PRIMARY KEY,
  value      jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Pictures are stored in Postgres so they survive redeploys and are covered by database backups.
CREATE TABLE media (
  id         bigserial PRIMARY KEY,
  mime       text NOT NULL DEFAULT 'image/webp',
  data       bytea NOT NULL,
  thumb      bytea NOT NULL,
  width      int,
  height     int,
  bytes      int,
  sha256     text NOT NULL,
  source     text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'telegram', 'system')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX media_sha_idx ON media (sha256);

CREATE TABLE categories (
  id                  serial PRIMARY KEY,
  key                 text UNIQUE NOT NULL,
  name                text NOT NULL,
  -- behaviour of the category: controls privacy rules, templates and statistics
  kind                text NOT NULL CHECK (kind IN ('shidduch', 'tenaim', 'wedding', 'birth_boy', 'upsheren', 'other')),
  sort_order          int NOT NULL DEFAULT 100,
  enabled             boolean NOT NULL DEFAULT true,
  counts_for_shidduch boolean NOT NULL DEFAULT false,
  keywords            text[] NOT NULL DEFAULT '{}',
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

INSERT INTO categories (key, name, kind, sort_order, counts_for_shidduch, keywords) VALUES
  ('shidduch', 'שידוך',     'shidduch', 10, true,  ARRAY['שידוך','שידוכין','אירוסין','אירוסיו','ווארט','פארלאבט','נתקשר','נתקשרו','קשרי']),
  ('tenaim',   'תנאים',     'tenaim',   20, true,  ARRAY['תנאים','כתיבת התנאים']),
  ('wedding',  'חתונה',     'wedding',  30, true,  ARRAY['חתונה','חתונת','נישואין','נישואיו','נשואי','חופה','חופתו']),
  ('birth',    'בן זכר',    'birth_boy',40, false, ARRAY['בן זכר','בבן זכר','להולדת הבן','נולד לו בן','א אינגל','שלום זכר']),
  ('upsheren', 'אפשערן',    'upsheren', 50, false, ARRAY['אפשערן','אפשערנס','חלאקה','חאלאקה','תספורת']),
  ('other',    'אנדערע שמחות','other',  60, false, ARRAY['בר מצוה','הכנסת ספר תורה']);

CREATE TABLE boys (
  id             serial PRIMARY KEY,
  official_name  text NOT NULL CHECK (length(official_name) BETWEEN 2 AND 120),
  name_key       text NOT NULL,
  name_skel      text NOT NULL,
  branch         text NOT NULL CHECK (branch IN ('b1', 'b2', 'b3', 'b4')),
  photo_media_id bigint REFERENCES media(id) ON DELETE SET NULL,
  admin_notes    text,
  search_key     text NOT NULL DEFAULT '',
  merged_into    int REFERENCES boys(id) ON DELETE SET NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  deleted_at     timestamptz
);
CREATE INDEX boys_name_key_idx ON boys (name_key);
CREATE INDEX boys_skel_idx ON boys (name_skel);
CREATE INDEX boys_branch_idx ON boys (branch) WHERE deleted_at IS NULL;

CREATE TABLE boy_aliases (
  id        serial PRIMARY KEY,
  boy_id    int NOT NULL REFERENCES boys(id) ON DELETE CASCADE,
  alias     text NOT NULL CHECK (length(alias) BETWEEN 2 AND 120),
  alias_key text NOT NULL,
  UNIQUE (boy_id, alias_key)
);
CREATE INDEX boy_aliases_key_idx ON boy_aliases (alias_key);

CREATE TABLE telegram_imports (
  id             serial PRIMARY KEY,
  update_id      bigint,
  chat_id        bigint NOT NULL,
  chat_title     text,
  message_id     bigint NOT NULL,
  media_group_id text,
  message_date   timestamptz,
  raw_text       text NOT NULL DEFAULT '',
  raw_json       jsonb NOT NULL,
  status         text NOT NULL CHECK (status IN ('recognized', 'needs_review', 'ignored', 'error', 'corrected', 'echo')),
  parse_result   jsonb,
  error          text,
  occasion_id    int,
  edit_count     int NOT NULL DEFAULT 0,
  received_at    timestamptz NOT NULL DEFAULT now(),
  processed_at   timestamptz,
  UNIQUE (chat_id, message_id)
);
CREATE INDEX telegram_imports_status_idx ON telegram_imports (status, received_at DESC);
CREATE INDEX telegram_imports_group_idx ON telegram_imports (media_group_id) WHERE media_group_id IS NOT NULL;

CREATE TABLE occasions (
  id                 serial PRIMARY KEY,
  boy_id             int NOT NULL REFERENCES boys(id) ON DELETE RESTRICT,
  branch             text NOT NULL CHECK (branch IN ('b1', 'b2', 'b3', 'b4')),
  category_id        int NOT NULL REFERENCES categories(id) ON DELETE RESTRICT,
  greg_date          date NOT NULL,
  after_sunset       boolean NOT NULL DEFAULT false,
  heb_year           int NOT NULL,
  heb_month          int NOT NULL CHECK (heb_month BETWEEN 1 AND 13),
  heb_day            int NOT NULL CHECK (heb_day BETWEEN 1 AND 30),
  heb_date_text      text NOT NULL,
  father_in_law_name text CHECK (length(father_in_law_name) <= 160),
  residence          text CHECK (length(residence) <= 160),
  family_details     text CHECK (length(family_details) <= 400),
  show_family        boolean NOT NULL DEFAULT true,
  announcement_text  text CHECK (length(announcement_text) <= 4000),
  status             text NOT NULL DEFAULT 'published' CHECK (status IN ('published', 'hidden')),
  source             text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'telegram')),
  import_id          int REFERENCES telegram_imports(id) ON DELETE SET NULL,
  duplicate_of       int REFERENCES occasions(id) ON DELETE SET NULL,
  needs_review       boolean NOT NULL DEFAULT false,
  review_note        text,
  occ_key            text NOT NULL DEFAULT '',
  created_by         text,
  updated_by         text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  deleted_at         timestamptz
);
CREATE INDEX occasions_boy_idx ON occasions (boy_id) WHERE deleted_at IS NULL;
CREATE INDEX occasions_date_idx ON occasions (greg_date DESC) WHERE deleted_at IS NULL;
CREATE INDEX occasions_heb_idx ON occasions (heb_year, heb_month, heb_day) WHERE deleted_at IS NULL;
CREATE INDEX occasions_cat_idx ON occasions (category_id, branch) WHERE deleted_at IS NULL;

ALTER TABLE telegram_imports ADD CONSTRAINT telegram_imports_occasion_fk
  FOREIGN KEY (occasion_id) REFERENCES occasions(id) ON DELETE SET NULL;

CREATE TABLE occasion_media (
  occasion_id int NOT NULL REFERENCES occasions(id) ON DELETE CASCADE,
  media_id    bigint NOT NULL REFERENCES media(id) ON DELETE CASCADE,
  sort_order  int NOT NULL DEFAULT 0,
  PRIMARY KEY (occasion_id, media_id)
);

CREATE TABLE announcements (
  id                  serial PRIMARY KEY,
  title               text NOT NULL CHECK (length(title) BETWEEN 2 AND 200),
  body                text NOT NULL DEFAULT '' CHECK (length(body) <= 8000),
  branch              text CHECK (branch IN ('b1', 'b2', 'b3', 'b4')),
  featured            boolean NOT NULL DEFAULT true,
  published           boolean NOT NULL DEFAULT true,
  event_date          date,
  media_id            bigint REFERENCES media(id) ON DELETE SET NULL,
  created_by          text,
  updated_by          text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  deleted_at          timestamptz
);

CREATE TABLE telegram_outbox (
  id                  serial PRIMARY KEY,
  kind                text NOT NULL CHECK (kind IN ('announcement', 'occasion')),
  ref_id              int NOT NULL,
  chat_id             text NOT NULL,
  text                text NOT NULL,
  media_id            bigint REFERENCES media(id) ON DELETE SET NULL,
  status              text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sending', 'sent', 'failed')),
  attempts            int NOT NULL DEFAULT 0,
  next_attempt_at     timestamptz NOT NULL DEFAULT now(),
  error               text,
  telegram_message_id bigint,
  created_by          text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  sent_at             timestamptz
);
CREATE INDEX telegram_outbox_status_idx ON telegram_outbox (status, next_attempt_at);
CREATE INDEX telegram_outbox_ref_idx ON telegram_outbox (kind, ref_id);

CREATE TABLE admin_sessions (
  token_hash text PRIMARY KEY,
  role       text NOT NULL CHECK (role IN ('admin', 'super')),
  ip         text,
  user_agent text,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);

CREATE TABLE login_failures (
  id  bigserial PRIMARY KEY,
  ip  text NOT NULL,
  at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX login_failures_ip_idx ON login_failures (ip, at);

CREATE TABLE audit_log (
  id        bigserial PRIMARY KEY,
  at        timestamptz NOT NULL DEFAULT now(),
  role      text,
  action    text NOT NULL,
  entity    text,
  entity_id text,
  details   jsonb,
  ip        text
);
CREATE INDEX audit_log_at_idx ON audit_log (at DESC);
