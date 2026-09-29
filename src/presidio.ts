import type { Config } from './config.js';
import { logger } from './logger.js';

/**
 * Pseudonymization of user text through Microsoft Presidio, for chatbots whose
 * admin has switched it on.
 *
 * Only the *analyzer* is needed: it reports where the personal data is, and the
 * substitution is done here. That halves the infrastructure (no separate
 * presidio-anonymizer service) and lets one placeholder be reused for one
 * value, so the model can still tell two people apart in the same thread.
 *
 * What is anonymized is the text the *user* wrote — their messages and the
 * replayed history. The system prompt is left alone: it is written by an admin,
 * and rewriting it would invalidate the prompt cache on every request.
 */

/** Presidio's default confidence floor; below this it guesses too freely. */
const DEFAULT_SCORE_THRESHOLD = 0.5;
const REQUEST_TIMEOUT_MS = 10_000;

/**
 * Texts are analyzed in one call, joined by this. It is a blank-line-separated
 * rule, which no recognizer treats as part of an entity, so a span never
 * straddles two messages — and any span that somehow does is dropped.
 */
const SEPARATOR = '\n\n~~~~~~~~\n\n';

export interface Anonymizer {
  /** False when no PRESIDIO_URL is set; the toggle then refuses to run. */
  readonly configured: boolean;
  /**
   * Replaces the personal data in each text with a placeholder. One call for
   * the whole batch, with one shared mapping, so the same person keeps the same
   * placeholder across the messages of a conversation.
   */
  anonymizeBatch(texts: readonly string[]): Promise<string[]>;
}

/**
 * Thrown when anonymization was asked for and could not be done. It is
 * deliberately fatal to the request: sending the text unprotected would be the
 * one outcome an admin switched this on to prevent.
 */
export class AnonymizationError extends Error {
  readonly code = 'anonymization';
}

interface AnalyzerResult {
  entity_type?: unknown;
  start?: unknown;
  end?: unknown;
  score?: unknown;
}

interface Span {
  type: string;
  start: number;
  end: number;
  score: number;
}

function toSpan(row: AnalyzerResult): Span | null {
  const { entity_type: type, start, end, score } = row;
  if (typeof type !== 'string' || typeof start !== 'number' || typeof end !== 'number') return null;
  if (!Number.isInteger(start) || !Number.isInteger(end) || end <= start || start < 0) return null;
  return { type, start, end, score: typeof score === 'number' ? score : 0 };
}

/**
 * Presidio returns overlapping matches — the same stretch of text recognized as
 * two entities. Keeping both would corrupt the offsets, so the stronger match
 * wins and the weaker one is dropped.
 */
function withoutOverlaps(spans: Span[]): Span[] {
  const ordered = [...spans].sort((a, b) => {
    if (a.start !== b.start) return a.start - b.start;
    if (a.score !== b.score) return b.score - a.score;
    return b.end - a.end;
  });

  const kept: Span[] = [];
  let boundary = -1;
  for (const span of ordered) {
    if (span.start < boundary) continue;
    kept.push(span);
    boundary = span.end;
  }
  return kept;
}

/**
 * Stable placeholders: the same value gets the same name everywhere in the
 * batch, and different values of one type are numbered apart, so "Ann asked
 * Bob" does not collapse into one person.
 */
function createNaming(): (type: string, value: string) => string {
  const assigned = new Map<string, string>();
  const counts = new Map<string, number>();

  return (type, value) => {
    const key = `${type}:${value.toLowerCase()}`;
    const known = assigned.get(key);
    if (known) return known;

    const next = (counts.get(type) ?? 0) + 1;
    counts.set(type, next);
    const placeholder = `<${type}_${next}>`;
    assigned.set(key, placeholder);
    return placeholder;
  };
}

export function createAnonymizer(config: Config): Anonymizer {
  const { url, language, scoreThreshold } = config.presidio;

  if (!url) {
    return {
      configured: false,
      async anonymizeBatch() {
        throw new AnonymizationError('No Presidio service is configured (PRESIDIO_URL).');
      },
    };
  }

  const analyzeUrl = `${url.replace(/\/+$/, '')}/analyze`;

  async function analyze(text: string): Promise<Span[]> {
    let response: Response;
    try {
      response = await fetch(analyzeUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({
          text,
          language,
          score_threshold: scoreThreshold ?? DEFAULT_SCORE_THRESHOLD,
        }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      // fetch has no timeout of its own; without one a hung analyzer would
      // hold the chat request open with no answer and no error. The cause goes
      // to the log, not to the browser — it is a hostname and a stack trace.
      logger.error({ err: error, url: analyzeUrl }, 'the Presidio service could not be reached');
      throw new AnonymizationError(
        'The service that removes personal data from messages could not be reached, so nothing was sent. An administrator needs to check it.',
      );
    }

    if (!response.ok) {
      logger.error({ status: response.status }, 'the Presidio service refused the request');
      throw new AnonymizationError(
        'The service that removes personal data from messages failed, so nothing was sent. An administrator needs to check it.',
      );
    }

    const body: unknown = await response.json();
    if (!Array.isArray(body)) {
      throw new AnonymizationError(
        'The service that removes personal data from messages answered in a form this app does not understand, so nothing was sent.',
      );
    }

    return withoutOverlaps(
      (body as AnalyzerResult[]).map(toSpan).filter((span): span is Span => span !== null),
    );
  }

  return {
    configured: true,

    async anonymizeBatch(texts) {
      if (texts.length === 0) return [];

      const joined = texts.join(SEPARATOR);
      if (joined.trim().length === 0) return [...texts];

      const spans = await analyze(joined);
      const name = createNaming();

      // Where each text starts inside the joined string, so a span can be
      // attributed to exactly one of them.
      const offsets: number[] = [];
      let cursor = 0;
      for (const text of texts) {
        offsets.push(cursor);
        cursor += text.length + SEPARATOR.length;
      }

      const result = [...texts];
      // Right to left: replacing from the end keeps every earlier offset valid.
      for (const span of [...spans].sort((a, b) => b.start - a.start)) {
        const index = offsets.findLastIndex((offset) => offset <= span.start);
        const offset = offsets[index];
        const text = result[index];
        if (offset === undefined || text === undefined) continue;

        const start = span.start - offset;
        const end = span.end - offset;
        // A span that runs past the end of its own message crossed a separator,
        // which means the offsets cannot be trusted for it.
        if (end > text.length) continue;

        result[index] = text.slice(0, start) + name(span.type, text.slice(start, end)) + text.slice(end);
      }

      const replaced = spans.length;
      if (replaced > 0) logger.debug({ replaced }, 'anonymized outgoing text');
      return result;
    },
  };
}
