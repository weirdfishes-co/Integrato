-- Addresses a chatbot used to have. A slug can be changed after creation, and
-- /<old-slug> then redirects to the new one instead of turning into a 404 for
-- everyone who bookmarked or shared the link.
--
-- slug is the key, not the pair: an address points at one chatbot at a time.
-- A live assistants.slug always wins over a row here, so reusing an old
-- address for a new chatbot needs no cleanup.
CREATE TABLE IF NOT EXISTS assistant_slug_history (
  slug         TEXT        PRIMARY KEY,
  assistant_id INTEGER     NOT NULL REFERENCES assistants(id) ON DELETE CASCADE,
  retired_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_slug_history_assistant ON assistant_slug_history(assistant_id);
