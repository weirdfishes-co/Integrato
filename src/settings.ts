import type { Config, Effort } from './config.js';
import { EFFORT_LEVELS } from './config.js';
import type { Repo } from './db/repo.js';
import { isAspectRatio, isVoice } from './kinds.js';

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
  /**
   * Let users write their own documents for this chatbot, in the editor, and
   * carry them in its prompt.
   */
  notes: boolean;
  /**
   * Route only through providers that serve this model from an EU data centre.
   * Enforced on the request itself, not just in the model picker.
   */
  euOnly: boolean;
  /** Strip personal data out of user messages before they leave for the model. */
  anonymize: boolean;
  /**
   * Let an admin read every conversation with this chatbot from /admin, across
   * all users. Stored messages are never anonymized regardless of `anonymize`
   * above — that setting only affects what the model sees.
   */
  adminConversationLog: boolean;
  /**
   * Sampling knobs. `null` means "send nothing and let the model use its own
   * default", which is not the same as any number we could pick: several
   * reasoning models reject a temperature outright.
   */
  temperature: number | null;
  topP: number | null;
  /**
   * Image shape, for a text-to-image chatbot. Null sends nothing and lets the
   * model choose. Only the ratios OpenRouter enumerates are accepted; it
   * rejects anything else.
   */
  aspectRatio: string | null;
  /**
   * Which voice a text-to-speech chatbot speaks in. Null sends nothing and
   * leaves it to the model.
   */
  voice: string | null;
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
  notes: 'notes',
  euOnly: 'eu_only',
  anonymize: 'anonymize',
  adminConversationLog: 'admin_conversation_log',
  temperature: 'temperature',
  topP: 'top_p',
  aspectRatio: 'aspect_ratio',
  voice: 'voice',
} as const;

export type SettingKey = keyof typeof KEYS;

export const MAX_SEARCH_RESULTS = 20;
const DEFAULT_SEARCH_RESULTS = 5;

/** OpenRouter's own bounds; a value outside them is rejected by the API. */
export const MAX_TEMPERATURE = 2;
export const MAX_TOP_P = 1;

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

/**
 * An empty string is stored for "unset", because the settings table holds no
 * nulls — and unset has to stay distinguishable from 0, which is a temperature
 * an admin may well want.
 */
function readNumber(stored: Stored, key: string, max: number): number | null {
  const raw = stored.get(key);
  if (raw === undefined || raw.trim().length === 0) return null;
  const parsed = Number.parseFloat(raw);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > max) return null;
  return parsed;
}

/** Parses what an admin typed into a sampling field; blank stays blank. */
export function parseSampling(raw: string, max: number): number | null {
  if (raw.trim().length === 0) return null;
  const parsed = Number.parseFloat(raw);
  if (!Number.isFinite(parsed)) return null;
  return Math.min(Math.max(parsed, 0), max);
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
    notes: readBoolean(stored, KEYS.notes, false),
    euOnly: readBoolean(stored, KEYS.euOnly, false),
    anonymize: readBoolean(stored, KEYS.anonymize, false),
    adminConversationLog: readBoolean(stored, KEYS.adminConversationLog, false),
    temperature: readNumber(stored, KEYS.temperature, MAX_TEMPERATURE),
    topP: readNumber(stored, KEYS.topP, MAX_TOP_P),
    aspectRatio: isAspectRatio(stored.get(KEYS.aspectRatio)) ? stored.get(KEYS.aspectRatio)! : null,
    voice: isVoice(stored.get(KEYS.voice)) ? stored.get(KEYS.voice)! : null,
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
  await repo.setSetting(assistantId, KEYS.notes, settings.notes ? '1' : '0');
  await repo.setSetting(assistantId, KEYS.euOnly, settings.euOnly ? '1' : '0');
  await repo.setSetting(assistantId, KEYS.anonymize, settings.anonymize ? '1' : '0');
  await repo.setSetting(assistantId, KEYS.adminConversationLog, settings.adminConversationLog ? '1' : '0');
  await repo.setSetting(assistantId, KEYS.temperature, settings.temperature === null ? '' : String(settings.temperature));
  await repo.setSetting(assistantId, KEYS.topP, settings.topP === null ? '' : String(settings.topP));
  await repo.setSetting(assistantId, KEYS.aspectRatio, settings.aspectRatio ?? '');
  await repo.setSetting(assistantId, KEYS.voice, settings.voice ?? '');
}
