import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { closeAll, freshRepo } from './helpers/db.js';

import type { Config } from '../src/config.js';
import type { Repo } from '../src/db/repo.js';
import {
  loadSettings,
  parseDomains,
  parseSampling,
  saveSettings,
  MAX_TEMPERATURE,
} from '../src/settings.js';

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
    expect(settings.euOnly).toBe(false);
    expect(settings.anonymize).toBe(false);
  });

  /*
   * Not zero, and not a number of our own choosing: an unset knob has to stay
   * unset, so the model uses the default its provider tuned.
   */
  it('leaves temperature and top-p unset until an admin fills them in', async () => {
    const settings = await loadSettings(repo, config, assistantId);

    expect(settings.temperature).toBeNull();
    expect(settings.topP).toBeNull();
  });

  it('keeps a temperature of zero, which is a real choice', async () => {
    await repo.setSetting(assistantId, 'temperature', '0');

    expect((await loadSettings(repo, config, assistantId)).temperature).toBe(0);
  });

  it('ignores a sampling value outside the range the API accepts', async () => {
    await repo.setSetting(assistantId, 'temperature', '11');
    await repo.setSetting(assistantId, 'top_p', '-1');

    const settings = await loadSettings(repo, config, assistantId);
    expect(settings.temperature).toBeNull();
    expect(settings.topP).toBeNull();
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
      euOnly: true,
      anonymize: true,
      temperature: 0.3,
      topP: null,
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
      euOnly: true,
      anonymize: true,
      temperature: 0.3,
      topP: null,
    });
  });

  it('caps the result count at the maximum', async () => {
    await repo.setSetting(assistantId, 'web_search_max_results', '9999');

    expect((await loadSettings(repo, config, assistantId)).webSearchMaxResults).toBe(20);
  });
});

describe('parseSampling', () => {
  it('reads a number an admin typed', async () => {
    expect(parseSampling('0.7', MAX_TEMPERATURE)).toBe(0.7);
  });

  it('treats a blank field as "leave it to the model"', async () => {
    expect(parseSampling('', MAX_TEMPERATURE)).toBeNull();
    expect(parseSampling('   ', MAX_TEMPERATURE)).toBeNull();
  });

  it('clamps rather than refuses, so a typo does not lose the whole form', async () => {
    expect(parseSampling('9', MAX_TEMPERATURE)).toBe(MAX_TEMPERATURE);
    expect(parseSampling('-3', MAX_TEMPERATURE)).toBe(0);
  });

  it('rejects something that is not a number at all', async () => {
    expect(parseSampling('warm', MAX_TEMPERATURE)).toBeNull();
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
