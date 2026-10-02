/**
 * All configuration comes from the environment and is validated at boot.
 * A missing required variable fails the process immediately (fail fast), so
 * Railway never marks a broken deploy as "healthy".
 */

import { MIN_ENCRYPTION_SECRET } from './crypto.js';

type Env = NodeJS.ProcessEnv;

function required(env: Env, key: string): string {
  const value = env[key]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
}

function optional(env: Env, key: string, fallback: string): string {
  const value = env[key]?.trim();
  return value ? value : fallback;
}

function integer(env: Env, key: string, fallback: number): number {
  const raw = env[key]?.trim();
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Environment variable ${key} must be an integer, got: ${raw}`);
  }
  return parsed;
}

function boolean(env: Env, key: string, fallback: boolean): boolean {
  const raw = env[key]?.trim().toLowerCase();
  if (!raw) return fallback;
  return raw === 'true' || raw === '1' || raw === 'yes';
}

/** Splits a comma-separated list of email addresses and normalizes them. */
export function parseEmailList(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((entry) => normalizeEmail(entry))
    .filter((entry) => entry.length > 0);
}

export function normalizeEmail(input: string): string {
  return input.trim().toLowerCase();
}

/** Only enforced in production; see loadConfig. */
export const MIN_ADMIN_PASSWORD = 12;

/**
 * The transactional-mail APIs the app can speak. Both run over 443, which is
 * the only reason either works here — see the SMTP note in CLAUDE.md.
 */
export const MAIL_PROVIDERS = ['brevo', 'mailjet'] as const;
export type MailProvider = (typeof MAIL_PROVIDERS)[number];

export const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type Effort = (typeof EFFORT_LEVELS)[number];

function effort(env: Env, key: string, fallback: Effort): Effort {
  const raw = env[key]?.trim().toLowerCase();
  if (!raw) return fallback;
  const match = EFFORT_LEVELS.find((level) => level === raw);
  if (!match) {
    throw new Error(`${key} must be one of ${EFFORT_LEVELS.join(' | ')}, got: ${raw}`);
  }
  return match;
}

export interface Config {
  readonly nodeEnv: string;
  readonly isProduction: boolean;
  readonly port: number;
  readonly appUrl: string;
  /** Shown in the interface and in the login email. */
  readonly assistantName: string;
  /** Language the assistant answers in, regardless of what the user writes. */
  readonly assistantLanguage: string;
  readonly databaseUrl: string;
  /** Writable location of the knowledge base; empty = the bundled files. */
  /** Root under which each assistant gets its own knowledge-base directory. */
  readonly assistantsDir: string;
  readonly logLevel: string;
  readonly openRouterApiKey: string;
  /** Fallback model; an admin can override it at runtime on /admin. */
  readonly defaultModel: string;
  readonly effort: Effort;
  readonly maxTokens: number;
  /** Optional attribution headers shown on openrouter.ai. */
  readonly siteUrl: string | undefined;
  readonly siteName: string;
  readonly adminEmails: readonly string[];
  readonly sessionDays: number;
  readonly loginTokenMinutes: number;
  /**
   * Shared password for the addresses in adminEmails. Admins sign in with it
   * instead of a magic link; everyone else still gets a link by email.
   */
  readonly adminPassword: string;
  /**
   * Secret that user email addresses are encrypted with at rest. Losing it
   * loses every address, and changing it makes the stored ones unreadable, so
   * it is required and not derived from anything else.
   */
  readonly emailEncryptionKey: string;
  readonly mail: {
    /**
     * Which API sends the sign-in links. Undefined means none is configured,
     * which is allowed outside production: the link is written to the log
     * instead, so a fresh install needs no mail account at all.
     */
    readonly provider: MailProvider | undefined;
    readonly brevoApiKey: string | undefined;
    /** Mailjet authenticates with a pair; one without the other is a mistake. */
    readonly mailjet: { readonly apiKey: string; readonly secretKey: string } | undefined;
    readonly from: string;
  };

}

/**
 * Mailjet needs both halves of its key pair. Half of one is not a working
 * configuration and not a deliberate choice either, so it fails at boot rather
 * than at the first sign-in attempt.
 */
function mailjetCredentials(env: Env): { apiKey: string; secretKey: string } | undefined {
  const apiKey = env.MAILJET_API_KEY?.trim() || undefined;
  const secretKey = env.MAILJET_SECRET_KEY?.trim() || undefined;

  if (apiKey && secretKey) return { apiKey, secretKey };
  if (apiKey || secretKey) {
    throw new Error(
      'Mailjet needs both MAILJET_API_KEY and MAILJET_SECRET_KEY; only one of them is set',
    );
  }
  return undefined;
}

/**
 * Which provider sends the mail.
 *
 * With one configured, that is the answer and `MAIL_PROVIDER` is not needed.
 * With both, the app refuses to start: picking one silently would leave the
 * other key sitting in the environment looking live, and "which service is
 * actually sending our sign-in links" is not a question anyone should have to
 * answer by reading logs.
 */
function chooseMailProvider(env: Env, hasBrevo: boolean, hasMailjet: boolean): MailProvider | undefined {
  const requested = env.MAIL_PROVIDER?.trim().toLowerCase();

  if (requested) {
    const match = MAIL_PROVIDERS.find((provider) => provider === requested);
    if (!match) {
      throw new Error(`MAIL_PROVIDER must be one of ${MAIL_PROVIDERS.join(' | ')}, got: ${requested}`);
    }
    if (match === 'brevo' && !hasBrevo) {
      throw new Error('MAIL_PROVIDER=brevo, but BREVO_API_KEY is not set');
    }
    if (match === 'mailjet' && !hasMailjet) {
      throw new Error('MAIL_PROVIDER=mailjet, but MAILJET_API_KEY and MAILJET_SECRET_KEY are not set');
    }
    return match;
  }

  if (hasBrevo && hasMailjet) {
    throw new Error(
      'Both Brevo and Mailjet are configured — set MAIL_PROVIDER to brevo or mailjet to say which one sends the mail',
    );
  }
  if (hasBrevo) return 'brevo';
  if (hasMailjet) return 'mailjet';
  return undefined;
}

export function loadConfig(env: Env = process.env): Config {
  const nodeEnv = optional(env, 'NODE_ENV', 'development');
  const isProduction = nodeEnv === 'production';
  const appUrl = optional(env, 'APP_URL', 'http://localhost:3000').replace(/\/+$/, '');
  const assistantName = optional(env, 'ASSISTANT_NAME', 'Integrato');

  const adminEmails = parseEmailList(env.ADMIN_EMAILS ?? env.ADMIN_EMAIL);
  if (adminEmails.length === 0) {
    throw new Error('Set ADMIN_EMAILS to at least one email address allowed to manage the user list');
  }

  // Mandatory in production — a sign-in link must never end up in a log file
  // there. Locally it may be missing, so you can start without a mail account.
  const brevoApiKey = env.BREVO_API_KEY?.trim() || undefined;
  const mailjet = mailjetCredentials(env);
  const mailProvider = chooseMailProvider(env, brevoApiKey !== undefined, mailjet !== undefined);
  if (isProduction && !mailProvider) {
    throw new Error(
      'Configure a mail provider so sign-in links can be emailed: set BREVO_API_KEY, or MAILJET_API_KEY with MAILJET_SECRET_KEY',
    );
  }

  // Admins have no other way in, so an empty value locks the app's own owner
  // out of /admin — hence required rather than optional. The length floor only
  // binds in production: a short password is a fair trade for a local database
  // full of test data, but not for a public deployment.
  const adminPassword = required(env, 'ADMIN_PASSWORD');
  if (isProduction && adminPassword.length < MIN_ADMIN_PASSWORD) {
    throw new Error(
      `ADMIN_PASSWORD must be at least ${MIN_ADMIN_PASSWORD} characters — it is the only lock on /admin`,
    );
  }

  const emailEncryptionKey = required(env, 'EMAIL_ENCRYPTION_KEY');
  if (emailEncryptionKey.length < MIN_ENCRYPTION_SECRET) {
    throw new Error(
      `EMAIL_ENCRYPTION_KEY must be at least ${MIN_ENCRYPTION_SECRET} characters (generate one with: openssl rand -base64 32)`,
    );
  }

  return {
    nodeEnv,
    isProduction,
    port: integer(env, 'PORT', 3000),
    appUrl,
    assistantName,
    assistantLanguage: optional(env, 'ASSISTANT_LANGUAGE', 'English'),
    databaseUrl: required(env, 'DATABASE_URL'),
    assistantsDir: optional(env, 'ASSISTANTS_DIR', './data/assistants'),
    logLevel: optional(env, 'LOG_LEVEL', 'info'),
    openRouterApiKey: required(env, 'OPENROUTER_API_KEY'),
    defaultModel: optional(env, 'OPENROUTER_MODEL', 'anthropic/claude-opus-5'),
    effort: effort(env, 'MODEL_EFFORT', 'high'),
    maxTokens: integer(env, 'MODEL_MAX_TOKENS', 8000),
    siteUrl: env.OPENROUTER_SITE_URL?.trim() || undefined,
    siteName: optional(env, 'OPENROUTER_SITE_NAME', assistantName),
    adminEmails,
    sessionDays: integer(env, 'SESSION_DAYS', 30),
    loginTokenMinutes: integer(env, 'LOGIN_TOKEN_MINUTES', 30),
    adminPassword,
    emailEncryptionKey,
    mail: {
      provider: mailProvider,
      brevoApiKey,
      mailjet,
      from: optional(env, 'MAIL_FROM', `${assistantName} <noreply@localhost>`),
    },
  };
}
