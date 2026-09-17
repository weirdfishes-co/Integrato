import { describe, expect, it } from 'vitest';

import { buildMagicLinkEmail, parseSender } from '../src/mail.js';

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
  const APP_URL = 'https://coach.example.com';

  it('names the assistant in the subject', () => {
    expect(buildMagicLinkEmail('Coach', APP_URL, link, 30).subject).toBe('Your sign-in link for Coach');
  });

  it('puts the link in both the text and the html body', () => {
    const message = buildMagicLinkEmail('Coach', APP_URL, link, 30);

    expect(message.text).toContain(link);
    expect(message.html).toContain(link);
  });

  it('states how long the link is valid', () => {
    expect(buildMagicLinkEmail('Coach', APP_URL, link, 15).text).toContain('15 minutes');
  });

  it('points the logo at an absolute url, since a mail client cannot resolve a relative one', () => {
    const message = buildMagicLinkEmail('Coach', APP_URL, link, 30);

    expect(message.html).toContain(`${APP_URL}/header_ny.jpg`);
    expect(message.html).toContain('alt="Nyenrode Business Universiteit"');
  });

  it('does not double the slash when APP_URL has a trailing one', () => {
    const message = buildMagicLinkEmail('Coach', `${APP_URL}/`, link, 30);

    expect(message.html).toContain(`${APP_URL}/header_ny.jpg`);
    expect(message.html).not.toContain('//header_ny.jpg');
  });

  it('carries the brand colours inline, since a mail client loads no stylesheet', () => {
    const message = buildMagicLinkEmail('Coach', APP_URL, link, 30);

    expect(message.html).toContain('#355071');
    expect(message.html).toContain('#fbba20');
    expect(message.html).not.toContain('<style');
  });

  it('still reads with the images stripped, which most clients do by default', () => {
    const message = buildMagicLinkEmail('Coach', APP_URL, link, 30);
    const withoutImages = message.html.replace(/<img[^>]*>/g, '');

    expect(withoutImages).toContain('Sign in to Coach');
    expect(withoutImages).toContain(link);
  });

  it('escapes html so a crafted link cannot inject markup', () => {
    const hostile = 'https://example.com/?token="><script>alert(1)</script>';
    const message = buildMagicLinkEmail('Coach', APP_URL, hostile, 30);

    expect(message.html).not.toContain('<script>');
    expect(message.html).toContain('&lt;script&gt;');
  });
});
