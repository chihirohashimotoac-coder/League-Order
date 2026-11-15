import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { expectNoAxeViolations } from './axe';
import { TDA_PLAYER, TDA_PLAYER_NAME } from '../src/features/analytics/realData.tda.fixtures';
import { gamesOf, serveTdaWorld, SNAP } from './tdaWorld';

/**
 * シングルス opened directly, with no cache and no button: the shown player's leg details are read
 * by themselves, and First 9 / Keep率 / Break率 appear next to the 3DA from the game rows. Against a
 * fixture n01 holding the real TDA 2026年度 中期 season (`tdaWorld.ts`, read 2026-11-15); the long
 * cases (1,665 games, several seasons) are simulated on top of it. Figures are never injected into
 * the screen: the page reads them through its own requests.
 *
 * Expected (the pseudonymised player テスト選手029, `P028`, from the fixture, hand-checked in `realData.tda.test.ts`):
 * 9 games, 23 legs, 3DA 66.89 (487 darts), First 9 68.26 (4,710 / 207), Keep 90.9% (10/11),
 * Break 33.3% (4/12).
 */
test.use({ serviceWorkers: 'block' });

const PLAYER = TDA_PLAYER_NAME;

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
  for (const mid of gamesOf(TDA_PLAYER)) expect(gets.filter((e) => e === `match/get?mid=${mid}`)).toHaveLength(1);

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
  const singles = gamesOf(TDA_PLAYER)[0];
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

test('a game list cut off mid-way: shown as 取得失敗 with a retry, which reads the rows again, compares them, and goes on', async ({ page }) => {
  // Requests 5, 6 and 7 fail (one try and two bounded retries): the reading stops at its 6th page.
  const n01 = await serveTdaWorld(page, { fillerGames: 900, failList: [5, 6, 7] });
  await openSingles(page);
  await expect(page.getByTestId('reconstruction')).toHaveAttribute('data-state', 'failed', { timeout: 30_000 });
  await expect(page.getByTestId('metric-3DA')).not.toContainText('66.89');
  await page.getByTestId('analysis-details').locator('summary').first().click();
  const before = n01.log.filter((e) => e.startsWith('match/list')).length;
  await page.getByTestId('games-retry').click();
  await expectFigures(page);
  const after = n01.log.filter((e) => e.startsWith('match/list')).slice(before);
  // The 496 rows read before the stop are read again (they may have changed) and compared: nothing changed.
  expect(after[0]).not.toContain('skip=');
  expect(new Set(after).size).toBe(after.length);
  await expect(page.getByTestId('games-recollated')).toContainText('496件を照合し、変化なし');
});

test('an expired saved list shown offline is read again when back online; the same season\'s new content updates the player and the breakdown', async ({ page, context }) => {
  await page.clock.install({ time: new Date('2026-11-15T10:00:00+09:00') });
  const n01 = await serveTdaWorld(page);
  // n01 at first: one of the player's singles games not finished yet.
  const pending = gamesOf(TDA_PLAYER).find((mid) => (SNAP.games.find((g) => g.mid === mid)!.statsData as { order: unknown[] }[])[0].order.length === 1)!;
  n01.setUnfinished(pending);
  await openSingles(page);
  await expect(page.getByTestId('player-basis')).toContainText('8ゲーム', { timeout: 30_000 });
  await expect(page.getByTestId('reconstruction')).not.toHaveAttribute('data-state', /waiting|running/, { timeout: 30_000 });

  // Seven hours later (the running season's 6 hours are over), offline: the saved list is shown, marked as such.
  await page.clock.fastForward('07:00:00');
  await context.setOffline(true);
  await page.locator('.tab-bar').getByRole('button', { name: 'ホーム', exact: true }).click();
  await page.locator('.tab-bar').getByRole('button', { name: '分析', exact: true }).click();
  await page.getByTestId('scope-bar').getByRole('button', { name: 'シングルス', exact: true }).click();
  await page.locator('.analytics-roster').getByRole('button', { name: new RegExp(PLAYER) }).click();
  await expect(page.getByTestId('player-basis')).toContainText('8ゲーム');
  await expect(page.getByTestId('summary-stale')).toBeVisible();

  // n01 has the game finished now. Back online: read again by itself, no button pressed.
  n01.setUnfinished(null);
  const lists = n01.log.filter((e) => e.startsWith('match/list')).length;
  await context.setOffline(false);
  await expectFigures(page);
  expect(n01.log.filter((e) => e.startsWith('match/list')).length).toBeGreaterThan(lists);
  await expect(page.getByTestId('summary-stale')).toHaveCount(0);
  await page.getByTestId('analysis-details').locator('summary').first().click();
  await expect(page.getByTestId('focus-summary')).toContainText('取得済み');
  await expect(page.getByTestId('metric-adoption').locator('li', { hasText: 'First 9' })).toContainText('Leg明細を照合できた選手のみ採用');
});

test('the browser\'s storage refuses every write: lists and leg details are still read once each (直近3季, 75 legs)', async ({ page }) => {
  await page.addInitScript(() => {
    // Storage failure (the quota, a broken database): every write to the analytics database fails
    // (the app's own database is left alone).
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function guarded(this: IDBObjectStore, ...args: Parameters<IDBObjectStore['put']>): IDBRequest<IDBValidKey> {
      if (this.transaction.db.name === 'league-order-analytics') throw new DOMException('simulated quota', 'QuotaExceededError');
      return put.apply(this, args);
    };
  });
  const n01 = await serveTdaWorld(page, { copies: 3 });
  await openSingles(page);
  await expectFigures(page); // 今季 read to its end (nothing could be stored)
  await page.getByRole('button', { name: '直近3季', exact: true }).click();
  await page.locator('.analytics-roster').getByRole('button', { name: new RegExp(PLAYER) }).click();
  await expect(page.getByTestId('summary-used')).toHaveText('3', { timeout: 30_000 });
  await expectFigures(page, 69, 27);
  const mine = n01.log.filter((e) => e.startsWith('match/get') && gamesOf(TDA_PLAYER).some((mid) => e.includes(mid)));
  expect(new Set(mine).size).toBe(75);
  // 今季 first, then 直近3季: the newest season's 25 legs were read for 今季 and kept in memory.
  expect(mine).toHaveLength(75);
  const lists = n01.log.filter((e) => e.startsWith('match/list') && e.includes('tmid__regex=_lg_'));
  expect(new Set(lists).size).toBe(lists.length);
  await page.getByTestId('reconstruction-details').locator('summary').click();
  await expect(page.getByTestId('detail-save-failed')).toBeVisible();
});

test('01全体 shown while a part of the leg read is under way: that part ends, the next one does not start; back to シングルス it goes on', async ({ page }) => {
  // Four seasons (直近12季 finds four): 今季's 25 legs are read first; the other 75 are read as the
  // seasons' lists arrive (one read per season, or parts of 60 requests when the lists came first).
  // The exact pause between two parts is covered by `realData.tda.multi.test.tsx`.
  const n01 = await serveTdaWorld(page, { copies: 4 });
  await openSingles(page);
  await expectFigures(page);
  const before = n01.log.filter((e) => e.startsWith('match/get')).length;
  const hold = n01.holdDetail(before + 10); // a request of the first read of the period
  await page.getByRole('button', { name: '直近12季', exact: true }).click();
  await page.locator('.analytics-roster').getByRole('button', { name: new RegExp(PLAYER) }).click();
  await hold.reached;
  await page.getByTestId('scope-bar').getByRole('button', { name: '01全体', exact: true }).click();
  hold.release();
  await page.waitForTimeout(1500);
  const paused = n01.log.filter((e) => e.startsWith('match/get')).length;
  await page.waitForTimeout(1000);
  // The read under way was read to its end; nothing new started in 01全体 (the lists still arrived).
  expect(paused - before).toBeLessThan(75);
  expect(n01.log.filter((e) => e.startsWith('match/get')).length).toBe(paused);
  await page.getByTestId('scope-bar').getByRole('button', { name: 'シングルス', exact: true }).click();
  await expectFigures(page, 92, 36);
  const mine = n01.log.filter((e) => e.startsWith('match/get') && gamesOf(TDA_PLAYER).some((mid) => e.includes(mid)));
  expect(new Set(mine).size).toBe(100);
  expect(mine).toHaveLength(100);
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
  const mine = gets.filter((e) => gamesOf(TDA_PLAYER).some((mid) => e.includes(mid)));
  expect(new Set(mine).size).toBe(75);
  expect(mine).toHaveLength(75);
  await expect(page.getByTestId('reconstruction')).toContainText('3季すべて');
});
