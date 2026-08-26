import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { beforeEach, describe, expect, it } from 'vitest';

import { assistantPaths, isValidSlug, slugify, uniqueSlug, AssistantError } from '../src/assistants.js';
import type { Config } from '../src/config.js';
import { openDatabase } from '../src/db/index.js';
import { createRepo, type Repo } from '../src/db/repo.js';

function freshRepo(): Repo {
  const dir = mkdtempSync(join(tmpdir(), 'assistant-multi-'));
  return createRepo(openDatabase(join(dir, 'test.db')));
}

const config = { assistantsDir: '/data/assistants' } as Config;

describe('slugify', () => {
  it('lowercases and hyphenates a display name', () => {
    expect(slugify('Coach Suzy')).toBe('coach-suzy');
  });

  it('strips punctuation and collapses separators', () => {
    expect(slugify('HR  &  Legal!!')).toBe('hr-legal');
  });

  it('returns an empty string when nothing usable is left', () => {
    expect(slugify('***')).toBe('');
  });
});

describe('uniqueSlug', () => {
  it('keeps a free slug as it is', () => {
    expect(uniqueSlug('coach', () => false)).toBe('coach');
  });

  it('appends a number when the slug is taken', () => {
    const taken = new Set(['coach', 'coach-2']);
    expect(uniqueSlug('coach', (slug) => taken.has(slug))).toBe('coach-3');
  });

  it('falls back to a generic name for an empty slug', () => {
    expect(uniqueSlug('', () => false)).toBe('assistant');
  });
});

describe('assistantPaths', () => {
  it('puts each assistant in its own directory', () => {
    const paths = assistantPaths(config, 'coach');

    expect(paths.instructionsPath).toBe('/data/assistants/coach/instr.md');
    expect(paths.contextDir).toBe('/data/assistants/coach/context');
  });

  it('refuses a slug that would escape the root', () => {
    expect(() => assistantPaths(config, '../../etc')).toThrow(AssistantError);
  });

  it('refuses slugs outside the allowed character range', () => {
    expect(isValidSlug('coach suzy')).toBe(false);
    expect(isValidSlug('Coach')).toBe(false);
    expect(isValidSlug('coach-suzy')).toBe(true);
  });
});

describe('the rights matrix', () => {
  let repo: Repo;

  beforeEach(() => {
    repo = freshRepo();
  });

  it('hides an assistant a user was not granted', () => {
    const coach = repo.createAssistant('coach', 'Coach', '', 'English');
    const user = repo.upsertUser('a@example.com', false);

    expect(repo.canUseAssistant(user.id, false, coach.id)).toBe(false);
    expect(repo.listAssistantsForUser(user.id, false)).toHaveLength(0);
  });

  it('shows an assistant once access is granted', () => {
    const coach = repo.createAssistant('coach', 'Coach', '', 'English');
    const user = repo.upsertUser('a@example.com', false);
    repo.grantAssistant(coach.id, user.id);

    expect(repo.canUseAssistant(user.id, false, coach.id)).toBe(true);
    expect(repo.listAssistantsForUser(user.id, false).map((a) => a.slug)).toEqual(['coach']);
  });

  it('lets an admin use every assistant without a grant', () => {
    repo.createAssistant('coach', 'Coach', '', 'English');
    const second = repo.createAssistant('hr', 'HR', '', 'English');
    const admin = repo.upsertUser('admin@example.com', true);

    expect(repo.canUseAssistant(admin.id, true, second.id)).toBe(true);
    expect(repo.listAssistantsForUser(admin.id, true)).toHaveLength(2);
  });

  it('revokes access again', () => {
    const coach = repo.createAssistant('coach', 'Coach', '', 'English');
    const user = repo.upsertUser('a@example.com', false);
    repo.grantAssistant(coach.id, user.id);
    repo.revokeAssistant(coach.id, user.id);

    expect(repo.canUseAssistant(user.id, false, coach.id)).toBe(false);
  });

  it('replaces the whole grant list at once', () => {
    const coach = repo.createAssistant('coach', 'Coach', '', 'English');
    const alice = repo.upsertUser('alice@example.com', false);
    const bob = repo.upsertUser('bob@example.com', false);
    repo.grantAssistant(coach.id, alice.id);

    repo.setAssistantUsers(coach.id, [bob.id]);

    expect(repo.listGrantedUserIds(coach.id)).toEqual([bob.id]);
  });
});

describe('per-assistant isolation', () => {
  let repo: Repo;

  beforeEach(() => {
    repo = freshRepo();
  });

  it('keeps conversations of one assistant out of another', () => {
    const coach = repo.createAssistant('coach', 'Coach', '', 'English');
    const hr = repo.createAssistant('hr', 'HR', '', 'English');
    const user = repo.upsertUser('a@example.com', false);
    repo.createConversation(user.id, coach.id, 'With the coach');

    expect(repo.listConversations(user.id, coach.id)).toHaveLength(1);
    expect(repo.listConversations(user.id, hr.id)).toHaveLength(0);
  });

  it('keeps remembered facts out of another assistant', () => {
    const coach = repo.createAssistant('coach', 'Coach', '', 'English');
    const hr = repo.createAssistant('hr', 'HR', '', 'English');
    const user = repo.upsertUser('a@example.com', false);
    repo.addMemory(user.id, coach.id, 'Wants to lead a team.');

    expect(repo.listMemories(user.id, coach.id, 10)).toHaveLength(1);
    expect(repo.listMemories(user.id, hr.id, 10)).toHaveLength(0);
  });

  it('keeps settings separate', () => {
    const coach = repo.createAssistant('coach', 'Coach', '', 'English');
    const hr = repo.createAssistant('hr', 'HR', '', 'English');
    repo.setSetting(coach.id, 'model', 'openai/gpt-5');

    expect(repo.getSetting(coach.id, 'model')).toBe('openai/gpt-5');
    expect(repo.getSetting(hr.id, 'model')).toBeNull();
  });

  it('removes an assistant with everything hanging off it', () => {
    const coach = repo.createAssistant('coach', 'Coach', '', 'English');
    const user = repo.upsertUser('a@example.com', false);
    repo.grantAssistant(coach.id, user.id);
    const conversation = repo.createConversation(user.id, coach.id, 'Doomed');
    repo.addMemory(user.id, coach.id, 'Something.');

    repo.deleteAssistant(coach.id);

    expect(repo.findAssistantById(coach.id)).toBeNull();
    expect(repo.findConversation(conversation.id, user.id)).toBeNull();
    expect(repo.listMemories(user.id, coach.id, 10)).toHaveLength(0);
    expect(repo.listGrantedUserIds(coach.id)).toHaveLength(0);
  });
});
