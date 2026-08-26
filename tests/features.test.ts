import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { beforeEach, describe, expect, it } from 'vitest';

import { compactConversation, historyWithSummary, parseSummary } from '../src/compaction.js';
import { createRepo, type Message, type Repo } from '../src/db/repo.js';
import { openDatabase } from '../src/db/index.js';
import type { ChatClient } from '../src/llm.js';
import { memorySection, parseFacts } from '../src/memory.js';
import type { AssistantSettings } from '../src/settings.js';

function freshRepo(): Repo {
  const dir = mkdtempSync(join(tmpdir(), 'assistant-features-'));
  return createRepo(openDatabase(join(dir, 'test.db')));
}

function message(id: number, content: string): Message {
  return { id, conversationId: 1, role: 'user', content, createdAt: '' };
}

describe('historyWithSummary', () => {
  const messages = [message(1, 'one'), message(2, 'two'), message(3, 'three')];

  it('returns the most recent messages when there is no summary', () => {
    expect(historyWithSummary(messages, null, 2)).toEqual([
      { role: 'user', content: 'two' },
      { role: 'user', content: 'three' },
    ]);
  });

  it('prepends the summary as an opening turn', () => {
    const history = historyWithSummary(messages, 'They discussed onboarding.', 2);

    expect(history).toHaveLength(3);
    expect(history[0]?.content).toContain('They discussed onboarding.');
    expect(history[1]?.content).toBe('two');
  });

  it('keeps every message when the limit exceeds the conversation length', () => {
    expect(historyWithSummary(messages, null, 99)).toHaveLength(3);
  });
});

describe('memorySection', () => {
  let repo: Repo;
  let assistantId: number;

  beforeEach(() => {
    repo = freshRepo();
    assistantId = repo.createAssistant('coach', 'Coach', '', 'English').id;
  });

  it('returns null for a user with no memories', () => {
    const user = repo.upsertUser('a@example.com', false);

    expect(memorySection(repo, user.id, assistantId)).toBeNull();
  });

  it('lists the stored facts', () => {
    const user = repo.upsertUser('a@example.com', false);
    repo.addMemory(user.id, assistantId, 'Works as a recruiter at Acme.');
    repo.addMemory(user.id, assistantId, 'Prefers short answers.');

    const section = memorySection(repo, user.id, assistantId);

    expect(section).toContain('Works as a recruiter at Acme.');
    expect(section).toContain('Prefers short answers.');
  });

  it('does not leak one user memories into another user prompt', () => {
    const alice = repo.upsertUser('alice@example.com', false);
    const bob = repo.upsertUser('bob@example.com', false);
    repo.addMemory(alice.id, assistantId, 'Works at Acme.');

    expect(memorySection(repo, bob.id, assistantId)).toBeNull();
  });
});

describe('compactConversation', () => {
  let repo: Repo;

  /** Records what it was asked to summarize; returns a fixed summary. */
  function stubChat(): { chat: ChatClient; prompts: string[] } {
    const prompts: string[] = [];
    const chat = {
      stream: async () => ({ answer: '', sources: [] }),
      complete: async ({ user }: { user: string }) => {
        prompts.push(user);
        return '<summary>They discussed onboarding.</summary>';
      },
    } as unknown as ChatClient;
    return { chat, prompts };
  }

  const settings = { compaction: true, model: 'test/model' } as AssistantSettings;

  beforeEach(() => {
    repo = freshRepo();
  });

  function seed(count: number): number {
    const user = repo.upsertUser('a@example.com', false);
    const assistantId = repo.createAssistant('t', 'T', '', 'English').id;
    const conversation = repo.createConversation(user.id, assistantId, 'Test');
    for (let index = 0; index < count; index += 1) {
      repo.addMessage(conversation.id, index % 2 === 0 ? 'user' : 'assistant', `message ${index}`);
    }
    return conversation.id;
  }

  it('does nothing for a conversation below the threshold', async () => {
    const id = seed(10);
    const { chat, prompts } = stubChat();

    await compactConversation({ repo, chat }, settings, id);

    expect(prompts).toHaveLength(0);
    expect(repo.findConversationById(id)?.summary).toBeNull();
  });

  it('does nothing when compaction is switched off', async () => {
    const id = seed(50);
    const { chat, prompts } = stubChat();

    await compactConversation({ repo, chat }, { ...settings, compaction: false }, id);

    expect(prompts).toHaveLength(0);
  });

  it('summarizes everything older than the verbatim window', async () => {
    const id = seed(50);
    const { chat, prompts } = stubChat();

    await compactConversation({ repo, chat }, settings, id);

    const conversation = repo.findConversationById(id);
    expect(conversation?.summary).toBe('They discussed onboarding.');
    // 50 messages, last 20 kept verbatim -> the first 30 are summarized.
    expect(prompts[0]).toContain('message 0');
    expect(prompts[0]).toContain('message 29');
    expect(prompts[0]).not.toContain('message 30');
    expect(conversation?.summarizedThrough).toBe(30);
  });

  it('does not re-summarize messages already covered', async () => {
    const id = seed(50);
    const { chat, prompts } = stubChat();

    await compactConversation({ repo, chat }, settings, id);
    await compactConversation({ repo, chat }, settings, id);

    expect(prompts).toHaveLength(1);
  });
});

describe('parseFacts', () => {
  it('reads the lines inside the facts block', () => {
    expect(parseFacts('<facts>\nWorks at Acme.\nPrefers short answers.\n</facts>')).toEqual([
      'Works at Acme.',
      'Prefers short answers.',
    ]);
  });

  it('ignores reasoning a model wrote before the block', () => {
    const raw = [
      "Here's a thinking process:",
      'Analyze User Request:**',
      'The user is Stephan, a developer.',
      '<facts>',
      'Works as a developer.',
      '</facts>',
    ].join('\n');

    expect(parseFacts(raw)).toEqual(['Works as a developer.']);
  });

  it('returns nothing when the model skipped the block entirely', () => {
    expect(parseFacts('Works as a developer.\nPrefers short answers.')).toEqual([]);
  });

  it('returns nothing for an empty block', () => {
    expect(parseFacts('<facts></facts>')).toEqual([]);
  });

  it('strips bullets and numbering', () => {
    expect(parseFacts('<facts>\n- Works at Acme.\n2. Lives in Utrecht.\n</facts>')).toEqual([
      'Works at Acme.',
      'Lives in Utrecht.',
    ]);
  });
});

describe('parseSummary', () => {
  it('reads the summary block', () => {
    expect(parseSummary('<summary>They discussed onboarding.</summary>')).toBe(
      'They discussed onboarding.',
    );
  });

  it('drops anything written outside the block', () => {
    expect(parseSummary('Let me think.\n<summary>They discussed onboarding.</summary>')).toBe(
      'They discussed onboarding.',
    );
  });

  it('falls back to the whole reply when the model skipped the tags', () => {
    expect(parseSummary('  They discussed onboarding.  ')).toBe('They discussed onboarding.');
  });
});
