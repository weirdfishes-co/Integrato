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

/** A 0..1 setting, e.g. a confidence threshold. */
function ratio(env: Env, key: string, fallback: number): number {
  const raw = env[key]?.trim();
  if (!raw) return fallback;
  const parsed = Number.parseFloat(raw);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
    throw new Error(`Environment variable ${key} must be a number between 0 and 1, got: ${raw}`);
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
  readonly mail: {
    /**
     * Brevo's HTTP API key, and the only way the app sends mail. Empty outside
     * production: the magic link is then written to the log instead.
     */
    readonly brevoApiKey: string | undefined;
    readonly from: string;
  };
  /**
   * Microsoft Presidio, used to strip personal data out of user messages before
   * they leave for the model. It is a service of its own — only the analyzer is
   * needed — so without a URL the per-chatbot toggle has nothing to call and
   * refuses to run rather than sending the text unprotected.
   */
  readonly presidio: {
    readonly url: string | undefined;
    /**
     * The language the analyzer runs in. It is not the chatbot's answer
     * language: it selects the recognizers and the spaCy model, so it has to be
     * one the service actually has installed.
     */
    readonly language: string;
    /** Confidence floor; below it the analyzer starts guessing. */
    readonly scoreThreshold: number;
  };
}

export function loadConfig(env: Env = process.env): Config {
  const nodeEnv = optional(env, 'NODE_ENV', 'development');
  const isProduction = nodeEnv === 'production';
  const appUrl = optional(env, 'APP_URL', 'http://localhost:3000').replace(/\/+$/, '');
  const assistantName = optional(env, 'ASSISTANT_NAME', 'Unlimited Brain');

  const adminEmails = parseEmailList(env.ADMIN_EMAILS ?? env.ADMIN_EMAIL);
  if (adminEmails.length === 0) {
    throw new Error('Set ADMIN_EMAILS to at least one email address allowed to manage the user list');
  }

  // Mandatory in production — a sign-in link must never end up in a log file
  // there. Locally it may be missing, so you can start without a mail account.
  const brevoApiKey = env.BREVO_API_KEY?.trim() || undefined;
  if (isProduction && !brevoApiKey) {
    throw new Error('Set BREVO_API_KEY so sign-in links can be emailed');
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
    mail: {
      brevoApiKey,
      from: optional(env, 'MAIL_FROM', `${assistantName} <noreply@localhost>`),
    },
    presidio: {
      url: env.PRESIDIO_URL?.trim().replace(/\/+$/, '') || undefined,
      language: optional(env, 'PRESIDIO_LANGUAGE', 'en'),
      scoreThreshold: ratio(env, 'PRESIDIO_SCORE_THRESHOLD', 0.5),
    },
  };
}
