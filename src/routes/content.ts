import express, { Router } from 'express';

import type { Auth } from '../auth.js';
import { ContentError, MAX_DOCUMENT_BYTES, type ContentStore } from '../content.js';
import { logger } from '../logger.js';
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
  store: ContentStore;
  views: Views;
  /** Shown above the instr.md editor. */
  instructionsDescription: string;
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

export function createContentRouter({
  auth,
  store,
  views,
  instructionsDescription,
}: ContentRouteDeps): Router {
  const router = Router();

  router.use('/admin/content', auth.requireAdmin);
  router.use('/admin/content', express.urlencoded({ extended: false, limit: bodyLimit }));
  router.use('/admin/content', express.json({ limit: bodyLimit }));

  const notices = (req: express.Request) => ({
    message: typeof req.query.ok === 'string' ? req.query.ok : undefined,
    error: typeof req.query.error === 'string' ? req.query.error : undefined,
  });

  router.get('/admin/content', async (req, res, next) => {
    try {
      const [documents, instructions] = await Promise.all([store.listDocuments(), store.readInstructions()]);
      res.type('html').send(views.contentPage(documents, instructions.length, notices(req)));
    } catch (error) {
      next(error);
    }
  });

  // ---- base prompt ----------------------------------------------------------

  router.get('/admin/content/instructions', async (req, res, next) => {
    try {
      res.type('html').send(
        views.editorPage({
          heading: 'Base prompt',
          description: instructionsDescription,
          action: '/admin/content/instructions',
          content: await store.readInstructions(),
          notice: notices(req),
        }),
      );
    } catch (error) {
      next(error);
    }
  });

  router.post('/admin/content/instructions', async (req, res, next) => {
    try {
      const content = typeof req.body?.content === 'string' ? req.body.content : '';
      if (content.trim().length === 0) {
        throw new ContentError('The base prompt cannot be empty.');
      }
      await store.writeInstructions(content);
      logger.info({ by: req.user?.id }, 'base prompt updated');
      res.redirect(`/admin/content?ok=${encodeURIComponent('Base prompt saved.')}`);
    } catch (error) {
      fail(error, res, next, '/admin/content/instructions');
    }
  });

  // ---- context documents ----------------------------------------------------

  router.get('/admin/content/edit', async (req, res, next) => {
    const name = typeof req.query.name === 'string' ? req.query.name : '';
    try {
      res.type('html').send(
        views.editorPage({
          heading: name,
          description: `Context document. To insert it at a fixed spot in the base prompt, use {Global.${name.replace(
            /\.md$/,
            '',
          )}}.`,
          action: `/admin/content/edit?name=${encodeURIComponent(name)}`,
          content: await store.readDocument(name),
          notice: notices(req),
        }),
      );
    } catch (error) {
      fail(error, res, next, '/admin/content');
    }
  });

  router.post('/admin/content/edit', async (req, res, next) => {
    const name = typeof req.query.name === 'string' ? req.query.name : '';
    try {
      const content = typeof req.body?.content === 'string' ? req.body.content : '';
      await store.writeDocument(name, content);
      logger.info({ by: req.user?.id, document: name }, 'context document updated');
      res.redirect(`/admin/content?ok=${encodeURIComponent(`${name} saved.`)}`);
    } catch (error) {
      fail(error, res, next, `/admin/content/edit?name=${encodeURIComponent(name)}`);
    }
  });

  router.post('/admin/content/new', async (req, res, next) => {
    const raw = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
    const name = raw.toLowerCase().endsWith('.md') ? raw : `${raw}.md`;
    try {
      const existing = await store.listDocuments();
      if (existing.some((doc) => doc.name.toLowerCase() === name.toLowerCase())) {
        throw new ContentError(`${name} already exists.`);
      }
      await store.writeDocument(name, `# ${name.replace(/\.md$/, '')}\n\n`);
      res.redirect(`/admin/content/edit?name=${encodeURIComponent(name)}`);
    } catch (error) {
      fail(error, res, next, '/admin/content');
    }
  });

  router.post('/admin/content/delete', async (req, res, next) => {
    const name = typeof req.body?.name === 'string' ? req.body.name : '';
    try {
      await store.deleteDocument(name);
      logger.info({ by: req.user?.id, document: name }, 'context document deleted');
      res.redirect(`/admin/content?ok=${encodeURIComponent(`${name} deleted.`)}`);
    } catch (error) {
      fail(error, res, next, '/admin/content');
    }
  });

  /** JSON upload: [{ name, content }]. Existing files are overwritten. */
  router.post('/admin/content/upload', async (req, res) => {
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
        await store.writeDocument(name, content);
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
