import { logger } from './logger.js';

/**
 * The model catalogue from OpenRouter, used to populate the picker on /admin.
 * The endpoint is public (no API key) and the list changes rarely, so the
 * result is cached in memory for CATALOGUE_TTL_MS.
 */

const CATALOGUE_URL = 'https://openrouter.ai/api/v1/models';
const CATALOGUE_TTL_MS = 60 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 10_000;

export interface ModelOption {
  id: string;
  name: string;
  contextLength: number;
  /** US dollars per million input/output tokens; null when the model is free. */
  inputPricePerMillion: number | null;
  outputPricePerMillion: number | null;
  supportsReasoning: boolean;
}

interface CatalogueRow {
  id?: unknown;
  name?: unknown;
  context_length?: unknown;
  pricing?: { prompt?: unknown; completion?: unknown };
  supported_parameters?: unknown;
}

interface Cached {
  fetchedAt: number;
  models: ModelOption[];
}

let cache: Cached | null = null;

/** Prices arrive as per-token decimal strings ("0.000005"). */
function perMillion(raw: unknown): number | null {
  if (typeof raw !== 'string') return null;
  const value = Number.parseFloat(raw);
  if (!Number.isFinite(value) || value <= 0) return null;
  return value * 1_000_000;
}

function toModel(row: CatalogueRow): ModelOption | null {
  if (typeof row.id !== 'string' || row.id.length === 0) return null;
  const parameters = Array.isArray(row.supported_parameters) ? row.supported_parameters : [];
  return {
    id: row.id,
    name: typeof row.name === 'string' && row.name.length > 0 ? row.name : row.id,
    contextLength: typeof row.context_length === 'number' ? row.context_length : 0,
    inputPricePerMillion: perMillion(row.pricing?.prompt),
    outputPricePerMillion: perMillion(row.pricing?.completion),
    supportsReasoning: parameters.includes('reasoning'),
  };
}

/**
 * Every model OpenRouter currently offers, sorted by name. Throws when the
 * catalogue cannot be fetched and nothing is cached yet — the caller decides
 * whether that is fatal (it is not: the admin page falls back to a text field).
 */
export async function listModels(): Promise<ModelOption[]> {
  if (cache && Date.now() - cache.fetchedAt < CATALOGUE_TTL_MS) {
    return cache.models;
  }

  const response = await fetch(CATALOGUE_URL, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`OpenRouter model list returned ${response.status}`);
  }

  const body = (await response.json()) as { data?: unknown };
  const rows = Array.isArray(body.data) ? (body.data as CatalogueRow[]) : [];
  const models = rows
    .map(toModel)
    .filter((model): model is ModelOption => model !== null)
    .sort((a, b) => a.name.localeCompare(b.name));

  if (models.length === 0) {
    throw new Error('OpenRouter model list was empty');
  }

  cache = { fetchedAt: Date.now(), models };
  logger.info({ models: models.length }, 'model catalogue refreshed');
  return models;
}

/** Tests only: forces the next listModels() to hit the network again. */
export function resetModelCache(): void {
  cache = null;
}
