import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Config } from '../src/config.js';
import { euProviderTags, listModels, resetModelCache } from '../src/models.js';
import { createAnonymizer, AnonymizationError } from '../src/presidio.js';

const config = {
  presidio: { url: 'http://presidio:3000', language: 'en', scoreThreshold: 0.5 },
} as Config;

/** One analyzer result, in the shape Presidio returns them. */
function span(type: string, start: number, end: number, score = 0.9) {
  return { entity_type: type, start, end, score };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('the anonymizer', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** Answers every analyze call with spans computed from the text itself. */
  function stubAnalyzer(spansFor: (text: string) => unknown[]): ReturnType<typeof vi.fn> {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { text: string };
      return jsonResponse(spansFor(body.text));
    });
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  it('replaces what the analyzer found', async () => {
    const text = 'Call Ann today';
    stubAnalyzer(() => [span('PERSON', text.indexOf('Ann'), text.indexOf('Ann') + 3)]);

    expect(await createAnonymizer(config).anonymizeBatch([text])).toEqual(['Call <PERSON_1> today']);
  });

  /*
   * The whole point of doing the substitution ourselves: one value keeps one
   * placeholder, so the model can still follow who is who.
   */
  it('gives one person one placeholder and two people two', async () => {
    const text = 'Ann met Bob, then Ann left';
    stubAnalyzer(() => [
      span('PERSON', 0, 3),
      span('PERSON', 8, 11),
      span('PERSON', 18, 21),
    ]);

    expect(await createAnonymizer(config).anonymizeBatch([text])).toEqual([
      '<PERSON_1> met <PERSON_2>, then <PERSON_1> left',
    ]);
  });

  it('numbers by type, so a name and an email do not share a counter', async () => {
    const text = 'Ann at ann@x.com';
    stubAnalyzer(() => [span('PERSON', 0, 3), span('EMAIL_ADDRESS', 7, 16)]);

    expect(await createAnonymizer(config).anonymizeBatch([text])).toEqual([
      '<PERSON_1> at <EMAIL_ADDRESS_1>',
    ]);
  });

  /*
   * A conversation is analyzed in one call, so one name keeps one placeholder
   * across the turns — and each message still comes back on its own.
   */
  it('analyzes a whole conversation in a single call and keeps the turns apart', async () => {
    const fetchMock = stubAnalyzer((joined) => {
      const spans = [];
      let at = joined.indexOf('Ann');
      while (at !== -1) {
        spans.push(span('PERSON', at, at + 3));
        at = joined.indexOf('Ann', at + 1);
      }
      return spans;
    });

    const result = await createAnonymizer(config).anonymizeBatch(['Ann asked', 'Ann again']);

    expect(result).toEqual(['<PERSON_1> asked', '<PERSON_1> again']);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('keeps the stronger of two overlapping matches, rather than both', async () => {
    const text = 'Ann Smith called';
    stubAnalyzer(() => [span('PERSON', 0, 9, 0.9), span('LOCATION', 4, 9, 0.6)]);

    expect(await createAnonymizer(config).anonymizeBatch([text])).toEqual(['<PERSON_1> called']);
  });

  it('leaves text alone when nothing was found', async () => {
    stubAnalyzer(() => []);

    expect(await createAnonymizer(config).anonymizeBatch(['nothing here'])).toEqual([
      'nothing here',
    ]);
  });

  /*
   * Fail closed. Every failure below would otherwise end with the original
   * text going to the model, which is the one outcome this setting exists to
   * prevent.
   */
  it('refuses to run at all when no service is configured', async () => {
    const without = { presidio: { url: undefined, language: 'en', scoreThreshold: 0.5 } } as Config;

    expect(createAnonymizer(without).configured).toBe(false);
    await expect(createAnonymizer(without).anonymizeBatch(['Ann'])).rejects.toBeInstanceOf(
      AnonymizationError,
    );
  });

  it('throws when the service answers with an error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ error: 'boom' }, 500)));

    await expect(createAnonymizer(config).anonymizeBatch(['Ann'])).rejects.toBeInstanceOf(
      AnonymizationError,
    );
  });

  it('throws when the service cannot be reached', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    }));

    await expect(createAnonymizer(config).anonymizeBatch(['Ann'])).rejects.toBeInstanceOf(
      AnonymizationError,
    );
  });

  it('throws on a body that is not a list of results', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ results: [] })));

    await expect(createAnonymizer(config).anonymizeBatch(['Ann'])).rejects.toBeInstanceOf(
      AnonymizationError,
    );
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
