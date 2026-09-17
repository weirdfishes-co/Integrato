import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { closeAll, freshRepo } from './helpers/db.js';

import type { Config } from '../src/config.js';
import type { Repo } from '../src/db/repo.js';
import { loadSettings, parseDomains, saveSettings } from '../src/settings.js';

/** Settings are per assistant, so every test needs one to hang them on. */
async function freshAssistant(repo: Repo, slug = 'coach'): Promise<number> {
  return (await repo.createAssistant(slug, 'Coach', '', 'English')).id;
}

/** Only the fields loadSettings reads. */
const config = { defaultModel: 'anthropic/claude-opus-5', effort: 'high' } as Config;

describe('settings storage', () => {
  let repo: Repo;

  let assistantId: number;

  beforeEach(async () => {
    repo = await freshRepo();
    assistantId = await freshAssistant(repo);
  });

  it('overwrites an existing setting instead of inserting a second row', async () => {
    await repo.setSetting(assistantId, 'model', 'openai/gpt-5');
    await repo.setSetting(assistantId, 'model', 'google/gemini-2.5-pro');

    expect(await repo.getSetting(assistantId, 'model')).toBe('google/gemini-2.5-pro');
  });
});

describe('loadSettings', () => {
  let repo: Repo;

  let assistantId: number;

  beforeEach(async () => {
    repo = await freshRepo();
    assistantId = await freshAssistant(repo);
  });

  it('falls back to the environment when no admin has saved anything', async () => {
    const settings = await loadSettings(repo, config, assistantId);

    expect(settings.model).toBe('anthropic/claude-opus-5');
    expect(settings.effort).toBe('high');
  });

  it('defaults every optional feature to off', async () => {
    const settings = await loadSettings(repo, config, assistantId);

    expect(settings.showThinking).toBe(false);
    expect(settings.webSearch).toBe(false);
    expect(settings.memory).toBe(false);
    expect(settings.citations).toBe(false);
    expect(settings.compaction).toBe(false);
  });

  it('prefers the admin choice over the configured default', async () => {
    await repo.setSetting(assistantId, 'model', 'openai/gpt-5');

    expect((await loadSettings(repo, config, assistantId)).model).toBe('openai/gpt-5');
  });

  it('ignores an effort value that is not a known level', async () => {
    await repo.setSetting(assistantId, 'effort', 'turbo');

    expect((await loadSettings(repo, config, assistantId)).effort).toBe('high');
  });

  it('round-trips a full settings object', async () => {
    await saveSettings(repo, assistantId, {
      model: 'openai/gpt-5',
      effort: 'max',
      showThinking: true,
      webSearch: true,
      webSearchMaxResults: 8,
      webSearchIncludeDomains: ['example.com'],
      webSearchExcludeDomains: [],
      memory: true,
      citations: true,
      compaction: true,
    });

    expect(await loadSettings(repo, config, assistantId)).toEqual({
      model: 'openai/gpt-5',
      effort: 'max',
      showThinking: true,
      webSearch: true,
      webSearchMaxResults: 8,
      webSearchIncludeDomains: ['example.com'],
      webSearchExcludeDomains: [],
      memory: true,
      citations: true,
      compaction: true,
    });
  });

  it('caps the result count at the maximum', async () => {
    await repo.setSetting(assistantId, 'web_search_max_results', '9999');

    expect((await loadSettings(repo, config, assistantId)).webSearchMaxResults).toBe(20);
  });
});

describe('parseDomains', () => {
  it('splits on newlines and commas, lowercasing and trimming', async () => {
    expect(parseDomains(' Example.com\nfoo.org , bar.net ')).toEqual([
      'example.com',
      'foo.org',
      'bar.net',
    ]);
  });

  it('drops empty lines and entries containing spaces', async () => {
    expect(parseDomains('example.com\n\n  \nnot a domain\n')).toEqual(['example.com']);
  });

  it('returns an empty list for empty input', async () => {
    expect(parseDomains('')).toEqual([]);
  });
});

afterAll(closeAll);
