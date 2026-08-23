import nodemailer, { type Transporter } from 'nodemailer';

import type { Config } from './config.js';
import { logger } from './logger.js';

export interface Mailer {
  sendMagicLink(to: string, link: string, minutesValid: number): Promise<void>;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

/**
 * Without these, a blocked outbound SMTP port (a common hosting default) leaves
 * the send hanging until the OS gives up — minutes during which the sign-in
 * request never answers and the user just watches a spinner. Failing fast turns
 * that into a visible "could not send" message instead.
 */
const CONNECTION_TIMEOUT_MS = 10_000;
const GREETING_TIMEOUT_MS = 10_000;
const SOCKET_TIMEOUT_MS = 20_000;

export function createMailer(config: Config): Mailer {
  const appName = config.assistantName;

  // Without an SMTP host (only allowed outside production) the link goes to the
  // log, so you can sign in locally without a mail server.
  if (!config.mail.host) {
    logger.warn('no SMTP_HOST configured — sign-in links are written to the log instead of emailed');
    return {
      async sendMagicLink(to, link) {
        logger.info({ to, link }, 'SIGN-IN LINK (dev mode, not emailed)');
      },
    };
  }

  const transporter: Transporter = nodemailer.createTransport({
    host: config.mail.host,
    port: config.mail.port,
    secure: config.mail.secure,
    auth: config.mail.user ? { user: config.mail.user, pass: config.mail.pass } : undefined,
    connectionTimeout: CONNECTION_TIMEOUT_MS,
    greetingTimeout: GREETING_TIMEOUT_MS,
    socketTimeout: SOCKET_TIMEOUT_MS,
  });

  if (!config.mail.user) {
    logger.warn(
      { host: config.mail.host },
      'SMTP_USER is empty — connecting to the relay without authentication',
    );
  }

  return {
    async sendMagicLink(to, link, minutesValid) {
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

      await transporter.sendMail({
        from: config.mail.from,
        to,
        subject: `Your sign-in link for ${appName}`,
        text,
        html,
      });
      logger.info({ to }, 'magic link sent');
    },
  };
}
