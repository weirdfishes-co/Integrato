-- What a chatbot does: text->text, text->image, speech->text, text->speech.
--
-- On the assistants row rather than in assistant_settings because it decides
-- which settings exist at all, and a value that governs the others is identity
-- rather than one of them. Defaults to 'text', so every existing chatbot keeps
-- behaving exactly as it did.
ALTER TABLE assistants ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'text';

ALTER TABLE assistants DROP CONSTRAINT IF EXISTS assistants_kind_check;
ALTER TABLE assistants ADD CONSTRAINT assistants_kind_check
  CHECK (kind IN ('text', 'image', 'transcribe', 'speech'));
