import type { NextFunction, Request, Response } from 'express';
import { Router } from 'express';

import type { Auth } from '../auth.js';
import type { Config } from '../config.js';
import type { Assistant, Repo } from '../db/repo.js';
import { loadSettings } from '../settings.js';
import type { Views } from '../views.js';

/**
 * Admin-only, read-only view of every conversation held with one chatbot,
 * across every user. Gated by the `adminConversationLog` setting — off by
 * default, so a chatbot's threads are not readable from /admin until an
 * admin turns it on for that chatbot specifically.
 *
 * Mounted at /admin/assistants/:id/conversations, same shape as content.ts.
 */

export interface ConversationsRouteDeps {
  auth: Auth;
  views: Views;
  config: Config;
  repo: Repo;
}

export function createConversationsRouter({ auth, views, config, repo }: ConversationsRouteDeps): Router {
  const router = Router({ mergeParams: true });

  router.use(auth.requireAdmin);

  /** Resolves :id into an assistant with the log enabled; 404 otherwise. */
  async function resolve(req: Request, res: Response): Promise<{ assistant: Assistant; base: string } | null> {
    const id = Number.parseInt(String((req.params as Record<string, string>).id ?? ''), 10);
    const assistant = Number.isInteger(id) ? await repo.findAssistantById(id) : null;
    if (!assistant) {
      res.status(404).type('html').send(views.errorPage(404, 'This chatbot does not exist.'));
      return null;
    }
    const settings = await loadSettings(repo, config, assistant.id);
    if (!settings.adminConversationLog) {
      res.status(404).type('html').send(views.errorPage(404, 'Conversation logging is off for this chatbot.'));
      return null;
    }
    return { assistant, base: `/admin/assistants/${assistant.id}/conversations` };
  }

  router.get('/', async (req: Request, res: Response, next: NextFunction) => {
    const found = await resolve(req, res);
    if (!found) return;
    try {
      const conversations = await repo.listConversationsForAssistant(found.assistant.id);
      res.type('html').send(
        views.conversationsPage(conversations, {
          assistant: found.assistant,
          message: typeof req.query.ok === 'string' ? req.query.ok : undefined,
        }),
      );
    } catch (error) {
      next(error);
    }
  });

  router.get('/:conversationId', async (req: Request, res: Response, next: NextFunction) => {
    const found = await resolve(req, res);
    if (!found) return;
    try {
      const conversationId = Number.parseInt(String(req.params.conversationId ?? ''), 10);
      const conversation = Number.isInteger(conversationId)
        ? await repo.findConversationWithUser(conversationId)
        : null;
      if (!conversation || conversation.assistantId !== found.assistant.id) {
        res.status(404).type('html').send(views.errorPage(404, 'This conversation does not exist.'));
        return;
      }
      const messages = await repo.listMessages(conversation.id);
      res.type('html').send(
        views.conversationPage(messages, {
          assistant: found.assistant,
          conversation,
          base: found.base,
        }),
      );
    } catch (error) {
      next(error);
    }
  });

  return router;
}
