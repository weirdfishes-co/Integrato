import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { anonymizeBatch, RECOGNIZED_TYPES } from '../src/anonymize.js';
import { euProviderTags, listModels, resetModelCache } from '../src/models.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** The one text case, for readability. */
function anonymize(text: string): string {
  return anonymizeBatch([text])[0]!;
}

describe('anonymizing a message', () => {
  it('masks an email address', async () => {
    expect(anonymize('Mail me at ann.smith@example.com today')).toBe(
      'Mail me at <EMAIL_ADDRESS_1> today',
    );
  });

  /* mod-97 makes this exact: a string that passes is an IBAN. */
  it('masks an IBAN, spaced or not', async () => {
    expect(anonymize('IBAN NL91 ABNA 0417 1643 00 please')).toBe('IBAN <IBAN_1> please');
    expect(anonymize('IBAN NL91ABNA0417164300 please')).toBe('IBAN <IBAN_1> please');
  });

  it('leaves a bank-account-shaped string that fails mod-97', async () => {
    const text = 'IBAN GB00 WEST 1234 5698 7654 32 please';

    expect(anonymize(text)).toBe(text);
  });

  /*
   * A rejected IBAN is not thereby innocent: NL92 ABNA 0417 1643 00 fails
   * mod-97, but its digits are a ten-digit number starting with a zero, which
   * is exactly a Dutch phone number. Masking it is the right outcome — the
   * recognizers are a net, not a classifier.
   */
  it('still masks a rejected IBAN whose digits look like a phone number', async () => {
    expect(anonymize('IBAN NL92 ABNA 0417 1643 00 please')).toContain('<PHONE_NUMBER_1>');
  });

  it('masks a card number that passes the Luhn check', async () => {
    expect(anonymize('Card 4111 1111 1111 1111 expires')).toBe('Card <CREDIT_CARD_1> expires');
  });

  it('leaves a card-length number that fails Luhn', async () => {
    const text = 'Card 4111 1111 1111 1112 expires';

    expect(anonymize(text)).toBe(text);
  });

  it('masks a BSN that passes the 11-proef', async () => {
    expect(anonymize('BSN 111222333 here')).toBe('BSN <BSN_1> here');
  });

  it('leaves a nine-digit number that fails the 11-proef', async () => {
    const text = 'Number 123456789 here';

    expect(anonymize(text)).toBe(text);
  });

  it('masks phone numbers in the shapes people actually type', async () => {
    expect(anonymize('Bel +31 6 12345678 nu')).toBe('Bel <PHONE_NUMBER_1> nu');
    expect(anonymize('Bel 06-12345678 nu')).toBe('Bel <PHONE_NUMBER_1> nu');
    expect(anonymize('Bel 020-1234567 nu')).toBe('Bel <PHONE_NUMBER_1> nu');
    expect(anonymize('Call +1 (555) 123-4567 now')).toBe('Call <PHONE_NUMBER_1> now');
  });

  it('masks an IP address', async () => {
    expect(anonymize('Host 192.168.1.44 is down')).toBe('Host <IP_ADDRESS_1> is down');
  });

  it('masks a Dutch postcode', async () => {
    expect(anonymize('Op 1234 AB woont zij')).toBe('Op <POSTCODE_1> woont zij');
    expect(anonymize('Op 1234AB woont zij')).toBe('Op <POSTCODE_1> woont zij');
  });

  /*
   * The whole family of false positives this has to survive. A privacy control
   * that mangles ordinary prose gets switched off, so these matter as much as
   * the matches above.
   */
  it.each([
    'Between 2019 and 2024 we doubled',
    'In 1990 in Rotterdam it began',
    'By 2025 as many as half',
    'Order 12345 shipped on 3 March',
    'Our KvK number is 12345678',
    'Version 3.14.159 of the library',
    'Revenue rose to 1.234.567 euro',
    'ISBN 978 0 13 235088 4 is the reference',
    'Meeting at 14:30 in room 2.04',
    'A 10-20-30 split across teams',
    'It cost 1250 euro, up from 999',
    'He is 45 with 3 children',
    'We hired 150 people and grew 12.5 percent',
  ])('leaves ordinary prose alone: %s', async (text) => {
    expect(anonymize(text)).toBe(text);
  });

  /*
   * Numbering follows the order a reader sees, which is not the order the
   * replacements are applied in — those run backwards to keep offsets valid.
   */
  it('numbers placeholders in reading order', async () => {
    expect(anonymize('first a@example.com then b@example.com')).toBe(
      'first <EMAIL_ADDRESS_1> then <EMAIL_ADDRESS_2>',
    );
  });

  it('gives one value one placeholder across the whole conversation', async () => {
    expect(anonymizeBatch(['ask a@example.com', 'a@example.com again, plus b@example.com'])).toEqual([
      'ask <EMAIL_ADDRESS_1>',
      '<EMAIL_ADDRESS_1> again, plus <EMAIL_ADDRESS_2>',
    ]);
  });

  it('matches a value that was typed differently the second time', async () => {
    expect(anonymizeBatch(['IBAN NL91 ABNA 0417 1643 00', 'IBAN NL91ABNA0417164300'])).toEqual([
      'IBAN <IBAN_1>',
      'IBAN <IBAN_1>',
    ]);
  });

  it('numbers each type on its own counter', async () => {
    expect(anonymize('a@example.com and 192.168.1.44')).toBe(
      '<EMAIL_ADDRESS_1> and <IP_ADDRESS_1>',
    );
  });

  /*
   * An IBAN's digits are also a card-shaped and phone-shaped number, so three
   * recognizers claim the same stretch. Priority has to settle it as one span,
   * or the replacement would carve the account number into pieces.
   */
  it('keeps the stronger of two overlapping matches', async () => {
    expect(anonymize('My NL91 ABNA 0417 1643 00 account')).toBe('My <IBAN_1> account');
  });

  it('handles a message that is only personal data', async () => {
    expect(anonymize('a@example.com')).toBe('<EMAIL_ADDRESS_1>');
  });

  it('leaves an empty batch and empty text alone', async () => {
    expect(anonymizeBatch([])).toEqual([]);
    expect(anonymizeBatch([''])).toEqual(['']);
  });

  /*
   * The documented gap, asserted so nobody "fixes" the docs to claim
   * otherwise. Catching this needs a model, which this deliberately has not.
   */
  it('does not catch names, which is the known limit', async () => {
    const text = 'My name is Ann Smith and I work at Acme';

    expect(anonymize(text)).toBe(text);
    expect(RECOGNIZED_TYPES).not.toContain('PERSON');
  });
});

describe('EU routing', () => {
  beforeEach(() => {
    resetModelCache();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** The two OpenRouter endpoints the resolution reads. */
  function stubOpenRouter(tags: string[], providers: unknown[] = []): void {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.includes('/providers')) return jsonResponse({ data: providers });
        if (url.includes('/endpoints')) {
          return jsonResponse({ data: { endpoints: tags.map((tag) => ({ tag })) } });
        }
        return jsonResponse({ data: [] });
      }),
    );
  }

  it('keeps the endpoints tagged with a European region', async () => {
    stubOpenRouter(['azure/eu', 'amazon-bedrock/eu-west-1', 'google-vertex/europe']);

    expect(await euProviderTags('a/b')).toEqual([
      'azure/eu',
      'amazon-bedrock/eu-west-1',
      'google-vertex/europe',
    ]);
  });

  /* "global" is the trap: it includes Europe but is not limited to it. */
  it('drops global, American and untagged endpoints', async () => {
    stubOpenRouter(['azure/global', 'azure/us', 'amazon-bedrock/us-east-1', 'anthropic']);

    expect(await euProviderTags('a/b')).toEqual([]);
  });

  it('does not mistake a quantization shard for a region', async () => {
    stubOpenRouter(['deepinfra/fp8', 'baseten/fast', 'mistral/zdr']);

    expect(await euProviderTags('a/b')).toEqual([]);
  });

  /* A provider whose every data centre is in the EEA needs no regional tag. */
  it('accepts a provider that is wholly inside the EEA', async () => {
    stubOpenRouter(
      ['nextbit/fp8', 'together'],
      [
        { slug: 'nextbit', datacenters: ['ES'] },
        { slug: 'together', datacenters: ['US'] },
      ],
    );

    expect(await euProviderTags('a/b')).toEqual(['nextbit/fp8']);
  });

  it('still finds the region shards when the provider list fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.includes('/providers')) return jsonResponse({ error: 'nope' }, 500);
        return jsonResponse({ data: { endpoints: [{ tag: 'azure/eu' }] } });
      }),
    );

    expect(await euProviderTags('a/b')).toEqual(['azure/eu']);
  });

  it('asks OpenRouter for the European catalogue, not the whole one', async () => {
    const urls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        urls.push(url);
        return jsonResponse({ data: [{ id: 'a/b', name: 'B', context_length: 1 }] });
      }),
    );

    await listModels({ region: 'eu' });

    expect(urls[0]).toContain('region=eu');
  });

  it('caches the two catalogues apart, so one does not answer for the other', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ data: [{ id: 'a/b', name: 'B', context_length: 1 }] }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await listModels({ region: 'eu' });
    await listModels({ region: 'eu' });
    await listModels();

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
