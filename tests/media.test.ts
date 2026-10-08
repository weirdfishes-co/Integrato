import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Config } from '../src/config.js';
import { createChatClient, ChatRefusalError } from '../src/llm.js';
import type { AssistantSettings } from '../src/settings.js';

const config = {
  openRouterApiKey: 'sk-or-test',
  // The value that broke it: a sensible cap for prose, fatal for a picture.
  maxTokens: 800,
  siteUrl: undefined,
  siteName: 'Test',
} as Config;

const settings = {
  model: 'google/gemini-nano-banana-2.1',
  effort: 'high',
  showThinking: false,
  webSearch: false,
  webSearchMaxResults: 5,
  webSearchIncludeDomains: [],
  webSearchExcludeDomains: [],
  memory: false,
  citations: false,
  compaction: false,
  notes: false,
  adminConversationLog: false,
  euOnly: false,
  anonymize: false,
  temperature: null,
  topP: null,
  aspectRatio: null,
  voice: null,
} as AssistantSettings;

/** A one-pixel gif, so the decoding has something real to chew on. */
const PIXEL =
  'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

/** Captures the body the SDK puts on the wire, and answers with `reply`. */
function stubProvider(reply: unknown, status = 200) {
  const bodies: Record<string, unknown>[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: unknown, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      return new Response(JSON.stringify(reply), {
        status,
        headers: { 'content-type': 'application/json' },
      });
    }),
  );
  return bodies;
}

function answer(message: Record<string, unknown>, finish = 'stop') {
  return {
    id: 'gen-1',
    choices: [{ index: 0, finish_reason: finish, message: { role: 'assistant', ...message } }],
    usage: { prompt_tokens: 8, completion_tokens: 1300, cost: 0.035 },
  };
}

const events = { onDelta: () => {} };

function request(overrides: Partial<AssistantSettings> = {}) {
  return {
    systemPrompt: 'You draw.',
    history: [{ role: 'user' as const, content: 'A red maple leaf.' }],
    settings: { ...settings, ...overrides },
    kind: 'image' as const,
  };
}

describe('an image request', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /*
   * The bug, pinned. MODEL_MAX_TOKENS is an answer-length budget; an image
   * costs ~1,300 completion tokens whatever it depicts, so a cap set for prose
   * truncates the response and the user gets no image and no explanation.
   * Nothing is uncapped by leaving it out — one request yields one image.
   */
  it('sends no token cap, however low MODEL_MAX_TOKENS is', async () => {
    const bodies = stubProvider(answer({ content: '', images: [{ image_url: { url: PIXEL } }] }));
    await createChatClient(config).stream(request(), events);

    expect(bodies[0]).not.toHaveProperty('max_tokens');
  });

  it('asks for an image as well as text', async () => {
    const bodies = stubProvider(answer({ content: '', images: [{ image_url: { url: PIXEL } }] }));
    await createChatClient(config).stream(request(), events);

    expect(bodies[0]?.modalities).toEqual(['image', 'text']);
    expect(bodies[0]?.stream).toBeFalsy();
  });

  it('sends a shape only when one was chosen', async () => {
    const without = stubProvider(answer({ images: [{ image_url: { url: PIXEL } }] }));
    await createChatClient(config).stream(request(), events);
    expect(without[0]).not.toHaveProperty('image_config');

    vi.unstubAllGlobals();
    const withRatio = stubProvider(answer({ images: [{ image_url: { url: PIXEL } }] }));
    await createChatClient(config).stream(request({ aspectRatio: '16:9' }), events);
    expect(withRatio[0]?.image_config).toEqual({ aspect_ratio: '16:9' });
  });

  it('decodes the image out of the data: url', async () => {
    stubProvider(answer({ content: 'Here you are.', images: [{ image_url: { url: PIXEL } }] }));
    const result = await createChatClient(config).stream(request(), events);

    expect(result.media).toHaveLength(1);
    expect(result.media[0]?.mimeType).toBe('image/gif');
    expect(result.media[0]?.bytes.subarray(0, 3).toString()).toBe('GIF');
    expect(result.answer).toBe('Here you are.');
  });

  /* Several image models return a picture and no caption. That is an answer. */
  it('accepts an image with no caption at all', async () => {
    stubProvider(answer({ content: '', images: [{ image_url: { url: PIXEL } }] }));
    const result = await createChatClient(config).stream(request(), events);

    expect(result.answer).toBe('');
    expect(result.media).toHaveLength(1);
  });

  // ---- the empty responses, each with its own sentence -------------------

  it('names the token cap when the model was cut off', async () => {
    stubProvider(answer({ content: '' }, 'length'));

    await expect(createChatClient(config).stream(request(), events)).rejects.toThrow(
      /MODEL_MAX_TOKENS/,
    );
  });

  it('says so when the model declined', async () => {
    stubProvider(answer({ content: '' }, 'content_filter'));

    await expect(createChatClient(config).stream(request(), events)).rejects.toThrow(
      /declined to draw/,
    );
  });

  it('falls back to the plain message when it stopped for no stated reason', async () => {
    stubProvider(answer({ content: '' }, 'stop'));

    await expect(createChatClient(config).stream(request(), events)).rejects.toBeInstanceOf(
      ChatRefusalError,
    );
  });

  it('ignores an image it cannot decode rather than passing it on', async () => {
    stubProvider(answer({ content: 'Text.', images: [{ image_url: { url: 'https://x/y.png' } }] }));
    const result = await createChatClient(config).stream(request(), events);

    expect(result.media).toEqual([]);
    expect(result.answer).toBe('Text.');
  });
});

/** An SSE body the OpenAI client can read, from a list of chunk objects. */
function stubStream(chunks: unknown[]) {
  const bodies: Record<string, unknown>[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: unknown, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      const text =
        chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n';
      return new Response(text, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });
    }),
  );
  return bodies;
}

function audioChunk(delta: Record<string, unknown>, finish: string | null = null) {
  return { id: 'gen-1', choices: [{ index: 0, delta, finish_reason: finish }] };
}

/** 16-bit silence: four sample frames. */
const PCM = Buffer.from([0, 0, 1, 0, 2, 0, 3, 0]).toString('base64');

describe('a speech request', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function speechRequest(overrides: Partial<AssistantSettings> = {}) {
    return {
      systemPrompt: 'You read aloud.',
      history: [{ role: 'user' as const, content: 'Good morning.' }],
      settings: { ...settings, model: 'openai/gpt-audio-mini', ...overrides },
      kind: 'speech' as const,
    };
  }

  /*
   * The API refuses outright otherwise — "Audio output requires stream: true" —
   * which is the exact opposite of the image path, and pcm16 is the only format
   * available while streaming because a container cannot be written
   * incrementally.
   */
  it('streams, and asks for pcm16', async () => {
    const bodies = stubStream([audioChunk({ audio: { data: PCM } }, 'stop')]);
    await createChatClient(config).stream(speechRequest(), events);

    expect(bodies[0]?.stream).toBe(true);
    expect(bodies[0]?.modalities).toEqual(['text', 'audio']);
    expect(bodies[0]?.audio).toEqual({ format: 'pcm16' });
    // For the same reason an image sends none: a prose cap truncates media.
    expect(bodies[0]).not.toHaveProperty('max_tokens');
  });

  it('sends a voice only when one was chosen', async () => {
    const bodies = stubStream([audioChunk({ audio: { data: PCM } }, 'stop')]);
    await createChatClient(config).stream(speechRequest({ voice: 'nova' }), events);

    expect(bodies[0]?.audio).toEqual({ voice: 'nova', format: 'pcm16' });
  });

  /*
   * The header is written by hand, so its bytes are worth asserting: a wrong
   * sample rate plays the voice at the wrong pitch, and a wrong data length
   * makes some players refuse the file outright.
   */
  it('wraps the samples in a 24 kHz mono WAV', async () => {
    stubStream([
      audioChunk({ audio: { data: PCM } }),
      audioChunk({ audio: { data: PCM } }, 'stop'),
    ]);
    const result = await createChatClient(config).stream(speechRequest(), events);

    expect(result.media).toHaveLength(1);
    const wav = result.media[0]!;
    expect(wav.mimeType).toBe('audio/wav');

    const pcmBytes = 8 * 2; // two chunks of four 16-bit frames
    expect(wav.bytes.length).toBe(44 + pcmBytes);
    expect(wav.bytes.subarray(0, 4).toString()).toBe('RIFF');
    expect(wav.bytes.subarray(8, 12).toString()).toBe('WAVE');
    expect(wav.bytes.readUInt16LE(22)).toBe(1); // mono
    expect(wav.bytes.readUInt32LE(24)).toBe(24_000); // sample rate
    expect(wav.bytes.readUInt16LE(34)).toBe(16); // bits per sample
    expect(wav.bytes.readUInt32LE(40)).toBe(pcmBytes); // the data chunk's length
    expect(wav.bytes.readUInt32LE(4)).toBe(36 + pcmBytes); // and the file's
  });

  /*
   * gpt-audio sends the words as `audio.transcript` and leaves `content` empty,
   * so the conversation would otherwise store a blank answer beside the sound.
   */
  it('falls back to the transcript when there is no text content', async () => {
    stubStream([
      audioChunk({ audio: { transcript: 'Good ' } }),
      audioChunk({ audio: { transcript: 'morning.', data: PCM } }, 'stop'),
    ]);
    const result = await createChatClient(config).stream(speechRequest(), events);

    expect(result.answer).toBe('Good morning.');
  });

  it('prefers the text content when the model sends both', async () => {
    stubStream([
      audioChunk({ content: 'Spoken answer.', audio: { transcript: 'ignored', data: PCM } }, 'stop'),
    ]);
    const result = await createChatClient(config).stream(speechRequest(), events);

    expect(result.answer).toBe('Spoken answer.');
  });

  it('refuses to pass off a text-only reply as speech', async () => {
    stubStream([audioChunk({ content: 'I would rather not.' }, 'stop')]);

    await expect(createChatClient(config).stream(speechRequest(), events)).rejects.toThrow(
      /no audio/,
    );
  });

  it('says so when the model declined', async () => {
    stubStream([audioChunk({ content: '' }, 'content_filter')]);

    await expect(createChatClient(config).stream(speechRequest(), events)).rejects.toThrow(
      /declined to read/,
    );
  });
});
