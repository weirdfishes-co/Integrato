/**
 * Replaces personal data in a user's message with placeholders, before the
 * message is sent to the model.
 *
 * This runs in this process: no service, no model, no network call. That is a
 * deliberate trade. Every recognizer here is a pattern with a checksum behind
 * it, which makes it exact and explainable — an IBAN either passes mod-97 or it
 * does not. What it cannot do is names: recognizing that "Priya Raghunathan"
 * is a person needs a trained model, and there is no honest way to do it with
 * a regular expression. The admin page says so rather than implying otherwise.
 *
 * The thing to understand about the alternative: a name lexicon (the usual
 * pure-JavaScript approach) finds the names it has seen and misses the rest
 * silently, which for a privacy control is worse than a gap you can see.
 */

/** What a recognizer found, before it competes with the others. */
interface Span {
  type: string;
  start: number;
  end: number;
  /** Decides which of two overlapping matches survives; higher wins. */
  priority: number;
}

interface Recognizer {
  type: string;
  priority: number;
  pattern: RegExp;
  /**
   * Second look at a candidate the pattern matched. This is where the
   * checksums live, and it is what keeps an order number from being read as a
   * bank account.
   */
  accept?: (match: string) => boolean;
}

/** The digits of a match, with the spaces and dashes people type left out. */
function digits(value: string): string {
  return value.replace(/\D/g, '');
}

/**
 * The Luhn check, which every payment card number satisfies. A random string of
 * digits passes it one time in ten, so it is a filter and not a proof — paired
 * with a 13-to-19-digit length it is enough to stop ordinary numbers.
 */
function passesLuhn(value: string): boolean {
  const numbers = digits(value);
  if (numbers.length < 13 || numbers.length > 19) return false;

  let sum = 0;
  let double = false;
  for (let index = numbers.length - 1; index >= 0; index -= 1) {
    let digit = Number(numbers[index]);
    if (double) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    double = !double;
  }
  return sum % 10 === 0;
}

/**
 * IBAN's mod-97 check: move the first four characters to the end, turn letters
 * into numbers, and the remainder must be 1. Strong enough on its own — a
 * string that passes is an IBAN.
 */
function passesMod97(value: string): boolean {
  const account = value.replace(/\s/g, '').toUpperCase();
  if (account.length < 15 || account.length > 34) return false;

  const rearranged = account.slice(4) + account.slice(0, 4);
  const expanded = [...rearranged]
    .map((character) => {
      const code = character.charCodeAt(0);
      if (code >= 65 && code <= 90) return String(code - 55);
      if (code >= 48 && code <= 57) return character;
      return '';
    })
    .join('');
  if (expanded.length === 0) return false;

  // The number is far past Number.MAX_SAFE_INTEGER, so it is reduced in chunks.
  let remainder = 0;
  for (const digit of expanded) {
    remainder = (remainder * 10 + Number(digit)) % 97;
  }
  return remainder === 1;
}

/**
 * The Dutch 11-proef, which a BSN satisfies. One nine-digit number in eleven
 * passes it by chance, so an order number can be caught by mistake — erring
 * towards masking is the right direction for a privacy control, and the
 * placeholder still tells the model a number stood there.
 */
function passesElevenProof(value: string): boolean {
  const numbers = digits(value);
  if (numbers.length !== 9) return false;
  if (/^0+$/.test(numbers)) return false;

  let sum = 0;
  for (let index = 0; index < 9; index += 1) {
    const weight = index === 8 ? -1 : 9 - index;
    sum += Number(numbers[index]) * weight;
  }
  return sum % 11 === 0;
}

/**
 * A telephone number, which has no checksum and therefore needs its shape to
 * carry the weight. A match must either start with a country code or a
 * national trunk zero, and hold 9 to 15 digits — which is what keeps a year, a
 * price, a version or an invoice number out.
 */
function looksLikePhone(value: string): boolean {
  const numbers = digits(value);
  if (numbers.length < 9 || numbers.length > 15) return false;
  return value.trim().startsWith('+') || numbers.startsWith('0') || /^\(0/.test(value.trim());
}

/*
 * Order matters only for readability; overlaps are settled by priority below.
 * An email outranks everything because it contains things that look like other
 * entities, and an IBAN outranks a card and a BSN for the same reason.
 */
const RECOGNIZERS: readonly Recognizer[] = [
  {
    type: 'EMAIL_ADDRESS',
    priority: 100,
    pattern: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,
  },
  {
    type: 'IBAN',
    priority: 90,
    // Two letters, two check digits, then up to 30 alphanumerics in groups.
    pattern: /\b[A-Z]{2}\d{2}(?:[ ]?[A-Z0-9]{2,4}){2,8}\b/g,
    accept: passesMod97,
  },
  {
    type: 'CREDIT_CARD',
    priority: 80,
    pattern: /\b(?:\d[ -]?){12,18}\d\b/g,
    accept: passesLuhn,
  },
  {
    type: 'BSN',
    priority: 70,
    pattern: /\b\d{9}\b/g,
    accept: passesElevenProof,
  },
  {
    type: 'PHONE_NUMBER',
    priority: 60,
    // Groups of digits, optionally parenthesised, joined by a space, dot or
    // dash — which covers +31 6 12345678, 020-1234567 and +1 (555) 123-4567
    // alike. What makes it a phone number rather than a sum is `looksLikePhone`.
    pattern: /(?:\+\d{1,4}|\(\d{1,4}\)|\b\d{1,4})(?:[ .-]?(?:\(\d{1,4}\)|\d{1,4})){1,6}\b/g,
    accept: looksLikePhone,
  },
  {
    type: 'IP_ADDRESS',
    priority: 50,
    pattern: /\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b/g,
  },
  {
    type: 'POSTCODE',
    priority: 40,
    /*
     * Dutch postcode: four digits then two letters. The letters must be capital
     * — lowercase would swallow "in 2024 we doubled", a year followed by any
     * two-letter word, which is common enough in ordinary prose to make the
     * whole recognizer a nuisance. The three combinations the Dutch system
     * never issues are excluded for the same reason.
     */
    pattern: /\b[1-9]\d{3}[ ]?(?!SA\b|SD\b|SS\b)[A-Z]{2}\b/g,
  },
];

/** Every entity type this can find, for the admin page to list. */
export const RECOGNIZED_TYPES: readonly string[] = RECOGNIZERS.map(
  (recognizer) => recognizer.type,
);

function findSpans(text: string): Span[] {
  const spans: Span[] = [];

  for (const { type, priority, pattern, accept } of RECOGNIZERS) {
    // Each recognizer gets its own regex object: lastIndex is state, and a
    // shared /g pattern would skip matches on the next text.
    const scanner = new RegExp(pattern.source, pattern.flags);
    let match = scanner.exec(text);

    while (match !== null) {
      const value = match[0];
      if (!accept || accept(value)) {
        spans.push({ type, start: match.index, end: match.index + value.length, priority });
      }
      // A zero-length match would loop forever; regexes here cannot produce one,
      // but the guard costs nothing and the failure would be a hung request.
      scanner.lastIndex = match.index + Math.max(value.length, 1);
      match = scanner.exec(text);
    }
  }

  return spans;
}

/**
 * Two recognizers often claim the same stretch of text — the digits of a phone
 * number inside an IBAN, a postcode inside an address. Keeping both would
 * corrupt the offsets, so the higher priority wins, and the longer match wins
 * between equals.
 */
function withoutOverlaps(spans: readonly Span[]): Span[] {
  const ordered = [...spans].sort((a, b) => {
    if (a.start !== b.start) return a.start - b.start;
    if (a.priority !== b.priority) return b.priority - a.priority;
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
 * Stable placeholders: one value keeps one name everywhere in the batch, and
 * two values of a type are numbered apart — so a message naming two bank
 * accounts still reads as two.
 */
function createNaming(): (type: string, value: string) => string {
  const assigned = new Map<string, string>();
  const counts = new Map<string, number>();

  return (type, value) => {
    const key = `${type}:${value.replace(/[\s-]/g, '').toLowerCase()}`;
    const known = assigned.get(key);
    if (known) return known;

    const next = (counts.get(type) ?? 0) + 1;
    counts.set(type, next);
    const placeholder = `<${type}_${next}>`;
    assigned.set(key, placeholder);
    return placeholder;
  };
}

/**
 * Replaces the personal data in each text with a placeholder.
 *
 * The batch shares one naming table on purpose: a conversation is anonymized in
 * one call, so the same address keeps the same placeholder from the first turn
 * to the last and the model can follow the thread.
 */
export function anonymizeBatch(texts: readonly string[]): string[] {
  const name = createNaming();

  return texts.map((text) => {
    const spans = withoutOverlaps(findSpans(text));

    // Named front to back, so the numbering follows the order a reader sees,
    // then replaced back to front, so every offset stays valid while the
    // lengths change underneath.
    const named = spans.map((span) => ({ span, placeholder: name(span.type, text.slice(span.start, span.end)) }));

    let result = text;
    for (const { span, placeholder } of [...named].reverse()) {
      result = result.slice(0, span.start) + placeholder + result.slice(span.end);
    }
    return result;
  });
}
