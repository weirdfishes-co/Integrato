import OpenAI from 'openai';

import type { Config, Effort } from './config.js';
import type { Role } from './db/repo.js';
import type { AssistantSettings } from './settings.js';

/**
 * Chat completions through OpenRouter, which speaks the OpenAI wire format for
 * every model it offers. Everything an admin can change (model, reasoning
 * depth, web search) travels with the request rather than with the client.
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
   * compaction) where no user is watching.
   */
  complete(request: { model: string; system: string; user: string; maxTokens: number }): Promise<string>;
}

/** Thrown when the provider declined to answer, so the route can say so. */
export class ChatRefusalError extends Error {
  readonly code = 'refusal';
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
}

interface OpenRouterCompletionParams extends OpenAI.ChatCompletionCreateParamsNonStreaming {
  reasoning?: ReasoningConfig;
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

function reasoningText(delta: OpenRouterDelta): string {
  if (typeof delta.reasoning === 'string' && delta.reasoning.length > 0) {
    return delta.reasoning;
  }
  return (delta.reasoning_details ?? [])
    .map((detail) => detail.text ?? '')
    .join('');
}

export function createChatClient(config: Config): ChatClient {
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
      const params: OpenRouterParams = {
        model: settings.model,
        max_tokens: config.maxTokens,
        stream: true,
        cache_control: { type: 'ephemeral' },
        reasoning: { effort: settings.effort, exclude: !settings.showThinking },
        plugins: webPlugin(settings),
        messages: [
          { role: 'system', content: systemPrompt },
          ...history.map((turn) => ({ role: turn.role, content: turn.content })),
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

    async complete({ model, system, user, maxTokens }) {
      // Background work needs an answer, not reasoning. Some models otherwise
      // write their chain of thought straight into the content.
      const params: OpenRouterCompletionParams = {
        model,
        max_tokens: maxTokens,
        reasoning: { enabled: false, exclude: true },
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
      };

      const response = await client.chat.completions.create(params);
      return response.choices[0]?.message?.content ?? '';
    },
  };
}
