import { existsSync } from 'node:fs';
import { defineConfig, devices } from '@playwright/test';

/**
 * The container ships a pre-installed Chromium that may be a different build number to
 * the one this Playwright version downloads. When it is present, point Playwright at it
 * rather than fetching another copy; otherwise fall back to Playwright's own browser.
 */
const PREINSTALLED_CHROMIUM = '/opt/pw-browsers/chromium';
const chromiumPath = existsSync(PREINSTALLED_CHROMIUM) ? PREINSTALLED_CHROMIUM : undefined;

const launchOptions = {
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
  ...(chromiumPath ? { executablePath: chromiumPath } : {}),
};

/**
 * End-to-end configuration.
 *
 * Runs against the production build (`vite preview`) so the service worker, the module
 * worker and the real bundle are all exercised, not just the dev server. The default
 * project is a phone viewport, because that is where the app is actually used.
 */
export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : [['list']],
  use: {
    baseURL: 'http://127.0.0.1:4173',
    trace: 'retain-on-failure',
    launchOptions,
  },
  projects: [
    { name: 'mobile', use: { ...devices['Pixel 5'], launchOptions } },
    { name: 'desktop', use: { ...devices['Desktop Chrome'], launchOptions } },
  ],
  webServer: {
    command: 'npm run build && npx vite preview --port 4173 --host 127.0.0.1',
    url: 'http://127.0.0.1:4173',
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
  },
});
