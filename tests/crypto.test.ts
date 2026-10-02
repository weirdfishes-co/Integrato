import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { closeAll, freshRepo, TEST_ENCRYPTION_KEY } from './helpers/db.js';

import { createCipher } from '../src/crypto.js';
import type { Repo } from '../src/db/repo.js';
import { openDatabase } from '../src/db/index.js';
import { createRepo } from '../src/db/repo.js';

afterAll(closeAll);

describe('cipher', () => {
  const cipher = createCipher(TEST_ENCRYPTION_KEY);

  it('round-trips a value', async () => {
    expect(cipher.decrypt(cipher.encrypt('Ünï@example.com'))).toBe('Ünï@example.com');
  });

  it('never produces the same ciphertext twice, and never contains the plaintext', async () => {
    const a = cipher.encrypt('a@example.com');
    expect(a).not.toBe(cipher.encrypt('a@example.com'));
    expect(a).not.toContain('example');
  });

  it('gives the same blind index for the same input, and a different one otherwise', async () => {
    expect(cipher.blindIndex('a@example.com')).toBe(cipher.blindIndex('a@example.com'));
    expect(cipher.blindIndex('a@example.com')).not.toBe(cipher.blindIndex('b@example.com'));
  });

  it('refuses a tampered value and a different key', async () => {
    const stored = cipher.encrypt('a@example.com');
    const [v, iv, tag, body] = stored.split(':');
    const flipped = `${v}:${iv}:${tag}:${body!.startsWith('A') ? 'B' : 'A'}${body!.slice(1)}`;

    expect(() => cipher.decrypt(flipped)).toThrow();
    expect(() => createCipher('another-key-another-key-another-key-1').decrypt(stored)).toThrow();
  });

  it('refuses a weak secret', async () => {
    expect(() => createCipher('short')).toThrow();
  });
});

describe('stored email addresses', () => {
  let repo: Repo;

  beforeEach(async () => {
    repo = await freshRepo();
  });

  it('are found by address, whatever its case', async () => {
    const user = await repo.upsertUser('Alice@Example.com', false);

    expect((await repo.findUserByEmail('alice@example.com'))?.id).toBe(user.id);
    expect((await repo.findUserByEmail('ALICE@EXAMPLE.COM'))?.email).toBe('alice@example.com');
  });

  it('stay unique: adding the same address twice returns the same user', async () => {
    const first = await repo.upsertUser('a@example.com', false);
    const second = await repo.upsertUser('A@example.com', true);

    expect(second.id).toBe(first.id);
    expect(second.isAdmin).toBe(true);
    expect(await repo.listUsers()).toHaveLength(1);
  });

  it('are listed in alphabetical order', async () => {
    await repo.upsertUser('carol@example.com', false);
    await repo.upsertUser('alice@example.com', false);
    await repo.upsertUser('bob@example.com', false);

    expect((await repo.listUsers()).map((u) => u.email)).toEqual([
      'alice@example.com',
      'bob@example.com',
      'carol@example.com',
    ]);
  });

  it('are not readable in the database', async () => {
    const url = process.env.TEST_DATABASE_URL!;
    const schema = `crypto_${process.pid}`;
    const db = await openDatabase(url, { schema, max: 2 });
    const plainRepo = createRepo(db, createCipher(TEST_ENCRYPTION_KEY));
    await plainRepo.upsertUser('secret@example.com', false);

    const raw = await db.all<Record<string, unknown>>('SELECT * FROM users');
    expect(JSON.stringify(raw)).not.toContain('secret@example.com');
    expect(raw[0]?.email).toBeNull();
    await db.close();
  });

  it('are converted from plaintext rows written before encryption', async () => {
    const url = process.env.TEST_DATABASE_URL!;
    const db = await openDatabase(url, { schema: `legacy_${process.pid}`, max: 2 });
    const legacy = createRepo(db, createCipher(TEST_ENCRYPTION_KEY));
    await db.run("INSERT INTO users (email, is_admin) VALUES ('old@example.com', FALSE)");

    expect(await legacy.protectEmails()).toBe(1);
    expect(await legacy.protectEmails()).toBe(0);
    expect((await legacy.findUserByEmail('old@example.com'))?.email).toBe('old@example.com');
    expect((await db.all<{ email: string | null }>('SELECT email FROM users'))[0]?.email).toBeNull();
    await db.close();
  });
});
