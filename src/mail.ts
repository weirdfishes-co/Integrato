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

/**
 * Brand tokens from STYLE.md. Repeated as literals rather than read from
 * the stylesheet because an email carries its own styling inline — no client
 * fetches a stylesheet, and many strip <style> blocks entirely.
 */
const BRAND = {
  primary: '#0c4466',
  paper: '#f9f9f9',
  gray: '#f3f3f3',
  border: '#efefef',
  text: '#1c1c1c',
  muted: '#55565a',
} as const;

/** Web fonts do not load in mail clients, so these are only the fallbacks. */
const BODY_FONT = "Lato, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";
const HEADING_FONT = "Montserrat, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";

/**
 * The email itself; exported so tests can check it without sending.
 *
 * There is no image in it at all: the wordmark is text, so nothing depends on
 * the reader allowing images — which most clients block by default — and there
 * is no absolute URL to get wrong.
 */
export function buildMagicLinkEmail(appName: string, link: string, minutesValid: number): Message {
  const safeLink = escapeHtml(link);
  const safeName = escapeHtml(appName);

  const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Sign in to ${safeName}</title>
  </head>
  <body style="margin:0;padding:0;background:${BRAND.gray};font-family:${BODY_FONT};color:${BRAND.text};-webkit-font-smoothing:antialiased;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${BRAND.gray};">
      <tr>
        <td align="center" style="padding:32px 16px;">

          <table role="presentation" width="560" cellpadding="0" cellspacing="0" border="0"
                 style="width:100%;max-width:560px;background:#ffffff;border:1px solid ${BRAND.border};">

            <tr>
              <td align="left" style="padding:28px 32px 0;">
                <p style="margin:0;font-family:${HEADING_FONT};font-size:14px;line-height:20px;font-weight:700;letter-spacing:0.06em;text-transform:uppercase;color:${BRAND.muted};">
                  ${safeName}
                </p>
              </td>
            </tr>

            <tr>
              <td style="padding:24px 32px 0;">
                <h1 style="margin:0;font-family:${HEADING_FONT};font-size:22px;line-height:30px;font-weight:600;color:${BRAND.primary};">
                  Sign in to ${safeName}
                </h1>
              </td>
            </tr>

            <tr>
              <td style="padding:12px 32px 0;">
                <p style="margin:0;font-size:16px;line-height:26px;color:${BRAND.text};">
                  Use the button below to sign in. The link is valid for ${minutesValid} minutes and works once.
                </p>
              </td>
            </tr>

            <tr>
              <td style="padding:24px 32px 0;">
                <table role="presentation" cellpadding="0" cellspacing="0" border="0">
                  <tr>
                    <td style="background:${BRAND.primary};border:1px solid ${BRAND.primary};">
                      <a href="${safeLink}"
                         style="display:inline-block;padding:10px 16px;font-size:16px;font-weight:700;text-decoration:none;color:${BRAND.paper};">
                        Sign in
                      </a>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>

            <tr>
              <td style="padding:24px 32px 0;">
                <p style="margin:0;font-size:13px;line-height:22px;color:${BRAND.muted};">
                  Button not working? Copy this link into your browser:<br>
                  <span style="word-break:break-all;color:${BRAND.muted};">${safeLink}</span>
                </p>
              </td>
            </tr>

            <tr>
              <td style="padding:24px 32px 32px;">
                <div style="border-top:1px solid ${BRAND.border};padding-top:16px;">
                  <p style="margin:0;font-size:13px;line-height:22px;color:${BRAND.muted};">
                    Did not request a sign-in link yourself? You can safely ignore this email.
                  </p>
                </div>
              </td>
            </tr>

          </table>

          <p style="margin:16px 0 0;font-size:12px;line-height:20px;color:${BRAND.muted};font-family:${BODY_FONT};">
            ${safeName}
          </p>

        </td>
      </tr>
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
    '',
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
