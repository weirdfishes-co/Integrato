import { once } from 'node:events';
import type { AddressInfo } from 'node:net';

import cookieParser from 'cookie-parser';
import express from 'express';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeAll, freshRepo } from './helpers/db.js';

import { createAuth, hashToken } from '../src/auth.js';
import { loadConfig } from '../src/config.js';
import type { Repo } from '../src/db/repo.js';
import type { Mailer } from '../src/mail.js';
import { createAuthRouter } from '../src/routes/auth.js';
import { createViews } from '../src/views.js';

describe('login tokens', () => {
  let repo: Repo;

  beforeEach(async () => {
    repo = await freshRepo();
  });

  it('exchanges a valid token for the user', async () => {
    const user = await repo.upsertUser('a@example.com', false);
    await repo.createLoginToken(user.id, hashToken('secret'), new Date(Date.now() + 60_000));

    expect((await repo.consumeLoginToken(hashToken('secret')))?.id).toBe(user.id);
  });

  it('works only once per token', async () => {
    const user = await repo.upsertUser('a@example.com', false);
    await repo.createLoginToken(user.id, hashToken('secret'), new Date(Date.now() + 60_000));

    await repo.consumeLoginToken(hashToken('secret'));
    expect(await repo.consumeLoginToken(hashToken('secret'))).toBeNull();
  });

  it('rejects an expired token', async () => {
    const user = await repo.upsertUser('a@example.com', false);
    await repo.createLoginToken(user.id, hashToken('old'), new Date(Date.now() - 60_000));

    expect(await repo.consumeLoginToken(hashToken('old'))).toBeNull();
  });

  it('rejects an unknown token', async () => {
    expect(await repo.consumeLoginToken(hashToken('does-not-exist'))).toBeNull();
  });
});

describe('sessions', () => {
  it('finds the user for a valid session and not for an expired one', async () => {
    const repo = await freshRepo();
    const user = await repo.upsertUser('a@example.com', false);

    await repo.createSession(user.id, hashToken('active'), new Date(Date.now() + 60_000));
    await repo.createSession(user.id, hashToken('expired'), new Date(Date.now() - 60_000));

    expect((await repo.findUserBySessionToken(hashToken('active')))?.email).toBe('a@example.com');
    expect(await repo.findUserBySessionToken(hashToken('expired'))).toBeNull();
  });

  it('invalidates the session after signing out', async () => {
    const repo = await freshRepo();
    const user = await repo.upsertUser('a@example.com', false);
    await repo.createSession(user.id, hashToken('t'), new Date(Date.now() + 60_000));

    await repo.deleteSession(hashToken('t'));
    expect(await repo.findUserBySessionToken(hashToken('t'))).toBeNull();
  });
});

describe('users and conversations', () => {
  it('normalizes email addresses to lower case', async () => {
    const repo = await freshRepo();
    await repo.upsertUser('Someone@Example.COM', false);

    expect(await repo.findUserByEmail('someone@example.com')).not.toBeNull();
  });

  it('keeps admin rights on a second upsert', async () => {
    const repo = await freshRepo();
    await repo.upsertUser('boss@example.com', true);

    expect((await repo.upsertUser('boss@example.com', false)).isAdmin).toBe(true);
  });

  it('does not return another user\'s conversation', async () => {
    const repo = await freshRepo();
    const owner = await repo.upsertUser('a@example.com', false);
    const other = await repo.upsertUser('b@example.com', false);
    const assistant = await repo.createAssistant('a', 'A', '', 'English');
    const conversation = await repo.createConversation(owner.id, assistant.id, 'Private');

    expect(await repo.findConversation(conversation.id, other.id)).toBeNull();
    expect((await repo.findConversation(conversation.id, owner.id))?.title).toBe('Private');
  });

  it('keeps messages in order and removes them with the conversation', async () => {
    const repo = await freshRepo();
    const user = await repo.upsertUser('a@example.com', false);
    const assistant = await repo.createAssistant('a', 'A', '', 'English');
    const conversation = await repo.createConversation(user.id, assistant.id, 'Test');

    await repo.addMessage(conversation.id, 'user', 'Hello');
    await repo.addMessage(conversation.id, 'assistant', 'Hi!');

    expect((await repo.listMessages(conversation.id)).map((m) => m.content)).toEqual(['Hello', 'Hi!']);

    await repo.deleteConversation(conversation.id, user.id);
    expect(await repo.listMessages(conversation.id)).toHaveLength(0);
  });
});

describe('loadConfig', () => {
  const base = {
    DATABASE_URL: 'postgres://localhost/test',
    OPENROUTER_API_KEY: 'sk-or-test',
    ADMIN_EMAILS: 'Boss@Example.COM, second@example.com',
    ADMIN_PASSWORD: 'a-long-enough-secret',
    BREVO_API_KEY: 'xkeysib-test',
    EMAIL_ENCRYPTION_KEY: 'test-only-encryption-key-0123456789abcdef',
  };

  it('normalizes and splits the admin list', async () => {
    expect(loadConfig({ ...base } as NodeJS.ProcessEnv).adminEmails).toEqual([
      'boss@example.com',
      'second@example.com',
    ]);
  });

  it('fails without OPENROUTER_API_KEY', async () => {
    const { OPENROUTER_API_KEY: _omitted, ...rest } = base;
    expect(() => loadConfig(rest as NodeJS.ProcessEnv)).toThrow(/OPENROUTER_API_KEY/);
  });

  it('fails without an admin', async () => {
    const { ADMIN_EMAILS: _omitted, ...rest } = base;
    expect(() => loadConfig(rest as NodeJS.ProcessEnv)).toThrow(/ADMIN_EMAILS/);
  });

  it('fails without an admin password, which would lock everyone out of /admin', async () => {
    const { ADMIN_PASSWORD: _omitted, ...rest } = base;
    expect(() => loadConfig(rest as NodeJS.ProcessEnv)).toThrow(/ADMIN_PASSWORD/);
  });

  it('allows a short admin password outside production', async () => {
    expect(loadConfig({ ...base, ADMIN_PASSWORD: 'short' } as NodeJS.ProcessEnv).adminPassword).toBe('short');
  });

  it('requires a long admin password in production', async () => {
    expect(() =>
      loadConfig({ ...base, ADMIN_PASSWORD: 'short', NODE_ENV: 'production' } as NodeJS.ProcessEnv),
    ).toThrow(/ADMIN_PASSWORD/);
  });

  it('allows a missing BREVO_API_KEY outside production, so the link goes to the log', async () => {
    const { BREVO_API_KEY: _omitted, ...rest } = base;
    expect(loadConfig(rest as NodeJS.ProcessEnv).mail.brevoApiKey).toBeUndefined();
  });

  it('requires BREVO_API_KEY in production, so sign-in links never end up in the log', async () => {
    const { BREVO_API_KEY: _omitted, ...rest } = base;
    expect(() => loadConfig({ ...rest, NODE_ENV: 'production' } as NodeJS.ProcessEnv)).toThrow(
      /BREVO_API_KEY/,
    );
  });

  it('rejects an unknown effort level', async () => {
    expect(() => loadConfig({ ...base, MODEL_EFFORT: 'turbo' } as NodeJS.ProcessEnv)).toThrow(/MODEL_EFFORT/);
  });

  it('strips the trailing slash from APP_URL', async () => {
    expect(loadConfig({ ...base, APP_URL: 'https://example.com/' } as NodeJS.ProcessEnv).appUrl).toBe(
      'https://example.com',
    );
  });

  it('defaults the assistant name and language, and uses the name in MAIL_FROM', async () => {
    const config = loadConfig({ ...base } as NodeJS.ProcessEnv);

    expect(config.assistantName).toBe('Unlimited Brain');
    expect(config.assistantLanguage).toBe('English');
    expect(config.mail.from).toBe('Unlimited Brain <noreply@localhost>');
  });

  it('accepts a custom assistant name and language', async () => {
    const config = loadConfig({
      ...base,
      ASSISTANT_NAME: 'Helpdesk Bot',
      ASSISTANT_LANGUAGE: 'German',
    } as NodeJS.ProcessEnv);

    expect(config.assistantName).toBe('Helpdesk Bot');
    expect(config.assistantLanguage).toBe('German');
  });
});

describe('loadConfig: email encryption key', () => {
  const env = {
    DATABASE_URL: 'postgres://localhost/test',
    OPENROUTER_API_KEY: 'sk-or-test',
    ADMIN_EMAILS: 'boss@example.com',
    ADMIN_PASSWORD: 'a-long-enough-secret',
  };

  it('is required', async () => {
    expect(() => loadConfig(env as NodeJS.ProcessEnv)).toThrow(/EMAIL_ENCRYPTION_KEY/);
  });

  it('must be long enough to mean something', async () => {
    expect(() => loadConfig({ ...env, EMAIL_ENCRYPTION_KEY: 'short' } as NodeJS.ProcessEnv)).toThrow(
      /EMAIL_ENCRYPTION_KEY/,
    );
  });
});

describe('admin password sign-in', () => {
  const env = {
    DATABASE_URL: 'postgres://localhost/test',
    OPENROUTER_API_KEY: 'sk-or-test',
    ADMIN_EMAILS: 'boss@example.com',
    ADMIN_PASSWORD: 'correct horse battery',
    BREVO_API_KEY: 'xkeysib-test',
    EMAIL_ENCRYPTION_KEY: 'test-only-encryption-key-0123456789abcdef',
  } as NodeJS.ProcessEnv;

  let repo: Repo;
  let sent: string[];
  let base: string;
  let close: () => Promise<void>;

  /** The auth router on a real port, so the branches are exercised end to end. */
  beforeEach(async () => {
    repo = await freshRepo();
    sent = [];

    const config = loadConfig(env);
    const auth = createAuth(config, repo);
    const views = createViews({ assistantName: 'Test', assistantLanguage: 'English' });
    const mailer: Mailer = {
      async sendMagicLink(to) {
        sent.push(to);
      },
    };

    const app = express();
    app.use(express.urlencoded({ extended: false }));
    app.use(cookieParser());
    app.use(createAuthRouter({ config, repo, auth, mailer, views }));

    const server = app.listen(0);
    await once(server, 'listening');
    const address = server.address() as AddressInfo;
    base = `http://127.0.0.1:${address.port}`;
    close = () => new Promise((resolve) => server.close(() => resolve()));
  });

  afterEach(async () => {
    await close();
  });

  function login(email: string, password?: string): Promise<Response> {
    const body = new URLSearchParams({ email });
    if (password !== undefined) body.set('password', password);
    return fetch(`${base}/login`, {
      method: 'POST',
      body,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      redirect: 'manual',
    });
  }

  it('signs an admin in on the right password, without sending mail', async () => {
    await repo.upsertUser('boss@example.com', true);

    const response = await login('boss@example.com', 'correct horse battery');

    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('/');
    expect(response.headers.get('set-cookie')).toMatch(/^session=/);
    expect(sent).toEqual([]);
  });

  it('refuses an admin with the wrong password', async () => {
    await repo.upsertUser('boss@example.com', true);

    const response = await login('boss@example.com', 'guess');

    expect(response.status).toBe(401);
    expect(response.headers.get('set-cookie')).toBeNull();
    expect(sent).toEqual([]);
  });

  it('never lets a non-admin in with the admin password', async () => {
    await repo.upsertUser('user@example.com', false);

    const response = await login('user@example.com', 'correct horse battery');

    expect(response.status).toBe(401);
    expect(response.headers.get('set-cookie')).toBeNull();
    // No link either: a password attempt is never silently downgraded to one.
    expect(sent).toEqual([]);
  });

  it('answers a wrong password and an unknown address identically, so probing reveals nothing', async () => {
    await repo.upsertUser('boss@example.com', true);

    const wrong = await login('boss@example.com', 'guess');
    const unknown = await login('nobody@example.com', 'guess');

    // Apart from the address echoed back into the form — which whoever typed it
    // already knows — the two responses have to be indistinguishable.
    const strip = (html: string) => html.replaceAll(/value="[^"]*"/g, 'value=""');

    expect(unknown.status).toBe(wrong.status);
    expect(strip(await unknown.text())).toBe(strip(await wrong.text()));
  });

  it('still emails a link to a non-admin who leaves the password empty', async () => {
    await repo.upsertUser('user@example.com', false);

    const response = await login('user@example.com', '');

    expect(response.status).toBe(200);
    expect(sent).toEqual(['user@example.com']);
  });

  it('tells an admin with an empty password to use it, rather than mailing a link', async () => {
    await repo.upsertUser('boss@example.com', true);

    const response = await login('boss@example.com', '');

    expect(response.status).toBe(400);
    expect(await response.text()).toContain('Administrators sign in with the password');
    expect(sent).toEqual([]);
  });

  it('rate-limits password guessing', async () => {
    await repo.upsertUser('boss@example.com', true);

    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect((await login('boss@example.com', 'guess')).status).toBe(401);
    }
    // The sixth is refused before the password is even looked at.
    expect((await login('boss@example.com', 'correct horse battery')).status).toBe(429);
  });
});

describe('verifyAdminPassword', () => {
  const config = loadConfig({
    DATABASE_URL: 'postgres://localhost/test',
    OPENROUTER_API_KEY: 'sk-or-test',
    ADMIN_EMAILS: 'boss@example.com',
    ADMIN_PASSWORD: 'a-long-enough-secret',
    EMAIL_ENCRYPTION_KEY: 'test-only-encryption-key-0123456789abcdef',
  } as NodeJS.ProcessEnv);

  it('accepts the configured password', async () => {
    const auth = createAuth(config, await freshRepo());
    expect(auth.verifyAdminPassword('a-long-enough-secret')).toBe(true);
  });

  it('rejects a wrong, empty, longer or shorter password', async () => {
    const auth = createAuth(config, await freshRepo());

    expect(auth.verifyAdminPassword('wrong')).toBe(false);
    expect(auth.verifyAdminPassword('')).toBe(false);
    expect(auth.verifyAdminPassword('a-long-enough-secret ')).toBe(false);
    expect(auth.verifyAdminPassword('a-long-enough-secre')).toBe(false);
  });
});

afterAll(closeAll);
