/**
 * What a chatbot *does*: text in and text out, or an image out, or speech in.
 *
 * One source of truth, because three places have to agree about it and they are
 * far apart — the admin form (which fields to show), the model picker (which of
 * OpenRouter's 468 models can do this at all) and `llm.ts` (what to put in the
 * request). A fourth place, `routes/chat.ts`, decides what to do with what
 * comes back.
 *
 * The modalities are the catalogue's own words: every model carries
 * `architecture.input_modalities` and `output_modalities`, so "which models can
 * generate an image" is a question the catalogue answers rather than a list we
 * maintain.
 */

export const ASSISTANT_KINDS = ['text', 'image', 'transcribe', 'speech'] as const;
export type AssistantKind = (typeof ASSISTANT_KINDS)[number];

export const DEFAULT_KIND: AssistantKind = 'text';

/**
 * Settings a kind has any use for. The admin form asks this rather than
 * carrying its own list of exceptions, so a new kind cannot quietly inherit a
 * field that does nothing for it — a setting that is visible but inert is worse
 * than one that is absent.
 */
export type KindSetting =
  | 'effort'
  | 'thinking'
  | 'sampling'
  | 'webSearch'
  | 'memory'
  | 'citations'
  | 'compaction'
  | 'notes'
  | 'anonymize'
  | 'aspectRatio'
  | 'language'
  | 'voice';

export interface KindSpec {
  readonly label: string;
  /** One line under the chooser, in the admin form. */
  readonly summary: string;
  /** What the *user* sends. 'audio' means the composer uploads a recording. */
  readonly accepts: 'text' | 'audio';
  /** What comes back, and therefore how the chat renders it. */
  readonly produces: 'text' | 'image' | 'audio';
  readonly settings: readonly KindSetting[];
  /**
   * False while the chat cannot actually do this yet. The admin form says so
   * rather than letting someone configure a chatbot that answers as text.
   */
  readonly ready: boolean;
}

/*
 * EU-only routing, the admin conversation log and the model itself apply to
 * every kind, so they are not listed per kind — only the ones that differ are.
 */
export const KINDS: Readonly<Record<AssistantKind, KindSpec>> = {
  text: {
    label: 'Text → text',
    summary: 'An ordinary chatbot: the user writes, the model answers.',
    accepts: 'text',
    produces: 'text',
    settings: [
      'language',
      'effort',
      'thinking',
      'sampling',
      'webSearch',
      'memory',
      'citations',
      'compaction',
      'notes',
      'anonymize',
    ],
    ready: true,
  },
  image: {
    label: 'Text → image',
    summary: 'The user describes a picture and the model draws it.',
    accepts: 'text',
    produces: 'image',
    /*
     * No sampling, web search, citations, compaction or memory. The last four
     * are about carrying text between turns, and temperature / top-p tune
     * word choice, which an image generator has no use for. Anonymization stays — a prompt is still the user's text and can still
     * carry a name or an address.
     */
    settings: ['language', 'aspectRatio', 'anonymize'],
    ready: true,
  },
  transcribe: {
    label: 'Speech → text',
    summary: 'The user uploads a recording and the model writes out what was said.',
    accepts: 'audio',
    produces: 'text',
    /*
     * Anonymization is deliberately absent: it rewrites outgoing *text*, and
     * here the user sends audio. Leaving the toggle visible would promise
     * something it cannot do to the one input that matters.
     *
     * Nor a language or sampling: a transcriber writes what it hears, in the
     * language it hears, and temperature / top-p are not parameters of the
     * transcription endpoint at all.
     */
    settings: [],
    ready: true,
  },
  speech: {
    label: 'Text → speech',
    summary: 'The user writes and the model reads it aloud.',
    accepts: 'text',
    produces: 'audio',
    settings: ['voice', 'language', 'sampling'],
    ready: true,
  },
};

export function isAssistantKind(value: unknown): value is AssistantKind {
  return typeof value === 'string' && (ASSISTANT_KINDS as readonly string[]).includes(value);
}

export function kindSpec(kind: AssistantKind): KindSpec {
  return KINDS[kind];
}

/** Does this kind's admin form show that setting? */
export function kindHasSetting(kind: AssistantKind, setting: KindSetting): boolean {
  return KINDS[kind].settings.includes(setting);
}

/**
 * The aspect ratios OpenRouter accepts in `image_config`, exactly as its API
 * enumerates them — it rejects anything else, so this list is not ours to
 * extend. An unset ratio sends nothing and lets the model choose.
 */
export const ASPECT_RATIOS = [
  '1:1',
  '2:3',
  '3:2',
  '3:4',
  '4:3',
  '4:5',
  '5:4',
  '9:16',
  '16:9',
  '21:9',
  '1:4',
  '4:1',
  '1:8',
  '8:1',
] as const;

export function isAspectRatio(value: unknown): value is (typeof ASPECT_RATIOS)[number] {
  return typeof value === 'string' && (ASPECT_RATIOS as readonly string[]).includes(value);
}

/**
 * The voices OpenAI's audio models offer. The catalogue does not expose them —
 * `supported_voices` is null on every model that speaks — so this list is ours,
 * checked by hand against gpt-audio-mini: alloy, nova, onyx and shimmer all
 * speak, and an unknown name is refused by the provider rather than ignored.
 * An unset voice sends nothing and lets the model use its own.
 */
export const VOICES = [
  'alloy',
  'ash',
  'ballad',
  'coral',
  'echo',
  'fable',
  'nova',
  'onyx',
  'sage',
  'shimmer',
  'verse',
] as const;

export function isVoice(value: unknown): value is (typeof VOICES)[number] {
  return typeof value === 'string' && (VOICES as readonly string[]).includes(value);
}
