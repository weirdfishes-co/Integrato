import { constants } from 'node:fs';
import { access, copyFile, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';

import { logger } from './logger.js';

/**
 * Management of the knowledge base: instr.md and the markdown files in the
 * context directory.
 *
 * Every file name comes from an admin over the web, so each name is validated
 * AND the resolved path is checked against the base directory. Path names are
 * never handed to fs directly.
 */

/** Deliberately narrow: exactly the character range that also works in {Global.Name} placeholders. */
const FILENAME_PATTERN = /^[A-Za-z0-9_-]{1,64}\.md$/;

/** Generous upper bound per document; everything is sent as input with every question. */
export const MAX_DOCUMENT_BYTES = 512 * 1024;

export class ContentError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

export interface DocumentSummary {
  name: string;
  /** Name without .md — this is what you use in a {Global.…} placeholder. */
  placeholder: string;
  sizeBytes: number;
  modifiedAt: string;
}

export interface ContentStore {
  listDocuments(): Promise<DocumentSummary[]>;
  readDocument(name: string): Promise<string>;
  writeDocument(name: string, content: string): Promise<void>;
  deleteDocument(name: string): Promise<void>;
  readInstructions(): Promise<string>;
  writeInstructions(content: string): Promise<void>;
}

export interface ContentPaths {
  readonly contextDir: string;
  readonly instructionsPath: string;
}

/** Validates the name and enforces that the result stays inside the context directory. */
function safePath(contextDir: string, name: string): string {
  if (!FILENAME_PATTERN.test(name)) {
    throw new ContentError(
      'Invalid file name. Use letters, digits, - and _ , and end with .md (for example Guidelines.md).',
    );
  }

  const base = resolve(contextDir);
  const target = resolve(base, name);
  if (target !== join(base, name) || !target.startsWith(base + sep)) {
    throw new ContentError('Invalid path.');
  }
  return target;
}

function assertSize(content: string): void {
  const bytes = Buffer.byteLength(content, 'utf8');
  if (bytes > MAX_DOCUMENT_BYTES) {
    throw new ContentError(
      `Document is too large (${Math.round(bytes / 1024)} kB, maximum ${MAX_DOCUMENT_BYTES / 1024} kB).`,
    );
  }
}

/** Normalizes line endings so what you save equals what you read back. */
function normalize(content: string): string {
  const text = content.replaceAll('\r\n', '\n');
  return text.endsWith('\n') || text.length === 0 ? text : `${text}\n`;
}

export function createContentStore({ contextDir, instructionsPath }: ContentPaths): ContentStore {
  return {
    async listDocuments() {
      let entries: string[];
      try {
        entries = await readdir(contextDir);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
        throw error;
      }

      const documents: DocumentSummary[] = [];
      for (const name of entries.filter((entry) => FILENAME_PATTERN.test(entry)).sort()) {
        const info = await stat(join(contextDir, name));
        if (!info.isFile()) continue;
        documents.push({
          name,
          placeholder: name.replace(/\.md$/, ''),
          sizeBytes: info.size,
          modifiedAt: info.mtime.toISOString().slice(0, 16).replace('T', ' '),
        });
      }
      return documents;
    },

    async readDocument(name) {
      const path = safePath(contextDir, name);
      try {
        return await readFile(path, 'utf8');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          throw new ContentError('This file does not exist.', 404);
        }
        throw error;
      }
    },

    async writeDocument(name, content) {
      const path = safePath(contextDir, name);
      assertSize(content);
      await mkdir(contextDir, { recursive: true });
      await writeFile(path, normalize(content), 'utf8');
      logger.info({ document: name }, 'context document saved');
    },

    async deleteDocument(name) {
      const path = safePath(contextDir, name);
      await rm(path, { force: true });
      logger.info({ document: name }, 'context document deleted');
    },

    async readInstructions() {
      try {
        return await readFile(instructionsPath, 'utf8');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '';
        throw error;
      }
    },

    async writeInstructions(content) {
      assertSize(content);
      await writeFile(instructionsPath, normalize(content), 'utf8');
      logger.info('instructions saved');
    },
  };
}

/**
 * Copies the bundled instr.md and context files to the writable location when
 * that location is still empty. On Railway those paths point at the volume, so
 * changes survive a deploy; without seeding the app would start there with an
 * empty knowledge base.
 */
export async function seedContent(bundled: ContentPaths, target: ContentPaths): Promise<void> {
  if (resolve(bundled.instructionsPath) !== resolve(target.instructionsPath)) {
    const exists = await access(target.instructionsPath, constants.F_OK).then(
      () => true,
      () => false,
    );
    if (!exists) {
      await mkdir(resolve(target.instructionsPath, '..'), { recursive: true });
      await copyFile(bundled.instructionsPath, target.instructionsPath).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error;
      });
      logger.info({ path: target.instructionsPath }, 'instr.md seeded');
    }
  }

  if (resolve(bundled.contextDir) === resolve(target.contextDir)) return;

  await mkdir(target.contextDir, { recursive: true });
  const existing = await readdir(target.contextDir);
  if (existing.some((name) => FILENAME_PATTERN.test(name))) return;

  const source = await readdir(bundled.contextDir).catch(() => [] as string[]);
  const documents = source.filter((entry) => FILENAME_PATTERN.test(entry));
  for (const name of documents) {
    await copyFile(join(bundled.contextDir, name), join(target.contextDir, name));
  }
  // Count what was actually copied: the source may hold only a .gitkeep.
  if (documents.length > 0) {
    logger.info({ dir: target.contextDir, files: documents.length }, 'context directory seeded');
  }
}
