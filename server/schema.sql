CREATE TABLE IF NOT EXISTS em_users (
  id            SERIAL PRIMARY KEY,
  name          TEXT NOT NULL,
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'staff' CHECK (role IN ('admin', 'staff')),
  active        BOOLEAN NOT NULL DEFAULT TRUE,
  signature_html TEXT NOT NULL DEFAULT '',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_login_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS em_sessions (
  token_hash TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES em_users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  user_agent TEXT
);

CREATE TABLE IF NOT EXISTS em_login_failures (
  id  SERIAL PRIMARY KEY,
  key TEXT NOT NULL,
  at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS em_login_failures_key ON em_login_failures (key, at);

CREATE TABLE IF NOT EXISTS em_settings (
  key        TEXT PRIMARY KEY,
  value      JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS em_messages (
  id          SERIAL PRIMARY KEY,
  user_id     INTEGER REFERENCES em_users(id) ON DELETE SET NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('single', 'bulk')),
  subject     TEXT NOT NULL DEFAULT '',
  html        TEXT NOT NULL DEFAULT '',
  from_name   TEXT NOT NULL DEFAULT '',
  reply_to    TEXT NOT NULL DEFAULT '',
  cc          TEXT NOT NULL DEFAULT '',
  bcc         TEXT NOT NULL DEFAULT '',
  add_unsubscribe BOOLEAN NOT NULL DEFAULT FALSE,
  source      TEXT NOT NULL DEFAULT '',
  status      TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'sending', 'paused', 'done', 'failed', 'cancelled')),
  base_url    TEXT NOT NULL DEFAULT '',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at  TIMESTAMPTZ,
  finished_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS em_messages_user ON em_messages (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS em_messages_created ON em_messages (created_at DESC);

CREATE TABLE IF NOT EXISTS em_recipients (
  id         BIGSERIAL PRIMARY KEY,
  message_id INTEGER NOT NULL REFERENCES em_messages(id) ON DELETE CASCADE,
  email      TEXT NOT NULL,
  name       TEXT NOT NULL DEFAULT '',
  data       JSONB NOT NULL DEFAULT '{}'::jsonb,
  status     TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sending', 'sent', 'failed', 'skipped')),
  error      TEXT,
  attempts   INTEGER NOT NULL DEFAULT 0,
  claimed_at TIMESTAMPTZ,
  sent_at    TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS em_recipients_msg ON em_recipients (message_id, status, id);
CREATE INDEX IF NOT EXISTS em_recipients_sent ON em_recipients (sent_at) WHERE status = 'sent';

CREATE TABLE IF NOT EXISTS em_attachments (
  id           SERIAL PRIMARY KEY,
  message_id   INTEGER NOT NULL REFERENCES em_messages(id) ON DELETE CASCADE,
  filename     TEXT NOT NULL,
  content_type TEXT NOT NULL DEFAULT 'application/octet-stream',
  size         INTEGER NOT NULL,
  data         BYTEA NOT NULL
);
CREATE INDEX IF NOT EXISTS em_attachments_msg ON em_attachments (message_id);

CREATE TABLE IF NOT EXISTS em_lists (
  id         SERIAL PRIMARY KEY,
  name       TEXT NOT NULL,
  user_id    INTEGER REFERENCES em_users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS em_contacts (
  id         SERIAL PRIMARY KEY,
  list_id    INTEGER NOT NULL REFERENCES em_lists(id) ON DELETE CASCADE,
  email      TEXT NOT NULL,
  name       TEXT NOT NULL DEFAULT '',
  data       JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (list_id, email)
);

CREATE TABLE IF NOT EXISTS em_templates (
  id         SERIAL PRIMARY KEY,
  name       TEXT NOT NULL,
  subject    TEXT NOT NULL DEFAULT '',
  html       TEXT NOT NULL DEFAULT '',
  user_id    INTEGER REFERENCES em_users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS em_suppressions (
  email      TEXT PRIMARY KEY,
  reason     TEXT NOT NULL DEFAULT 'unsubscribed',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Open tracking (added after the first release, so applied as ALTERs).
ALTER TABLE em_messages ADD COLUMN IF NOT EXISTS track_opens BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE em_recipients ADD COLUMN IF NOT EXISTS open_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE em_recipients ADD COLUMN IF NOT EXISTS opened_at TIMESTAMPTZ;
ALTER TABLE em_recipients ADD COLUMN IF NOT EXISTS last_opened_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS em_recipients_email ON em_recipients (email);
CREATE INDEX IF NOT EXISTS em_contacts_email ON em_contacts (email);

-- Supabase exposes the public schema through its REST API. Row level security with no policies
-- blocks that API completely; this app connects as the database owner, which is not affected.
ALTER TABLE em_users ENABLE ROW LEVEL SECURITY;
ALTER TABLE em_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE em_login_failures ENABLE ROW LEVEL SECURITY;
ALTER TABLE em_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE em_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE em_recipients ENABLE ROW LEVEL SECURITY;
ALTER TABLE em_attachments ENABLE ROW LEVEL SECURITY;
ALTER TABLE em_lists ENABLE ROW LEVEL SECURITY;
ALTER TABLE em_contacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE em_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE em_suppressions ENABLE ROW LEVEL SECURITY;
