import type { Config } from './config.js';
import { logger } from './logger.js';

/**
 * OpenRouter spend, shown on /admin.
 *
 * Two different numbers gate a request and they are easy to confuse:
 *  - credits: what the account actually has. This is what a 402 measures.
 *  - key limit: an optional spending cap on the API key itself.
 * A key can show plenty of headroom against its limit while the account is out
 * of credits, so both are reported.
 */

const CREDITS_URL = 'https://openrouter.ai/api/v1/credits';
const KEY_URL = 'https://openrouter.ai/api/v1/key';
const CACHE_TTL_MS = 30_000;
const REQUEST_TIMEOUT_MS = 8_000;

export interface Balance {
  /** Everything ever added to the account, in US dollars. */
  totalCredits: number;
  totalUsage: number;
  /** totalCredits - totalUsage; negative means the account is overdrawn. */
  remaining: number;
  /** Spending cap on this key, when one is set. */
  limit: number | null;
  limitRemaining: number | null;
  limitReset: string | null;
  isFreeTier: boolean;
}

interface Cached {
  fetchedAt: number;
  balance: Balance;
}

let cache: Cached | null = null;

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

async function getJson(url: string, apiKey: string): Promise<Record<string, unknown>> {
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`${url} returned ${response.status}`);
  }
  const body = (await response.json()) as { data?: unknown };
  return typeof body.data === 'object' && body.data !== null
    ? (body.data as Record<string, unknown>)
    : {};
}

/**
 * Current spend, or null when OpenRouter cannot be reached — the admin page
 * must still render without it.
 */
export async function fetchBalance(config: Config): Promise<Balance | null> {
  if (cache && Date.now() - cache.fetchedAt < CACHE_TTL_MS) {
    return cache.balance;
  }

  try {
    const [credits, key] = await Promise.all([
      getJson(CREDITS_URL, config.openRouterApiKey),
      getJson(KEY_URL, config.openRouterApiKey),
    ]);

    const totalCredits = numberOrNull(credits.total_credits) ?? 0;
    const totalUsage = numberOrNull(credits.total_usage) ?? 0;

    const balance: Balance = {
      totalCredits,
      totalUsage,
      remaining: totalCredits - totalUsage,
      limit: numberOrNull(key.limit),
      limitRemaining: numberOrNull(key.limit_remaining),
      limitReset: typeof key.limit_reset === 'string' ? key.limit_reset : null,
      isFreeTier: key.is_free_tier === true,
    };

    cache = { fetchedAt: Date.now(), balance };
    return balance;
  } catch (error) {
    logger.warn({ err: error }, 'could not read the OpenRouter balance');
    return null;
  }
}

/** Tests only: forces the next fetchBalance() to hit the network again. */
export function resetBalanceCache(): void {
  cache = null;
}
