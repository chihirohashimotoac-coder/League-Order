import { expect, test } from '@playwright/test';
import { expectNoAxeViolations } from './axe';
import { serveDoublesWorld } from './doublesWorld';

/**
 * The doubles view's positive path in a real browser (phone and desktop projects), against a
 * fixture n01 holding one real season (`doublesWorld.ts`): with no button pressed, the shown
 * player's legs alone are read, and 3DA, First 9 and ダブルイン成功率 appear.
 *
 * Expected values (灰田 裕一郎, `o3ul`, ATDO 2026 3rd — n01's own totals, read 2026-10-13):
 *  - 3DA 473 × 3 / 26 = 54.58; First 9 96 × 3 / 6 = 48.00 (the reconstruction equals them);
 *  - ダブルイン成功率 1/1: his only doubles game (`mfLrlWMg_1790853252790`, ダブルス1 `2gbr`,
 *    pair [gm3v, o3ul]): leg 1 `0` (gm3v ✗) then `56` (o3ul ✓); leg 2 `61` (gm3v ✓) — he never
 *    threw again before the pair started.
 */
test.use({ serviceWorkers: 'block' });

test('doubles: 3DA, First 9 and ダブルイン成功率 appear without a button, reading the shown player only', async ({ page }, info) => {
  const n01 = await serveDoublesWorld(page);
  await page.goto('/');
  await page.getByRole('button', { name: 'n01から作成' }).click();
  const wizard = page.getByRole('dialog', { name: 'n01から作成' });
  await wizard.getByRole('button', { name: 'ATDO', exact: true }).click();
  await wizard.getByRole('button', { name: /ドリズム/ }).click();
  await wizard.getByRole('button', { name: 'このチームを作成' }).click();
  await expect(page.getByRole('heading', { name: 'ドリズム', level: 1 })).toBeVisible();

  await page.locator('.tab-bar').getByRole('button', { name: '分析', exact: true }).click();
  await expect(page.getByTestId('analytics-page')).toBeVisible();
  const beforeDoubles = n01.log.length;
  await page.getByTestId('scope-bar').getByRole('button', { name: 'ダブルス', exact: true }).click();

  // 灰田 is the first roster member with figures: shown, and read, without a click.
  const detail = page.getByTestId('analytics-detail');
  await expect(detail.getByRole('heading', { name: /灰田 裕一郎/ })).toBeVisible();
  await expect(page.getByTestId('reconstruction')).toHaveAttribute('data-state', 'done');
  await expect(page.getByTestId('metric-3DA')).toContainText('54.58');
  await expect(page.getByTestId('metric-First 9')).toContainText('48.00');
  const start = page.getByTestId('metric-ダブルイン成功率');
  await expect(start).toContainText('100.0%');
  await expect(start).toContainText('1/1スロー');
  await expect(start).toContainText('Leg明細から算出');
  await expect(page.getByTestId('reconstruct-run')).toHaveCount(0);
  await expect(page.getByTestId('reconstruct-retry')).toHaveCount(0);

  // Only his one game's legs, and the season's high-in records once (empty: not needed for the rule).
  const after = n01.log.slice(beforeDoubles);
  expect(after.filter((e) => e.startsWith('match/get'))).toEqual(['match/get?mid=mfLrlWMg_1790853252790']);
  expect(after.filter((e) => e.includes('kind=player_high_in'))).toHaveLength(1);
  await page.getByTestId('start-breakdown').locator('summary').click();
  await expect(page.getByTestId('start-adopted')).toContainText('1ゲーム中 1ゲーム');
  await page.screenshot({ path: `test-results/analytics-doubles-values-${info.project.name}.png`, fullPage: true });

  // Coming back to ダブルス reads nothing again.
  const settled = n01.log.length;
  await page.getByTestId('scope-bar').getByRole('button', { name: '01全体', exact: true }).click();
  await page.getByTestId('scope-bar').getByRole('button', { name: 'ダブルス', exact: true }).click();
  await expect(page.getByTestId('metric-ダブルイン成功率')).toContainText('1/1スロー');
  expect(n01.log.slice(settled).filter((e) => e.startsWith('match/get') || e.includes('player_high_in'))).toEqual([]);

  // No sideways scroll, and WCAG 2.1 AA with the figures on screen.
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  await expectNoAxeViolations(page, info);
  expect(n01.unanswered.filter((e) => e.startsWith('match/') || e.startsWith('tournament/'))).toEqual([]);
});
