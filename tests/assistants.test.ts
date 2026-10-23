import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { existsSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { closeAll, freshRepo } from './helpers/db.js';

import {
  assistantPaths,
  renameAssistantSlug,
  isValidSlug,
  slugify,
  uniqueSlug,
  AssistantError,
  RESERVED_SLUGS,
} from '../src/assistants.js';
import type { Config } from '../src/config.js';
import type { Repo } from '../src/db/repo.js';

const config = { assistantsDir: '/data/assistants' } as Config;

describe('slugify', () => {
  it('lowercases and hyphenates a display name', async () => {
    expect(slugify('Coach Suzy')).toBe('coach-suzy');
  });

  it('strips punctuation and collapses separators', async () => {
    expect(slugify('HR  &  Legal!!')).toBe('hr-legal');
  });

  it('returns an empty string when nothing usable is left', async () => {
    expect(slugify('***')).toBe('');
  });
});

describe('uniqueSlug', () => {
  it('keeps a free slug as it is', async () => {
    expect(uniqueSlug('coach', () => false)).toBe('coach');
  });

  it('appends a number when the slug is taken', async () => {
    const taken = new Set(['coach', 'coach-2']);
    expect(uniqueSlug('coach', (slug) => taken.has(slug))).toBe('coach-3');
  });

  it('falls back to a generic name for an empty slug', async () => {
    expect(uniqueSlug('', () => false)).toBe('assistant');
  });

  /*
   * An assistant lives at /<slug>, so a slug that matches a fixed route would
   * leave it permanently unreachable behind that route.
   */
  it('never hands out a slug that a route already owns', async () => {
    expect(uniqueSlug('admin', () => false)).toBe('admin-2');
    expect(uniqueSlug('api', () => false)).toBe('api-2');
    expect(uniqueSlug('login', () => false)).toBe('login-2');
  });

  it('treats every reserved word as unavailable', async () => {
    for (const reserved of RESERVED_SLUGS) {
      expect(uniqueSlug(reserved, () => false)).not.toBe(reserved);
      expect(isValidSlug(reserved)).toBe(false);
    }
  });
});

describe('assistantPaths', () => {
  it('puts each assistant in its own directory', async () => {
    const paths = assistantPaths(config, 'coach');

    expect(paths.instructionsPath).toBe('/data/assistants/coach/instr.md');
    expect(paths.contextDir).toBe('/data/assistants/coach/context');
  });

  it('refuses a slug that would escape the root', async () => {
    expect(() => assistantPaths(config, '../../etc')).toThrow(AssistantError);
  });

  it('refuses slugs outside the allowed character range', async () => {
    expect(isValidSlug('coach suzy')).toBe(false);
    expect(isValidSlug('Coach')).toBe(false);
    expect(isValidSlug('coach-suzy')).toBe(true);
  });
});

describe('the rights matrix', () => {
  let repo: Repo;

  beforeEach(async () => {
    repo = await freshRepo();
  });

  it('hides an assistant a user was not granted', async () => {
    const coach = await repo.createAssistant('coach', 'Coach', '', 'English');
    const user = await repo.upsertUser('a@example.com', false);

    expect(await repo.canUseAssistant(user.id, false, coach.id)).toBe(false);
    expect(await repo.listAssistantsForUser(user.id, false)).toHaveLength(0);
  });

  it('shows an assistant once access is granted', async () => {
    const coach = await repo.createAssistant('coach', 'Coach', '', 'English');
    const user = await repo.upsertUser('a@example.com', false);
    await repo.grantAssistant(coach.id, user.id);

    expect(await repo.canUseAssistant(user.id, false, coach.id)).toBe(true);
    expect((await repo.listAssistantsForUser(user.id, false)).map((a) => a.slug)).toEqual(['coach']);
  });

  it('lets an admin use every assistant without a grant', async () => {
    await repo.createAssistant('coach', 'Coach', '', 'English');
    const second = await repo.createAssistant('hr', 'HR', '', 'English');
    const admin = await repo.upsertUser('admin@example.com', true);

    expect(await repo.canUseAssistant(admin.id, true, second.id)).toBe(true);
    expect(await repo.listAssistantsForUser(admin.id, true)).toHaveLength(2);
  });

  it('revokes access again', async () => {
    const coach = await repo.createAssistant('coach', 'Coach', '', 'English');
    const user = await repo.upsertUser('a@example.com', false);
    await repo.grantAssistant(coach.id, user.id);
    await repo.revokeAssistant(coach.id, user.id);

    expect(await repo.canUseAssistant(user.id, false, coach.id)).toBe(false);
  });

  it('replaces the whole grant list at once', async () => {
    const coach = await repo.createAssistant('coach', 'Coach', '', 'English');
    const alice = await repo.upsertUser('alice@example.com', false);
    const bob = await repo.upsertUser('bob@example.com', false);
    await repo.grantAssistant(coach.id, alice.id);

    await repo.setAssistantUsers(coach.id, [bob.id]);

    expect(await repo.listGrantedUserIds(coach.id)).toEqual([bob.id]);
  });
});

describe('the welcome message', () => {
  let repo: Repo;

  beforeEach(async () => {
    repo = await freshRepo();
  });

  it('starts empty, which means the built-in sentence is used', async () => {
    const coach = await repo.createAssistant('coach', 'Coach', '', 'English');

    expect(coach.welcome).toBe('');
  });

  it('round-trips what an admin typed, newlines and all', async () => {
    const coach = await repo.createAssistant('coach', 'Coach', '', 'English');
    const welcome = 'Welcome.\n\nAsk me anything.';

    await repo.updateAssistant(coach.id, 'Coach', '', 'English', welcome, 'text');

    expect((await repo.findAssistantById(coach.id))?.welcome).toBe(welcome);
  });

  it('is kept per chatbot', async () => {
    const coach = await repo.createAssistant('coach', 'Coach', '', 'English');
    const hr = await repo.createAssistant('hr', 'HR', '', 'English');

    await repo.updateAssistant(coach.id, 'Coach', '', 'English', 'Only for the coach.', 'text');

    expect((await repo.findAssistantById(coach.id))?.welcome).toBe('Only for the coach.');
    expect((await repo.findAssistantById(hr.id))?.welcome).toBe('');
  });
});

describe('per-assistant isolation', () => {
  let repo: Repo;

  beforeEach(async () => {
    repo = await freshRepo();
  });

  it('keeps conversations of one assistant out of another', async () => {
    const coach = await repo.createAssistant('coach', 'Coach', '', 'English');
    const hr = await repo.createAssistant('hr', 'HR', '', 'English');
    const user = await repo.upsertUser('a@example.com', false);
    await repo.createConversation(user.id, coach.id, 'With the coach');

    expect(await repo.listConversations(user.id, coach.id)).toHaveLength(1);
    expect(await repo.listConversations(user.id, hr.id)).toHaveLength(0);
  });

  it('keeps remembered facts out of another assistant', async () => {
    const coach = await repo.createAssistant('coach', 'Coach', '', 'English');
    const hr = await repo.createAssistant('hr', 'HR', '', 'English');
    const user = await repo.upsertUser('a@example.com', false);
    await repo.addMemory(user.id, coach.id, 'Wants to lead a team.');

    expect(await repo.listMemories(user.id, coach.id, 10)).toHaveLength(1);
    expect(await repo.listMemories(user.id, hr.id, 10)).toHaveLength(0);
  });

  it('keeps settings separate', async () => {
    const coach = await repo.createAssistant('coach', 'Coach', '', 'English');
    const hr = await repo.createAssistant('hr', 'HR', '', 'English');
    await repo.setSetting(coach.id, 'model', 'openai/gpt-5');

    expect(await repo.getSetting(coach.id, 'model')).toBe('openai/gpt-5');
    expect(await repo.getSetting(hr.id, 'model')).toBeNull();
  });

  it('removes an assistant with everything hanging off it', async () => {
    const coach = await repo.createAssistant('coach', 'Coach', '', 'English');
    const user = await repo.upsertUser('a@example.com', false);
    await repo.grantAssistant(coach.id, user.id);
    const conversation = await repo.createConversation(user.id, coach.id, 'Doomed');
    await repo.addMemory(user.id, coach.id, 'Something.');

    await repo.deleteAssistant(coach.id);

    expect(await repo.findAssistantById(coach.id)).toBeNull();
    expect(await repo.findConversation(conversation.id, user.id)).toBeNull();
    expect(await repo.listMemories(user.id, coach.id, 10)).toHaveLength(0);
    expect(await repo.listGrantedUserIds(coach.id)).toHaveLength(0);
  });
});

afterAll(closeAll);

describe('changing an address', () => {
  let repo: Repo;
  let cfg: Config;

  beforeEach(async () => {
    repo = await freshRepo();
    cfg = { assistantsDir: mkdtempSync(join(tmpdir(), 'assistants-')) } as Config;
  });

  function seed(slug: string): void {
    mkdirSync(join(cfg.assistantsDir, slug, 'context'), { recursive: true });
    writeFileSync(join(cfg.assistantsDir, slug, 'instr.md'), 'prompt');
  }

  it('moves the folder and the row, and keeps the old address as a redirect', async () => {
    const coach = await repo.createAssistant('coach', 'Coach', '', 'English');
    seed('coach');

    await renameAssistantSlug(cfg, repo, coach, 'mentor');

    expect((await repo.findAssistantById(coach.id))?.slug).toBe('mentor');
    expect(existsSync(join(cfg.assistantsDir, 'mentor', 'instr.md'))).toBe(true);
    expect(existsSync(join(cfg.assistantsDir, 'coach'))).toBe(false);
    expect(await repo.findAssistantBySlug('coach')).toBeNull();
    expect((await repo.findAssistantByFormerSlug('coach'))?.id).toBe(coach.id);
  });

  it('refuses an address another chatbot uses', async () => {
    const coach = await repo.createAssistant('coach', 'Coach', '', 'English');
    await repo.createAssistant('hr', 'HR', '', 'English');
    seed('coach');

    await expect(renameAssistantSlug(cfg, repo, coach, 'hr')).rejects.toThrow(AssistantError);
    expect(existsSync(join(cfg.assistantsDir, 'coach'))).toBe(true);
  });

  it('refuses reserved and malformed addresses', async () => {
    const coach = await repo.createAssistant('coach', 'Coach', '', 'English');

    await expect(renameAssistantSlug(cfg, repo, coach, 'admin')).rejects.toThrow(AssistantError);
    await expect(renameAssistantSlug(cfg, repo, coach, '../x')).rejects.toThrow(AssistantError);
  });

  it('refuses to merge into a folder that is already on the volume', async () => {
    const coach = await repo.createAssistant('coach', 'Coach', '', 'English');
    seed('coach');
    seed('leftover');

    await expect(renameAssistantSlug(cfg, repo, coach, 'leftover')).rejects.toThrow(AssistantError);
    expect(existsSync(join(cfg.assistantsDir, 'coach', 'instr.md'))).toBe(true);
    expect((await repo.findAssistantById(coach.id))?.slug).toBe('coach');
  });

  it('stops redirecting once the old address is taken back', async () => {
    const coach = await repo.createAssistant('coach', 'Coach', '', 'English');
    await renameAssistantSlug(cfg, repo, coach, 'mentor');
    const renamed = (await repo.findAssistantById(coach.id))!;
    await renameAssistantSlug(cfg, repo, renamed, 'coach');

    expect((await repo.findAssistantBySlug('coach'))?.id).toBe(coach.id);
    expect(await repo.findAssistantByFormerSlug('coach')).toBeNull();
    expect((await repo.findAssistantByFormerSlug('mentor'))?.id).toBe(coach.id);
  });
});
