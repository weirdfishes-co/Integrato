import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { closeAll, freshRepo } from './helpers/db.js';

import { hashToken } from '../src/auth.js';
import { loadConfig } from '../src/config.js';
import type { Repo } from '../src/db/repo.js';

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
    SMTP_HOST: 'smtp.example.com',
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

  it('allows a missing SMTP_HOST outside production', async () => {
    const { SMTP_HOST: _omitted, ...rest } = base;
    expect(loadConfig(rest as NodeJS.ProcessEnv).mail.host).toBeUndefined();
  });

  it('requires SMTP_HOST in production, so sign-in links never end up in the log', async () => {
    const { SMTP_HOST: _omitted, ...rest } = base;
    expect(() => loadConfig({ ...rest, NODE_ENV: 'production' } as NodeJS.ProcessEnv)).toThrow(/SMTP_HOST/);
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

    expect(config.assistantName).toBe('AI Assistant');
    expect(config.assistantLanguage).toBe('English');
    expect(config.mail.from).toBe('AI Assistant <noreply@localhost>');
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

afterAll(closeAll);
