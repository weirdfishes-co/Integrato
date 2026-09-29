import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import cookieParser from 'cookie-parser';
import express, { type Express, type NextFunction, type Request, type Response } from 'express';

import { createAuth } from './auth.js';
import type { Config } from './config.js';
import type { ContentPaths } from './content.js';
import type { Db } from './db/index.js';
import { createRepo, type Repo } from './db/repo.js';
import { createChatClient } from './llm.js';
import { createAnonymizer } from './presidio.js';
import { logger } from './logger.js';
import { createMailer } from './mail.js';
import { createAdminRouter } from './routes/admin.js';
import { createAuthRouter } from './routes/auth.js';
import { createChatRouter } from './routes/chat.js';
import { createContentRouter } from './routes/content.js';
import { createViews } from './views.js';

const here = dirname(fileURLToPath(import.meta.url));
/** dist/ and src/ both sit one level below the project root. */
const projectRoot = resolve(here, '..');

export interface App {
  readonly express: Express;
  readonly db: Db;
  readonly repo: Repo;
  /** Where the knowledge base actually lives; seeding into it happens in server.ts. */
  readonly bundledContent: ContentPaths;
}

/**
 * Builds the Express app over an already-open database. Opening it is the
 * caller's job (server.ts) because migrations are async and must finish before
 * the first request, not race it.
 */
export function createApp(config: Config, db: Db): App {
  // Shipped in the image and copied into each new assistant's own directory.
  const bundledContent: ContentPaths = {
    contextDir: join(projectRoot, 'context'),
    instructionsPath: join(projectRoot, 'instr.md'),
  };

  const repo = createRepo(db);
  const auth = createAuth(config, repo);
  const mailer = createMailer(config);
  const anonymizer = createAnonymizer(config);
  const chat = createChatClient(config, anonymizer);
  const branding = {
    assistantName: config.assistantName,
    assistantLanguage: config.assistantLanguage,
  };
  const views = createViews(branding);

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1); // Railway sits behind a proxy: needed for req.ip and secure cookies.

  app.use(express.urlencoded({ extended: false, limit: '64kb' }));
  app.use(express.json({ limit: '256kb' }));
  app.use(cookieParser());
  app.use(
    express.static(join(projectRoot, 'public'), {
      maxAge: config.nodeEnv === 'production' ? '1h' : 0,
    }),
  );

  app.get('/healthz', (_req, res) => {
    res.json({ status: 'ok' });
  });

  app.use(createAuthRouter({ config, repo, auth, mailer, views }));
  app.use(createAdminRouter({ config, repo, auth, views, bundledContent }));
  app.use('/admin/assistants/:id/content', createContentRouter({ auth, views, config, repo }));
  app.use(createChatRouter({ config, repo, auth, chat, views }));

  app.use((req, res) => {
    if (req.path.startsWith('/api/')) {
      res.status(404).json({ error: 'Not found' });
      return;
    }
    res.status(404).type('html').send(views.errorPage(404, 'This page does not exist.'));
  });

  app.use((error: Error, req: Request, res: Response, _next: NextFunction) => {
    logger.error({ err: error, path: req.path }, 'unexpected error');
    if (res.headersSent) {
      res.end();
      return;
    }
    if (req.path.startsWith('/api/')) {
      res.status(500).json({ error: 'Internal server error' });
      return;
    }
    res.status(500).type('html').send(views.errorPage(500, 'Something went wrong on our side.'));
  });

  return { express: app, db, repo, bundledContent };
}
