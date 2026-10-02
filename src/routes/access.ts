import type { Request, Response } from 'express';

import type { Assistant, Repo } from '../db/repo.js';
import type { Views } from '../views.js';

/**
 * Resolving `:slug` against the rights matrix, shared by every user-facing
 * router that lives under a chatbot's address.
 *
 * It is one function rather than one per router on purpose: the rule it encodes
 * — **404 and not 403**, so the names of chatbots a user may not use never leak
 * — is the kind that drifts the moment it is written twice.
 */
export function createAssistantResolver({ repo, views }: { repo: Repo; views: Views }) {
  return async function resolveAssistant(req: Request, res: Response): Promise<Assistant | null> {
    const slug = typeof req.params.slug === 'string' ? req.params.slug : '';
    const assistant = await repo.findAssistantBySlug(slug);
    const user = req.user!;

    if (!assistant && req.method === 'GET' && !req.path.startsWith('/api/')) {
      // An address that was changed: send the visitor on to the new one. Only
      // when they may use that chatbot, so this cannot reveal its new address
      // to anyone else.
      const former = await repo.findAssistantByFormerSlug(slug);
      if (former && (await repo.canUseAssistant(user.id, user.isAdmin, former.id))) {
        const rest = req.originalUrl.slice(`/${encodeURIComponent(slug)}`.length);
        res.redirect(301, `/${encodeURIComponent(former.slug)}${rest}`);
        return null;
      }
    }

    if (!assistant || !(await repo.canUseAssistant(user.id, user.isAdmin, assistant.id))) {
      if (req.path.startsWith('/api/')) {
        res.status(404).json({ error: 'Chatbot not found' });
      } else {
        res.status(404).type('html').send(views.errorPage(404, 'This chatbot does not exist.'));
      }
      return null;
    }
    return assistant;
  };
}
