import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes } from 'node:crypto';

/**
 * Encrypts personal data at rest. Two derived keys come from one secret, so
 * that the key which encrypts is never the key which indexes:
 *
 *   - AES-256-GCM for the value itself. A random IV makes every ciphertext
 *     different, which is exactly why it cannot be looked up or kept UNIQUE.
 *   - HMAC-SHA-256 as a "blind index": the same address always gives the same
 *     digest, so `WHERE email_hash = $1` and a UNIQUE constraint still work,
 *     and the digest cannot be reversed or brute-forced without the key.
 *
 * The stored form is `v1:<iv>:<tag>:<ciphertext>` (base64url), versioned so a
 * later key rotation can tell old rows from new.
 */

export const MIN_ENCRYPTION_SECRET = 32;

export interface Cipher {
  encrypt(plain: string): string;
  decrypt(stored: string): string;
  /** Deterministic digest for equality lookups. Input is used as given. */
  blindIndex(plain: string): string;
}

export function createCipher(secret: string): Cipher {
  if (secret.length < MIN_ENCRYPTION_SECRET) {
    throw new Error(`The encryption secret must be at least ${MIN_ENCRYPTION_SECRET} characters`);
  }
  const derive = (info: string): Buffer =>
    Buffer.from(hkdfSync('sha256', secret, 'unlimited-brain', info, 32));
  const encryptionKey = derive('email-encryption');
  const indexKey = derive('email-blind-index');

  return {
    encrypt(plain) {
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', encryptionKey, iv);
      const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
      return ['v1', iv, cipher.getAuthTag(), body].map((part) =>
        typeof part === 'string' ? part : part.toString('base64url'),
      ).join(':');
    },

    decrypt(stored) {
      const [version, iv, tag, body] = stored.split(':');
      if (version !== 'v1' || !iv || !tag || body === undefined) {
        throw new Error('Unrecognized encrypted value');
      }
      const decipher = createDecipheriv('aes-256-gcm', encryptionKey, Buffer.from(iv, 'base64url'));
      decipher.setAuthTag(Buffer.from(tag, 'base64url'));
      return Buffer.concat([
        decipher.update(Buffer.from(body, 'base64url')),
        decipher.final(),
      ]).toString('utf8');
    },

    blindIndex(plain) {
      return createHmac('sha256', indexKey).update(plain).digest('base64url');
    },
  };
}
