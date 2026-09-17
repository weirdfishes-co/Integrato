import { join, resolve } from 'node:path';

import type { Config } from './config.js';
import { seedContent, type ContentPaths } from './content.js';
import type { Assistant, Repo } from './db/repo.js';
import { logger } from './logger.js';

/**
 * Each assistant owns a directory under ASSISTANTS_DIR holding its own
 * instructions and context documents:
 *
 *   <assistantsDir>/<slug>/instr.md
 *   <assistantsDir>/<slug>/context/*.md
 *
 * The slug is validated on the way in and the resolved path is checked against
 * the root, so a crafted name cannot escape the directory.
 */

const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,48}[a-z0-9]$|^[a-z0-9]$/;
export const MAX_NAME_LENGTH = 80;
export const MAX_DESCRIPTION_LENGTH = 200;

export class AssistantError extends Error {}

/** Turns a display name into a URL-safe slug. */
export function slugify(name: string): string {
  const slug = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50)
    .replace(/-+$/g, '');
  return slug;
}

/** Appends -2, -3, … until the slug is free. */
export function uniqueSlug(base: string, taken: (slug: string) => boolean): string {
  const seed = base.length > 0 ? base : 'assistant';
  if (!taken(seed)) return seed;
  for (let suffix = 2; suffix < 1000; suffix += 1) {
    const candidate = `${seed.slice(0, 46)}-${suffix}`;
    if (!taken(candidate)) return candidate;
  }
  throw new AssistantError('Could not find a free slug for this name');
}

export function isValidSlug(slug: string): boolean {
  return SLUG_PATTERN.test(slug);
}

/**
 * Where this assistant's knowledge base lives. Throws when the slug would
 * resolve outside the root — the same defence content.ts applies to file names.
 */
export function assistantPaths(config: Config, slug: string): ContentPaths {
  if (!isValidSlug(slug)) {
    throw new AssistantError(`Invalid assistant slug: ${slug}`);
  }
  const root = resolve(config.assistantsDir);
  const dir = resolve(join(root, slug));
  if (dir !== join(root, slug)) {
    throw new AssistantError(`Assistant slug escapes the root: ${slug}`);
  }
  return { contextDir: join(dir, 'context'), instructionsPath: join(dir, 'instr.md') };
}

/**
 * Gives a new assistant its starting knowledge base. `seedFrom` is the bundled
 * content (instr.example.md and friends); nothing is overwritten if the target
 * already holds documents.
 */
export async function provisionAssistant(
  config: Config,
  assistant: Assistant,
  seedFrom: ContentPaths,
): Promise<ContentPaths> {
  const paths = assistantPaths(config, assistant.slug);
  await seedContent(seedFrom, paths);
  return paths;
}

export interface BootstrapDeps {
  repo: Repo;
  config: Config;
  /** Files shipped in the image, used to seed a brand-new assistant. */
  bundled: ContentPaths;
}

/**
 * Makes sure at least one assistant exists, so a fresh install has something to
 * open. Named from ASSISTANT_NAME, granted to every user who already exists,
 * and seeded with the bundled knowledge base.
 */
export async function bootstrapAssistants({
  repo,
  config,
  bundled,
}: BootstrapDeps): Promise<Assistant> {
  const existing = await repo.listAssistants();
  const first = existing[0];
  if (first) return first;

  // One query for the whole slug set beats one per candidate.
  const taken = new Set(existing.map((assistant) => assistant.slug));
  const slug = uniqueSlug(slugify(config.assistantName), (candidate) => taken.has(candidate));

  const assistant = await repo.createAssistant(
    slug,
    config.assistantName,
    '',
    config.assistantLanguage,
  );
  logger.info({ slug, name: assistant.name }, 'created the first assistant');

  for (const user of await repo.listUsers()) {
    await repo.grantAssistant(assistant.id, user.id);
  }

  await provisionAssistant(config, assistant, bundled);
  return assistant;
}
