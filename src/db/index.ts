import { mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import Database from 'better-sqlite3';

import { logger } from '../logger.js';

export type Db = Database.Database;

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Opens the SQLite database and runs the migrations in-process.
 * Migrating in-process (instead of a separate start command) saves one cold
 * start on Railway, so /healthz comes up sooner.
 */
export function openDatabase(databasePath: string): Db {
  mkdirSync(dirname(databasePath), { recursive: true });

  const db = new Database(databasePath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');

  migrate(db);
  return db;
}

/** Forward-only, idempotent migrations; applied file names live in schema_migrations. */
function migrate(db: Db): void {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name       TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);

  const migrationsDir = join(here, 'migrations');
  const applied = new Set(
    db.prepare('SELECT name FROM schema_migrations').all().map((row) => (row as { name: string }).name),
  );

  const files = readdirSync(migrationsDir)
    .filter((name) => name.endsWith('.sql'))
    .sort();

  const record = db.prepare('INSERT INTO schema_migrations (name) VALUES (?)');

  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = readFileSync(join(migrationsDir, file), 'utf8');
    db.transaction(() => {
      db.exec(sql);
      record.run(file);
    })();
    logger.info({ migration: file }, 'migration applied');
  }
}
