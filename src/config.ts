/**
 * All configuration comes from the environment and is validated at boot.
 * A missing required variable fails the process immediately (fail fast), so
 * Railway never marks a broken deploy as "healthy".
 */

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
  readonly databasePath: string;
  /** Writable location of the knowledge base; empty = the bundled files. */
  readonly contextDir: string | undefined;
  readonly instructionsPath: string | undefined;
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
  readonly mail: {
    /**
     * Brevo's HTTP API key. When set it is used instead of SMTP — hosting
     * platforms and mail providers block SMTP ports far more often than 443.
     */
    readonly brevoApiKey: string | undefined;
    /** Empty outside production: the magic link is then written to the log. */
    readonly host: string | undefined;
    readonly port: number;
    readonly secure: boolean;
    readonly user: string | undefined;
    readonly pass: string | undefined;
    readonly from: string;
  };
}

export function loadConfig(env: Env = process.env): Config {
  const nodeEnv = optional(env, 'NODE_ENV', 'development');
  const isProduction = nodeEnv === 'production';
  const appUrl = optional(env, 'APP_URL', 'http://localhost:3000').replace(/\/+$/, '');
  const assistantName = optional(env, 'ASSISTANT_NAME', 'AI Assistant');

  const adminEmails = parseEmailList(env.ADMIN_EMAILS ?? env.ADMIN_EMAIL);
  if (adminEmails.length === 0) {
    throw new Error('Set ADMIN_EMAILS to at least one email address allowed to manage the user list');
  }

  // A way to send mail is mandatory in production — a login link must never end
  // up in a log file there. Either transport satisfies that; locally both may be
  // missing, so you can start without a mail server.
  const brevoApiKey = env.BREVO_API_KEY?.trim() || undefined;
  const smtpHost = env.SMTP_HOST?.trim() || undefined;
  if (isProduction && !brevoApiKey && !smtpHost) {
    throw new Error('Set BREVO_API_KEY or SMTP_HOST so sign-in links can be emailed');
  }

  return {
    nodeEnv,
    isProduction,
    port: integer(env, 'PORT', 3000),
    appUrl,
    assistantName,
    assistantLanguage: optional(env, 'ASSISTANT_LANGUAGE', 'English'),
    databasePath: optional(env, 'DATABASE_PATH', './data/app.db'),
    contextDir: env.CONTEXT_DIR?.trim() || undefined,
    instructionsPath: env.INSTRUCTIONS_PATH?.trim() || undefined,
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
    mail: {
      brevoApiKey,
      host: smtpHost,
      port: integer(env, 'SMTP_PORT', 587),
      secure: boolean(env, 'SMTP_SECURE', integer(env, 'SMTP_PORT', 587) === 465),
      user: env.SMTP_USER?.trim() || undefined,
      pass: env.SMTP_PASS?.trim() || undefined,
      from: optional(env, 'MAIL_FROM', `${assistantName} <noreply@localhost>`),
    },
  };
}
