-- Images and now audio: the same thing — bytes a model produced, belonging to
-- one message — so one table rather than two of identical shape. The mime type
-- already says which it is, and the route that serves them does not care.
ALTER TABLE IF EXISTS message_images RENAME TO message_media;
ALTER INDEX IF EXISTS idx_message_images_message RENAME TO idx_message_media_message;

CREATE TABLE IF NOT EXISTS message_media (
  id         INTEGER     GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  message_id INTEGER     NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  mime_type  TEXT        NOT NULL,
  bytes      BYTEA       NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_message_media_message ON message_media(message_id, id);
