import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { closeAll, freshRepo } from './helpers/db.js';

import type { MessageUsage, Repo } from '../src/db/repo.js';
import { formatCost, formatTokens, totalsLine, usageLine } from '../public/format.js';

const usage: MessageUsage = {
  promptTokens: 1234,
  completionTokens: 567,
  reasoningTokens: 0,
  cachedTokens: 0,
  cost: 0.0031,
};

describe('storing what an answer cost', () => {
  let repo: Repo;
  let conversationId: number;

  beforeEach(async () => {
    repo = await freshRepo();
    const user = await repo.upsertUser('a@example.com', false);
    const assistant = await repo.createAssistant('coach', 'Coach', '', 'English');
    conversationId = (await repo.createConversation(user.id, assistant.id, 'Test')).id;
  });

  it('round-trips the tokens and the cost', async () => {
    const stored = await repo.addMessage(conversationId, 'assistant', 'Hello', usage);

    expect(stored.usage).toEqual(usage);
    expect((await repo.listMessages(conversationId))[0]?.usage).toEqual(usage);
  });

  /*
   * NUMERIC comes back from the driver as a string, so without the conversion
   * every arithmetic on a cost would silently concatenate instead of add.
   */
  it('reads the cost back as a number, not the string Postgres sends', async () => {
    await repo.addMessage(conversationId, 'assistant', 'Hello', usage);
    const cost = (await repo.listMessages(conversationId))[0]?.usage?.cost;

    expect(typeof cost).toBe('number');
  });

  it('keeps a cost far below a cent instead of rounding it away', async () => {
    await repo.addMessage(conversationId, 'assistant', 'Hi', { ...usage, cost: 0.0000059 });

    expect((await repo.listMessages(conversationId))[0]?.usage?.cost).toBeCloseTo(0.0000059, 10);
  });

  /* Null, not zero: zero would claim the answer was free. */
  it('leaves usage null when none was reported', async () => {
    const stored = await repo.addMessage(conversationId, 'assistant', 'Hello');

    expect(stored.usage).toBeNull();
  });

  it('leaves a user message without usage', async () => {
    const stored = await repo.addMessage(conversationId, 'user', 'A question');

    expect(stored.usage).toBeNull();
  });

  it('records the reasoning and cached counts a model reports', async () => {
    const detailed = { ...usage, reasoningTokens: 900, cachedTokens: 1000 };
    const stored = await repo.addMessage(conversationId, 'assistant', 'Hello', detailed);

    expect(stored.usage).toEqual(detailed);
  });
});

describe('showing what an answer cost', () => {
  /*
   * The reason this is a module of its own: two decimals would print every
   * cheap answer as $0.00, which reads as free.
   */
  it('keeps a figure that is far below a cent visible', async () => {
    expect(formatCost(0.0000059)).toBe('$0.000006');
  });

  it('uses four places in between, and two for real money', async () => {
    expect(formatCost(0.00031)).toBe('$0.0003');
    expect(formatCost(0.42)).toBe('$0.42');
    expect(formatCost(1.5)).toBe('$1.50');
  });

  it('writes an exact zero as one', async () => {
    expect(formatCost(0)).toBe('$0');
  });

  it('separates thousands', async () => {
    expect(formatTokens(12345)).toBe('12,345');
  });

  it('names the two counts that always matter', async () => {
    expect(usageLine(usage)).toBe('1,234 in · 567 out · $0.0031');
  });

  /* A row of zeroes would bury the numbers that are always there. */
  it('adds reasoning and cached counts only when there were any', async () => {
    expect(usageLine({ ...usage, reasoningTokens: 900, cachedTokens: 64 })).toBe(
      '1,234 in · 567 out · 900 thinking · 64 cached · $0.0031',
    );
  });

  it('sums a conversation over the messages that recorded anything', async () => {
    expect(totalsLine([{ usage }, { usage: null }, { usage }])).toBe('3,602 tokens · $0.0062');
  });

  it('says nothing at all when nothing was recorded', async () => {
    expect(totalsLine([{ usage: null }])).toBe('');
    expect(totalsLine([])).toBe('');
  });
});

afterAll(closeAll);
