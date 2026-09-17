import type { Config } from './config.js';
import { logger } from './logger.js';

/**
 * Delivery of the sign-in link through Brevo's HTTP API.
 *
 * SMTP was removed: Railway could open no TCP connection to Brevo's SMTP port
 * on 587, 2525 or 465 — a connection timeout before any credential was
 * exchanged — while the same configuration worked from a laptop. Port 443 has
 * no such problem, so keeping a second transport only kept a second way to
 * fail.
 *
 * Without a key, and outside production, the link goes to the log instead so
 * you can sign in with no mail account at all.
 */

export interface Mailer {
  sendMagicLink(to: string, link: string, minutesValid: number): Promise<void>;
}

// Brevo's own path for transactional mail; nothing here speaks SMTP.
const BREVO_URL = 'https://api.brevo.com/v3/smtp/email';
const BREVO_TIMEOUT_MS = 15_000;

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

interface Sender {
  name: string | undefined;
  email: string;
}

/** Splits `Name <a@b.c>` into its parts; a bare address is also accepted. */
export function parseSender(from: string, fallbackName: string): Sender {
  const match = /^\s*(.*?)\s*<\s*([^>]+)\s*>\s*$/.exec(from);
  if (match?.[2]) {
    const name = match[1]?.replace(/^"|"$/g, '').trim();
    return { name: name && name.length > 0 ? name : fallbackName, email: match[2].trim() };
  }
  return { name: fallbackName, email: from.trim() };
}

interface Message {
  subject: string;
  html: string;
  text: string;
}

/** The email itself; exported so tests can check it without sending. */
export function buildMagicLinkEmail(appName: string, link: string, minutesValid: number): Message {
  const safeLink = escapeHtml(link);
  const safeName = escapeHtml(appName);

  const html = `<!doctype html>
<html lang="en">
  <body style="margin:0;padding:24px;background:#f5f5f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#1a1a1a;">
    <table role="presentation" style="max-width:520px;margin:0 auto;background:#ffffff;border-radius:12px;padding:32px;">
      <tr><td>
        <h1 style="margin:0 0 16px;font-size:20px;font-weight:600;">Sign in to ${safeName}</h1>
        <p style="margin:0 0 24px;line-height:1.6;color:#4a4a4a;">
          Click the button below to sign in. The link is valid for ${minutesValid} minutes and works once.
        </p>
        <p style="margin:0 0 24px;">
          <a href="${safeLink}" style="display:inline-block;background:#1a1a1a;color:#ffffff;text-decoration:none;padding:12px 20px;border-radius:8px;font-weight:500;">Sign in</a>
        </p>
        <p style="margin:0;font-size:13px;line-height:1.6;color:#767676;">
          Button not working? Copy this link into your browser:<br>
          <span style="word-break:break-all;">${safeLink}</span>
        </p>
        <p style="margin:24px 0 0;font-size:13px;color:#767676;">
          Did not request a sign-in link yourself? You can safely ignore this email.
        </p>
      </td></tr>
    </table>
  </body>
</html>`;

  const text = [
    `Sign in to ${appName}`,
    '',
    `Open this link to sign in (valid for ${minutesValid} minutes, single use):`,
    link,
    '',
    'Did not request a sign-in link yourself? You can safely ignore this email.',
  ].join('\n');

  return { subject: `Your sign-in link for ${appName}`, html, text };
}

function createBrevoMailer(config: Config, apiKey: string): Mailer {
  const appName = config.assistantName;
  const sender = parseSender(config.mail.from, appName);

  return {
    async sendMagicLink(to, link, minutesValid) {
      const message = buildMagicLinkEmail(appName, link, minutesValid);

      const response = await fetch(BREVO_URL, {
        method: 'POST',
        headers: {
          'api-key': apiKey,
          'content-type': 'application/json',
          accept: 'application/json',
        },
        body: JSON.stringify({
          sender: { name: sender.name, email: sender.email },
          to: [{ email: to }],
          subject: message.subject,
          htmlContent: message.html,
          textContent: message.text,
        }),
        signal: AbortSignal.timeout(BREVO_TIMEOUT_MS),
      });

      if (!response.ok) {
        // Brevo explains refusals in the body (unverified sender, quota, …);
        // without it the caller only sees a status code.
        const detail = await response.text().catch(() => '');
        throw new Error(`Brevo rejected the email (${response.status}): ${detail.slice(0, 200)}`);
      }

      logger.info({ to }, 'magic link sent');
    },
  };
}

export function createMailer(config: Config): Mailer {
  if (config.mail.brevoApiKey) {
    logger.info('sending sign-in links through the Brevo HTTP API');
    return createBrevoMailer(config, config.mail.brevoApiKey);
  }

  logger.warn('no BREVO_API_KEY — sign-in links are written to the log instead of emailed');
  return {
    async sendMagicLink(to, link) {
      logger.info({ to, link }, 'SIGN-IN LINK (dev mode, not emailed)');
    },
  };
}
