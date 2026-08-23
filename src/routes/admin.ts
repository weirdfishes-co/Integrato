import { Router, type Request } from 'express';

import type { Auth } from '../auth.js';
import { fetchBalance } from '../balance.js';
import { EFFORT_LEVELS, normalizeEmail, type Config, type Effort } from '../config.js';
import type { Repo } from '../db/repo.js';
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
}

function checked(body: unknown, field: string): boolean {
  return typeof body === 'object' && body !== null && (body as Record<string, unknown>)[field] === '1';
}

function text(body: unknown, field: string): string {
  if (typeof body !== 'object' || body === null) return '';
  const value = (body as Record<string, unknown>)[field];
  return typeof value === 'string' ? value.trim() : '';
}

export function createAdminRouter({ config, repo, auth, views }: AdminRouteDeps): Router {
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
    const [models, balance] = await Promise.all([modelChoices(), fetchBalance(config)]);
    return views.adminPage(repo.listUsers(), req.user!, {
      ...notice,
      models,
      balance,
      settings: loadSettings(repo, config),
      effortLevels: EFFORT_LEVELS,
      maxSearchResults: MAX_SEARCH_RESULTS,
    });
  }

  router.get('/admin', auth.requireAdmin, async (req, res) => {
    const message = typeof req.query.ok === 'string' ? req.query.ok : undefined;
    res.type('html').send(await renderAdmin(req, { message }));
  });

  router.post('/admin/settings', auth.requireAdmin, async (req, res) => {
    const current = loadSettings(repo, config);
    const model = text(req.body, 'model');
    const effort = EFFORT_LEVELS.find((level): level is Effort => level === text(req.body, 'effort'));

    if (model.length === 0 || model.length > MAX_MODEL_LENGTH) {
      res.status(400).type('html').send(await renderAdmin(req, { error: 'Choose a model.' }));
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

    saveSettings(repo, settings);
    logger.info({ by: req.user!.id, model: settings.model }, 'settings changed');
    res.redirect(`/admin?ok=${encodeURIComponent('Settings saved.')}`);
  });

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

    repo.upsertUser(email, isAdmin);
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

    repo.deleteUser(id);
    logger.info({ by: current.id, deletedUserId: id }, 'user deleted');
    res.redirect(`/admin?ok=${encodeURIComponent('User deleted.')}`);
  });

  return router;
}
