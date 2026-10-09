import { defineConfig, devices } from '@playwright/test';

/**
 * Smoke test of the PUBLISHED site (GitHub Pages) against the REAL n01 API, in a real
 * browser. Nothing is mocked and nothing is built here: it opens `PAGES_URL` as a visitor
 * would. Run by the `Smoke test the published site` workflow (`npm run smoke:pages`), not by
 * `npm run test:e2e` (which only looks in ./e2e) and not by the publish gate.
 */
export const PAGES_URL = process.env.PAGES_URL ?? 'https://chihirohashimotoac-coder.github.io/League-Order/';

export default defineConfig({
  testDir: './e2e-live',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 180_000,
  expect: { timeout: 45_000 },
  reporter: [['list']],
  outputDir: 'smoke-results',
  use: {
    baseURL: PAGES_URL,
    trace: 'retain-on-failure',
    launchOptions: { args: ['--no-sandbox', '--disable-dev-shm-usage'] },
  },
  projects: [
    { name: 'mobile', use: { ...devices['Pixel 5'] } },
    { name: 'desktop', use: { ...devices['Desktop Chrome'] } },
  ],
});
