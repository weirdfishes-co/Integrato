import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { beforeEach, describe, expect, it } from 'vitest';

import { ContentError, createContentStore, seedContent, type ContentStore } from '../src/content.js';

let root: string;
let contextDir: string;
let instructionsPath: string;
let store: ContentStore;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'assistant-content-'));
  contextDir = join(root, 'context');
  instructionsPath = join(root, 'instr.md');
  mkdirSync(contextDir, { recursive: true });
  writeFileSync(instructionsPath, 'You are a helpful assistant.\n', 'utf8');
  store = createContentStore({ contextDir, instructionsPath });
});

describe('context documents', () => {
  it('writes, reads and deletes a document', async () => {
    await store.writeDocument('Guidelines.md', 'Rule one is X.');

    expect(await store.readDocument('Guidelines.md')).toContain('Rule one is X.');
    expect((await store.listDocuments()).map((doc) => doc.name)).toEqual(['Guidelines.md']);

    await store.deleteDocument('Guidelines.md');
    expect(await store.listDocuments()).toHaveLength(0);
  });

  it('returns the matching placeholder', async () => {
    await store.writeDocument('QuestionBank.md', 'content');
    const [doc] = await store.listDocuments();

    expect(doc?.placeholder).toBe('QuestionBank');
  });

  it('reports cleanly that an unknown file does not exist', async () => {
    await expect(store.readDocument('Unknown.md')).rejects.toThrow(ContentError);
  });

  it('ignores files that are not .md', async () => {
    writeFileSync(join(contextDir, 'notes.txt'), 'not markdown', 'utf8');

    expect(await store.listDocuments()).toHaveLength(0);
  });

  it('reads back exactly what was stored', async () => {
    await store.writeDocument('Test.md', 'line one\r\nline two');

    expect(await store.readDocument('Test.md')).toBe('line one\nline two\n');
  });

  it('rejects documents over the maximum size', async () => {
    await expect(store.writeDocument('Large.md', 'x'.repeat(600 * 1024))).rejects.toThrow(/too large/);
  });
});

describe('file name validation', () => {
  const forbidden = [
    '../secret.md',
    '../../etc/passwd',
    'dir/file.md',
    '/etc/passwd.md',
    'file.md/../../escaped.md',
    '.env',
    'file.txt',
    'file',
    '',
    'fi le.md',
  ];

  for (const name of forbidden) {
    it(`rejects "${name}"`, async () => {
      await expect(store.writeDocument(name, 'content')).rejects.toThrow(ContentError);
      await expect(store.readDocument(name)).rejects.toThrow(ContentError);
      await expect(store.deleteDocument(name)).rejects.toThrow(ContentError);
    });
  }

  it('writes nothing outside the context directory on a path traversal attempt', async () => {
    await expect(store.writeDocument('../escaped.md', 'malicious')).rejects.toThrow(ContentError);

    expect(existsSync(join(root, 'escaped.md'))).toBe(false);
  });
});

describe('base prompt', () => {
  it('reads and writes instr.md', async () => {
    expect(await store.readInstructions()).toContain('You are a helpful assistant.');

    await store.writeInstructions('New prompt');
    expect(readFileSync(instructionsPath, 'utf8')).toBe('New prompt\n');
  });

  it('returns an empty string when instr.md does not exist yet', async () => {
    const empty = createContentStore({ contextDir, instructionsPath: join(root, 'does-not-exist.md') });

    expect(await empty.readInstructions()).toBe('');
  });
});

describe('seedContent', () => {
  it('copies the bundled files to an empty target location', async () => {
    await store.writeDocument('Guidelines.md', 'original');
    const target = { contextDir: join(root, 'volume/context'), instructionsPath: join(root, 'volume/instr.md') };

    await seedContent({ contextDir, instructionsPath }, target);

    expect(readFileSync(join(target.contextDir, 'Guidelines.md'), 'utf8')).toBe('original\n');
    expect(readFileSync(target.instructionsPath, 'utf8')).toContain('You are a helpful assistant.');
  });

  it('does not overwrite existing content at the target location', async () => {
    await store.writeDocument('Guidelines.md', 'from the image');
    const target = { contextDir: join(root, 'volume/context'), instructionsPath: join(root, 'volume/instr.md') };
    mkdirSync(target.contextDir, { recursive: true });
    writeFileSync(join(target.contextDir, 'Guidelines.md'), 'edited by the admin', 'utf8');
    writeFileSync(target.instructionsPath, 'custom prompt', 'utf8');

    await seedContent({ contextDir, instructionsPath }, target);

    expect(readFileSync(join(target.contextDir, 'Guidelines.md'), 'utf8')).toBe('edited by the admin');
    expect(readFileSync(target.instructionsPath, 'utf8')).toBe('custom prompt');
  });
});
