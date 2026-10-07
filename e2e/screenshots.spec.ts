import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { pinFixtureClock, serveN01 } from './n01Server';

/**
 * Final visual QA (MASTER SPEC Phase 6 §10): one screenshot per n01 screen, at phone
 * size, against the fixture n01 server.
 *
 * Not part of the regular suite (nothing is asserted that the other specs do not):
 *
 *   SCREENSHOTS=<dir> npx playwright test e2e/screenshots.spec.ts --project=mobile
 */
const DIR = process.env.SCREENSHOTS;
test.skip(!DIR, 'set SCREENSHOTS=<dir> to capture the visual QA screenshots');
test.use({ serviceWorkers: 'block' });

let index = 0;
async function shot(page: Page, name: string): Promise<void> {
  index += 1;
  await page.waitForTimeout(250);
  await page.screenshot({ path: join(DIR!, `${String(index).padStart(2, '0')}-${name}.png`), fullPage: false });
}

function tab(page: Page, name: string) {
  return page.locator('.tab-bar').getByRole('button', { name, exact: true });
}

test('n01 screens', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'mobile', 'phone screenshots only');
  test.setTimeout(180_000);
  mkdirSync(DIR!, { recursive: true });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await pinFixtureClock(page);
  const server = await serveN01(page);
  await page.goto('/');

  await shot(page, 'team-create');
  await page.getByRole('button', { name: 'n01から作成' }).click();
  const wizard = page.getByRole('dialog', { name: 'n01から作成' });
  await expect(wizard.getByRole('button', { name: 'ATDO', exact: true })).toBeVisible();
  await shot(page, 'league-picker');

  // Error, then recovery.
  server.offline = true;
  await wizard.getByRole('button', { name: 'ATDO', exact: true }).click();
  await expect(wizard.getByRole('alert')).toBeVisible();
  await shot(page, 'error');
  server.offline = false;
  await wizard.getByRole('button', { name: '再試行' }).click();
  await expect(wizard.getByRole('button', { name: /kalavinka/ })).toBeVisible();
  await shot(page, 'team-picker');

  await wizard.getByRole('button', { name: /kalavinka/ }).click();
  await expect(wizard.getByTestId('n01-preview')).toBeVisible();
  await shot(page, 'sync-preview');
  await wizard.getByRole('button', { name: 'このチームを作成' }).click();
  await expect(page.getByTestId('next-match-card')).toBeVisible();
  await expect(page.locator('.toast')).toHaveCount(0, { timeout: 6000 });
  await shot(page, 'home');

  // Sync progress, held long enough to see.
  server.delayMs = 600;
  await page.getByRole('button', { name: '次戦のオーダーを作る' }).click();
  const flow = page.getByRole('dialog', { name: '次戦のオーダーを作る' });
  await expect(flow.locator('.sync-step').first()).toBeVisible();
  await page.waitForTimeout(900);
  await shot(page, 'next-match-sync');
  server.delayMs = 0;
  await expect(flow.getByTestId('flow-attendance')).toBeVisible({ timeout: 20_000 });
  await shot(page, 'participant-confirm');
  await flow.getByRole('button', { name: 'このメンバーで作成' }).click();
  await expect(page.getByTestId('opponent-panel')).toBeVisible({ timeout: 20_000 });
  await shot(page, 'result');
  await page.getByRole('group', { name: '候補の比較' }).scrollIntoViewIfNeeded();
  await shot(page, 'candidate-comparison');
  await page.getByTestId('opponent-panel').scrollIntoViewIfNeeded();
  await shot(page, 'opponent-analysis');

  // Offline next-match flow.
  await tab(page, 'ホーム').click();
  server.offline = true;
  await page.getByRole('button', { name: '次戦のオーダーを作る' }).click();
  await expect(page.getByTestId('flow-offline')).toBeVisible();
  await shot(page, 'offline');
  await page.keyboard.press('Escape');
  server.offline = false;

  await page.getByRole('button', { name: '切替 / 管理' }).click();
  await page.getByRole('button', { name: '編集' }).first().click();
  await page.waitForTimeout(300);
  await shot(page, 'team');
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');

  await tab(page, 'メンバー').click();
  await page.locator('.list-row').filter({ hasText: '橋本 千尋' }).click();
  await expect(page.getByTestId('n01-player')).toBeVisible();
  await shot(page, 'player');
  await page.keyboard.press('Escape');

  await tab(page, 'フォーマット').click();
  await page.locator('.list-row').filter({ hasText: 'n01 管理' }).click();
  await shot(page, 'format');
});
