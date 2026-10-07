import { expect, test, type Page } from '@playwright/test';
import { pinFixtureClock, serveN01 } from './n01Server';

/**
 * n01 inside the installed PWA (MASTER SPEC Phase 6 §9), with the service worker
 * running — unlike e2e/n01.spec.ts, which blocks it to keep routing simple.
 *
 * - the service worker never caches n01 responses (old data must never look current);
 * - with the network gone, the app still opens, says the n01 data is not current, and
 *   builds the next order from the last sync only when the captain asks.
 */

async function waitForServiceWorker(page: Page): Promise<void> {
  await page.waitForFunction(
    async () => {
      const registration = await navigator.serviceWorker?.ready;
      return registration?.active?.state === 'activated';
    },
    undefined,
    { timeout: 60_000 },
  );
}

async function createKalavinka(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'n01から作成' }).click();
  const wizard = page.getByRole('dialog', { name: 'n01から作成' });
  await wizard.getByRole('button', { name: 'ATDO', exact: true }).click();
  await wizard.getByRole('button', { name: /kalavinka/ }).click();
  await wizard.getByRole('button', { name: 'このチームを作成' }).click();
  await expect(page.getByTestId('next-match-card')).toBeVisible();
}

test('the service worker caches the app, never n01 responses', async ({ page, request }) => {
  await pinFixtureClock(page);
  await serveN01(page);
  await page.goto('/');
  await waitForServiceWorker(page);
  const sw = await (await request.get('/sw.js')).text();
  expect(sw).not.toContain('n01darts');
  await createKalavinka(page);
  const cached = await page.evaluate(async () => {
    const urls: string[] = [];
    for (const name of await caches.keys()) {
      for (const entry of await (await caches.open(name)).keys()) urls.push(entry.url);
    }
    return urls;
  });
  expect(cached.length).toBeGreaterThan(0);
  expect(cached.filter((url) => url.includes('n01darts'))).toEqual([]);
});

test('offline in the installed app: last sync named, continue only when asked, order still made', async ({ page, context }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await pinFixtureClock(page);
  const server = await serveN01(page);
  await page.goto('/');
  await waitForServiceWorker(page);
  await createKalavinka(page);

  // Routed requests ignore `setOffline`, so the fixture n01 goes away explicitly too.
  server.offline = true;
  await context.setOffline(true);
  await page.reload();
  const card = page.getByTestId('next-match-card');
  await expect(card).toContainText('vs スピンコブラ');
  // Read back from the cache after a restart: shown with its age, never as 最新.
  await expect(page.getByTestId('n01-freshness')).not.toContainText('最新');

  await page.getByRole('button', { name: '次戦のオーダーを作る' }).click();
  const flow = page.getByRole('dialog', { name: '次戦のオーダーを作る' });
  await expect(flow.getByTestId('flow-offline')).toContainText('このデータは最新ではありません');
  await flow.getByRole('button', { name: '前回データで続ける' }).click();
  await expect(flow.getByTestId('flow-stale')).toBeVisible();
  await flow.getByRole('button', { name: 'このメンバーで作成' }).click();
  await expect(page.getByRole('heading', { name: 'オーダー結果' })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId('opponent-panel')).toContainText('スピンコブラ');
  await context.setOffline(false);
});
