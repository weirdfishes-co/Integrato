import { Router, type Request, type Response } from 'express';

import {
  assistantPaths,
  provisionAssistant,
  slugify,
  uniqueSlug,
  MAX_DESCRIPTION_LENGTH,
  MAX_NAME_LENGTH,
} from '../assistants.js';
import type { Auth } from '../auth.js';
import { fetchBalance } from '../balance.js';
import { EFFORT_LEVELS, normalizeEmail, type Config, type Effort } from '../config.js';
import type { ContentPaths } from '../content.js';
import type { Assistant, Repo } from '../db/repo.js';
import { logger } from '../logger.js';
import { listModels, type ModelOption } from '../models.js';
import {
  loadSettings,
  parseDomains,
  saveSettings,
  MAX_SEARCH_RESULTS,
  type AssistantSettings,
} from '../settings.js';
import type { Views } from '../views.js';

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_MODEL_LENGTH = 200;

export interface AdminRouteDeps {
  config: Config;
  repo: Repo;
  auth: Auth;
  views: Views;
  /** Bundled files a brand-new assistant starts from. */
  bundledContent: ContentPaths;
}

function checked(body: unknown, field: string): boolean {
  return typeof body === 'object' && body !== null && (body as Record<string, unknown>)[field] === '1';
}

function text(body: unknown, field: string): string {
  if (typeof body !== 'object' || body === null) return '';
  const value = (body as Record<string, unknown>)[field];
  return typeof value === 'string' ? value.trim() : '';
}

/** A checkbox group posts one value or many; normalize to a list of ids. */
function idList(body: unknown, field: string): number[] {
  if (typeof body !== 'object' || body === null) return [];
  const raw = (body as Record<string, unknown>)[field];
  const values = Array.isArray(raw) ? raw : raw === undefined ? [] : [raw];
  return values
    .map((value) => Number.parseInt(String(value), 10))
    .filter((value) => Number.isInteger(value) && value > 0);
}

export function createAdminRouter({
  config,
  repo,
  auth,
  views,
  bundledContent,
}: AdminRouteDeps): Router {
  const router = Router();

  /**
   * The catalogue needs a network call, so a failure must not take the whole
   * page down: the picker degrades to a plain text field when the list is empty.
   */
  async function modelChoices(): Promise<ModelOption[]> {
    try {
      return await listModels();
    } catch (error) {
      logger.warn({ err: error }, 'could not load the OpenRouter model list');
      return [];
    }
  }

  async function renderAdmin(
    req: Request,
    notice: { message?: string; error?: string } = {},
  ): Promise<string> {
    const [balance, assistants, users] = await Promise.all([
      fetchBalance(config),
      repo.listAssistants(),
      repo.listUsers(),
    ]);
    return views.adminPage(users, req.user!, { ...notice, balance, assistants });
  }

  async function renderAssistant(
    assistant: Assistant,
    notice: { message?: string; error?: string } = {},
  ): Promise<string> {
    const [models, settings, users, grantedUserIds] = await Promise.all([
      modelChoices(),
      loadSettings(repo, config, assistant.id),
      repo.listUsers(),
      repo.listGrantedUserIds(assistant.id),
    ]);
    return views.assistantPage(assistant, {
      ...notice,
      models,
      settings,
      effortLevels: EFFORT_LEVELS,
      maxSearchResults: MAX_SEARCH_RESULTS,
      users,
      grantedUserIds,
    });
  }

  /** Resolves :id, answering with a 404 page when it is not an assistant. */
  async function resolveAssistant(req: Request, res: Response): Promise<Assistant | null> {
    const id = Number.parseInt(String(req.params.id ?? ''), 10);
    const assistant = Number.isInteger(id) ? await repo.findAssistantById(id) : null;
    if (!assistant) {
      res.status(404).type('html').send(views.errorPage(404, 'This assistant does not exist.'));
      return null;
    }
    return assistant;
  }

  router.get('/admin', auth.requireAdmin, async (req, res) => {
    const message = typeof req.query.ok === 'string' ? req.query.ok : undefined;
    res.type('html').send(await renderAdmin(req, { message }));
  });

  // ---- assistants ---------------------------------------------------------

  router.post('/admin/assistants', auth.requireAdmin, async (req, res, next) => {
    try {
      const name = text(req.body, 'name');
      if (name.length === 0 || name.length > MAX_NAME_LENGTH) {
        res
          .status(400)
          .type('html')
          .send(await renderAdmin(req, { error: 'Give the assistant a name.' }));
        return;
      }

      const taken = new Set((await repo.listAssistants()).map((entry) => entry.slug));
      const slug = uniqueSlug(slugify(name), (candidate) => taken.has(candidate));
      const assistant = await repo.createAssistant(slug, name, '', config.assistantLanguage);
      await provisionAssistant(config, assistant, bundledContent);

      logger.info({ by: req.user!.id, slug, name }, 'assistant created');
      res.redirect(`/admin/assistants/${assistant.id}`);
    } catch (error) {
      next(error);
    }
  });

  router.get('/admin/assistants/:id', auth.requireAdmin, async (req, res) => {
    const assistant = await resolveAssistant(req, res);
    if (!assistant) return;
    const message = typeof req.query.ok === 'string' ? req.query.ok : undefined;
    res.type('html').send(await renderAssistant(assistant, { message }));
  });

  router.post('/admin/assistants/:id', auth.requireAdmin, async (req, res) => {
    const assistant = await resolveAssistant(req, res);
    if (!assistant) return;

    const name = text(req.body, 'name');
    const description = text(req.body, 'description').slice(0, MAX_DESCRIPTION_LENGTH);
    const language = text(req.body, 'language');

    if (name.length === 0 || name.length > MAX_NAME_LENGTH || language.length === 0) {
      res
        .status(400)
        .type('html')
        .send(await renderAssistant(assistant, { error: 'A name and an answer language are required.' }));
      return;
    }

    await repo.updateAssistant(assistant.id, name, description, language);
    logger.info({ by: req.user!.id, assistantId: assistant.id }, 'assistant updated');
    res.redirect(`/admin/assistants/${assistant.id}?ok=${encodeURIComponent('Identity saved.')}`);
  });

  router.post('/admin/assistants/:id/settings', auth.requireAdmin, async (req, res) => {
    const assistant = await resolveAssistant(req, res);
    if (!assistant) return;

    const current = await loadSettings(repo, config, assistant.id);
    const model = text(req.body, 'model');
    const effort = EFFORT_LEVELS.find((level): level is Effort => level === text(req.body, 'effort'));

    if (model.length === 0 || model.length > MAX_MODEL_LENGTH) {
      res.status(400).type('html').send(await renderAssistant(assistant, { error: 'Choose a model.' }));
      return;
    }

    const maxResults = Number.parseInt(text(req.body, 'web_search_max_results'), 10);
    const settings: AssistantSettings = {
      model,
      effort: effort ?? current.effort,
      showThinking: checked(req.body, 'show_thinking'),
      webSearch: checked(req.body, 'web_search'),
      webSearchMaxResults:
        Number.isInteger(maxResults) && maxResults >= 1
          ? Math.min(maxResults, MAX_SEARCH_RESULTS)
          : current.webSearchMaxResults,
      webSearchIncludeDomains: parseDomains(text(req.body, 'web_search_include_domains')),
      webSearchExcludeDomains: parseDomains(text(req.body, 'web_search_exclude_domains')),
      memory: checked(req.body, 'memory'),
      citations: checked(req.body, 'citations'),
      compaction: checked(req.body, 'compaction'),
    };

    await saveSettings(repo, assistant.id, settings);
    logger.info({ by: req.user!.id, assistantId: assistant.id, model }, 'assistant settings changed');
    res.redirect(`/admin/assistants/${assistant.id}?ok=${encodeURIComponent('Settings saved.')}`);
  });

  router.post('/admin/assistants/:id/users', auth.requireAdmin, async (req, res) => {
    const assistant = await resolveAssistant(req, res);
    if (!assistant) return;

    // Admins are allowed everywhere and are never stored as grants, so ticking
    // them would only create rows that nothing reads.
    const admins = new Set(
      (await repo.listUsers()).filter((user) => user.isAdmin).map((user) => user.id),
    );
    const userIds = idList(req.body, 'user').filter((id) => !admins.has(id));

    await repo.setAssistantUsers(assistant.id, userIds);
    logger.info({ by: req.user!.id, assistantId: assistant.id, users: userIds.length }, 'access changed');
    res.redirect(`/admin/assistants/${assistant.id}?ok=${encodeURIComponent('Access saved.')}`);
  });

  router.post('/admin/assistants/:id/delete', auth.requireAdmin, async (req, res) => {
    const assistant = await resolveAssistant(req, res);
    if (!assistant) return;

    // The files are left alone on purpose: a mistaken click should not destroy
    // a knowledge base that took work to write.
    const { contextDir } = assistantPaths(config, assistant.slug);
    await repo.deleteAssistant(assistant.id);
    logger.info(
      { by: req.user!.id, assistantId: assistant.id, keptFiles: contextDir },
      'assistant deleted',
    );
    res.redirect(`/admin?ok=${encodeURIComponent(`${assistant.name} has been deleted.`)}`);
  });

  // ---- users --------------------------------------------------------------

  router.post('/admin/users', auth.requireAdmin, async (req, res) => {
    const email = normalizeEmail(text(req.body, 'email'));
    const isAdmin = checked(req.body, 'is_admin');

    if (!EMAIL_PATTERN.test(email)) {
      res
        .status(400)
        .type('html')
        .send(await renderAdmin(req, { error: 'Enter a valid email address.' }));
      return;
    }

    await repo.upsertUser(email, isAdmin);
    logger.info({ by: req.user!.id, email, isAdmin }, 'user added');
    res.redirect(`/admin?ok=${encodeURIComponent(`${email} has been added.`)}`);
  });

  router.post('/admin/users/:id/delete', auth.requireAdmin, async (req, res) => {
    const id = Number.parseInt(String(req.params.id ?? ''), 10);
    const current = req.user!;

    if (!Number.isInteger(id)) {
      res.status(400).type('html').send(await renderAdmin(req, { error: 'Invalid id.' }));
      return;
    }
    if (id === current.id) {
      res
        .status(400)
        .type('html')
        .send(await renderAdmin(req, { error: 'You cannot delete yourself.' }));
      return;
    }

    await repo.deleteUser(id);
    logger.info({ by: current.id, deletedUserId: id }, 'user deleted');
    res.redirect(`/admin?ok=${encodeURIComponent('User deleted.')}`);
  });

  return router;
}
