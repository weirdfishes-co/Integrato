import express, { Router } from 'express';

import { assistantPaths } from '../assistants.js';
import type { Auth } from '../auth.js';
import type { Config } from '../config.js';
import { ContentError, createContentStore, MAX_DOCUMENT_BYTES, type ContentStore } from '../content.js';
import type { Assistant, Repo } from '../db/repo.js';
import { logger } from '../logger.js';
import { instructionsDescription } from '../views.js';
import type { Views } from '../views.js';

/**
 * Admin pages for the knowledge base: read/edit instr.md and create, upload,
 * edit and delete the context documents.
 *
 * Uploads arrive as JSON (the browser reads the file with file.text()), so no
 * multipart dependency is needed for what is always text.
 */

export interface ContentRouteDeps {
  auth: Auth;
  views: Views;
  config: Config;
  repo: Repo;
}

/** More generous than the global body limit: documents may be up to MAX_DOCUMENT_BYTES. */
const bodyLimit = `${Math.ceil((MAX_DOCUMENT_BYTES * 2) / 1024)}kb`;

function fail(error: unknown, res: express.Response, next: express.NextFunction, redirectTo: string): void {
  if (error instanceof ContentError) {
    res.redirect(`${redirectTo}?error=${encodeURIComponent(error.message)}`);
    return;
  }
  next(error);
}

/**
 * Mounted at /admin/assistants/:id/content, so every route here already knows
 * which assistant's knowledge base it is editing.
 */
export function createContentRouter({ auth, views, config, repo }: ContentRouteDeps): Router {
  const router = Router({ mergeParams: true });

  router.use(auth.requireAdmin);
  router.use(express.urlencoded({ extended: false, limit: bodyLimit }));
  router.use(express.json({ limit: bodyLimit }));

  /** Resolves :id into an assistant plus a store over its own directory. */
  function resolve(
    req: express.Request,
    res: express.Response,
  ): { assistant: Assistant; store: ContentStore; base: string } | null {
    const id = Number.parseInt(String((req.params as Record<string, string>).id ?? ''), 10);
    const assistant = Number.isInteger(id) ? repo.findAssistantById(id) : null;
    if (!assistant) {
      res.status(404).type('html').send(views.errorPage(404, 'This assistant does not exist.'));
      return null;
    }
    return {
      assistant,
      store: createContentStore(assistantPaths(config, assistant.slug)),
      base: `/admin/assistants/${assistant.id}/content`,
    };
  }

  const notices = (req: express.Request) => ({
    message: typeof req.query.ok === 'string' ? req.query.ok : undefined,
    error: typeof req.query.error === 'string' ? req.query.error : undefined,
  });

  router.get('/', async (req, res, next) => {
    const found = resolve(req, res);
    if (!found) return;
    try {
      const [documents, instructions] = await Promise.all([
        found.store.listDocuments(),
        found.store.readInstructions(),
      ]);
      res.type('html').send(
        views.contentPage(documents, instructions.length, {
          ...notices(req),
          base: found.base,
          assistant: found.assistant,
        }),
      );
    } catch (error) {
      next(error);
    }
  });

  // ---- base prompt ----------------------------------------------------------

  router.get('/instructions', async (req, res, next) => {
    const found = resolve(req, res);
    if (!found) return;
    try {
      res.type('html').send(
        views.editorPage({
          heading: 'Base prompt',
          description: instructionsDescription({
            assistantName: found.assistant.name,
            assistantLanguage: found.assistant.language,
          }),
          action: `${found.base}/instructions`,
          base: found.base,
          content: await found.store.readInstructions(),
          notice: notices(req),
        }),
      );
    } catch (error) {
      next(error);
    }
  });

  router.post('/instructions', async (req, res, next) => {
    const found = resolve(req, res);
    if (!found) return;
    try {
      const content = typeof req.body?.content === 'string' ? req.body.content : '';
      if (content.trim().length === 0) {
        throw new ContentError('The base prompt cannot be empty.');
      }
      await found.store.writeInstructions(content);
      logger.info({ by: req.user?.id, assistantId: found.assistant.id }, 'base prompt updated');
      res.redirect(`${found.base}?ok=${encodeURIComponent('Base prompt saved.')}`);
    } catch (error) {
      fail(error, res, next, `${found.base}/instructions`);
    }
  });

  // ---- context documents ----------------------------------------------------

  router.get('/edit', async (req, res, next) => {
    const found = resolve(req, res);
    if (!found) return;
    const name = typeof req.query.name === 'string' ? req.query.name : '';
    try {
      res.type('html').send(
        views.editorPage({
          heading: name,
          description: `Context document. To insert it at a fixed spot in the base prompt, use {Global.${name.replace(
            /\.md$/,
            '',
          )}}.`,
          action: `${found.base}/edit?name=${encodeURIComponent(name)}`,
          base: found.base,
          content: await found.store.readDocument(name),
          notice: notices(req),
        }),
      );
    } catch (error) {
      fail(error, res, next, found.base);
    }
  });

  router.post('/edit', async (req, res, next) => {
    const found = resolve(req, res);
    if (!found) return;
    const name = typeof req.query.name === 'string' ? req.query.name : '';
    try {
      const content = typeof req.body?.content === 'string' ? req.body.content : '';
      await found.store.writeDocument(name, content);
      logger.info({ by: req.user?.id, assistantId: found.assistant.id, document: name }, 'context document updated');
      res.redirect(`${found.base}?ok=${encodeURIComponent(`${name} saved.`)}`);
    } catch (error) {
      fail(error, res, next, `${found.base}/edit?name=${encodeURIComponent(name)}`);
    }
  });

  router.post('/new', async (req, res, next) => {
    const found = resolve(req, res);
    if (!found) return;
    const raw = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
    const name = raw.toLowerCase().endsWith('.md') ? raw : `${raw}.md`;
    try {
      const existing = await found.store.listDocuments();
      if (existing.some((doc) => doc.name.toLowerCase() === name.toLowerCase())) {
        throw new ContentError(`${name} already exists.`);
      }
      await found.store.writeDocument(name, `# ${name.replace(/\.md$/, '')}\n\n`);
      res.redirect(`${found.base}/edit?name=${encodeURIComponent(name)}`);
    } catch (error) {
      fail(error, res, next, found.base);
    }
  });

  router.post('/delete', async (req, res, next) => {
    const found = resolve(req, res);
    if (!found) return;
    const name = typeof req.body?.name === 'string' ? req.body.name : '';
    try {
      await found.store.deleteDocument(name);
      logger.info({ by: req.user?.id, assistantId: found.assistant.id, document: name }, 'context document deleted');
      res.redirect(`${found.base}?ok=${encodeURIComponent(`${name} deleted.`)}`);
    } catch (error) {
      fail(error, res, next, found.base);
    }
  });

  /** JSON upload: [{ name, content }]. Existing files are overwritten. */
  router.post('/upload', async (req, res) => {
    const found = resolve(req, res);
    if (!found) return;
    const files: unknown = req.body?.files;
    if (!Array.isArray(files) || files.length === 0) {
      res.status(400).json({ error: 'No files received.' });
      return;
    }
    if (files.length > 25) {
      res.status(400).json({ error: 'At most 25 files at a time.' });
      return;
    }

    const saved: string[] = [];
    const failed: { name: string; reason: string }[] = [];

    for (const entry of files) {
      const name = typeof (entry as { name?: unknown }).name === 'string' ? (entry as { name: string }).name : '';
      const content =
        typeof (entry as { content?: unknown }).content === 'string' ? (entry as { content: string }).content : '';
      try {
        await found.store.writeDocument(name, content);
        saved.push(name);
      } catch (error) {
        if (error instanceof ContentError) {
          failed.push({ name: name || '(unnamed)', reason: error.message });
          continue;
        }
        logger.error({ err: error, name }, 'upload of context document failed');
        failed.push({ name: name || '(unnamed)', reason: 'Saving failed.' });
      }
    }

    logger.info({ by: req.user?.id, saved: saved.length, failed: failed.length }, 'context documents uploaded');
    res.json({ saved, failed });
  });

  return router;
}
