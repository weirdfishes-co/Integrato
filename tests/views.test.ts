import { describe, expect, it } from 'vitest';

import type { Balance } from '../src/balance.js';
import type { Assistant, User } from '../src/db/repo.js';
import type { ModelOption } from '../src/models.js';
import type { AssistantSettings } from '../src/settings.js';
import { createViews } from '../src/views.js';

const views = createViews({ assistantName: 'Test Assistant', assistantLanguage: 'English' });

const admin: User = {
  id: 1,
  email: 'admin@example.com',
  isAdmin: true,
  createdAt: '',
  lastSeenAt: null,
};

const healthy: Balance = {
  totalCredits: 25,
  totalUsage: 5,
  remaining: 20,
  limit: null,
  limitRemaining: null,
  limitReset: null,
  isFreeTier: false,
};

function render(balance: Balance | null | undefined): string {
  return views.adminPage([admin], admin, { balance });
}

describe('admin balance panel', () => {
  it('shows the remaining balance', () => {
    const html = render(healthy);

    expect(html).toContain('OpenRouter balance');
    expect(html).toContain('$20.00');
    expect(html).toContain('balance--ok');
  });

  it('warns when the account is overdrawn', () => {
    const html = render({ ...healthy, totalCredits: 0, totalUsage: 0.14, remaining: -0.14 });

    expect(html).toContain('balance--empty');
    expect(html).toContain('-$0.14');
    expect(html).toContain('Out of credits');
  });

  it('warns when the balance is nearly gone', () => {
    const html = render({ ...healthy, remaining: 0.5 });

    expect(html).toContain('balance--low');
    expect(html).toContain('Running low.');
  });

  it('separates the key cap from the account balance', () => {
    const html = render({ ...healthy, limit: 12, limitRemaining: 11.86, limitReset: 'monthly' });

    expect(html).toContain('$11.86');
    expect(html).toContain('not money in the account');
  });

  it('says so when OpenRouter could not be reached', () => {
    const html = render(null);

    expect(html).toContain('Could not reach OpenRouter');
    expect(html).not.toContain('balance--');
  });

  it('omits the panel entirely when no balance was requested', () => {
    const html = render(undefined);

    expect(html).not.toContain('OpenRouter balance');
  });
});

describe('the chatbot settings form', () => {
  const assistant: Assistant = {
    id: 7,
    slug: 'coach',
    name: 'Coach',
    description: '',
    language: 'English',
    welcome: '',
    createdAt: '',
  };

  const settings: AssistantSettings = {
    model: 'a/b',
    effort: 'high',
    showThinking: false,
    webSearch: false,
    webSearchMaxResults: 5,
    webSearchIncludeDomains: [],
    webSearchExcludeDomains: [],
    memory: false,
    citations: false,
    compaction: false,
    euOnly: false,
    anonymize: false,
    temperature: null,
    topP: null,
  };

  function model(overrides: Partial<ModelOption> = {}): ModelOption {
    return {
      id: 'a/b',
      name: 'B',
      contextLength: 1000,
      inputPricePerMillion: null,
      outputPricePerMillion: null,
      supportsReasoning: true,
      supportsSampling: true,
      ...overrides,
    };
  }

  function render(overrides: Partial<AssistantSettings> = {}, models = [model()]): string {
    return views.assistantPage(assistant, { settings: { ...settings, ...overrides }, models });
  }

  /* Empty, not 0: an unset knob has to reach the form as an empty field. */
  it('leaves the sampling fields blank while they are unset', () => {
    expect(render()).toContain('id="temperature" name="temperature" type="number" step="0.05"');
    expect(render()).not.toContain('value="0"');
  });

  it('shows a temperature an admin saved', () => {
    expect(render({ temperature: 0.3 })).toContain('value="0.3"');
  });

  it('says so when the chosen model accepts neither knob', () => {
    expect(render({}, [model({ supportsSampling: false })])).toContain('accepts neither setting');
    expect(render()).not.toContain('accepts neither setting');
  });

  it('ticks the two new toggles from the settings', () => {
    const html = render({ euOnly: true, anonymize: true });

    expect(html).toContain('name="eu_only" value="1" checked');
    expect(html).toContain('name="anonymize" value="1" checked');
  });

  it('explains that the model list is narrowed while EU-only is on', () => {
    expect(render({ euOnly: true })).toContain('serve from the EU');
    expect(render()).not.toContain('serve from the EU');
  });

  /*
   * The gap has to be on the page, not only in the README: an admin switching
   * this on will otherwise assume names are covered.
   */
  it('says on the page that names are not caught', () => {
    expect(render({ anonymize: true })).toContain('does not catch names');
  });
});
