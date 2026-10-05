import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    environmentMatchGlobs: [
      ['src/**/*.dom.test.ts', 'jsdom'],
      ['src/**/*.test.tsx', 'jsdom'],
      ['src/storage/**/*.test.ts', 'jsdom'],
    ],
    setupFiles: ['src/test/setup.ts'],
    testTimeout: 30_000,
  },
});
