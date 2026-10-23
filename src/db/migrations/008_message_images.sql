-- Images a model generated, one row per image, beside the message that carries
-- the prompt and the model's accompanying text.
--
-- In the database and not on the volume, for the same reason as a user's own
-- documents: the per-assistant directories are shared by everyone who may use
-- that chatbot, and an image belongs to one conversation. Stored as BYTEA
-- rather than the data: URL the API returns, which saves a third of the bytes
-- and keeps the decoding in one place.
--
-- They are never sent back to the model. The history replay reads
-- messages.content only, so an image costs its tokens once.
CREATE TABLE IF NOT EXISTS message_images (
  id         INTEGER     GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  message_id INTEGER     NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  mime_type  TEXT        NOT NULL,
  bytes      BYTEA       NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_message_images_message ON message_images(message_id, id);
