import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    // vite-plugin-pwa's virtual module only exists in a Vite build.
    alias: { 'virtual:pwa-register': fileURLToPath(new URL('./src/test/pwaRegisterStub.ts', import.meta.url)) },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx', 'scripts/**/*.test.ts'],
    environmentMatchGlobs: [
      ['src/**/*.dom.test.ts', 'jsdom'],
      ['src/**/*.test.tsx', 'jsdom'],
      ['src/storage/**/*.test.ts', 'jsdom'],
    ],
    setupFiles: ['src/test/setup.ts'],
    testTimeout: 30_000,
  },
});
