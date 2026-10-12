import { existsSync } from 'node:fs';
import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end checks of the non-production preview page (`npm run test:e2e:preview`,
 * docs/THROW_ORDER_MODEL.md §10): the throw-order and underdog scenarios on synthetic data,
 * rendered by the real result screen and engine, served from `dist-preview/` (never GitHub Pages).
 */
const PREINSTALLED_CHROMIUM = '/opt/pw-browsers/chromium';
const chromiumPath = existsSync(PREINSTALLED_CHROMIUM) ? PREINSTALLED_CHROMIUM : undefined;

const launchOptions = {
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
  ...(chromiumPath ? { executablePath: chromiumPath } : {}),
};

export default defineConfig({
  testDir: './e2e-preview',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  reporter: [['list']],
  use: {
    baseURL: 'http://127.0.0.1:4180',
    trace: 'retain-on-failure',
    launchOptions,
  },
  projects: [
    { name: 'mobile', use: { ...devices['Pixel 5'], launchOptions } },
    { name: 'desktop', use: { ...devices['Desktop Chrome'], launchOptions } },
  ],
  webServer: {
    command: 'npm run build:preview && npx vite preview --config vite.preview.config.ts --port 4180 --host 127.0.0.1',
    url: 'http://127.0.0.1:4180/preview.html',
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
  },
});
