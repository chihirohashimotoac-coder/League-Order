import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { expectNoAxeViolations } from './axe';

/** The update history opens from HOME and from SETTINGS, lists one entry per change, and links nowhere. */
test.use({ serviceWorkers: 'block' });

const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf-8')) as { version: string };

async function openSample(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByRole('button', { name: 'サンプルで試す' }).click();
  await expect(page.getByRole('heading', { name: 'サンプルチーム', level: 1 })).toBeVisible();
  await expect(page.locator('.toast')).toHaveCount(0, { timeout: 6000 });
}

test('the update history opens from the home screen', async ({ page }, info) => {
  await openSample(page);

  const row = page.locator('.list-row').filter({ hasText: '更新履歴' });
  await expect(row).toContainText(`v${version}`);
  await row.click();

  const sheet = page.getByRole('dialog', { name: '更新履歴' });
  await expect(sheet).toBeVisible();
  await expect(sheet.locator(`[data-version="${version}"]`)).toBeVisible();
  await expect(sheet.locator('article').first()).toBeVisible();
  expect(await sheet.locator('article').count()).toBeGreaterThan(10);

  // No links: the history is plain text, one entry per change.
  await expect(sheet.locator('a')).toHaveCount(0);
  await expect(sheet).not.toContainText('github.com');

  await expectNoAxeViolations(page, info);

  await page.keyboard.press('Escape');
  await expect(sheet).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'サンプルチーム', level: 1 })).toBeVisible();
});

test('the update history still opens from the settings screen', async ({ page }) => {
  await openSample(page);
  await page.locator('.list-row').filter({ hasText: '設定 / バックアップ' }).click();
  await page.getByRole('button', { name: '更新履歴を見る' }).click();
  await expect(page.getByRole('dialog', { name: '更新履歴' })).toBeVisible();
});

test('the home screen does not scroll sideways at 320px with the history row', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 640 });
  await openSample(page);
  const sideways = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(sideways).toBeLessThanOrEqual(1);
});
