-- Multiple assistants: each with its own knowledge base, settings and users.
--
-- Existing rows carry a NULL assistant_id until the boot-time backfill in
-- app.ts attaches them to the assistant created from ASSISTANT_NAME, so this
-- migration stays pure SQL and loses nothing.

CREATE TABLE IF NOT EXISTS assistants (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  -- Used in the URL (/a/<slug>) and as the knowledge-base directory name.
  slug        TEXT    NOT NULL UNIQUE,
  name        TEXT    NOT NULL,
  description TEXT    NOT NULL DEFAULT '',
  language    TEXT    NOT NULL DEFAULT 'English',
  created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- The rights matrix: which user may use which assistant. Admins are not listed
-- here; they may use every assistant by virtue of being an admin.
CREATE TABLE IF NOT EXISTS assistant_users (
  assistant_id INTEGER NOT NULL REFERENCES assistants(id) ON DELETE CASCADE,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  granted_at   TEXT    NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (assistant_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_assistant_users_user ON assistant_users(user_id);

-- Replaces the single global settings table; that one is left in place so the
-- backfill can copy it into the first assistant.
CREATE TABLE IF NOT EXISTS assistant_settings (
  assistant_id INTEGER NOT NULL REFERENCES assistants(id) ON DELETE CASCADE,
  key          TEXT    NOT NULL,
  value        TEXT    NOT NULL,
  updated_at   TEXT    NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (assistant_id, key)
);

ALTER TABLE conversations ADD COLUMN assistant_id INTEGER REFERENCES assistants(id) ON DELETE CASCADE;
ALTER TABLE memories      ADD COLUMN assistant_id INTEGER REFERENCES assistants(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS idx_conversations_assistant
  ON conversations(user_id, assistant_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_memories_assistant
  ON memories(user_id, assistant_id, id);
