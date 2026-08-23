import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { beforeEach, describe, expect, it } from 'vitest';

import type { Config } from '../src/config.js';
import { openDatabase } from '../src/db/index.js';
import { createRepo, type Repo } from '../src/db/repo.js';
import { loadSettings, parseDomains, saveSettings } from '../src/settings.js';

function freshRepo(): Repo {
  const dir = mkdtempSync(join(tmpdir(), 'assistant-settings-'));
  return createRepo(openDatabase(join(dir, 'test.db')));
}

/** Only the fields loadSettings reads. */
const config = { defaultModel: 'anthropic/claude-opus-5', effort: 'high' } as Config;

describe('settings storage', () => {
  let repo: Repo;

  beforeEach(() => {
    repo = freshRepo();
  });

  it('overwrites an existing setting instead of inserting a second row', () => {
    repo.setSetting('model', 'openai/gpt-5');
    repo.setSetting('model', 'google/gemini-2.5-pro');

    expect(repo.getSetting('model')).toBe('google/gemini-2.5-pro');
  });
});

describe('loadSettings', () => {
  let repo: Repo;

  beforeEach(() => {
    repo = freshRepo();
  });

  it('falls back to the environment when no admin has saved anything', () => {
    const settings = loadSettings(repo, config);

    expect(settings.model).toBe('anthropic/claude-opus-5');
    expect(settings.effort).toBe('high');
  });

  it('defaults every optional feature to off', () => {
    const settings = loadSettings(repo, config);

    expect(settings.showThinking).toBe(false);
    expect(settings.webSearch).toBe(false);
    expect(settings.memory).toBe(false);
    expect(settings.citations).toBe(false);
    expect(settings.compaction).toBe(false);
  });

  it('prefers the admin choice over the configured default', () => {
    repo.setSetting('model', 'openai/gpt-5');

    expect(loadSettings(repo, config).model).toBe('openai/gpt-5');
  });

  it('ignores an effort value that is not a known level', () => {
    repo.setSetting('effort', 'turbo');

    expect(loadSettings(repo, config).effort).toBe('high');
  });

  it('round-trips a full settings object', () => {
    saveSettings(repo, {
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

    expect(loadSettings(repo, config)).toEqual({
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

  it('caps the result count at the maximum', () => {
    repo.setSetting('web_search_max_results', '9999');

    expect(loadSettings(repo, config).webSearchMaxResults).toBe(20);
  });
});

describe('parseDomains', () => {
  it('splits on newlines and commas, lowercasing and trimming', () => {
    expect(parseDomains(' Example.com\nfoo.org , bar.net ')).toEqual([
      'example.com',
      'foo.org',
      'bar.net',
    ]);
  });

  it('drops empty lines and entries containing spaces', () => {
    expect(parseDomains('example.com\n\n  \nnot a domain\n')).toEqual(['example.com']);
  });

  it('returns an empty list for empty input', () => {
    expect(parseDomains('')).toEqual([]);
  });
});
