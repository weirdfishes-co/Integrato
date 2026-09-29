import { logger } from './logger.js';

/**
 * The model catalogue from OpenRouter, used to populate the picker on /admin.
 * The endpoint is public (no API key) and the list changes rarely, so the
 * result is cached in memory for CATALOGUE_TTL_MS.
 */

const API_BASE = 'https://openrouter.ai/api/v1';
const CATALOGUE_URL = `${API_BASE}/models`;
const PROVIDERS_URL = `${API_BASE}/providers`;
const CATALOGUE_TTL_MS = 60 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 10_000;

/**
 * Countries an "EU only" chatbot may be served from: the EU plus the rest of
 * the EEA, since the GDPR applies there too and no transfer decision is needed.
 */
const EEA = new Set([
  'AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR', 'HU',
  'IE', 'IT', 'LV', 'LT', 'LU', 'MT', 'NL', 'PL', 'PT', 'RO', 'SK', 'SI', 'ES',
  'SE', 'IS', 'LI', 'NO',
]);

/**
 * OpenRouter shards a provider into region-tagged endpoints — `azure/eu`,
 * `amazon-bedrock/eu-west-1`, `google-vertex/europe` — and `provider.only`
 * takes those tags. This is the shard that means Europe; `global` does not,
 * and neither does a bare provider name.
 */
const EU_SHARD = /^(eu|europe)(-|$)/;

export interface ModelOption {
  id: string;
  name: string;
  contextLength: number;
  /** US dollars per million input/output tokens; null when the model is free. */
  inputPricePerMillion: number | null;
  outputPricePerMillion: number | null;
  supportsReasoning: boolean;
  /** Several reasoning models reject a temperature; the picker says so. */
  supportsSampling: boolean;
}

interface CatalogueRow {
  id?: unknown;
  name?: unknown;
  context_length?: unknown;
  pricing?: { prompt?: unknown; completion?: unknown };
  supported_parameters?: unknown;
}

interface Cached<T> {
  fetchedAt: number;
  value: T;
}

function fresh<T>(cached: Cached<T> | null): T | null {
  if (cached && Date.now() - cached.fetchedAt < CATALOGUE_TTL_MS) return cached.value;
  return null;
}

/** One entry per region, because the two lists are genuinely different. */
const catalogues = new Map<string, Cached<ModelOption[]>>();
let euProviders: Cached<Set<string>> | null = null;
const euTags = new Map<string, Cached<string[]>>();

async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`OpenRouter ${url} returned ${response.status}`);
  }
  return (await response.json()) as T;
}

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
    supportsSampling: parameters.includes('temperature') || parameters.includes('top_p'),
  };
}

/**
 * The models OpenRouter offers, sorted by name. Throws when the catalogue
 * cannot be fetched and nothing is cached yet — the caller decides whether that
 * is fatal (it is not: the admin page falls back to a text field).
 *
 * `region: 'eu'` asks OpenRouter for the models it can serve from Europe. It is
 * the catalogue's own filter, not a guess of ours, and it is what the model
 * picker shows once a chatbot is set to EU-only.
 */
export async function listModels(options: { region?: 'eu' } = {}): Promise<ModelOption[]> {
  const region = options.region ?? 'all';
  const cached = fresh(catalogues.get(region) ?? null);
  if (cached) return cached;

  const url = options.region ? `${CATALOGUE_URL}?region=${options.region}` : CATALOGUE_URL;
  const body = await getJson<{ data?: unknown }>(url);
  const rows = Array.isArray(body.data) ? (body.data as CatalogueRow[]) : [];
  const models = rows
    .map(toModel)
    .filter((model): model is ModelOption => model !== null)
    .sort((a, b) => a.name.localeCompare(b.name));

  if (models.length === 0) {
    throw new Error('OpenRouter model list was empty');
  }

  catalogues.set(region, { fetchedAt: Date.now(), value: models });
  logger.info({ models: models.length, region }, 'model catalogue refreshed');
  return models;
}

interface ProviderRow {
  slug?: unknown;
  datacenters?: unknown;
}

/**
 * Providers whose every listed data centre is in the EEA. Most providers list
 * none at all, so this is a small set and only a supplement to the region
 * shards — it catches the providers that are wholly European and therefore
 * carry no regional tag.
 */
async function loadEuProviders(): Promise<Set<string>> {
  const cached = fresh(euProviders);
  if (cached) return cached;

  const body = await getJson<{ data?: unknown } | unknown[]>(PROVIDERS_URL);
  const rows = (Array.isArray(body) ? body : (body as { data?: unknown }).data) as ProviderRow[];
  const slugs = new Set<string>();

  for (const row of Array.isArray(rows) ? rows : []) {
    const centres = Array.isArray(row.datacenters) ? (row.datacenters as unknown[]) : [];
    if (typeof row.slug !== 'string' || centres.length === 0) continue;
    if (centres.every((code) => typeof code === 'string' && EEA.has(code))) slugs.add(row.slug);
  }

  euProviders = { fetchedAt: Date.now(), value: slugs };
  return slugs;
}

interface EndpointRow {
  tag?: unknown;
}

/**
 * The `provider.only` tags that keep one model inside the EU.
 *
 * This is what makes "EU only" a routing guarantee rather than a filter on a
 * dropdown: sent with `allow_fallbacks: false`, OpenRouter either uses one of
 * these endpoints or refuses the request. An empty result therefore has to stop
 * the request, and the caller treats it that way.
 */
export async function euProviderTags(modelId: string): Promise<string[]> {
  const cached = fresh(euTags.get(modelId) ?? null);
  if (cached) return cached;

  const body = await getJson<{ data?: { endpoints?: unknown } }>(
    `${CATALOGUE_URL}/${modelId}/endpoints`,
  );
  const endpoints = Array.isArray(body.data?.endpoints)
    ? (body.data.endpoints as EndpointRow[])
    : [];

  // The provider list is a supplement, so losing it must not lose the shards.
  let wholly: Set<string>;
  try {
    wholly = await loadEuProviders();
  } catch (error) {
    logger.warn({ err: error }, 'could not load the OpenRouter provider list');
    wholly = new Set();
  }

  const tags = [
    ...new Set(
      endpoints
        .map((endpoint) => endpoint.tag)
        .filter((tag): tag is string => typeof tag === 'string' && tag.length > 0)
        .filter((tag) => {
          const [base, shard] = tag.split('/');
          if (base !== undefined && wholly.has(base)) return true;
          return shard !== undefined && EU_SHARD.test(shard);
        }),
    ),
  ];

  euTags.set(modelId, { fetchedAt: Date.now(), value: tags });
  logger.info({ model: modelId, tags }, 'resolved EU endpoints');
  return tags;
}

/** Tests only: forces the next catalogue call to hit the network again. */
export function resetModelCache(): void {
  catalogues.clear();
  euTags.clear();
  euProviders = null;
}
