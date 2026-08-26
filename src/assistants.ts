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
  /** The single knowledge base from before multi-assistant support. */
  legacy: ContentPaths;
}

/**
 * Makes sure at least one assistant exists and that nothing from the
 * single-assistant era is left stranded.
 *
 * On an existing install this runs once: it creates an assistant from
 * ASSISTANT_NAME, moves the old global settings onto it, attaches every
 * existing conversation and memory to it, grants it to all current users, and
 * seeds its knowledge base from the old location — so an upgrade keeps working
 * exactly as before, now as "the first assistant".
 */
export async function bootstrapAssistants({
  repo,
  config,
  bundled,
  legacy,
}: BootstrapDeps): Promise<Assistant> {
  const existing = repo.listAssistants();
  if (existing.length > 0) {
    const first = existing[0];
    if (!first) throw new AssistantError('Assistant list was not empty but held no assistant');
    return first;
  }

  const slug = uniqueSlug(slugify(config.assistantName), (candidate) =>
    repo.findAssistantBySlug(candidate) !== null,
  );
  const assistant = repo.createAssistant(slug, config.assistantName, '', config.assistantLanguage);
  logger.info({ slug, name: assistant.name }, 'created the first assistant');

  // Carry the old global settings over, so an upgrade changes no behaviour.
  for (const { key, value } of repo.legacySettings()) {
    repo.setSetting(assistant.id, key, value);
  }

  const moved = repo.attachOrphansToAssistant(assistant.id);
  if (moved.conversations > 0 || moved.memories > 0) {
    logger.info(moved, 'attached existing conversations and memories to the first assistant');
  }

  // Everyone who could use the app before can still use it.
  for (const user of repo.listUsers()) {
    repo.grantAssistant(assistant.id, user.id);
  }

  // Prefer the knowledge base that was already in use over the bundled files.
  await provisionAssistant(config, assistant, legacy);
  await provisionAssistant(config, assistant, bundled);
  return assistant;
}
