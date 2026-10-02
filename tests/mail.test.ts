import { afterEach, describe, expect, it, vi } from 'vitest';

import { loadConfig } from '../src/config.js';
import { buildMagicLinkEmail, createMailer, parseSender } from '../src/mail.js';

describe('parseSender', () => {
  it('splits a "Name <address>" pair', () => {
    expect(parseSender('AI Assistant <noreply@example.com>', 'Fallback')).toEqual({
      name: 'AI Assistant',
      email: 'noreply@example.com',
    });
  });

  it('accepts a bare address and uses the fallback name', () => {
    expect(parseSender('noreply@example.com', 'Fallback')).toEqual({
      name: 'Fallback',
      email: 'noreply@example.com',
    });
  });

  it('strips quotes around the display name', () => {
    expect(parseSender('"AI Assistant" <noreply@example.com>', 'Fallback').name).toBe('AI Assistant');
  });

  it('falls back when the display name is empty', () => {
    expect(parseSender('<noreply@example.com>', 'Fallback')).toEqual({
      name: 'Fallback',
      email: 'noreply@example.com',
    });
  });

  it('trims surrounding whitespace', () => {
    expect(parseSender('  Name <  noreply@example.com  >  ', 'Fallback').email).toBe(
      'noreply@example.com',
    );
  });
});

describe('buildMagicLinkEmail', () => {
  const link = 'https://example.com/auth/callback?token=abc123';

  it('names the assistant in the subject', () => {
    expect(buildMagicLinkEmail('Coach', link, 30).subject).toBe('Your sign-in link for Coach');
  });

  it('puts the link in both the text and the html body', () => {
    const message = buildMagicLinkEmail('Coach', link, 30);

    expect(message.text).toContain(link);
    expect(message.html).toContain(link);
  });

  it('states how long the link is valid', () => {
    expect(buildMagicLinkEmail('Coach', link, 15).text).toContain('15 minutes');
  });

  it('carries no image at all, so nothing depends on the reader allowing them', () => {
    const message = buildMagicLinkEmail('Coach', link, 30);

    expect(message.html).not.toContain('<img');
    // The wordmark stands in for the logo, as text.
    expect(message.html).toContain('Coach');
  });

  it('carries the brand colours inline, since a mail client loads no stylesheet', () => {
    const message = buildMagicLinkEmail('Coach', link, 30);

    // The forest green heading, the brown button and the off-white on it.
    expect(message.html).toContain('#2e4b36');
    expect(message.html).toContain('#4f473b');
    expect(message.html).toContain('#f7f6f3');
    expect(message.html).not.toContain('<style');
  });

  it('names the app and the link in the body', () => {
    const message = buildMagicLinkEmail('Coach', link, 30);

    expect(message.html).toContain('Sign in to Coach');
    expect(message.html).toContain(link);
  });

  it('escapes html so a crafted link cannot inject markup', () => {
    const hostile = 'https://example.com/?token="><script>alert(1)</script>';
    const message = buildMagicLinkEmail('Coach', hostile, 30);

    expect(message.html).not.toContain('<script>');
    expect(message.html).toContain('&lt;script&gt;');
  });
});

/** Everything loadConfig insists on, so a case can vary only the mail part. */
function env(extra: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return {
    ADMIN_EMAILS: 'admin@example.com',
    ADMIN_PASSWORD: 'a-long-enough-password',
    DATABASE_URL: 'postgres://localhost/test',
    OPENROUTER_API_KEY: 'sk-or-test',
    EMAIL_ENCRYPTION_KEY: 'x'.repeat(32),
    ...extra,
  } as NodeJS.ProcessEnv;
}

describe('choosing a mail provider', () => {
  it('needs no MAIL_PROVIDER when only one is configured', async () => {
    expect(loadConfig(env({ BREVO_API_KEY: 'k' })).mail.provider).toBe('brevo');
    expect(
      loadConfig(env({ MAILJET_API_KEY: 'k', MAILJET_SECRET_KEY: 's' })).mail.provider,
    ).toBe('mailjet');
  });

  /*
   * Refusing to start is the point: picking one silently would leave the other
   * key in the environment looking live, and "which service is actually sending
   * our sign-in links" should not be answered by reading logs.
   */
  it('refuses to start when both are configured and neither is named', async () => {
    expect(() =>
      loadConfig(env({ BREVO_API_KEY: 'k', MAILJET_API_KEY: 'k', MAILJET_SECRET_KEY: 's' })),
    ).toThrow(/set MAIL_PROVIDER/);
  });

  it('lets MAIL_PROVIDER settle it', async () => {
    const both = { BREVO_API_KEY: 'k', MAILJET_API_KEY: 'k', MAILJET_SECRET_KEY: 's' };

    expect(loadConfig(env({ ...both, MAIL_PROVIDER: 'mailjet' })).mail.provider).toBe('mailjet');
    expect(loadConfig(env({ ...both, MAIL_PROVIDER: 'brevo' })).mail.provider).toBe('brevo');
  });

  it('rejects a MAIL_PROVIDER whose credentials are missing', async () => {
    expect(() => loadConfig(env({ MAIL_PROVIDER: 'mailjet', BREVO_API_KEY: 'k' }))).toThrow(
      /MAILJET_API_KEY/,
    );
  });

  it('rejects a provider name it does not know', async () => {
    expect(() => loadConfig(env({ MAIL_PROVIDER: 'sendgrid', BREVO_API_KEY: 'k' }))).toThrow(
      /brevo \| mailjet/,
    );
  });

  /* Half a key pair is neither a working setup nor a deliberate choice. */
  it('rejects one half of the Mailjet pair', async () => {
    expect(() => loadConfig(env({ MAILJET_API_KEY: 'k' }))).toThrow(/both/);
    expect(() => loadConfig(env({ MAILJET_SECRET_KEY: 's' }))).toThrow(/both/);
  });

  it('allows no provider at all outside production, and writes to the log', async () => {
    expect(loadConfig(env()).mail.provider).toBeUndefined();
  });

  it('insists on one in production, naming both ways to supply it', async () => {
    expect(() => loadConfig(env({ NODE_ENV: 'production', ADMIN_PASSWORD: 'a-long-password' })))
      .toThrow(/BREVO_API_KEY, or MAILJET_API_KEY with MAILJET_SECRET_KEY/);
  });
});

describe('sending through each provider', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** Captures the one request a mailer makes. */
  function captureRequest(response: unknown, status = 200) {
    const calls: { url: string; init: RequestInit }[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push({ url, init });
        return new Response(JSON.stringify(response), {
          status,
          headers: { 'content-type': 'application/json' },
        });
      }),
    );
    return calls;
  }

  function config(extra: Record<string, string | undefined>) {
    return loadConfig(env({ MAIL_FROM: 'Coach <noreply@example.com>', ...extra }));
  }

  it('posts to Brevo with its own key header', async () => {
    const calls = captureRequest({ messageId: '1' });
    await createMailer(config({ BREVO_API_KEY: 'brevo-key' })).sendMagicLink(
      'user@example.com',
      'https://example.com/a',
      30,
    );

    expect(calls[0]?.url).toBe('https://api.brevo.com/v3/smtp/email');
    expect((calls[0]?.init.headers as Record<string, string>)['api-key']).toBe('brevo-key');
    expect(JSON.parse(String(calls[0]?.init.body)).to).toEqual([{ email: 'user@example.com' }]);
  });

  /* Mailjet authenticates with the key pair as HTTP Basic, not a custom header. */
  it('posts to Mailjet with basic auth and its own body shape', async () => {
    const calls = captureRequest({ Messages: [{ Status: 'success' }] });
    await createMailer(
      config({ MAILJET_API_KEY: 'public', MAILJET_SECRET_KEY: 'private' }),
    ).sendMagicLink('user@example.com', 'https://example.com/a', 30);

    expect(calls[0]?.url).toBe('https://api.mailjet.com/v3.1/send');
    expect((calls[0]?.init.headers as Record<string, string>).authorization).toBe(
      `Basic ${Buffer.from('public:private').toString('base64')}`,
    );

    const body = JSON.parse(String(calls[0]?.init.body));
    expect(body.Messages[0].To).toEqual([{ Email: 'user@example.com' }]);
    expect(body.Messages[0].From).toEqual({ Email: 'noreply@example.com', Name: 'Coach' });
    expect(body.Messages[0].Subject).toContain('sign-in link');
  });

  /*
   * The failure mode that a status code alone would hide: Mailjet reports a
   * refused message inside an otherwise successful response.
   */
  it('treats a Mailjet 200 with a failed message as a failure', async () => {
    captureRequest({ Messages: [{ Status: 'error', Errors: [{ ErrorMessage: 'bad sender' }] }] });

    await expect(
      createMailer(config({ MAILJET_API_KEY: 'k', MAILJET_SECRET_KEY: 's' })).sendMagicLink(
        'user@example.com',
        'https://example.com/a',
        30,
      ),
    ).rejects.toThrow(/did not send it/);
  });

  it('treats a Mailjet 200 with no messages at all as a failure', async () => {
    captureRequest({});

    await expect(
      createMailer(config({ MAILJET_API_KEY: 'k', MAILJET_SECRET_KEY: 's' })).sendMagicLink(
        'user@example.com',
        'https://example.com/a',
        30,
      ),
    ).rejects.toThrow(/did not send it/);
  });

  it('reports the provider body when either one refuses outright', async () => {
    captureRequest({ message: 'unverified sender' }, 400);

    await expect(
      createMailer(config({ BREVO_API_KEY: 'k' })).sendMagicLink(
        'user@example.com',
        'https://example.com/a',
        30,
      ),
    ).rejects.toThrow(/unverified sender/);
  });

  it('sends nothing at all when no provider is configured', async () => {
    const calls = captureRequest({});
    await createMailer(config({})).sendMagicLink('user@example.com', 'https://example.com/a', 30);

    expect(calls).toHaveLength(0);
  });
});
