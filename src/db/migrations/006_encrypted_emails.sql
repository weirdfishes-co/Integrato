-- Email addresses are stored encrypted. The cipher key lives in the
-- environment (EMAIL_ENCRYPTION_KEY), so the existing rows cannot be converted
-- here: the server does that at boot (protectEmails in repo.ts), row by row,
-- and clears the plaintext as it goes.
--
--   email_enc   the address, AES-256-GCM
--   email_hash  HMAC of the normalized address: lookups and uniqueness
--
-- email stays only until that backfill has run; it is nullable so new rows
-- never write it.
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_enc TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_hash TEXT;
ALTER TABLE users ALTER COLUMN email DROP NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email_hash ON users(email_hash);
