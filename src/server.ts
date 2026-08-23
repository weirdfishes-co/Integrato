import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { seedContent } from './content.js';
import { logger } from './logger.js';
import { loadSettings } from './settings.js';

const config = loadConfig();
const { express: app, db, repo, content, bundledContent } = createApp(config);

// If CONTEXT_DIR/INSTRUCTIONS_PATH point at an empty volume, the bundled
// knowledge base is copied there once.
await seedContent(bundledContent, content);

const server = app.listen(config.port, '0.0.0.0', () => {
  logger.info(
    { port: config.port, appUrl: config.appUrl, model: loadSettings(repo, config).model, assistant: config.assistantName },
    'server started',
  );
});

// Periodically purge expired sessions and sign-in links.
const cleanup = setInterval(
  () => {
    try {
      repo.purgeExpired();
    } catch (error) {
      logger.error({ err: error }, 'purging expired tokens failed');
    }
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
    db.close();
    logger.info('shut down cleanly');
    process.exit(0);
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
