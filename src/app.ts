import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import cookieParser from 'cookie-parser';
import express, { type Express } from 'express';

import { createAuth } from './auth.js';
import type { Config } from './config.js';
import type { ContentPaths } from './content.js';
import type { Db } from './db/index.js';
import { createCipher } from './crypto.js';
import { createRepo, type Repo } from './db/repo.js';
import { createChatClient } from './llm.js';
import { logger } from './logger.js';
import { createMailer } from './mail.js';
import { createAdminRouter } from './routes/admin.js';
import { createAuthRouter } from './routes/auth.js';
import { createChatRouter, MESSAGES_PATH, MESSAGE_BODY_LIMIT } from './routes/chat.js';
import { createNoteRouter, NOTES_PATH, NOTES_BODY_LIMIT } from './routes/notes.js';
import { createContentRouter, CONTENT_PATH, CONTENT_BODY_LIMIT } from './routes/content.js';
import { createConversationsRouter } from './routes/conversations.js';
import { createErrorHandler, createOriginGuard, securityHeaders, warnAboutProxy } from './security.js';
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

  const repo = createRepo(db, createCipher(config.emailEncryptionKey));
  const auth = createAuth(config, repo);
  const mailer = createMailer(config);
  const chat = createChatClient(config);
  const branding = {
    assistantName: config.assistantName,
    assistantLanguage: config.assistantLanguage,
  };
  const views = createViews(branding);

  const app = express();
  app.disable('x-powered-by');
  // Off unless TRUST_PROXY says otherwise: believing X-Forwarded-For with no
  // proxy in front would let anyone pick their own req.ip.
  app.set('trust proxy', config.trustProxy);

  app.use(securityHeaders());
  app.use(warnAboutProxy(config));
  app.use(createOriginGuard({ config, views }));

  /*
   * Body limits, and the order matters.
   *
   * body-parser runs once per request: the first parser to reach it sets
   * `req._body` and every later one steps aside. So a limit declared on a
   * router is never consulted — the global pair below would already have
   * rejected the request. Worse, it rejects by *throwing*, which the error
   * handler at the bottom of this file turns into a 500: a user uploading a
   * two-minute recording was told "something went wrong on our side".
   *
   * The three routes that legitimately carry more than a form's worth of data
   * therefore get their limit here, ahead of the default, and each limit lives
   * with the feature that knows how big its data can be.
   */
  app.post(MESSAGES_PATH, express.json({ limit: MESSAGE_BODY_LIMIT }));
  app.use(CONTENT_PATH, express.json({ limit: CONTENT_BODY_LIMIT }));
  app.use(CONTENT_PATH, express.urlencoded({ extended: false, limit: CONTENT_BODY_LIMIT }));
  app.use(NOTES_PATH, express.urlencoded({ extended: false, limit: NOTES_BODY_LIMIT }));

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
  app.use(
    '/admin/assistants/:id/conversations',
    createConversationsRouter({ auth, views, config, repo }),
  );
  // Before the chat router: both live under /<slug>, and this one owns the
  // deeper paths. Express would not confuse them, but reading them in this
  // order says which is the more specific.
  app.use(createNoteRouter({ config, repo, auth, views }));
  app.use(createChatRouter({ config, repo, auth, chat, views }));

  app.use((req, res) => {
    if (req.path.startsWith('/api/')) {
      res.status(404).json({ error: 'Not found' });
      return;
    }
    res.status(404).type('html').send(views.errorPage(404, 'This page does not exist.'));
  });

  app.use(createErrorHandler({ views }));

  return { express: app, db, repo, bundledContent };
}
