import OpenAI from 'openai';

import { anonymizeBatch } from './anonymize.js';
import type { Config, Effort } from './config.js';
import type { Role } from './db/repo.js';
import { logger } from './logger.js';
import { euProviderTags } from './models.js';
import type { AssistantSettings } from './settings.js';

/**
 * Chat completions through OpenRouter, which speaks the OpenAI wire format for
 * every model it offers. Everything an admin can change (model, reasoning
 * depth, web search, sampling) travels with the request rather than with the
 * client.
 *
 * Two of those settings are promises to the user rather than preferences, so
 * they are applied *here*, at the one point where a request is built, and not
 * by the callers: EU-only routing and anonymization. A caller that forgot
 * either one would not fail — it would quietly send the data anyway.
 */

const BASE_URL = 'https://openrouter.ai/api/v1';

export interface ChatTurn {
  role: Role;
  content: string;
}

/** A web page the model consulted, surfaced to the user under the answer. */
export interface SourceLink {
  url: string;
  title: string;
}

export interface ChatRequest {
  systemPrompt: string;
  history: readonly ChatTurn[];
  settings: AssistantSettings;
  signal?: AbortSignal;
}

export interface ChatEvents {
  onDelta(text: string): void;
  /** Only called while showThinking is on. */
  onThinking?(text: string): void;
  onSource?(source: SourceLink): void;
}

export interface ChatResult {
  answer: string;
  sources: SourceLink[];
}

export interface ChatClient {
  stream(request: ChatRequest, events: ChatEvents): Promise<ChatResult>;
  /**
   * One-shot, non-streaming call used for background work (memory extraction,
   * compaction) where no user is watching. It takes the whole settings object
   * rather than just a model id because this text is the user's too: it has to
   * be anonymized and routed exactly like the conversation it came from.
   */
  complete(request: {
    settings: AssistantSettings;
    system: string;
    user: string;
    maxTokens: number;
  }): Promise<string>;
}

/** Thrown when the provider declined to answer, so the route can say so. */
export class ChatRefusalError extends Error {
  readonly code = 'refusal';
}

/** Thrown when EU-only routing is on and no European endpoint serves the model. */
export class RegionUnavailableError extends Error {
  readonly code = 'region';
}

/**
 * A message a user can act on, from an OpenRouter failure.
 *
 * "Something went wrong" tells nobody anything: the common causes each have a
 * different fix, and only an admin reading the server log could tell them
 * apart. The status codes are stable enough to name the cause without leaking
 * anything from the provider's own message.
 */
export function describeChatError(error: unknown): string {
  // Ours, and already carrying a sentence written for a reader.
  if (error instanceof RegionUnavailableError) {
    return error.message;
  }

  const status = error instanceof OpenAI.APIError ? error.status : undefined;

  switch (status) {
    case 401:
    case 403:
      return 'The OpenRouter key was rejected. An administrator needs to check it.';
    case 402:
      return 'The OpenRouter account has too little credit for this request. An administrator needs to add credit, or lower MODEL_MAX_TOKENS.';
    case 404:
      // Also what an impossible EU-only request looks like: OpenRouter answers
      // 404 when provider.only leaves no endpoint, which is the fail-closed
      // behaviour that setting relies on.
      return 'This model is not available on OpenRouter, or not from the region this chatbot is restricted to. An administrator can pick another one on the admin page.';
    case 429:
      return 'Too many requests at once, or the model is rate limited. Please try again in a moment.';
    case 502:
    case 503:
      return 'The model provider is unavailable right now. Please try again shortly.';
    default:
      return 'Something went wrong while fetching the answer. Please try again.';
  }
}

interface ReasoningConfig {
  effort?: Effort;
  exclude?: boolean;
  enabled?: boolean;
}

interface WebPlugin {
  id: 'web';
  max_results?: number;
  include_domains?: string[];
  exclude_domains?: string[];
}

/** OpenRouter extends the OpenAI request body with these fields. */
interface OpenRouterParams extends OpenAI.ChatCompletionCreateParamsStreaming {
  /** Caches the stable prompt prefix on providers that support it (Anthropic). */
  cache_control?: { type: 'ephemeral' };
  reasoning?: ReasoningConfig;
  plugins?: WebPlugin[];
  provider?: ProviderPreferences;
}

interface OpenRouterCompletionParams extends OpenAI.ChatCompletionCreateParamsNonStreaming {
  reasoning?: ReasoningConfig;
  provider?: ProviderPreferences;
}

interface ProviderPreferences {
  /** Endpoint tags, e.g. `azure/eu`. Anything else is refused with a 404. */
  only?: string[];
  allow_fallbacks?: boolean;
}

/** Reasoning text and search annotations ride along on the standard delta. */
interface OpenRouterDelta {
  content?: string | null;
  reasoning?: string | null;
  reasoning_details?: { type?: string; text?: string }[];
  annotations?: {
    type?: string;
    url_citation?: { url?: string; title?: string };
  }[];
}

function webPlugin(settings: AssistantSettings): WebPlugin[] | undefined {
  if (!settings.webSearch) return undefined;

  const plugin: WebPlugin = { id: 'web', max_results: settings.webSearchMaxResults };
  // Some engines (notably Anthropic's native search) reject both lists at once,
  // so an include list wins when an admin has filled in both.
  if (settings.webSearchIncludeDomains.length > 0) {
    plugin.include_domains = [...settings.webSearchIncludeDomains];
  } else if (settings.webSearchExcludeDomains.length > 0) {
    plugin.exclude_domains = [...settings.webSearchExcludeDomains];
  }
  return [plugin];
}

/**
 * The tags a request may route through when the chatbot is EU-only, or
 * undefined when it is not restricted.
 *
 * `allow_fallbacks: false` is the point of the exercise: without it OpenRouter
 * is free to fall back to any other endpoint when the European ones are busy,
 * which is exactly the case the setting exists to prevent.
 */
async function providerPreferences(
  settings: AssistantSettings,
): Promise<ProviderPreferences | undefined> {
  if (!settings.euOnly) return undefined;

  let tags: string[];
  try {
    tags = await euProviderTags(settings.model);
  } catch (error) {
    // Unknown is not the same as none, but it has to be treated the same way:
    // sending the request unrestricted would break the promise silently.
    logger.error({ err: error, model: settings.model }, 'could not resolve EU endpoints');
    throw new RegionUnavailableError(
      'This chatbot may only use providers in the EU, and that could not be confirmed for this model right now, so nothing was sent. Please try again in a moment.',
    );
  }

  if (tags.length === 0) {
    throw new RegionUnavailableError(
      'This chatbot may only use providers in the EU, and this model has none. An administrator can pick a different model on the admin page.',
    );
  }

  return { only: tags, allow_fallbacks: false };
}

/**
 * Sampling is sent only when an admin filled it in. An omitted field is not the
 * same as a default we invent: the model's own default is usually tuned, and
 * several reasoning models reject a temperature outright.
 */
function sampling(settings: AssistantSettings): { temperature?: number; top_p?: number } {
  return {
    ...(settings.temperature === null ? {} : { temperature: settings.temperature }),
    ...(settings.topP === null ? {} : { top_p: settings.topP }),
  };
}

function reasoningText(delta: OpenRouterDelta): string {
  if (typeof delta.reasoning === 'string' && delta.reasoning.length > 0) {
    return delta.reasoning;
  }
  return (delta.reasoning_details ?? [])
    .map((detail) => detail.text ?? '')
    .join('');
}

export function createChatClient(config: Config): ChatClient {
  /**
   * The user's own words, pseudonymized when the chatbot asks for it. Only user
   * turns: the system prompt is the admin's text and is the cached prefix of
   * every request, so rewriting it would cost the prompt cache for nothing.
   *
   * It runs in this process and cannot fail, which is why it needs no error
   * path and no configuration — see `anonymize.ts` for what that buys and what
   * it costs.
   */
  function protect(settings: AssistantSettings, turns: readonly ChatTurn[]): ChatTurn[] {
    if (!settings.anonymize) return [...turns];

    const indexes = turns.flatMap((turn, index) => (turn.role === 'user' ? [index] : []));
    const cleaned = anonymizeBatch(indexes.map((index) => turns[index]!.content));

    const result = [...turns];
    indexes.forEach((index, position) => {
      result[index] = { role: 'user', content: cleaned[position] ?? turns[index]!.content };
    });
    return result;
  }

  const client = new OpenAI({
    apiKey: config.openRouterApiKey,
    baseURL: BASE_URL,
    // Optional attribution: shows the app on the openrouter.ai rankings.
    defaultHeaders: {
      ...(config.siteUrl ? { 'HTTP-Referer': config.siteUrl } : {}),
      'X-Title': config.siteName,
    },
  });

  return {
    async stream({ systemPrompt, history, settings, signal }, events) {
      const turns = protect(settings, history);
      const provider = await providerPreferences(settings);

      const params: OpenRouterParams = {
        model: settings.model,
        max_tokens: config.maxTokens,
        stream: true,
        cache_control: { type: 'ephemeral' },
        reasoning: { effort: settings.effort, exclude: !settings.showThinking },
        plugins: webPlugin(settings),
        ...sampling(settings),
        ...(provider ? { provider } : {}),
        messages: [
          { role: 'system', content: systemPrompt },
          ...turns.map((turn) => ({ role: turn.role, content: turn.content })),
        ],
      };

      const stream = await client.chat.completions.create(params, { signal });

      let answer = '';
      let refused = false;
      const sources: SourceLink[] = [];
      const seenUrls = new Set<string>();

      for await (const chunk of stream) {
        const choice = chunk.choices[0];
        if (choice?.finish_reason === 'content_filter') {
          refused = true;
        }

        const delta = choice?.delta as OpenRouterDelta | undefined;
        if (!delta) continue;

        if (settings.showThinking && events.onThinking) {
          const thinking = reasoningText(delta);
          if (thinking.length > 0) events.onThinking(thinking);
        }

        for (const annotation of delta.annotations ?? []) {
          const citation = annotation.url_citation;
          if (!citation?.url || seenUrls.has(citation.url)) continue;
          seenUrls.add(citation.url);
          const source = { url: citation.url, title: citation.title ?? citation.url };
          sources.push(source);
          events.onSource?.(source);
        }

        if (typeof delta.content === 'string' && delta.content.length > 0) {
          answer += delta.content;
          events.onDelta(delta.content);
        }
      }

      // A refusal with no text at all is worth surfacing; a filtered tail on an
      // otherwise complete answer is not.
      if (refused && answer.trim().length === 0) {
        throw new ChatRefusalError('The model declined to answer this request.');
      }

      return { answer, sources };
    },

    async complete({ settings, system, user, maxTokens }) {
      const turns = protect(settings, [{ role: 'user', content: user }]);
      const provider = await providerPreferences(settings);

      // Background work needs an answer, not reasoning. Some models otherwise
      // write their chain of thought straight into the content. It also keeps
      // the model's default sampling: a temperature chosen to make a chatbot
      // livelier has no business loosening a fact-extraction call.
      const params: OpenRouterCompletionParams = {
        model: settings.model,
        max_tokens: maxTokens,
        reasoning: { enabled: false, exclude: true },
        ...(provider ? { provider } : {}),
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: turns[0]?.content ?? user },
        ],
      };

      const response = await client.chat.completions.create(params);
      return response.choices[0]?.message?.content ?? '';
    },
  };
}
