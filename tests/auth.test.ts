import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { beforeEach, describe, expect, it } from 'vitest';

import { hashToken } from '../src/auth.js';
import { loadConfig } from '../src/config.js';
import { openDatabase } from '../src/db/index.js';
import { createRepo, type Repo } from '../src/db/repo.js';

function freshRepo(): Repo {
  const dir = mkdtempSync(join(tmpdir(), 'assistant-db-'));
  return createRepo(openDatabase(join(dir, 'test.db')));
}

describe('login tokens', () => {
  let repo: Repo;

  beforeEach(() => {
    repo = freshRepo();
  });

  it('exchanges a valid token for the user', () => {
    const user = repo.upsertUser('a@example.com', false);
    repo.createLoginToken(user.id, hashToken('secret'), new Date(Date.now() + 60_000));

    expect(repo.consumeLoginToken(hashToken('secret'))?.id).toBe(user.id);
  });

  it('works only once per token', () => {
    const user = repo.upsertUser('a@example.com', false);
    repo.createLoginToken(user.id, hashToken('secret'), new Date(Date.now() + 60_000));

    repo.consumeLoginToken(hashToken('secret'));
    expect(repo.consumeLoginToken(hashToken('secret'))).toBeNull();
  });

  it('rejects an expired token', () => {
    const user = repo.upsertUser('a@example.com', false);
    repo.createLoginToken(user.id, hashToken('old'), new Date(Date.now() - 60_000));

    expect(repo.consumeLoginToken(hashToken('old'))).toBeNull();
  });

  it('rejects an unknown token', () => {
    expect(repo.consumeLoginToken(hashToken('does-not-exist'))).toBeNull();
  });
});

describe('sessions', () => {
  it('finds the user for a valid session and not for an expired one', () => {
    const repo = freshRepo();
    const user = repo.upsertUser('a@example.com', false);

    repo.createSession(user.id, hashToken('active'), new Date(Date.now() + 60_000));
    repo.createSession(user.id, hashToken('expired'), new Date(Date.now() - 60_000));

    expect(repo.findUserBySessionToken(hashToken('active'))?.email).toBe('a@example.com');
    expect(repo.findUserBySessionToken(hashToken('expired'))).toBeNull();
  });

  it('invalidates the session after signing out', () => {
    const repo = freshRepo();
    const user = repo.upsertUser('a@example.com', false);
    repo.createSession(user.id, hashToken('t'), new Date(Date.now() + 60_000));

    repo.deleteSession(hashToken('t'));
    expect(repo.findUserBySessionToken(hashToken('t'))).toBeNull();
  });
});

describe('users and conversations', () => {
  it('normalizes email addresses to lower case', () => {
    const repo = freshRepo();
    repo.upsertUser('Someone@Example.COM', false);

    expect(repo.findUserByEmail('someone@example.com')).not.toBeNull();
  });

  it('keeps admin rights on a second upsert', () => {
    const repo = freshRepo();
    repo.upsertUser('boss@example.com', true);

    expect(repo.upsertUser('boss@example.com', false).isAdmin).toBe(true);
  });

  it('does not return another user\'s conversation', () => {
    const repo = freshRepo();
    const owner = repo.upsertUser('a@example.com', false);
    const other = repo.upsertUser('b@example.com', false);
    const conversation = repo.createConversation(owner.id, 'Private');

    expect(repo.findConversation(conversation.id, other.id)).toBeNull();
    expect(repo.findConversation(conversation.id, owner.id)?.title).toBe('Private');
  });

  it('keeps messages in order and removes them with the conversation', () => {
    const repo = freshRepo();
    const user = repo.upsertUser('a@example.com', false);
    const conversation = repo.createConversation(user.id, 'Test');

    repo.addMessage(conversation.id, 'user', 'Hello');
    repo.addMessage(conversation.id, 'assistant', 'Hi!');

    expect(repo.listMessages(conversation.id).map((m) => m.content)).toEqual(['Hello', 'Hi!']);

    repo.deleteConversation(conversation.id, user.id);
    expect(repo.listMessages(conversation.id)).toHaveLength(0);
  });
});

describe('loadConfig', () => {
  const base = {
    OPENROUTER_API_KEY: 'sk-or-test',
    ADMIN_EMAILS: 'Boss@Example.COM, second@example.com',
    SMTP_HOST: 'smtp.example.com',
  };

  it('normalizes and splits the admin list', () => {
    expect(loadConfig({ ...base } as NodeJS.ProcessEnv).adminEmails).toEqual([
      'boss@example.com',
      'second@example.com',
    ]);
  });

  it('fails without OPENROUTER_API_KEY', () => {
    const { OPENROUTER_API_KEY: _omitted, ...rest } = base;
    expect(() => loadConfig(rest as NodeJS.ProcessEnv)).toThrow(/OPENROUTER_API_KEY/);
  });

  it('fails without an admin', () => {
    const { ADMIN_EMAILS: _omitted, ...rest } = base;
    expect(() => loadConfig(rest as NodeJS.ProcessEnv)).toThrow(/ADMIN_EMAILS/);
  });

  it('allows a missing SMTP_HOST outside production', () => {
    const { SMTP_HOST: _omitted, ...rest } = base;
    expect(loadConfig(rest as NodeJS.ProcessEnv).mail.host).toBeUndefined();
  });

  it('requires SMTP_HOST in production, so sign-in links never end up in the log', () => {
    const { SMTP_HOST: _omitted, ...rest } = base;
    expect(() => loadConfig({ ...rest, NODE_ENV: 'production' } as NodeJS.ProcessEnv)).toThrow(/SMTP_HOST/);
  });

  it('rejects an unknown effort level', () => {
    expect(() => loadConfig({ ...base, MODEL_EFFORT: 'turbo' } as NodeJS.ProcessEnv)).toThrow(/MODEL_EFFORT/);
  });

  it('strips the trailing slash from APP_URL', () => {
    expect(loadConfig({ ...base, APP_URL: 'https://example.com/' } as NodeJS.ProcessEnv).appUrl).toBe(
      'https://example.com',
    );
  });

  it('defaults the assistant name and language, and uses the name in MAIL_FROM', () => {
    const config = loadConfig({ ...base } as NodeJS.ProcessEnv);

    expect(config.assistantName).toBe('AI Assistant');
    expect(config.assistantLanguage).toBe('English');
    expect(config.mail.from).toBe('AI Assistant <noreply@localhost>');
  });

  it('accepts a custom assistant name and language', () => {
    const config = loadConfig({
      ...base,
      ASSISTANT_NAME: 'Helpdesk Bot',
      ASSISTANT_LANGUAGE: 'German',
    } as NodeJS.ProcessEnv);

    expect(config.assistantName).toBe('Helpdesk Bot');
    expect(config.assistantLanguage).toBe('German');
  });
});
