import { createApp } from './app.js';
import { bootstrapAssistants } from './assistants.js';
import { loadConfig } from './config.js';
import { openDatabase } from './db/index.js';
import { logger } from './logger.js';

const config = loadConfig();

// Migrations run here, before the app is built and long before it listens.
const db = await openDatabase(config.databaseUrl);
const { express: app, repo, bundledContent } = createApp(config, db);

// Addresses stored before they were encrypted are converted once, before
// anything reads them.
const protectedEmails = await repo.protectEmails();
if (protectedEmails > 0) logger.info({ rows: protectedEmails }, 'encrypted stored email addresses');

// Admins from the environment always exist: that way you can sign in right
// after an empty database and manage the rest of the user list.
for (const email of config.adminEmails) {
  await repo.upsertUser(email, true);
}

const first = await bootstrapAssistants({ repo, config, bundled: bundledContent });

const assistantCount = (await repo.listAssistants()).length;

const server = app.listen(config.port, '0.0.0.0', () => {
  logger.info(
    {
      port: config.port,
      appUrl: config.appUrl,
      assistants: assistantCount,
      first: first.slug,
    },
    'server started',
  );
});

// Periodically purge expired sessions and sign-in links.
const cleanup = setInterval(
  () => {
    repo.purgeExpired().catch((error: unknown) => {
      logger.error({ err: error }, 'purging expired tokens failed');
    });
  },
  60 * 60 * 1000,
);
cleanup.unref();

let shuttingDown = false;

function shutdown(signal: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'shutdown started');

  const forced = setTimeout(() => {
    logger.warn('shutdown took too long — forcing the process to exit');
    process.exit(1);
  }, 10_000);
  forced.unref();

  server.close(() => {
    clearInterval(cleanup);
    void db.close().finally(() => {
      logger.info('shut down cleanly');
      process.exit(0);
    });
  });
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

process.on('unhandledRejection', (reason) => {
  logger.fatal({ err: reason }, 'unhandled promise rejection');
  shutdown('unhandledRejection');
});

process.on('uncaughtException', (error) => {
  logger.fatal({ err: error }, 'uncaught exception');
  shutdown('uncaughtException');
});
