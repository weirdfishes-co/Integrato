import { Router, type Request, type Response } from 'express';

import {
  assistantPaths,
  provisionAssistant,
  renameAssistantSlug,
  AssistantError,
  slugify,
  uniqueSlug,
  MAX_DESCRIPTION_LENGTH,
  MAX_NAME_LENGTH,
  MAX_WELCOME_LENGTH,
} from '../assistants.js';
import type { Auth } from '../auth.js';
import { fetchBalance } from '../balance.js';
import { EFFORT_LEVELS, normalizeEmail, type Config, type Effort } from '../config.js';
import type { ContentPaths } from '../content.js';
import type { Assistant, Repo } from '../db/repo.js';
import { logger } from '../logger.js';
import { isAspectRatio, isAssistantKind, isVoice, DEFAULT_KIND, type AssistantKind } from '../kinds.js';
import { euProviderTags, listModelsForKind, type ModelOption } from '../models.js';
import {
  loadSettings,
  parseDomains,
  parseSampling,
  saveSettings,
  MAX_SEARCH_RESULTS,
  MAX_TEMPERATURE,
  MAX_TOP_P,
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
   *
   * An EU-only chatbot is offered OpenRouter's European catalogue instead of
   * the whole one, so the picker cannot suggest a model the routing rules will
   * then refuse.
   */
  async function modelChoices(euOnly: boolean, kind: AssistantKind): Promise<ModelOption[]> {
    try {
      // Filtered by modality: offering a text model to an image chatbot would
      // produce a chatbot that fails on its first message.
      return await listModelsForKind(kind, euOnly ? { region: 'eu' } : {});
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
    const [settings, users, grantedUserIds, usage] = await Promise.all([
      loadSettings(repo, config, assistant.id),
      repo.listUsers(),
      repo.listGrantedUserIds(assistant.id),
      repo.usageByUser(assistant.id),
    ]);
    const models = await modelChoices(settings.euOnly, assistant.kind);

    return views.assistantPage(assistant, {
      ...notice,
      models,
      settings,
      effortLevels: EFFORT_LEVELS,
      maxSearchResults: MAX_SEARCH_RESULTS,
      maxTemperature: MAX_TEMPERATURE,
      maxTopP: MAX_TOP_P,
      users,
      grantedUserIds,
      usage,
    });
  }

  /**
   * Why this combination of settings cannot work, or null when it can.
   *
   * Only EU-only routing can be saved into an unusable state: it is resolved
   * against OpenRouter's endpoint list for the chosen model, which would
   * otherwise fail on every message with the admin nowhere near. Anonymization
   * runs in this process and has nothing to be wrong about.
   */
  async function unusable(settings: AssistantSettings): Promise<string | null> {
    if (settings.euOnly) {
      let tags: string[];
      try {
        tags = await euProviderTags(settings.model);
      } catch (error) {
        logger.warn({ err: error, model: settings.model }, 'could not resolve EU endpoints');
        return 'OpenRouter could not be reached to check where this model is served. Try saving again in a moment.';
      }
      if (tags.length === 0) {
        return 'No provider serves this model from the EU. Pick another model, or switch EU-only routing off.';
      }
    }

    return null;
  }

  /** Resolves :id, answering with a 404 page when it is not an assistant. */
  async function resolveAssistant(req: Request, res: Response): Promise<Assistant | null> {
    const id = Number.parseInt(String(req.params.id ?? ''), 10);
    const assistant = Number.isInteger(id) ? await repo.findAssistantById(id) : null;
    if (!assistant) {
      res.status(404).type('html').send(views.errorPage(404, 'This chatbot does not exist.'));
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
          .send(await renderAdmin(req, { error: 'Give the chatbot a name.' }));
        return;
      }

      const kindValue = text(req.body, 'kind');
      const kind: AssistantKind = isAssistantKind(kindValue) ? kindValue : DEFAULT_KIND;

      const taken = new Set((await repo.listAssistants()).map((entry) => entry.slug));
      const slug = uniqueSlug(slugify(name), (candidate) => taken.has(candidate));
      const assistant = await repo.createAssistant(slug, name, '', config.assistantLanguage, kind);
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
    // A kind without the field (speech to text) posts none: keep what is stored.
    const language = text(req.body, 'language') || assistant.language;
    // Cut rather than refuse: maxlength on the field already stops an honest
    // browser, and losing a long paste is worse than silently trimming it.
    const welcome = text(req.body, 'welcome').slice(0, MAX_WELCOME_LENGTH);

    if (name.length === 0 || name.length > MAX_NAME_LENGTH || language.length === 0) {
      res
        .status(400)
        .type('html')
        .send(await renderAssistant(assistant, { error: 'A name and an answer language are required.' }));
      return;
    }

    // Empty means "leave the address alone", so an older cached form cannot
    // blank it.
    const slug = text(req.body, 'slug').toLowerCase();
    if (slug.length > 0 && slug !== assistant.slug) {
      try {
        await renameAssistantSlug(config, repo, assistant, slug);
      } catch (error) {
        if (!(error instanceof AssistantError)) throw error;
        res.status(400).type('html').send(await renderAssistant(assistant, { error: error.message }));
        return;
      }
    }

    const kindValue = text(req.body, 'kind');
    const kind: AssistantKind = isAssistantKind(kindValue) ? kindValue : assistant.kind;

    await repo.updateAssistant(assistant.id, name, description, language, welcome, kind);
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
      notes: checked(req.body, 'notes'),
      euOnly: checked(req.body, 'eu_only'),
      anonymize: checked(req.body, 'anonymize'),
      adminConversationLog: checked(req.body, 'admin_conversation_log'),
      temperature: parseSampling(text(req.body, 'temperature'), MAX_TEMPERATURE),
      topP: parseSampling(text(req.body, 'top_p'), MAX_TOP_P),
      // Only the ratios OpenRouter enumerates; anything else it refuses.
      aspectRatio: isAspectRatio(text(req.body, 'aspect_ratio'))
        ? text(req.body, 'aspect_ratio')
        : null,
      // The provider refuses an unknown voice, so only known ones are stored.
      voice: isVoice(text(req.body, 'voice')) ? text(req.body, 'voice') : null,
    };

    // Say no here rather than on the first message. The two settings that can
    // be saved into an unusable combination are checked against the outside
    // world now, while an admin is looking at the page and can fix it.
    const complaint = await unusable(settings);
    if (complaint) {
      res.status(400).type('html').send(await renderAssistant(assistant, { error: complaint }));
      return;
    }

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
