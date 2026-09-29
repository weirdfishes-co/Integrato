-- What an exchange cost, kept on the assistant message that closed it.
--
-- Nullable rather than defaulted to zero: a user's own message never has usage,
-- and neither does any message written before this column existed. Zero would
-- claim an answer was free, which is a different statement from "not recorded".
ALTER TABLE messages ADD COLUMN IF NOT EXISTS prompt_tokens INTEGER;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS completion_tokens INTEGER;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS reasoning_tokens INTEGER;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS cached_tokens INTEGER;
-- OpenRouter bills to eight decimal places and a cheap answer costs a few
-- millionths of a dollar, so this is NUMERIC and not a float.
ALTER TABLE messages ADD COLUMN IF NOT EXISTS cost NUMERIC(14, 10);
