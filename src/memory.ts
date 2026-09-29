import type { Repo } from './db/repo.js';
import type { ChatClient } from './llm.js';
import { logger } from './logger.js';
import type { AssistantSettings } from './settings.js';

/**
 * Cross-conversation memory. OpenRouter has no memory feature, so this is ours:
 * after an exchange, a cheap second call extracts durable facts about the user,
 * which are stored per user and prepended to the system prompt next time.
 *
 * Extraction runs after the answer has been streamed, so it never delays a reply.
 */

/** Enough for a compact profile; older entries drop out of the prompt first. */
const MAX_MEMORIES_IN_PROMPT = 40;
const MAX_MEMORY_CHARS = 300;
const EXTRACTION_MAX_TOKENS = 400;

const EXTRACTION_SYSTEM = `You extract durable facts about a user from one exchange with an assistant.

Return only facts that stay true beyond this conversation: their role, employer, team,
projects, goals, constraints, stated preferences, and how they want to be helped.

Ignore anything transient: the question itself, what the assistant answered, one-off
requests, and small talk.

Wrap your output in <facts> tags, one short third-person sentence per line:

<facts>
Works as a recruiter at Acme.
Prefers short answers.
</facts>

No bullets, no numbering, no commentary inside the tags. If nothing durable came up,
output <facts></facts> and nothing else.`;

export interface MemoryDeps {
  repo: Repo;
  chat: ChatClient;
}

/** The block prepended to the system prompt, or null when there is nothing yet. */
export async function memorySection(
  repo: Repo,
  userId: number,
  assistantId: number,
): Promise<string | null> {
  const memories = await repo.listMemories(userId, assistantId, MAX_MEMORIES_IN_PROMPT);
  if (memories.length === 0) return null;

  const lines = memories.map((memory) => `- ${memory.content}`).join('\n');
  return `# What you know about this user\n\nFrom earlier conversations:\n\n${lines}`;
}

/**
 * Reads the facts out of the <facts> block.
 *
 * The block matters: some models write their reasoning into the visible content,
 * and without a delimiter that chain of thought ends up stored as "facts" and
 * poisons every later prompt. No block means no facts — never fall back to
 * treating the whole reply as a list.
 */
export function parseFacts(raw: string): string[] {
  const block = /<facts>([\s\S]*?)<\/facts>/i.exec(raw);
  if (!block?.[1]) return [];

  return block[1]
    .split('\n')
    .map((line) => line.replace(/^[-*\d.\s]+/, '').trim())
    .filter((line) => line.length > 0 && line.length <= MAX_MEMORY_CHARS)
    .filter((line) => !line.toUpperCase().startsWith('NONE'))
    .slice(0, 10);
}

/**
 * Extracts and stores durable facts from one exchange. Never throws: memory is
 * a nice-to-have and must not turn a delivered answer into an error.
 */
export async function rememberExchange(
  { repo, chat }: MemoryDeps,
  settings: AssistantSettings,
  userId: number,
  assistantId: number,
  question: string,
  answer: string,
): Promise<void> {
  if (!settings.memory) return;

  try {
    const raw = await chat.complete({
      settings,
      system: EXTRACTION_SYSTEM,
      user: `User said:\n${question}\n\nAssistant replied:\n${answer}`,
      maxTokens: EXTRACTION_MAX_TOKENS,
    });

    const facts = parseFacts(raw);
    if (facts.length === 0) return;

    const known = new Set(
      (await repo.listMemories(userId, assistantId, 200)).map((memory) =>
        memory.content.toLowerCase(),
      ),
    );
    const fresh = facts.filter((fact) => !known.has(fact.toLowerCase()));
    for (const fact of fresh) {
      await repo.addMemory(userId, assistantId, fact);
    }
    if (fresh.length > 0) {
      logger.info({ userId, assistantId, stored: fresh.length }, 'memories stored');
    }
  } catch (error) {
    logger.warn({ err: error, userId, assistantId }, 'memory extraction failed');
  }
}
