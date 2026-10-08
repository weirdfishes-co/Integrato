import OpenAI from 'openai';

import { anonymizeBatch } from './anonymize.js';
import type { Config, Effort } from './config.js';
import type { AssistantKind } from './kinds.js';
import type { MessageUsage, Role } from './db/repo.js';
import { logger } from './logger.js';
import { euProviderTags, isTranscriptionModel } from './models.js';
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
  /**
   * A recording, for a speech-to-text chatbot. Base64 without the data: prefix,
   * and a format the provider recognises ('wav', 'mp3', …) — the provider
   * validates it, OpenRouter passes it through.
   */
  audio?: { data: string; format: string };
}

/** Something a model produced: a picture it drew, or speech it spoke. */
export interface GeneratedMedia {
  mimeType: string;
  bytes: Buffer;
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
  /** Decides the request shape and what comes back. See kinds.ts. */
  kind: AssistantKind;
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
  /** Non-empty for a text-to-image or text-to-speech chatbot. */
  media: GeneratedMedia[];
  /**
   * What the answer consumed, as the provider reported it — null when the
   * stream ended without a usage chunk, which some providers do.
   */
  usage: MessageUsage | null;
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
      // Reached only after the retries in withAuthRetry, so it is persistent.
      // The user cannot fix a key; say so, and keep the admin's hint short.
      return 'The model service did not accept the request, even after retrying. Please come back in a few minutes; if it keeps happening, tell an administrator to check the OpenRouter key.';
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

const AUTH_RETRY_DELAYS_MS = [1000, 3000];

/**
 * Retries a request that OpenRouter answered with 401, twice more.
 *
 * The SDK already retries 408, 409, 429 and 5xx, but never 401, and OpenRouter
 * does now and then answer a good key with one under load. It wraps only the
 * call that opens the request: a 401 arrives before any text, so a retry cannot
 * duplicate output. An error in the middle of a stream is not retried.
 * Every attempt is logged with the provider's own message, which is the only
 * way to tell a flaky 401 from a genuinely dead key.
 */
export async function withAuthRetry<T>(
  call: () => Promise<T>,
  signal?: AbortSignal,
  delays: readonly number[] = AUTH_RETRY_DELAYS_MS,
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await call();
    } catch (error) {
      const isAuth = error instanceof OpenAI.APIError && error.status === 401;
      if (!isAuth || attempt >= delays.length || signal?.aborted) throw error;
      logger.warn(
        { attempt: attempt + 1, status: 401, providerMessage: error.message },
        'OpenRouter answered 401, retrying',
      );
      await new Promise((resolve) => setTimeout(resolve, delays[attempt]));
    }
  }
}

/**
 * A dedicated transcriber (AssemblyAI, Fish Audio, Whisper, …) is not reached
 * through chat completions: it has its own endpoint, which takes the recording
 * and answers with the text and what it cost. The error is shaped like the
 * SDK's, so the retry and `describeChatError` treat it like any other.
 */
async function transcribe(
  config: Config,
  model: string,
  audio: { data: string; format: string },
  provider: ProviderPreferences | undefined,
  signal?: AbortSignal,
): Promise<{ text: string; cost: number | null }> {
  const response = await fetch(`${BASE_URL}/audio/transcriptions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.openRouterApiKey}`,
      'Content-Type': 'application/json',
      ...(config.siteUrl ? { 'HTTP-Referer': config.siteUrl } : {}),
      'X-Title': config.siteName,
    },
    body: JSON.stringify({
      model,
      input_audio: { data: audio.data, format: audio.format },
      ...(provider ? { provider } : {}),
    }),
    signal,
  });

  const body = (await response.json().catch(() => ({}))) as {
    text?: unknown;
    usage?: { cost?: unknown };
  };
  if (!response.ok) {
    throw new OpenAI.APIError(response.status, body, undefined, response.headers);
  }
  return {
    text: typeof body.text === 'string' ? body.text : '',
    cost: typeof body.usage?.cost === 'number' ? body.usage.cost : null,
  };
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

/**
 * The usage chunk OpenRouter sends last. `cost` is its own extension and the
 * reason this is worth reading rather than multiplying tokens by a rate card:
 * it is the figure actually billed, cache discounts and all.
 */
interface OpenRouterUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  cost?: number;
  prompt_tokens_details?: { cached_tokens?: number };
  completion_tokens_details?: { reasoning_tokens?: number };
}

function toUsage(usage: OpenRouterUsage | undefined): MessageUsage | null {
  if (!usage || typeof usage.prompt_tokens !== 'number' || typeof usage.completion_tokens !== 'number') {
    return null;
  }
  return {
    promptTokens: usage.prompt_tokens,
    completionTokens: usage.completion_tokens,
    reasoningTokens: usage.completion_tokens_details?.reasoning_tokens ?? 0,
    cachedTokens: usage.prompt_tokens_details?.cached_tokens ?? 0,
    cost: typeof usage.cost === 'number' ? usage.cost : 0,
  };
}

/** OpenRouter extends the OpenAI request body with these fields. */
interface OpenRouterParams extends OpenAI.ChatCompletionCreateParamsStreaming {
  /** Caches the stable prompt prefix on providers that support it (Anthropic). */
  cache_control?: { type: 'ephemeral' };
  reasoning?: ReasoningConfig;
  plugins?: WebPlugin[];
  provider?: ProviderPreferences;
  /** OpenRouter's flag for adding `cost` to the usage it reports. */
  usage?: { include: true };
}

/*
 * `modalities` is omitted from the SDK's own type and redeclared: the SDK knows
 * only "text" and "audio", while OpenRouter also takes "image". Narrowing to
 * the SDK's union would make the one value this feature needs unspellable.
 */
interface OpenRouterCompletionParams
  extends Omit<OpenAI.ChatCompletionCreateParamsNonStreaming, 'modalities'> {
  reasoning?: ReasoningConfig;
  provider?: ProviderPreferences;
  /** Which outputs to ask for; an image model needs this to draw anything. */
  modalities?: string[];
  image_config?: { aspect_ratio?: string };
  usage?: { include: true };
}

interface OpenRouterStreamingParams
  extends Omit<OpenAI.ChatCompletionCreateParamsStreaming, 'modalities' | 'audio'> {
  modalities?: string[];
  audio?: { voice?: string; format: string };
  provider?: ProviderPreferences;
  usage?: { include: true };
}

/**
 * Where a generated image arrives: on the message, not in the content, as a
 * data: URL of about a megabyte.
 */
interface OpenRouterImage {
  type?: string;
  image_url?: { url?: string };
}

/** `data:image/png;base64,…` into something storable. */
function decodeImage(url: unknown): GeneratedMedia | null {
  if (typeof url !== 'string') return null;
  const match = /^data:([\w/+.-]+);base64,(.+)$/s.exec(url);
  if (!match?.[1] || !match[2]) return null;
  return { mimeType: match[1], bytes: Buffer.from(match[2], 'base64') };
}

interface ProviderPreferences {
  /** Endpoint tags, e.g. `azure/eu`. Anything else is refused with a 404. */
  only?: string[];
  allow_fallbacks?: boolean;
}

/** Reasoning text and search annotations ride along on the standard delta. */
interface OpenRouterDelta {
  content?: string | null;
  /** Spoken output: base64 pcm16 in `data`, the words in `transcript`. */
  audio?: { data?: string; transcript?: string };
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

/**
 * One turn as the API wants it. Plain text stays a plain string — the cached
 * prompt prefix depends on the shape being stable — and only a turn carrying a
 * recording becomes the content-part array.
 */
/**
 * Raw PCM into a playable file.
 *
 * Streamed audio arrives as `pcm16` and nothing else — mp3 and wav are refused
 * with "Audio output requires stream: true"'s sibling error, because a
 * container cannot be written incrementally. So the samples come back bare and
 * the 44-byte RIFF header is written here.
 *
 * 24 kHz, mono, 16-bit is what these models produce. The figure is not a guess:
 * speech generated at this rate, wrapped with this header, was handed to a
 * different model for transcription and came back word for word — a wrong rate
 * would have shifted the pitch and garbled it.
 */
const PCM_SAMPLE_RATE = 24_000;

function pcmToWav(pcm: Buffer): GeneratedMedia {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16); // the size of this fmt chunk
  header.writeUInt16LE(1, 20); // 1 = uncompressed PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(PCM_SAMPLE_RATE, 24);
  header.writeUInt32LE(PCM_SAMPLE_RATE * 2, 28); // bytes per second
  header.writeUInt16LE(2, 32); // bytes per sample frame
  header.writeUInt16LE(16, 34); // bits per sample
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return { mimeType: 'audio/wav', bytes: Buffer.concat([header, pcm]) };
}

export function toMessage(turn: ChatTurn): OpenAI.ChatCompletionMessageParam {
  if (!turn.audio) {
    return { role: turn.role, content: turn.content } as OpenAI.ChatCompletionMessageParam;
  }
  return {
    role: 'user',
    content: [
      { type: 'text', text: turn.content },
      { type: 'input_audio', input_audio: { data: turn.audio.data, format: turn.audio.format } },
    ],
  } as unknown as OpenAI.ChatCompletionMessageParam;
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
      result[index] = {
        ...turns[index]!,
        role: 'user',
        content: cleaned[position] ?? turns[index]!.content,
      };
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
    async stream({ systemPrompt, history, settings, kind, signal }, events) {
      const turns = protect(settings, history);
      const provider = await providerPreferences(settings);

      /*
       * A dedicated transcriber answers in one piece from another endpoint.
       * The recording is read from `history`, not `turns`: anonymization
       * rewrites text turns and would not carry it along.
       */
      if (kind === 'transcribe' && (await isTranscriptionModel(settings.model))) {
        const audio = [...history].reverse().find((turn) => turn.audio)?.audio;
        if (!audio) throw new ChatRefusalError('There is no recording to transcribe.');

        const { text, cost } = await withAuthRetry(
          () => transcribe(config, settings.model, audio, provider, signal),
          signal,
        );
        if (text.trim().length === 0) {
          throw new ChatRefusalError('No speech was found in that recording.');
        }
        events.onDelta(text);
        // Billed per second of audio, so there are no tokens to report — only
        // the cost, which is the figure that matters on the usage panel.
        const usage: MessageUsage | null =
          cost === null
            ? null
            : { promptTokens: 0, completionTokens: 0, reasoningTokens: 0, cachedTokens: 0, cost };
        return { answer: text, sources: [], media: [], usage };
      }

      /*
       * An image is not worth streaming: it arrives whole, in one chunk at the
       * end, so a stream would buy a spinner and an extra failure mode. One
       * non-streaming call, and the text that accompanies it is handed to the
       * same onDelta the text chatbots use — so the route and the front end do
       * not need to know which kind they are serving.
       */
      if (kind === 'image') {
        /*
         * Deliberately no max_tokens. MODEL_MAX_TOKENS is an answer-*length*
         * budget, which is the wrong instrument here: an image costs on the
         * order of 1,300 completion tokens whatever it depicts, so a cap set
         * for prose — 800 is a perfectly sensible one — truncates the response
         * and returns finish_reason "length" with no image and no text at all.
         * Nothing is uncapped by leaving it out: a request yields one image, so
         * its cost is bounded by the request rather than by a token count.
         */
        const params: OpenRouterCompletionParams = {
          model: settings.model,
          modalities: ['image', 'text'],
          ...(settings.aspectRatio ? { image_config: { aspect_ratio: settings.aspectRatio } } : {}),
          usage: { include: true },
          // No sampling: the admin form hides it for this kind, so a value
          // saved before the kind was switched must not be sent either.
          ...(provider ? { provider } : {}),
          messages: [
            { role: 'system', content: systemPrompt },
            ...turns.map(toMessage),
          ],
        };

        const response = await withAuthRetry(
          () =>
            client.chat.completions.create(
              params as unknown as OpenAI.ChatCompletionCreateParamsNonStreaming,
              { signal },
            ),
          signal,
        );
        const message = response.choices[0]?.message as
          | { content?: string | null; images?: OpenRouterImage[] }
          | undefined;

        const answer = message?.content ?? '';
        if (answer.length > 0) events.onDelta(answer);

        const images = (message?.images ?? [])
          .map((image) => decodeImage(image.image_url?.url))
          .filter((image): image is GeneratedMedia => image !== null);

        /*
         * An empty response is not self-explanatory, and the two ways of
         * getting one need different fixes, so they get different sentences.
         * This is exactly the rule describeChatError follows for the provider's
         * status codes.
         */
        if (images.length === 0 && answer.trim().length === 0) {
          const reason = response.choices[0]?.finish_reason;
          if (reason === 'length') {
            throw new ChatRefusalError(
              'The model ran out of room before it finished the image. An administrator needs to raise MODEL_MAX_TOKENS, or leave it unset.',
            );
          }
          if (reason === 'content_filter') {
            throw new ChatRefusalError('The model declined to draw this.');
          }
          throw new ChatRefusalError('The model returned neither an image nor an explanation.');
        }

        return {
          answer,
          sources: [],
          media: images,
          usage: toUsage((response as { usage?: OpenRouterUsage }).usage),
        };
      }

      /*
       * Speech is the mirror image of the image path: it *must* be streamed —
       * the API answers "Audio output requires stream: true" otherwise — and
       * the only format available while streaming is bare `pcm16`, because a
       * container cannot be written incrementally. So the samples are gathered
       * and wrapped into a WAV at the end.
       *
       * Also no max_tokens, for the reason the image path has none: a cap set
       * for prose truncates generated media, and here it would cut the sentence
       * off mid-word. The length of what is spoken follows the text, which the
       * system prompt governs.
       */
      if (kind === 'speech') {
        const params: OpenRouterStreamingParams = {
          model: settings.model,
          stream: true,
          modalities: ['text', 'audio'],
          audio: { ...(settings.voice ? { voice: settings.voice } : {}), format: 'pcm16' },
          stream_options: { include_usage: true },
          usage: { include: true },
          ...sampling(settings),
          ...(provider ? { provider } : {}),
          messages: [
            { role: 'system', content: systemPrompt },
            ...turns.map(toMessage),
          ],
        };

        const stream = await client.chat.completions.create(
          params as unknown as OpenAI.ChatCompletionCreateParamsStreaming,
          { signal },
        );

        const samples: Buffer[] = [];
        let spoken = '';
        let said = '';
        let usage: MessageUsage | null = null;
        let refused = false;

        for await (const chunk of stream) {
          usage = toUsage((chunk as { usage?: OpenRouterUsage }).usage) ?? usage;
          const choice = chunk.choices[0];
          if (choice?.finish_reason === 'content_filter') refused = true;

          const delta = choice?.delta as OpenRouterDelta | undefined;
          if (!delta) continue;

          if (typeof delta.content === 'string' && delta.content.length > 0) {
            said += delta.content;
            events.onDelta(delta.content);
          }
          /*
           * The words arrive twice over: as ordinary content, and as the
           * transcript of what is being spoken. Whichever turns up is what the
           * conversation shows — gpt-audio sends only the transcript.
           */
          if (delta.audio?.transcript) spoken += delta.audio.transcript;
          if (delta.audio?.data) samples.push(Buffer.from(delta.audio.data, 'base64'));
        }

        const answer = said.length > 0 ? said : spoken;
        if (samples.length === 0) {
          if (refused) throw new ChatRefusalError('The model declined to read this out.');
          throw new ChatRefusalError(
            answer.trim().length > 0
              ? 'The model answered in text but produced no audio.'
              : 'The model produced no audio and no text.',
          );
        }

        if (spoken.length > 0 && said.length === 0) events.onDelta(spoken);

        return { answer, sources: [], media: [pcmToWav(Buffer.concat(samples))], usage };
      }

      const params: OpenRouterParams = {
        model: settings.model,
        max_tokens: config.maxTokens,
        stream: true,
        cache_control: { type: 'ephemeral' },
        reasoning: { effort: settings.effort, exclude: !settings.showThinking },
        plugins: webPlugin(settings),
        // Two flags, deliberately: stream_options is the OpenAI-standard way to
        // get a usage chunk at all, and `usage.include` is OpenRouter's way to
        // put the billed cost in it.
        stream_options: { include_usage: true },
        usage: { include: true },
        ...sampling(settings),
        ...(provider ? { provider } : {}),
        messages: [
          { role: 'system', content: systemPrompt },
          ...turns.map(toMessage),
        ],
      };

      const stream = await withAuthRetry(
        () => client.chat.completions.create(params, { signal }),
        signal,
      );

      let answer = '';
      let refused = false;
      let usage: MessageUsage | null = null;
      const sources: SourceLink[] = [];
      const seenUrls = new Set<string>();

      for await (const chunk of stream) {
        // The usage chunk carries no choices, so it has to be read before
        // anything below gives up on an empty delta.
        usage = toUsage((chunk as { usage?: OpenRouterUsage }).usage) ?? usage;

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

      return { answer, sources, media: [], usage };
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

      const response = await withAuthRetry(() =>
        client.chat.completions.create(
          params as unknown as OpenAI.ChatCompletionCreateParamsNonStreaming,
        ),
      );
      return response.choices[0]?.message?.content ?? '';
    },
  };
}
