import express, { Router, type Request, type Response } from 'express';

import { createAssistantResolver } from './access.js';
import type { Auth } from '../auth.js';
import type { Config } from '../config.js';
import type { Assistant, Note, Repo } from '../db/repo.js';
import { logger } from '../logger.js';
import { readNoteInput, MAX_NOTE_CHARS, MAX_NOTES_PER_USER, NoteError } from '../notes.js';
import { loadSettings } from '../settings.js';
import type { Views } from '../views.js';

/**
 * The user's own documents: a markdown editor they can use instead of asking a
 * question, whose documents are then carried in that chatbot's prompt.
 *
 * Server-rendered pages rather than part of the chat's single-page frontend.
 * The shape is a list and an editor, which is exactly what the admin knowledge
 * base already is, and a form post needs no streaming, no state and no script
 * beyond the live preview.
 */

export interface NoteRouteDeps {
  config: Config;
  repo: Repo;
  auth: Auth;
  views: Views;
}

/** Room for a full document plus its form encoding. */
const bodyLimit = `${Math.ceil((MAX_NOTE_CHARS * 4) / 1024)}kb`;

function field(body: unknown, name: string): string {
  if (typeof body !== 'object' || body === null) return '';
  const value = (body as Record<string, unknown>)[name];
  return typeof value === 'string' ? value : '';
}

export function createNoteRouter({ config, repo, auth, views }: NoteRouteDeps): Router {
  const router = Router();
  const resolveAssistant = createAssistantResolver({ repo, views });

  router.use(express.urlencoded({ extended: false, limit: bodyLimit }));

  /**
   * The chatbot, if this user may use it *and* its admin switched the editor
   * on. A chatbot without the setting answers 404 rather than 403: the feature
   * being off is not information worth handing out, and it keeps these routes
   * indistinguishable from a chatbot that does not exist.
   */
  async function resolveWritable(req: Request, res: Response): Promise<Assistant | null> {
    const assistant = await resolveAssistant(req, res);
    if (!assistant) return null;

    const settings = await loadSettings(repo, config, assistant.id);
    if (!settings.notes) {
      res
        .status(404)
        .type('html')
        .send(views.errorPage(404, 'This chatbot does not have the document editor.'));
      return null;
    }
    return assistant;
  }

  /** One document of this user's, or null once the 404 has been sent. */
  async function resolveNote(
    req: Request,
    res: Response,
    assistant: Assistant,
  ): Promise<Note | null> {
    const id = Number.parseInt(String(req.params.id ?? ''), 10);
    const note = Number.isInteger(id)
      ? await repo.findNote(id, req.user!.id, assistant.id)
      : null;
    if (!note) {
      res.status(404).type('html').send(views.errorPage(404, 'This document does not exist.'));
      return null;
    }
    return note;
  }

  router.get('/:slug/documents', auth.requireUser, async (req, res) => {
    const assistant = await resolveWritable(req, res);
    if (!assistant) return;

    const notes = await repo.listNotes(req.user!.id, assistant.id);
    const message = typeof req.query.ok === 'string' ? req.query.ok : undefined;
    res.type('html').send(views.notesPage(assistant, notes, { message }));
  });

  router.get('/:slug/documents/new', auth.requireUser, async (req, res) => {
    const assistant = await resolveWritable(req, res);
    if (!assistant) return;
    res.type('html').send(views.notePage(assistant, null, {}));
  });

  router.get('/:slug/documents/:id', auth.requireUser, async (req, res) => {
    const assistant = await resolveWritable(req, res);
    if (!assistant) return;
    const note = await resolveNote(req, res, assistant);
    if (!note) return;

    const message = typeof req.query.ok === 'string' ? req.query.ok : undefined;
    res.type('html').send(views.notePage(assistant, note, { message }));
  });

  /**
   * Two submit buttons share the name `finish`, so the browser posts the value
   * of whichever was pressed: Save stays in the editor, Save and finish returns
   * to the list.
   */
  function after(assistant: Assistant, note: Note, body: unknown): string {
    const base = `/${assistant.slug}/documents`;
    const saved = encodeURIComponent('Saved.');
    return field(body, 'finish') === '1' ? `${base}?ok=${saved}` : `${base}/${note.id}?ok=${saved}`;
  }

  router.post('/:slug/documents', auth.requireUser, async (req, res) => {
    const assistant = await resolveWritable(req, res);
    if (!assistant) return;

    const submitted = {
      name: field(req.body, 'name'),
      tags: field(req.body, 'tags'),
      content: field(req.body, 'content'),
    };

    if ((await repo.countNotes(req.user!.id, assistant.id)) >= MAX_NOTES_PER_USER) {
      res.status(400).type('html').send(
        views.notePage(assistant, null, {
          error: `You have reached the limit of ${MAX_NOTES_PER_USER} documents for this chatbot. Delete one to add another.`,
          draft: submitted,
        }),
      );
      return;
    }

    try {
      const input = readNoteInput(submitted.name, submitted.tags, submitted.content);
      const note = await repo.createNote(
        req.user!.id,
        assistant.id,
        input.name,
        input.tags,
        input.content,
      );
      logger.info({ userId: req.user!.id, assistantId: assistant.id, noteId: note.id }, 'document created');
      res.redirect(after(assistant, note, req.body));
    } catch (error) {
      if (!(error instanceof NoteError)) throw error;
      // Re-render with what they typed: losing a pasted document to a
      // validation message would be worse than the mistake being corrected.
      res
        .status(400)
        .type('html')
        .send(views.notePage(assistant, null, { error: error.message, draft: submitted }));
    }
  });

  router.post('/:slug/documents/:id', auth.requireUser, async (req, res) => {
    const assistant = await resolveWritable(req, res);
    if (!assistant) return;
    const existing = await resolveNote(req, res, assistant);
    if (!existing) return;

    const submitted = {
      name: field(req.body, 'name'),
      tags: field(req.body, 'tags'),
      content: field(req.body, 'content'),
    };

    try {
      const input = readNoteInput(submitted.name, submitted.tags, submitted.content);
      const note = await repo.updateNote(
        existing.id,
        req.user!.id,
        assistant.id,
        input.name,
        input.tags,
        input.content,
      );
      if (!note) {
        res.status(404).type('html').send(views.errorPage(404, 'This document does not exist.'));
        return;
      }
      logger.info({ userId: req.user!.id, assistantId: assistant.id, noteId: note.id }, 'document updated');
      res.redirect(after(assistant, note, req.body));
    } catch (error) {
      if (!(error instanceof NoteError)) throw error;
      res
        .status(400)
        .type('html')
        .send(views.notePage(assistant, existing, { error: error.message, draft: submitted }));
    }
  });

  router.post('/:slug/documents/:id/delete', auth.requireUser, async (req, res) => {
    const assistant = await resolveWritable(req, res);
    if (!assistant) return;
    const note = await resolveNote(req, res, assistant);
    if (!note) return;

    await repo.deleteNote(note.id, req.user!.id, assistant.id);
    logger.info({ userId: req.user!.id, assistantId: assistant.id, noteId: note.id }, 'document deleted');
    res.redirect(`/${assistant.slug}/documents?ok=${encodeURIComponent(`"${note.name}" deleted.`)}`);
  });

  return router;
}
