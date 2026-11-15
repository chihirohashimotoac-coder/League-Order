import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { expectNoAxeViolations } from './axe';
import { gamesOf, serveTdaWorld } from './tdaWorld';

/**
 * シングルス opened directly, with no cache and no button: the shown player's leg details are read
 * by themselves, and First 9 / Keep率 / Break率 appear next to the 3DA from the game rows. Against a
 * fixture n01 holding the real TDA 2026年度 中期 season (`tdaWorld.ts`, read 2026-11-15); the long
 * cases (1,665 games, several seasons) are simulated on top of it. Figures are never injected into
 * the screen: the page reads them through its own requests.
 *
 * Expected (ニシマタ タイヨウ, `wlp9`, from the fixture, hand-checked in `realData.tda.test.ts`):
 * 9 games, 23 legs, 3DA 66.89 (487 darts), First 9 68.26 (4,710 / 207), Keep 90.9% (10/11),
 * Break 33.3% (4/12).
 */
test.use({ serviceWorkers: 'block' });

const PLAYER = 'ニシマタ タイヨウ';

async function openSingles(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByRole('button', { name: 'n01から作成' }).click();
  const wizard = page.getByRole('dialog', { name: 'n01から作成' });
  await wizard.getByRole('button', { name: 'TDA', exact: true }).click();
  await wizard.getByRole('button', { name: /ドリズ カム トゥルー/ }).click();
  await wizard.getByRole('button', { name: 'このチームを作成' }).click();
  await expect(page.getByRole('heading', { name: 'ドリズ カム トゥルー', level: 1 })).toBeVisible();
  await page.locator('.tab-bar').getByRole('button', { name: '分析', exact: true }).click();
  await expect(page.getByTestId('analytics-page')).toBeVisible();
  await page.getByTestId('scope-bar').getByRole('button', { name: 'シングルス', exact: true }).click();
  await page.locator('.analytics-roster').getByRole('button', { name: new RegExp(PLAYER) }).click();
  await expect(page.getByTestId('analytics-detail').getByRole('heading', { name: new RegExp(PLAYER) })).toBeVisible();
}

async function expectFigures(page: Page, legs = 23, games = 9): Promise<void> {
  await expect(page.getByTestId('reconstruction')).toHaveAttribute('data-state', 'done', { timeout: 30_000 });
  await expect(page.getByTestId('player-basis')).toContainText(`${games}ゲーム`);
  await expect(page.getByTestId('metric-3DA')).toContainText('66.89');
  await expect(page.getByTestId('metric-First 9')).toContainText('68.26');
  await expect(page.getByTestId('metric-Keep率')).toContainText('90.9%');
  await expect(page.getByTestId('metric-Break率')).toContainText('33.3%');
  await expect(page.getByTestId('metric-Leg勝率')).toContainText(`${legs}`);
  await expect(page.getByTestId('reconstruct-run')).toHaveCount(0);
  await expect(page.getByTestId('reconstruct-retry')).toHaveCount(0);
}

test('TDA: シングルス opened directly reads the shown player\'s legs by itself; cards and the breakdown agree', async ({ page }, info) => {
  const n01 = await serveTdaWorld(page);
  await openSingles(page);
  await expectFigures(page);
  await expect(page.getByTestId('metric-First 9')).toContainText('Leg明細から復元');
  // His 25 games (9 singles, 7 doubles, 9 team games) were each read exactly once; the doubles view was never opened.
  const gets = n01.log.filter((e) => e.startsWith('match/get'));
  for (const mid of gamesOf('wlp9')) expect(gets.filter((e) => e === `match/get?mid=${mid}`)).toHaveLength(1);

  // 集計の内訳: First 9 / Keep / Break are adopted for the players read — not "対象外" for everyone —
  // and the shown player's state is told apart from the league's.
  const details = page.getByTestId('analysis-details');
  await details.locator('summary').first().click();
  await expect(page.getByTestId('focus-summary')).toContainText(PLAYER);
  await expect(page.getByTestId('focus-summary')).toContainText('取得済み');
  const adoption = page.getByTestId('metric-adoption');
  await expect(adoption.locator('li', { hasText: 'First 9' })).toContainText('Leg明細を照合できた選手のみ採用');
  await expect(adoption.locator('li', { hasText: 'Keep / Break' })).toContainText('Leg明細を照合できた選手のみ採用');
  await expect(adoption.locator('li', { hasText: 'First 9' })).not.toContainText('この表示では対象外');
  await page.screenshot({ path: `test-results/analytics-singles-tda-${info.project.name}.png`, fullPage: true });

  // Tab round trip: ダブルス uses the same read (his doubles 3DA appears), and nothing is read again.
  const settled = n01.log.filter((e) => e.startsWith('match/get')).length;
  await page.getByTestId('scope-bar').getByRole('button', { name: 'ダブルス', exact: true }).click();
  await expect(page.getByTestId('reconstruction')).toHaveAttribute('data-state', 'done');
  await expect(page.getByTestId('metric-3DA')).toContainText('Leg明細から復元');
  await page.getByTestId('scope-bar').getByRole('button', { name: 'シングルス', exact: true }).click();
  await expectFigures(page);
  expect(n01.log.filter((e) => e.startsWith('match/get')).length).toBe(settled);

  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  await expectNoAxeViolations(page, info);
});

test('TDO size (1,665 rows): the 17th match/list request is reached; an unfinished game is not counted', async ({ page }) => {
  const singles = gamesOf('wlp9')[0];
  const n01 = await serveTdaWorld(page, { fillerGames: 1665 - 77 - 1, unfinishedOf: singles });
  await openSingles(page);
  await expectFigures(page);
  const lists = n01.log.filter((e) => e.startsWith('match/list') && e.includes('tmid__regex=_lg_'));
  expect(lists).toHaveLength(17);
  expect(new Set(lists).size).toBe(17);
  // Doubles are aggregated from the same lists.
  await page.getByTestId('scope-bar').getByRole('button', { name: 'ダブルス', exact: true }).click();
  await expect(page.getByTestId('player-basis')).toContainText('7ゲーム');
  await expect(page.getByTestId('reconstruction')).toHaveAttribute('data-state', 'done');
});

test('a game list cut off mid-way: shown as 取得失敗 with a retry, which continues from where it stopped', async ({ page }) => {
  // Requests 5, 6 and 7 fail (one try and two bounded retries): the season stops at its 6th page.
  const n01 = await serveTdaWorld(page, { fillerGames: 900, failList: [5, 6, 7] });
  await openSingles(page);
  await expect(page.getByTestId('reconstruction')).toHaveAttribute('data-state', 'failed', { timeout: 30_000 });
  await expect(page.getByTestId('metric-3DA')).not.toContainText('66.89');
  await page.getByTestId('analysis-details').locator('summary').first().click();
  const before = n01.log.filter((e) => e.startsWith('match/list')).length;
  await page.getByTestId('games-retry').click();
  await expectFigures(page);
  const after = n01.log.filter((e) => e.startsWith('match/list')).slice(before);
  // Continued from the last row read (5 pages: 100 + 99·4 = 496 rows → skip 495), never from the start.
  expect(after[0]).toContain('skip=495');
  expect(after.some((e) => !e.includes('skip='))).toBe(false);
});

test('直近3季 (simulated copies of the season): more than 60 leg details for one player, read part after part', async ({ page }) => {
  const n01 = await serveTdaWorld(page, { copies: 3 });
  await openSingles(page);
  // 今季 first: its 25 games are read and kept; the period of three seasons reuses them.
  await expectFigures(page);
  await page.getByRole('button', { name: '直近3季', exact: true }).click();
  await page.locator('.analytics-roster').getByRole('button', { name: new RegExp(PLAYER) }).click();
  await expect(page.getByTestId('summary-used')).toHaveText('3', { timeout: 30_000 });
  await expectFigures(page, 69, 27);
  const gets = n01.log.filter((e) => e.startsWith('match/get'));
  const mine = gets.filter((e) => gamesOf('wlp9').some((mid) => e.includes(mid)));
  expect(new Set(mine).size).toBe(75);
  expect(mine).toHaveLength(75);
  await expect(page.getByTestId('reconstruction')).toContainText('3季すべて');
});
