import type { Config } from './config.js';
import { logger } from './logger.js';

/**
 * Delivery of the sign-in link over HTTP, through Brevo or Mailjet. Which one
 * is decided in `config.ts` from what the environment holds.
 *
 * SMTP was removed: Railway could open no TCP connection to Brevo's SMTP port
 * on 587, 2525 or 465 — a connection timeout before any credential was
 * exchanged — while the same configuration worked from a laptop. Port 443 has
 * no such problem. That is also the bar a second provider has to clear, and
 * why these are the HTTP APIs and not two SMTP hosts: a transport that only
 * works in one environment is a second way to fail, not a fallback.
 *
 * With no provider configured, and outside production, the link goes to the
 * log instead so you can sign in with no mail account at all.
 */

export interface Mailer {
  sendMagicLink(to: string, link: string, minutesValid: number): Promise<void>;
}

// Both providers' own paths for transactional mail; nothing here speaks SMTP.
const BREVO_URL = 'https://api.brevo.com/v3/smtp/email';
const MAILJET_URL = 'https://api.mailjet.com/v3.1/send';
/*
 * `fetch` has no timeout of its own, and a hanging send leaves POST /login
 * with no response at all — an endless spinner rather than an error. This is
 * the same failure SMTP used to produce when its port was blocked.
 */
const SEND_TIMEOUT_MS = 15_000;

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
  /* The forest green and the brown, as the stylesheet binds them. */
  primary: '#2e4b36',
  accent: '#4f473b',
  paper: '#f7f6f3',
  gray: '#f2f4f1',
  border: '#e3e6e1',
  text: '#312e28',
  muted: '#6b6459',
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
                    <td style="background:${BRAND.accent};border:1px solid ${BRAND.accent};">
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

/**
 * One POST, shared by both providers.
 *
 * The provider's own body is included in the error on a refusal: it is where
 * the reason lives (an unverified sender, a quota, a bad key) and without it
 * the caller sees a status code and nothing to act on.
 */
async function post(
  url: string,
  headers: Record<string, string>,
  body: unknown,
  provider: string,
): Promise<unknown> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json', ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`${provider} rejected the email (${response.status}): ${detail.slice(0, 200)}`);
  }

  return response.json().catch(() => null);
}

function createBrevoMailer(config: Config, apiKey: string): Mailer {
  const appName = config.assistantName;
  const sender = parseSender(config.mail.from, appName);

  return {
    async sendMagicLink(to, link, minutesValid) {
      const message = buildMagicLinkEmail(appName, link, minutesValid);

      await post(
        BREVO_URL,
        { 'api-key': apiKey },
        {
          sender: { name: sender.name, email: sender.email },
          to: [{ email: to }],
          subject: message.subject,
          htmlContent: message.html,
          textContent: message.text,
        },
        'Brevo',
      );

      logger.info({ to, provider: 'brevo' }, 'magic link sent');
    },
  };
}

interface MailjetResponse {
  Messages?: { Status?: unknown }[];
}

function createMailjetMailer(
  config: Config,
  credentials: { apiKey: string; secretKey: string },
): Mailer {
  const appName = config.assistantName;
  const sender = parseSender(config.mail.from, appName);
  // Mailjet authenticates with the key pair as HTTP Basic, not a header of its own.
  const authorization = `Basic ${Buffer.from(`${credentials.apiKey}:${credentials.secretKey}`).toString('base64')}`;

  return {
    async sendMagicLink(to, link, minutesValid) {
      const message = buildMagicLinkEmail(appName, link, minutesValid);

      const body = (await post(
        MAILJET_URL,
        { authorization },
        {
          Messages: [
            {
              From: { Email: sender.email, Name: sender.name },
              To: [{ Email: to }],
              Subject: message.subject,
              TextPart: message.text,
              HTMLPart: message.html,
            },
          ],
        },
        'Mailjet',
      )) as MailjetResponse | null;

      /*
       * Mailjet reports a per-message outcome *inside* a 200: a refused
       * recipient is a `Status` other than "success" on an otherwise fine
       * response. Trusting the status code alone would log "magic link sent"
       * for mail that was never sent, and leave the user waiting for it.
       */
      const statuses = body?.Messages ?? [];
      const failed = statuses.filter((entry) => entry.Status !== 'success');
      if (statuses.length === 0 || failed.length > 0) {
        throw new Error(
          `Mailjet accepted the request but did not send it: ${JSON.stringify(body).slice(0, 200)}`,
        );
      }

      logger.info({ to, provider: 'mailjet' }, 'magic link sent');
    },
  };
}

export function createMailer(config: Config): Mailer {
  // The provider was resolved at boot, so there is nothing to decide here and
  // no way for the two sets of credentials to be ambiguous this far in.
  switch (config.mail.provider) {
    case 'brevo':
      logger.info('sending sign-in links through the Brevo HTTP API');
      return createBrevoMailer(config, config.mail.brevoApiKey!);
    case 'mailjet':
      logger.info('sending sign-in links through the Mailjet HTTP API');
      return createMailjetMailer(config, config.mail.mailjet!);
    default:
      logger.warn('no mail provider configured — sign-in links are written to the log');
      return {
        async sendMagicLink(to, link) {
          logger.info({ to, link }, 'SIGN-IN LINK (dev mode, not emailed)');
        },
      };
  }
}
