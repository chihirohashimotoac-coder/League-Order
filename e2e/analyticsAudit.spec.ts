import { expect, test } from '@playwright/test';
import { expectNoAxeViolations } from './axe';
import { AKDO_LEAGUE, serveAkdoWorld } from './akdoWorld';

/**
 * Audit 2026-11-16 in a real browser (phone and desktop), on a fixture n01 holding the real AKDO
 * 2026/2nd season of MC-BREMEN (`akdoWorld.ts`), through the normal path — nothing is injected:
 *  - チーム × シングルス: First 9 64.01 from the team's 12 singles games' legs, read without a button;
 *  - プレイヤー × ダブルス: 竹内 淳 (AKDO選手01) ダブルイン成功率 66.7%（6/9スロー）, the season
 *    verified although n01's averages leave the doubles out;
 *  - the loading gauge under the filters says what was read.
 */
test.use({ serviceWorkers: 'block' });

test('AKDO: team singles First 9 and a doubles player’s ダブルイン成功率 on the normal path', async ({ page }, info) => {
  const n01 = await serveAkdoWorld(page);
  await page.goto('/');
  await page.getByRole('button', { name: 'n01から作成' }).click();
  const wizard = page.getByRole('dialog', { name: 'n01から作成' });
  await wizard.getByText('リーグ ID / URL で指定').click();
  await wizard.getByLabel(/リーグ ID \/ n01 の URL/).fill(AKDO_LEAGUE);
  await wizard.getByRole('button', { name: '決定' }).click();
  await wizard.getByRole('button', { name: /MC-BREMEN/ }).click();
  await wizard.getByRole('button', { name: 'このチームを作成' }).click();
  await expect(page.getByRole('heading', { name: 'MC-BREMEN', level: 1 })).toBeVisible();

  await page.locator('.tab-bar').getByRole('button', { name: '分析', exact: true }).click();
  await expect(page.getByTestId('analytics-page')).toBeVisible();
  await expect(page.getByTestId('load-gauge')).toBeVisible();

  // チーム × シングルス
  await page.getByRole('group', { name: '分析の対象' }).getByRole('button', { name: 'チーム' }).click();
  await page.getByTestId('scope-bar').getByRole('button', { name: 'シングルス', exact: true }).click();
  await expect(page.getByTestId('metric-First 9')).toContainText('64.01', { timeout: 30_000 });
  await expect(page.getByTestId('metric-First 9')).toContainText('このチームのLeg明細から算出');
  await expect(page.getByTestId('metric-3DA')).toContainText('61.56');
  // Everything read: the gauge folds into one line with the time.
  await expect(page.getByTestId('load-gauge')).toHaveAttribute('data-state', 'done');
  await expect(page.getByTestId('load-gauge')).toContainText('取得完了');
  expect(n01.log.filter((e) => e.startsWith('match/get'))).toHaveLength(12);

  // プレイヤー × ダブルス: 竹内 淳
  await page.getByRole('group', { name: '分析の対象' }).getByRole('button', { name: 'プレイヤー' }).click();
  await page.getByTestId('scope-bar').getByRole('button', { name: 'ダブルス', exact: true }).click();
  await page.getByRole('button', { name: /AKDO選手01/ }).first().click();
  await expect(page.getByTestId('analytics-detail').getByRole('heading', { name: /AKDO選手01/ })).toBeVisible();
  await expect(page.getByTestId('reconstruction')).toHaveAttribute('data-state', 'done', { timeout: 30_000 });
  const start = page.getByTestId('metric-ダブルイン成功率');
  await expect(start).toContainText('66.7%');
  await expect(start).toContainText('6/9スロー');
  await expect(page.getByTestId('metric-3DA')).toContainText('59.38');
  await page.screenshot({ path: `test-results/analytics-audit-akdo-${info.project.name}.png`, fullPage: true });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  await expectNoAxeViolations(page, info);
});
