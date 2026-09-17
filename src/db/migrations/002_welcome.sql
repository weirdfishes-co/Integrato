-- A greeting shown in an empty conversation, set per coachbot.
-- Empty means "use the built-in sentence", so existing rows need no backfill.

ALTER TABLE assistants ADD COLUMN IF NOT EXISTS welcome TEXT NOT NULL DEFAULT '';
