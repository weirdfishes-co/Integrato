import type { Message, Repo } from './db/repo.js';
import type { ChatClient, ChatTurn } from './llm.js';
import { logger } from './logger.js';
import type { AssistantSettings } from './settings.js';

/**
 * Keeps long conversations coherent. Without compaction the oldest messages are
 * simply dropped once a thread passes HISTORY_LIMIT; with it they are folded
 * into a running summary that is carried along as context instead.
 *
 * OpenRouter has no server-side compaction, so this is done here and works on
 * any model.
 */

/** Messages kept verbatim; everything older is summarized. */
export const KEEP_VERBATIM = 20;
/** Compaction starts once a conversation is longer than this. */
export const COMPACT_THRESHOLD = 40;
const SUMMARY_MAX_TOKENS = 1000;

const SUMMARY_SYSTEM = `You maintain a running summary of a conversation so it can continue
after the earliest messages are dropped.

Write a compact summary that preserves: what the user is trying to achieve, decisions and
conclusions reached, facts and constraints they supplied, and anything still open.

Drop pleasantries and anything already superseded. Write plain prose, no headings or
bullets, at most 300 words.

Wrap the summary in <summary> tags and put nothing outside them.`;

/**
 * Reads the summary out of the <summary> block, falling back to the whole reply
 * when a model ignores the tags. Unlike memory extraction a stray sentence here
 * is harmless — it lands in one conversation's context, not in a stored fact.
 */
export function parseSummary(raw: string): string {
  const block = /<summary>([\s\S]*?)<\/summary>/i.exec(raw);
  return (block?.[1] ?? raw).trim();
}

function render(messages: readonly Message[]): string {
  return messages.map((message) => `${message.role}: ${message.content}`).join('\n\n');
}

export interface CompactionDeps {
  repo: Repo;
  chat: ChatClient;
}

/**
 * Folds everything older than the last KEEP_VERBATIM messages into the
 * conversation summary. Never throws — a failure just means no compaction this
 * time, and the caller falls back to plain truncation.
 */
export async function compactConversation(
  { repo, chat }: CompactionDeps,
  settings: AssistantSettings,
  conversationId: number,
): Promise<void> {
  if (!settings.compaction) return;

  const messages = await repo.listMessages(conversationId);
  if (messages.length <= COMPACT_THRESHOLD) return;

  const conversation = await repo.findConversationById(conversationId);
  if (!conversation) return;

  const olderThanKept = messages.slice(0, -KEEP_VERBATIM);
  const alreadyCovered = conversation.summarizedThrough ?? 0;
  const pending = olderThanKept.filter((message) => message.id > alreadyCovered);
  if (pending.length === 0) return;

  const last = pending[pending.length - 1];
  if (!last) return;

  try {
    const previous = conversation.summary
      ? `Summary so far:\n${conversation.summary}\n\nNewly dropped messages:\n`
      : 'Messages to summarize:\n';

    const summary = await chat.complete({
      model: settings.model,
      system: SUMMARY_SYSTEM,
      user: `${previous}${render(pending)}`,
      maxTokens: SUMMARY_MAX_TOKENS,
    });

    const text = parseSummary(summary);
    if (text.length === 0) return;

    await repo.setConversationSummary(conversationId, text, last.id);
    logger.info({ conversationId, compacted: pending.length }, 'conversation compacted');
  } catch (error) {
    logger.warn({ err: error, conversationId }, 'compaction failed');
  }
}

/**
 * The turns sent to the model: the summary of what was compacted away (as an
 * opening user turn) followed by the messages kept verbatim.
 */
export function historyWithSummary(
  messages: readonly Message[],
  summary: string | null,
  limit: number,
): ChatTurn[] {
  const recent = messages.slice(-limit).map((message) => ({
    role: message.role,
    content: message.content,
  }));

  if (!summary) return recent;

  return [
    {
      role: 'user' as const,
      content: `[Summary of the earlier part of this conversation]\n\n${summary}`,
    },
    ...recent,
  ];
}
