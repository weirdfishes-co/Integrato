import { describe, expect, it } from 'vitest';

import type { Balance } from '../src/balance.js';
import type { Assistant, ConversationWithUser, Message, Note, User, UserUsage } from '../src/db/repo.js';
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
    notes: false,
    adminConversationLog: false,
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

  it('ticks the admin conversation log toggle from the settings', () => {
    expect(render({ adminConversationLog: true })).toContain(
      'name="admin_conversation_log" value="1" checked',
    );
    expect(render()).not.toContain('name="admin_conversation_log" value="1" checked');
  });

  it('only links to the conversation log once it is turned on', () => {
    expect(render({ adminConversationLog: true })).toContain(
      `href="/admin/assistants/${assistant.id}/conversations"`,
    );
    expect(render()).not.toContain('/conversations"');
  });

  it('shows token and cost totals per user', () => {
    const usage: UserUsage[] = [
      { userId: 2, email: 'user@example.com', answerCount: 3, promptTokens: 1000, completionTokens: 500, cost: 0.12 },
    ];
    const html = views.assistantPage(assistant, { settings, models: [model()], usage });

    expect(html).toContain('user@example.com');
    expect(html).toContain('1,500');
    expect(html).toContain('$0.12');
    expect(html).toContain('Total: $0.12');
  });

  it('says so when nobody has used the chatbot yet', () => {
    const html = views.assistantPage(assistant, { settings, models: [model()], usage: [] });

    expect(html).toContain('No answers yet.');
  });

  it('shows "not recorded" rather than $0.00 when cost was never reported', () => {
    const usage: UserUsage[] = [
      { userId: 2, email: 'user@example.com', answerCount: 1, promptTokens: 10, completionTokens: 5, cost: null },
    ];
    const html = views.assistantPage(assistant, { settings, models: [model()], usage });

    expect(html).toContain('not recorded');
    expect(html).not.toContain('Total:');
  });
});

describe('the setup strip under the chat', () => {
  const user: User = {
    id: 2,
    email: 'user@example.com',
    isAdmin: false,
    createdAt: '',
    lastSeenAt: null,
  };

  const assistant: Assistant = {
    id: 7,
    slug: 'coach',
    name: 'Coach',
    description: '',
    language: 'Nederlands',
    welcome: '',
    createdAt: '',
  };

  const off: AssistantSettings = {
    model: 'google/gemini-3.5-flash-lite',
    effort: 'high',
    showThinking: false,
    webSearch: false,
    webSearchMaxResults: 5,
    webSearchIncludeDomains: [],
    webSearchExcludeDomains: [],
    memory: false,
    citations: false,
    compaction: false,
    notes: false,
    adminConversationLog: false,
    euOnly: false,
    anonymize: false,
    temperature: null,
    topP: null,
  };

  function render(overrides: Partial<AssistantSettings> = {}): string {
    return views.chatPage(user, assistant, false, { ...off, ...overrides });
  }

  /* A native <details>, so the accordion needs no script and keeps its keys. */
  it('is a closed accordion', () => {
    const html = render();

    expect(html).toContain('<details class="setup">');
    expect(html).not.toContain('<details class="setup" open>');
  });

  it('names the model while it is still shut', () => {
    expect(render()).toContain('<span class="setup__model">google/gemini-3.5-flash-lite</span>');
  });

  /* A long name must not push the sidebar's own links out of reach. */
  it('cuts the chatbot name at 40 characters but keeps it whole in the tooltip', () => {
    const long = { ...assistant, name: 'The Exceptionally Long Nyenrode Executive Coaching Chatbot' };
    const html = views.chatPage(user, long, false, off);

    expect(html).toContain('title="The Exceptionally Long Nyenrode Executive Coaching Chatbot"');
    expect(html).toMatch(/class="brand__assistant"[^>]*>The Exceptionally Long Nyenrode Executi\u2026</);
  });

  it('leaves a name that already fits alone', () => {
    expect(views.chatPage(user, assistant, false, off)).toContain('>Coach</span>');
  });

  /*
   * On the chat screen as well as the picker: a user granted exactly one
   * chatbot never sees the picker, and sessions last 30 days.
   */
  it('offers sign-out on the chat screen too', () => {
    expect(views.chatPage(user, assistant, false, off)).toContain('/logout');
    expect(views.pickerPage(user, [assistant])).toContain('/logout');
  });

  it('calls the editor Documents, not My documents', () => {
    const html = views.chatPage(user, assistant, false, { ...off, notes: true });

    expect(html).toContain('>Documents</a>');
    expect(html).not.toContain('My documents');
  });

  /*
   * The row with the most at stake for whoever is reading it: it is stated as
   * what happens, not as the name of the setting that causes it.
   */
  it('discloses whether an administrator can read these conversations', () => {
    const on = views.chatPage(user, assistant, false, { ...off, adminConversationLog: true });
    const shut = views.chatPage(user, assistant, false, off);

    expect(on).toContain('Administrators can read these conversations');
    expect(on).toContain('not only your own');
    expect(shut).toContain('nobody else can open your conversations');
  });

  it('states the routing either way', () => {
    expect(render({ euOnly: true })).toContain('EU and EEA data centres only');
    expect(render()).toContain('no regional restriction');
  });

  /*
   * The limit has to travel with the claim: a user told their message is
   * anonymized would otherwise assume their name was covered.
   */
  it('says names are not anonymized, right where it says anonymization is on', () => {
    expect(render({ anonymize: true })).toContain('names are not');
  });

  it('reports the sampling, or that the model decides', () => {
    expect(render({ temperature: 0.3, topP: 0.9 })).toContain('temperature 0.3, top-p 0.9');
    expect(render()).toContain("the model&#39;s own defaults");
  });

  it('spells out what web search may reach', () => {
    expect(render({ webSearch: true, webSearchIncludeDomains: ['nyenrode.nl'] })).toContain(
      'only nyenrode.nl, 5 results',
    );
    expect(render({ webSearch: true })).toContain('the whole web');
  });

  it('shows the answer language from the chatbot, not the settings', () => {
    expect(render()).toContain('Nederlands');
  });

  /* It is shown to everyone; nothing in it is a secret. */
  it('is there for an ordinary user, not only an admin', () => {
    expect(user.isAdmin).toBe(false);
    expect(render()).toContain('How this chatbot is set up');
  });
});

describe('the document pages', () => {
  const user: User = {
    id: 2,
    email: 'user@example.com',
    isAdmin: false,
    createdAt: '',
    lastSeenAt: null,
  };

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
    notes: false,
    adminConversationLog: false,
    euOnly: false,
    anonymize: false,
    temperature: null,
    topP: null,
  };

  const note: Note = {
    id: 3,
    userId: 2,
    assistantId: 7,
    name: 'Q3 goals',
    tags: ['goals'],
    content: '# Q3\n\nGrow the team.',
    createdAt: '2026-10-01 09:00:00',
    updatedAt: '2026-10-02 11:00:00',
  };

  /* The chat only offers the editor when the chatbot was given it. */
  it('links to the documents from the chat only when the setting is on', () => {
    const on = views.chatPage(user, assistant, false, { ...settings, notes: true });
    const off = views.chatPage(user, assistant, false, settings);

    expect(on).toContain('href="/coach/documents"');
    expect(off).not.toContain('/coach/documents');
  });

  it('lists a document with its tags and the date it changed', () => {
    const html = views.notesPage(assistant, [note], {});

    expect(html).toContain('Q3 goals');
    expect(html).toContain('<span class="tag">goals</span>');
    expect(html).toContain('2026-10-02');
    expect(html).toContain('href="/coach/documents/3"');
  });

  it('says plainly who can see them', () => {
    expect(views.notesPage(assistant, [], {})).toContain('Only you can see these');
  });

  it('offers both save buttons, which the route tells apart by value', () => {
    const html = views.notePage(assistant, note, {});

    expect(html).toContain('name="finish" value="0"');
    expect(html).toContain('name="finish" value="1"');
  });

  it('posts a new document to the collection and an edit to its own address', () => {
    expect(views.notePage(assistant, null, {})).toContain('action="/coach/documents"');
    expect(views.notePage(assistant, note, {})).toContain('action="/coach/documents/3"');
  });

  it('fills the editor from the stored document', () => {
    const html = views.notePage(assistant, note, {});

    expect(html).toContain('value="Q3 goals"');
    expect(html).toContain('value="goals"');
    expect(html).toContain('Grow the team.');
  });

  /*
   * A rejected save must come back with what was typed. Re-rendering the stored
   * version would throw away the edit that was being saved.
   */
  it('keeps the draft, not the stored text, when a save was refused', () => {
    const html = views.notePage(assistant, note, {
      error: 'The document is empty.',
      draft: { name: 'Renamed', tags: 'fresh', content: 'Edited text.' },
    });

    expect(html).toContain('value="Renamed"');
    expect(html).toContain('Edited text.');
    expect(html).not.toContain('Grow the team.');
    expect(html).toContain('The document is empty.');
  });

  it('escapes a document name rather than rendering it', () => {
    const hostile = { ...note, name: '<script>alert(1)</script>' };

    expect(views.notesPage(assistant, [hostile], {})).not.toContain('<script>alert');
  });
});

describe('the admin conversation log pages', () => {
  const assistant: Assistant = {
    id: 7,
    slug: 'coach',
    name: 'Coach',
    description: '',
    language: 'English',
    welcome: '',
    createdAt: '',
  };

  const conversation: ConversationWithUser = {
    id: 42,
    userId: 2,
    assistantId: 7,
    title: 'Planning Q4',
    createdAt: '2026-10-01 09:00:00',
    updatedAt: '2026-10-02 11:00:00',
    summary: null,
    summarizedThrough: null,
    userEmail: 'user@example.com',
  };

  const messages: Message[] = [
    { id: 1, conversationId: 42, role: 'user', content: 'What is our Q4 plan?', createdAt: '2026-10-02 10:59:00', usage: null },
    { id: 2, conversationId: 42, role: 'assistant', content: 'Here is the plan.', createdAt: '2026-10-02 11:00:00', usage: null },
  ];

  it('lists every conversation with who it belongs to', () => {
    const html = views.conversationsPage([conversation], { assistant });

    expect(html).toContain('Planning Q4');
    expect(html).toContain('user@example.com');
    expect(html).toContain(`href="/admin/assistants/7/conversations/42"`);
  });

  it('says plainly that stored text is never anonymized', () => {
    expect(views.conversationsPage([], { assistant })).toContain('never anonymized');
  });

  it('shows every message with its role', () => {
    const html = views.conversationPage(messages, {
      assistant,
      conversation,
      base: '/admin/assistants/7/conversations',
    });

    expect(html).toContain('What is our Q4 plan?');
    expect(html).toContain('Here is the plan.');
    expect(html).toContain('message--user');
    expect(html).toContain('message--assistant');
    expect(html).toContain('user@example.com');
  });

  it('escapes message content rather than rendering it', () => {
    const hostile = [{ ...messages[0]!, content: '<script>alert(1)</script>' }];

    expect(
      views.conversationPage(hostile, { assistant, conversation, base: '/admin/assistants/7/conversations' }),
    ).not.toContain('<script>alert');
  });
});
