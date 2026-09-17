import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';

/**
 * The suite runs against a real PostgreSQL rather than an emulation, so a
 * dialect or constraint mistake fails here instead of in production.
 *
 * One container serves the whole run. Isolation between tests comes from a
 * schema per case (see helpers/db.ts), which costs milliseconds.
 */

let container: StartedPostgreSqlContainer | undefined;

export async function setup(): Promise<void> {
  container = await new PostgreSqlContainer('postgres:17-alpine').start();
  process.env.TEST_DATABASE_URL = container.getConnectionUri();
}

export async function teardown(): Promise<void> {
  await container?.stop();
}
