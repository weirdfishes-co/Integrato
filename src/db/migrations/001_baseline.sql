-- Baseline schema on PostgreSQL.
--
-- This replaces the four SQLite migrations. The engine changed and no data was
-- carried across, so replaying that history would have meant porting a chain of
-- ALTERs to reach a shape we can state directly. Migrations from here on are
-- forward-only again, numbered from 002.

CREATE TABLE IF NOT EXISTS users (
  id           INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  email        TEXT        NOT NULL UNIQUE,
  is_admin     BOOLEAN     NOT NULL DEFAULT FALSE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS login_tokens (
  id         INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  token_hash TEXT        NOT NULL UNIQUE,
  user_id    INTEGER     NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at    TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_login_tokens_user ON login_tokens(user_id);

CREATE TABLE IF NOT EXISTS sessions (
  id         INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  token_hash TEXT        NOT NULL UNIQUE,
  user_id    INTEGER     NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

-- Each assistant has its own knowledge base, settings and users.
CREATE TABLE IF NOT EXISTS assistants (
  id          INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  -- Used in the URL (/a/<slug>) and as the knowledge-base directory name.
  slug        TEXT        NOT NULL UNIQUE,
  name        TEXT        NOT NULL,
  description TEXT        NOT NULL DEFAULT '',
  language    TEXT        NOT NULL DEFAULT 'English',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The rights matrix. Admins are not listed here; they may use every assistant
-- by virtue of being an admin.
CREATE TABLE IF NOT EXISTS assistant_users (
  assistant_id INTEGER     NOT NULL REFERENCES assistants(id) ON DELETE CASCADE,
  user_id      INTEGER     NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  granted_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (assistant_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_assistant_users_user ON assistant_users(user_id);

CREATE TABLE IF NOT EXISTS assistant_settings (
  assistant_id INTEGER     NOT NULL REFERENCES assistants(id) ON DELETE CASCADE,
  key          TEXT        NOT NULL,
  value        TEXT        NOT NULL,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (assistant_id, key)
);

CREATE TABLE IF NOT EXISTS conversations (
  id                 INTEGER     GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id            INTEGER     NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  assistant_id       INTEGER     NOT NULL REFERENCES assistants(id) ON DELETE CASCADE,
  title              TEXT        NOT NULL DEFAULT 'New conversation',
  -- Running summary of the messages compaction has folded away, and the id of
  -- the last message it covers.
  summary            TEXT,
  summarized_through INTEGER,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_conversations_assistant
  ON conversations(user_id, assistant_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS messages (
  id              INTEGER     GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  conversation_id INTEGER     NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role            TEXT        NOT NULL CHECK (role IN ('user', 'assistant')),
  content         TEXT        NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id, id);

-- Durable facts about a user, per assistant.
CREATE TABLE IF NOT EXISTS memories (
  id           INTEGER     GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id      INTEGER     NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  assistant_id INTEGER     NOT NULL REFERENCES assistants(id) ON DELETE CASCADE,
  content      TEXT        NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_memories_assistant ON memories(user_id, assistant_id, id);
