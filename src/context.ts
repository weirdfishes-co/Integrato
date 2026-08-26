import { readdir, readFile, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { logger } from './logger.js';

/**
 * Builds the system prompt from instr.md plus every .md file in /context.
 * The result is cached and only rebuilt when a file changes, so the API's
 * prompt cache stays valid between requests.
 */

export interface PromptSources {
  readonly instructionsPath: string;
  readonly contextDir: string;
  /** Used only when instr.md is missing or empty. */
  readonly assistantName?: string;
  /** Language the assistant must answer in. */
  readonly language?: string;
  /** Ask the model to name the knowledge-base file behind each claim. */
  readonly citations?: boolean;
}

interface CacheEntry {
  fingerprint: string;
  prompt: string;
}

const DEFAULT_NAME = 'AI Assistant';
const DEFAULT_LANGUAGE = 'English';

/**
 * OpenRouter has no equivalent of Anthropic's native citations, so this is
 * prompt-enforced: the model is asked to mark the source itself and the front
 * end turns those markers into a source list.
 */
const CITATION_RULE = `# Citing your sources

When a statement comes from one of the context documents, mark it with the file name
in square brackets, like [Guidelines.md], directly after the sentence. Cite the document
you actually used, never one you did not read. Statements that do not come from a
document get no marker.`;

function languageRule(language: string): string {
  return (
    `Always answer in ${language}, regardless of the language the user writes in. ` +
    'Use the supplied context as your primary source; if the answer is not in there, say so explicitly.'
  );
}

/** Keyed by instructions path: one entry per assistant, not one globally. */
const cache = new Map<string, CacheEntry>();

async function readIfExists(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new Error(`Could not read ${path}: ${(error as Error).message}`, { cause: error });
  }
}

async function listContextFiles(contextDir: string): Promise<string[]> {
  try {
    const entries = await readdir(contextDir);
    return entries
      .filter((name) => name.toLowerCase().endsWith('.md'))
      .sort() // deterministic order: otherwise the prompt prefix changes per boot
      .map((name) => join(contextDir, name));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

/** mtime + size per file; cheaper than hashing the full content. */
async function fingerprint(paths: string[]): Promise<string> {
  const parts: string[] = [];
  for (const path of paths) {
    try {
      const info = await stat(path);
      parts.push(`${path}:${info.mtimeMs}:${info.size}`);
    } catch {
      parts.push(`${path}:missing`);
    }
  }
  return parts.join('|');
}

/** `{Global.Name}` (or `{Name}`) refers to context/Name.md; case-insensitive. */
const PLACEHOLDER = /\{\s*(?:Global\.)?([A-Za-z0-9_-]+)\s*\}/g;

/**
 * Replaces placeholders in the instructions with the content of the context
 * file of the same name. If the file does not exist the placeholder stays put —
 * more visible in the answer than silently wiped away.
 */
function resolvePlaceholders(
  text: string,
  files: ReadonlyMap<string, { name: string; content: string }>,
): { text: string; used: Set<string> } {
  const used = new Set<string>();
  const resolved = text.replace(PLACEHOLDER, (match, rawName: string) => {
    const key = rawName.toLowerCase();
    const file = files.get(key);
    if (!file) {
      logger.warn({ placeholder: match }, 'no context file found for placeholder');
      return match;
    }
    used.add(key);
    return `\n<document name="${file.name}">\n${file.content}\n</document>\n`;
  });
  return { text: resolved, used };
}

export async function buildSystemPrompt(sources: PromptSources): Promise<string> {
  const instructionsPath = resolve(sources.instructionsPath);
  const contextDir = resolve(sources.contextDir);
  const assistantName = sources.assistantName ?? DEFAULT_NAME;
  const language = sources.language ?? DEFAULT_LANGUAGE;

  const contextFiles = await listContextFiles(contextDir);
  const citations = sources.citations === true;
  const current = `${assistantName}|${language}|${citations}|${await fingerprint([instructionsPath, ...contextFiles])}`;
  const cached = cache.get(instructionsPath);
  if (cached && cached.fingerprint === current) {
    return cached.prompt;
  }

  const instructions = (await readIfExists(instructionsPath))?.trim();
  if (!instructions) {
    logger.warn({ instructionsPath }, 'instr.md is missing or empty — falling back to the base instruction');
  }

  // Content per context file, keyed on the file name without the .md extension.
  const byName = new Map<string, { name: string; content: string }>();
  for (const path of contextFiles) {
    const content = (await readIfExists(path))?.trim();
    if (!content) continue;
    const name = path.slice(contextDir.length + 1);
    byName.set(name.replace(/\.md$/i, '').toLowerCase(), { name, content });
  }

  const { text: resolvedInstructions, used } = resolvePlaceholders(
    instructions || `You are ${assistantName}, a helpful assistant.`,
    byName,
  );

  const sections: string[] = [resolvedInstructions, languageRule(language)];
  if (citations) sections.push(CITATION_RULE);

  // Files already inserted through a placeholder are not sent a second time.
  const documents: string[] = [];
  for (const [key, file] of byName) {
    if (used.has(key)) continue;
    documents.push(`<document name="${file.name}">\n${file.content}\n</document>`);
  }

  if (documents.length > 0) {
    sections.push(`# Context\n\nThe following documents are your knowledge base.\n\n${documents.join('\n\n')}`);
  }

  const prompt = sections.join('\n\n');
  cache.set(instructionsPath, { fingerprint: current, prompt });
  logger.info({ contextFiles: contextFiles.length, promptChars: prompt.length }, 'system prompt built');
  return prompt;
}

/** Tests only: clears the cache so the next build reads from disk again. */
export function resetPromptCache(): void {
  cache.clear();
}
