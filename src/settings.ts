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

function readBoolean(repo: Repo, key: string, fallback: boolean): boolean {
  const raw = repo.getSetting(key);
  if (raw === null) return fallback;
  return raw === '1';
}

function readEffort(repo: Repo, fallback: Effort): Effort {
  const raw = repo.getSetting(KEYS.effort);
  const match = EFFORT_LEVELS.find((level) => level === raw);
  return match ?? fallback;
}

function readCount(repo: Repo, key: string, fallback: number): number {
  const parsed = Number.parseInt(repo.getSetting(key) ?? '', 10);
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

function readDomains(repo: Repo, key: string): string[] {
  return parseDomains(repo.getSetting(key) ?? '');
}

export function loadSettings(repo: Repo, config: Config): AssistantSettings {
  return {
    model: repo.getSetting(KEYS.model) ?? config.defaultModel,
    effort: readEffort(repo, config.effort),
    showThinking: readBoolean(repo, KEYS.showThinking, false),
    webSearch: readBoolean(repo, KEYS.webSearch, false),
    webSearchMaxResults: readCount(repo, KEYS.webSearchMaxResults, DEFAULT_SEARCH_RESULTS),
    webSearchIncludeDomains: readDomains(repo, KEYS.webSearchIncludeDomains),
    webSearchExcludeDomains: readDomains(repo, KEYS.webSearchExcludeDomains),
    memory: readBoolean(repo, KEYS.memory, false),
    citations: readBoolean(repo, KEYS.citations, false),
    compaction: readBoolean(repo, KEYS.compaction, false),
  };
}

/** Writes the settings an admin submitted; unchanged values are rewritten as-is. */
export function saveSettings(repo: Repo, settings: AssistantSettings): void {
  repo.setSetting(KEYS.model, settings.model);
  repo.setSetting(KEYS.effort, settings.effort);
  repo.setSetting(KEYS.showThinking, settings.showThinking ? '1' : '0');
  repo.setSetting(KEYS.webSearch, settings.webSearch ? '1' : '0');
  repo.setSetting(KEYS.webSearchMaxResults, String(settings.webSearchMaxResults));
  repo.setSetting(KEYS.webSearchIncludeDomains, settings.webSearchIncludeDomains.join('\n'));
  repo.setSetting(KEYS.webSearchExcludeDomains, settings.webSearchExcludeDomains.join('\n'));
  repo.setSetting(KEYS.memory, settings.memory ? '1' : '0');
  repo.setSetting(KEYS.citations, settings.citations ? '1' : '0');
  repo.setSetting(KEYS.compaction, settings.compaction ? '1' : '0');
}
