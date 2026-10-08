import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { closeAll, freshRepo } from './helpers/db.js';

import type { Repo } from '../src/db/repo.js';
import {
  isAspectRatio,
  isAssistantKind,
  kindHasSetting,
  kindSpec,
  ASPECT_RATIOS,
  ASSISTANT_KINDS,
} from '../src/kinds.js';
import { toMessage } from '../src/llm.js';
import { modelsForKind, type ModelOption } from '../src/models.js';

function model(id: string, inputs: string[], outputs: string[]): ModelOption {
  return {
    id,
    name: id,
    contextLength: 1000,
    inputPricePerMillion: null,
    outputPricePerMillion: null,
    supportsReasoning: false,
    supportsSampling: true,
    inputModalities: inputs,
    outputModalities: outputs,
  };
}

describe('the kinds', () => {
  it('knows the four, and nothing else', async () => {
    expect([...ASSISTANT_KINDS]).toEqual(['text', 'image', 'transcribe', 'speech']);
    expect(isAssistantKind('text')).toBe(true);
    expect(isAssistantKind('video')).toBe(false);
    expect(isAssistantKind(7)).toBe(false);
  });

  /*
   * All four have a runtime now. The flag stays in the model because it is what
   * the admin form reads to say "this cannot answer yet" — a kind added later
   * starts false, and the chooser stays honest without a second mechanism.
   */
  it('reports every kind as ready', async () => {
    for (const kind of ASSISTANT_KINDS) {
      expect(kindSpec(kind).ready).toBe(true);
    }
  });

  it('gives a speaking chatbot a voice, and nobody else one', async () => {
    expect(kindHasSetting('speech', 'voice')).toBe(true);
    expect(kindHasSetting('text', 'voice')).toBe(false);
    expect(kindHasSetting('image', 'voice')).toBe(false);
  });

  it('describes what each one sends and receives', async () => {
    expect(kindSpec('text')).toMatchObject({ accepts: 'text', produces: 'text' });
    expect(kindSpec('image')).toMatchObject({ accepts: 'text', produces: 'image' });
    expect(kindSpec('transcribe')).toMatchObject({ accepts: 'audio', produces: 'text' });
    expect(kindSpec('speech')).toMatchObject({ accepts: 'text', produces: 'audio' });
  });

  // ---- which settings each kind admits -----------------------------------

  it('gives a text chatbot everything', async () => {
    for (const setting of ['effort', 'webSearch', 'memory', 'citations', 'compaction', 'notes'] as const) {
      expect(kindHasSetting('text', setting)).toBe(true);
    }
    // Only an image chatbot has a shape.
    expect(kindHasSetting('text', 'aspectRatio')).toBe(false);
  });

  /*
   * An image generator carries nothing between turns, so the four settings that
   * exist to do exactly that would be inert — and a visible, inert setting is
   * worse than an absent one.
   */
  it('keeps the text-carrying settings away from an image chatbot', async () => {
    for (const setting of ['webSearch', 'memory', 'citations', 'compaction', 'notes', 'effort'] as const) {
      expect(kindHasSetting('image', setting)).toBe(false);
    }
    expect(kindHasSetting('image', 'aspectRatio')).toBe(true);
    // A prompt is still the user's text, and can still name a person.
    expect(kindHasSetting('image', 'anonymize')).toBe(true);
  });

  /*
   * Anonymization rewrites outgoing *text*. A speech-to-text chatbot is sent
   * audio, which it cannot touch, so offering the toggle would promise a
   * protection that does not reach the input that matters.
   */
  it('hides anonymization from a speech-to-text chatbot', async () => {
    expect(kindHasSetting('transcribe', 'anonymize')).toBe(false);
  });

  it('hides language and sampling from a speech-to-text chatbot, and keeps them elsewhere', async () => {
    expect(kindHasSetting('transcribe', 'language')).toBe(false);
    expect(kindHasSetting('transcribe', 'sampling')).toBe(false);
    expect(kindHasSetting('transcribe', 'aspectRatio')).toBe(false);
    expect(kindHasSetting('text', 'language')).toBe(true);
    expect(kindHasSetting('text', 'sampling')).toBe(true);
  });

  // ---- the aspect ratios --------------------------------------------------

  it('accepts only the ratios OpenRouter enumerates', async () => {
    expect(isAspectRatio('16:9')).toBe(true);
    expect(isAspectRatio('1:1')).toBe(true);
    expect(isAspectRatio('')).toBe(false);
    expect(isAspectRatio('1920x1080')).toBe(false);
    expect(isAspectRatio('7:3')).toBe(false);
    expect(ASPECT_RATIOS).toHaveLength(14);
  });
});

describe('picking models for a kind', () => {
  const catalogue = [
    model('a/text', ['text'], ['text']),
    model('a/vision', ['image', 'text'], ['text']),
    model('a/draws', ['image', 'text'], ['image', 'text']),
    model('a/hears', ['audio', 'file', 'image', 'text'], ['text']),
    model('a/speaks', ['audio', 'text'], ['audio', 'text']),
  ];

  /*
   * By the catalogue's own modalities, not by a list of ids: 12 of 468 models
   * draw and 4 speak, and those sets change weekly.
   */
  it('offers an image chatbot only models that output an image', async () => {
    expect(modelsForKind(catalogue, 'image').map((m) => m.id)).toEqual(['a/draws']);
  });

  it('offers a speech-to-text chatbot only models that accept audio', async () => {
    expect(modelsForKind(catalogue, 'transcribe').map((m) => m.id)).toEqual(['a/hears', 'a/speaks']);
  });

  it('also offers the dedicated transcribers, which output "transcription"', async () => {
    const withStt = [...catalogue, model('assemblyai/x', ['audio'], ['transcription'])];
    expect(modelsForKind(withStt, 'transcribe').map((m) => m.id)).toContain('assemblyai/x');
    expect(modelsForKind(withStt, 'text').map((m) => m.id)).not.toContain('assemblyai/x');
  });

  it('offers a text chatbot anything that reads and writes text', async () => {
    expect(modelsForKind(catalogue, 'text').map((m) => m.id)).toEqual([
      'a/text',
      'a/vision',
      'a/draws',
      'a/hears',
      'a/speaks',
    ]);
  });

  it('offers a text-to-speech chatbot only models that output audio', async () => {
    expect(modelsForKind(catalogue, 'speech').map((m) => m.id)).toEqual(['a/speaks']);
  });

  it('returns nothing rather than everything when none qualifies', async () => {
    expect(modelsForKind([model('a/text', ['text'], ['text'])], 'image')).toEqual([]);
  });
});

describe('the kind on a chatbot', () => {
  let repo: Repo;

  beforeEach(async () => {
    repo = await freshRepo();
  });

  it('defaults to text, so every chatbot made before this keeps working', async () => {
    const assistant = await repo.createAssistant('coach', 'Coach', '', 'English');

    expect(assistant.kind).toBe('text');
  });

  it('round-trips the kind it was created with', async () => {
    const drawing = await repo.createAssistant('art', 'Art', '', 'English', 'image');

    expect(drawing.kind).toBe('image');
    expect((await repo.findAssistantById(drawing.id))?.kind).toBe('image');
  });

  it('can be changed afterwards', async () => {
    const assistant = await repo.createAssistant('coach', 'Coach', '', 'English');
    await repo.updateAssistant(assistant.id, 'Coach', '', 'English', '', 'transcribe');

    expect((await repo.findAssistantById(assistant.id))?.kind).toBe('transcribe');
  });

  /* The check constraint is the backstop for anything bypassing the route. */
  it('refuses a kind the database does not know', async () => {
    await expect(
      repo.createAssistant('bad', 'Bad', '', 'English', 'telepathy' as never),
    ).rejects.toThrow();
  });
});

describe('storing a generated image', () => {
  let repo: Repo;
  let conversationId: number;
  let messageId: number;
  let userId: number;
  let assistantId: number;

  beforeEach(async () => {
    repo = await freshRepo();
    userId = (await repo.upsertUser('a@example.com', false)).id;
    assistantId = (await repo.createAssistant('art', 'Art', '', 'English', 'image')).id;
    conversationId = (await repo.createConversation(userId, assistantId, 'Test')).id;
    messageId = (await repo.addMessage(conversationId, 'assistant', 'Here it is')).id;
  });

  const bytes = Buffer.from('not really a png, but bytes all the same');

  it('keeps the bytes and reports their length without returning them', async () => {
    const stored = await repo.addMessageMedia(messageId, 'image/png', bytes);

    expect(stored.mimeType).toBe('image/png');
    expect(stored.byteLength).toBe(bytes.length);
    expect(stored).not.toHaveProperty('bytes');
  });

  it('returns the bytes unchanged to the owner', async () => {
    const stored = await repo.addMessageMedia(messageId, 'image/png', bytes);
    const found = await repo.findMediaForUser(stored.id, userId, assistantId);

    expect(found?.mimeType).toBe('image/png');
    expect(Buffer.compare(found!.bytes, bytes)).toBe(0);
  });

  /* The ownership is the join, like every conversation query. */
  it('hides an image from another user and another chatbot', async () => {
    const other = await repo.upsertUser('b@example.com', false);
    const second = await repo.createAssistant('hr', 'HR', '', 'English', 'image');
    const stored = await repo.addMessageMedia(messageId, 'image/png', bytes);

    expect(await repo.findMediaForUser(stored.id, other.id, assistantId)).toBeNull();
    expect(await repo.findMediaForUser(stored.id, userId, second.id)).toBeNull();
  });

  it('lists a conversation’s images against their messages', async () => {
    const first = await repo.addMessageMedia(messageId, 'image/png', bytes);
    const second = await repo.addMessageMedia(messageId, 'image/webp', bytes);

    const listed = await repo.listMediaForConversation(conversationId);
    expect(listed.map((image) => image.id)).toEqual([first.id, second.id]);
    expect(listed.every((image) => image.messageId === messageId)).toBe(true);
  });

  it('goes when its message goes', async () => {
    const stored = await repo.addMessageMedia(messageId, 'image/png', bytes);
    await repo.deleteConversation(conversationId, userId);

    expect(await repo.findMediaForUser(stored.id, userId, assistantId)).toBeNull();
  });
});

afterAll(closeAll);

describe('putting a turn on the wire', () => {
  /*
   * Plain text stays a plain string. The prompt cache depends on the prefix
   * being byte-identical between requests, and wrapping every turn in a
   * content-part array would change all of them.
   */
  it('leaves a text turn as a string', async () => {
    expect(toMessage({ role: 'user', content: 'hello' })).toEqual({
      role: 'user',
      content: 'hello',
    });
  });

  /*
   * The bug this pins: the streaming request builder rebuilt each turn from
   * role and content alone, so the recording was dropped on the floor and the
   * model answered "there is nothing to transcribe". It cost an end-to-end run
   * to notice, because every type still compiled.
   */
  it('carries a recording as a content part beside the text', async () => {
    const message = toMessage({
      role: 'user',
      content: 'Transcribe this.',
      audio: { data: 'QUJD', format: 'wav' },
    });

    expect(message).toEqual({
      role: 'user',
      content: [
        { type: 'text', text: 'Transcribe this.' },
        { type: 'input_audio', input_audio: { data: 'QUJD', format: 'wav' } },
      ],
    });
  });

  it('keeps an assistant turn as text even in an audio conversation', async () => {
    expect(toMessage({ role: 'assistant', content: 'A transcript.' })).toEqual({
      role: 'assistant',
      content: 'A transcript.',
    });
  });
});
