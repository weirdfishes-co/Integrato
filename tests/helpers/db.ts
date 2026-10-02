import { openDatabase, type Db } from '../../src/db/index.js';
import { createCipher } from '../../src/crypto.js';
import { createRepo, type Repo } from '../../src/db/repo.js';

/**
 * A repo over a schema of its own, so tests cannot see each other's rows.
 * Migrations run per schema; the baseline is small enough that this costs
 * milliseconds.
 */

/** Fixed so a test can assert on ciphertext; not a secret. */
export const TEST_ENCRYPTION_KEY = 'test-only-encryption-key-0123456789abcdef';

let counter = 0;
const opened: Db[] = [];

export async function freshRepo(): Promise<Repo> {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) {
    throw new Error('TEST_DATABASE_URL is unset — global-setup.ts should have started a container');
  }

  counter += 1;
  const schema = `t${process.pid}_${counter}`;
  // Small pools: a run opens dozens of them and the server has a connection cap.
  const db = await openDatabase(url, { schema, max: 2 });
  opened.push(db);
  return createRepo(db, createCipher(TEST_ENCRYPTION_KEY));
}

/** Closes every pool this worker opened; call from an afterAll. */
export async function closeAll(): Promise<void> {
  await Promise.all(opened.map((db) => db.close()));
  opened.length = 0;
}
