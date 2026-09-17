import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Starts one PostgreSQL container for the whole run; each test then gets
    // its own schema inside it, which is far cheaper than a container each.
    globalSetup: ['./tests/global-setup.ts'],
    // Pulling and starting the image on a cold machine takes a while.
    hookTimeout: 120_000,
    testTimeout: 30_000,
  },
});
