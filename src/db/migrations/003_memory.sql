-- Cross-conversation memory and per-conversation compaction state.

CREATE TABLE IF NOT EXISTS memories (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  content     TEXT    NOT NULL,
  created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_memories_user ON memories(user_id, id);

-- Running summary of the messages that have been compacted away, plus the id of
-- the last message it covers. NULL means nothing has been compacted yet.
ALTER TABLE conversations ADD COLUMN summary TEXT;
ALTER TABLE conversations ADD COLUMN summarized_through INTEGER;
