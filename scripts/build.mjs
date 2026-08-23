import { cpSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';

/**
 * Bundles the server to plain JS. We never run TypeScript through tsx in
 * production: an extra transpile step at startup can exceed Railway's health
 * check timeout and fail the deploy.
 */

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const outDir = join(root, 'dist');

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

await build({
  entryPoints: [join(root, 'src/server.ts')],
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  outfile: join(outDir, 'server.js'),
  packages: 'external',
  sourcemap: true,
  logLevel: 'info',
});

// At runtime the migrations are looked up next to the bundle (dist/migrations).
cpSync(join(root, 'src/db/migrations'), join(outDir, 'migrations'), { recursive: true });

console.log('build done: dist/server.js');
