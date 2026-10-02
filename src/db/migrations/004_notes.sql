-- Markdown a *user* wrote, as opposed to the knowledge base an admin maintains.
--
-- In the database and not on the volume, because these belong to one user and
-- one chatbot: the per-assistant directories under ASSISTANTS_DIR are shared by
-- everyone who may use that chatbot, which is the wrong boundary for this.
CREATE TABLE IF NOT EXISTS notes (
  id           INTEGER     GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id      INTEGER     NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  assistant_id INTEGER     NOT NULL REFERENCES assistants(id) ON DELETE CASCADE,
  name         TEXT        NOT NULL,
  -- Comma-separated once normalized (parseTags in notes.ts). Not a TEXT[]:
  -- nothing queries by tag, and a plain column keeps the repo uniform.
  tags         TEXT        NOT NULL DEFAULT '',
  content      TEXT        NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The list is "mine, for this chatbot, most recently touched first".
CREATE INDEX IF NOT EXISTS idx_notes_owner ON notes(user_id, assistant_id, updated_at DESC);
