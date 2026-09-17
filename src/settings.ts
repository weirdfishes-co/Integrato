import type { Config, Effort } from './config.js';
import { EFFORT_LEVELS } from './config.js';
import type { Repo } from './db/repo.js';

/**
 * Settings an admin controls on /admin. They live in the database so a change
 * takes effect on the next message without a redeploy; the environment only
 * supplies the starting values for a fresh install.
 */

export interface AssistantSettings {
  /** OpenRouter model id, e.g. "anthropic/claude-opus-5". */
  model: string;
  /** Reasoning depth. Models without reasoning support ignore it. */
  effort: Effort;
  /** Stream the model's reasoning to the user alongside the answer. */
  showThinking: boolean;
  webSearch: boolean;
  webSearchMaxResults: number;
  /** Empty means "search the whole web". */
  webSearchIncludeDomains: readonly string[];
  webSearchExcludeDomains: readonly string[];
  /** Remember facts about a user across their conversations. */
  memory: boolean;
  /** Ask the model to cite the knowledge-base file each claim comes from. */
  citations: boolean;
  /** Summarize old turns instead of dropping them once a thread gets long. */
  compaction: boolean;
}

const KEYS = {
  model: 'model',
  effort: 'effort',
  showThinking: 'show_thinking',
  webSearch: 'web_search',
  webSearchMaxResults: 'web_search_max_results',
  webSearchIncludeDomains: 'web_search_include_domains',
  webSearchExcludeDomains: 'web_search_exclude_domains',
  memory: 'memory',
  citations: 'citations',
  compaction: 'compaction',
} as const;

export type SettingKey = keyof typeof KEYS;

export const MAX_SEARCH_RESULTS = 20;
const DEFAULT_SEARCH_RESULTS = 5;

/** All settings are read in one query, so these work on the resulting map. */
type Stored = ReadonlyMap<string, string>;

function readBoolean(stored: Stored, key: string, fallback: boolean): boolean {
  const raw = stored.get(key);
  if (raw === undefined) return fallback;
  return raw === '1';
}

function readEffort(stored: Stored, fallback: Effort): Effort {
  const raw = stored.get(KEYS.effort);
  const match = EFFORT_LEVELS.find((level) => level === raw);
  return match ?? fallback;
}

function readCount(stored: Stored, key: string, fallback: number): number {
  const parsed = Number.parseInt(stored.get(key) ?? '', 10);
  if (!Number.isInteger(parsed) || parsed < 1) return fallback;
  return Math.min(parsed, MAX_SEARCH_RESULTS);
}

/** Domains are stored newline-separated, one per line. */
export function parseDomains(raw: string): string[] {
  return raw
    .split(/[\n,]/)
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0 && !entry.includes(' '))
    .slice(0, 64);
}

function readDomains(stored: Stored, key: string): string[] {
  return parseDomains(stored.get(key) ?? '');
}

/** One query, not one per setting: this runs on every chat message. */
export async function loadSettings(
  repo: Repo,
  config: Config,
  assistantId: number,
): Promise<AssistantSettings> {
  const stored = await repo.allSettings(assistantId);
  return {
    model: stored.get(KEYS.model) ?? config.defaultModel,
    effort: readEffort(stored, config.effort),
    showThinking: readBoolean(stored, KEYS.showThinking, false),
    webSearch: readBoolean(stored, KEYS.webSearch, false),
    webSearchMaxResults: readCount(stored, KEYS.webSearchMaxResults, DEFAULT_SEARCH_RESULTS),
    webSearchIncludeDomains: readDomains(stored, KEYS.webSearchIncludeDomains),
    webSearchExcludeDomains: readDomains(stored, KEYS.webSearchExcludeDomains),
    memory: readBoolean(stored, KEYS.memory, false),
    citations: readBoolean(stored, KEYS.citations, false),
    compaction: readBoolean(stored, KEYS.compaction, false),
  };
}

/** Writes the settings an admin submitted; unchanged values are rewritten as-is. */
export async function saveSettings(
  repo: Repo,
  assistantId: number,
  settings: AssistantSettings,
): Promise<void> {
  await repo.setSetting(assistantId, KEYS.model, settings.model);
  await repo.setSetting(assistantId, KEYS.effort, settings.effort);
  await repo.setSetting(assistantId, KEYS.showThinking, settings.showThinking ? '1' : '0');
  await repo.setSetting(assistantId, KEYS.webSearch, settings.webSearch ? '1' : '0');
  await repo.setSetting(assistantId, KEYS.webSearchMaxResults, String(settings.webSearchMaxResults));
  await repo.setSetting(assistantId, KEYS.webSearchIncludeDomains, settings.webSearchIncludeDomains.join('\n'));
  await repo.setSetting(assistantId, KEYS.webSearchExcludeDomains, settings.webSearchExcludeDomains.join('\n'));
  await repo.setSetting(assistantId, KEYS.memory, settings.memory ? '1' : '0');
  await repo.setSetting(assistantId, KEYS.citations, settings.citations ? '1' : '0');
  await repo.setSetting(assistantId, KEYS.compaction, settings.compaction ? '1' : '0');
}
