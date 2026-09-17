import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import pg from 'pg';

import { logger } from '../logger.js';

/**
 * PostgreSQL access: a pool, a thin query surface and forward-only migrations
 * applied in-process at boot (one cold start fewer than a separate command, so
 * /healthz comes up sooner).
 *
 * `pg` returns DATE and TIMESTAMP columns as JavaScript Date objects. The
 * domain treats timestamps as strings, so they are parsed as text here and
 * formatted once in repo.ts — that keeps a Date from reaching a template.
 */

const here = dirname(fileURLToPath(import.meta.url));

const TIMESTAMPTZ_OID = 1184;
const TIMESTAMP_OID = 1114;
pg.types.setTypeParser(TIMESTAMPTZ_OID, (value) => value);
pg.types.setTypeParser(TIMESTAMP_OID, (value) => value);

export interface Db {
  /** Every matching row. */
  all<T>(text: string, params?: readonly unknown[]): Promise<T[]>;
  /** The first row, or null when the query matched nothing. */
  one<T>(text: string, params?: readonly unknown[]): Promise<T | null>;
  /** Statements without a result; returns the number of affected rows. */
  run(text: string, params?: readonly unknown[]): Promise<number>;
  /** Runs `work` on a single connection inside BEGIN/COMMIT. */
  transaction<T>(work: (tx: Db) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

type Queryable = Pick<pg.PoolClient, 'query'>;

function wrap(queryable: Queryable, pool: pg.Pool | null): Db {
  return {
    async all<T>(text: string, params: readonly unknown[] = []): Promise<T[]> {
      const result = await queryable.query<T & pg.QueryResultRow>(text, [...params]);
      return result.rows;
    },

    async one<T>(text: string, params: readonly unknown[] = []): Promise<T | null> {
      const result = await queryable.query<T & pg.QueryResultRow>(text, [...params]);
      return result.rows[0] ?? null;
    },

    async run(text: string, params: readonly unknown[] = []): Promise<number> {
      const result = await queryable.query(text, [...params]);
      return result.rowCount ?? 0;
    },

    async transaction<T>(work: (tx: Db) => Promise<T>): Promise<T> {
      // Nested calls join the transaction already in progress rather than
      // opening a second one on a different connection.
      if (!pool) return work(wrap(queryable, null));

      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await work(wrap(client, null));
        await client.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },

    async close(): Promise<void> {
      if (pool) await pool.end();
    },
  };
}

export interface OpenOptions {
  /** Schema to place the tables in; tests use one per case for isolation. */
  schema?: string;
  /** Pool size. Tests open many small pools, the server one large one. */
  max?: number;
}

/** Opens the pool, applies any pending migrations and hands back the database. */
export async function openDatabase(databaseUrl: string, options: OpenOptions = {}): Promise<Db> {
  const pool = new pg.Pool({
    connectionString: databaseUrl,
    ...(options.schema ? { options: `-c search_path=${options.schema}` } : {}),
    max: options.max ?? 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
  });

  // A pool emits errors for idle clients dropped by the server; without a
  // listener Node treats that as an uncaught exception and kills the process.
  pool.on('error', (error) => {
    logger.error({ err: error }, 'idle database client errored');
  });

  const db = wrap(pool, pool);

  if (options.schema) {
    await db.run(`CREATE SCHEMA IF NOT EXISTS ${options.schema}`);
  }

  await migrate(db);
  return db;
}

/** Forward-only, idempotent; applied file names live in schema_migrations. */
async function migrate(db: Db): Promise<void> {
  await db.run(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name       TEXT PRIMARY KEY,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);

  const migrationsDir = join(here, 'migrations');
  const applied = new Set(
    (await db.all<{ name: string }>('SELECT name FROM schema_migrations')).map((row) => row.name),
  );

  const files = readdirSync(migrationsDir)
    .filter((name) => name.endsWith('.sql'))
    .sort();

  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = readFileSync(join(migrationsDir, file), 'utf8');
    await db.transaction(async (tx) => {
      await tx.run(sql);
      await tx.run('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
    });
    logger.info({ migration: file }, 'migration applied');
  }
}
