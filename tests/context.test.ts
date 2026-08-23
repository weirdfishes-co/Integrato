import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { beforeEach, describe, expect, it } from 'vitest';

import { buildSystemPrompt, resetPromptCache } from '../src/context.js';

function makeWorkspace(files: Record<string, string>, instructions?: string) {
  const root = mkdtempSync(join(tmpdir(), 'assistant-context-'));
  const contextDir = join(root, 'context');
  mkdirSync(contextDir, { recursive: true });

  const instructionsPath = join(root, 'instr.md');
  if (instructions !== undefined) writeFileSync(instructionsPath, instructions, 'utf8');
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(contextDir, name), content, 'utf8');
  }
  return { instructionsPath, contextDir };
}

describe('buildSystemPrompt', () => {
  beforeEach(() => {
    resetPromptCache();
  });

  it('contains the instructions and the language rule', async () => {
    const sources = makeWorkspace({}, 'You are a test assistant.');
    const prompt = await buildSystemPrompt(sources);

    expect(prompt).toContain('You are a test assistant.');
    expect(prompt).toContain('Always answer in English');
  });

  it('honours a configured language', async () => {
    const sources = makeWorkspace({}, 'Instructions');
    const prompt = await buildSystemPrompt({ ...sources, language: 'Dutch' });

    expect(prompt).toContain('Always answer in Dutch');
  });

  it('falls back to the assistant name when instr.md is missing', async () => {
    const sources = makeWorkspace({});
    const prompt = await buildSystemPrompt({ ...sources, assistantName: 'Helpdesk Bot' });

    expect(prompt).toContain('You are Helpdesk Bot, a helpful assistant.');
  });

  it('adds context files with their file name', async () => {
    const sources = makeWorkspace({ 'policy.md': 'The rule is X.' }, 'Instructions');
    const prompt = await buildSystemPrompt(sources);

    expect(prompt).toContain('<document name="policy.md">');
    expect(prompt).toContain('The rule is X.');
  });

  it('sorts context files alphabetically so the prompt prefix stays stable', async () => {
    const sources = makeWorkspace({ 'b.md': 'second', 'a.md': 'first' }, 'Instructions');
    const prompt = await buildSystemPrompt(sources);

    expect(prompt.indexOf('first')).toBeLessThan(prompt.indexOf('second'));
  });

  it('replaces {Global.Name} with the context file of the same name', async () => {
    const sources = makeWorkspace({ 'Guidelines.md': 'Rule one is X.' }, 'Use {Global.Guidelines} here.');
    const prompt = await buildSystemPrompt(sources);

    expect(prompt).not.toContain('{Global.Guidelines}');
    expect(prompt).toContain('Rule one is X.');
  });

  it('does not append a file that was already inserted through a placeholder', async () => {
    const sources = makeWorkspace({ 'Guidelines.md': 'UNIQUE-CONTENT' }, '{Global.Guidelines}');
    const prompt = await buildSystemPrompt(sources);

    expect(prompt.split('UNIQUE-CONTENT')).toHaveLength(2);
  });

  it('leaves a placeholder in place when the context file is missing', async () => {
    const sources = makeWorkspace({}, 'Use {Global.Missing} here.');
    const prompt = await buildSystemPrompt(sources);

    expect(prompt).toContain('{Global.Missing}');
  });

  it('works without instr.md and without a context directory', async () => {
    const root = mkdtempSync(join(tmpdir(), 'assistant-empty-'));
    const prompt = await buildSystemPrompt({
      instructionsPath: join(root, 'instr.md'),
      contextDir: join(root, 'context'),
    });

    expect(prompt).toContain('Always answer in English');
  });
});
