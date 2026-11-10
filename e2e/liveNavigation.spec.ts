import { expect, test, type Page } from '@playwright/test';
import { serveNight } from './liveNight';

/**
 * Watching a league night (2026-11-10 review of ライブ・観戦), in a real browser on canned n01:
 * - the first screen says which leg is on and the points left, without scrolling (phone);
 * - the chosen card's ring is whole (it was clipped by the sideways-scrolling row);
 * - an earlier leg of the live game, and an earlier game of the card, open in place — each with
 *   its own score sheet — and one tap returns to the live leg / game;
 * - another team's card is one tap away from anywhere on the page;
 * - the players' season figures (how strong the opponent is) sit with the scoreboard;
 * - a league whose event is a knockout tournament (JDO's opens) shows its matches.
 */

test.use({ serviceWorkers: 'block' });

async function openNight(page: Page): Promise<void> {
  await serveNight(page);
  await page.goto('/');
  await page.getByRole('group', { name: 'よく使われるリーグ' }).getByRole('button', { name: 'ATDO' }).click();
  await expect(page.getByTestId('live-board')).toBeVisible();
}

const noSidewaysScroll = async (page: Page): Promise<void> => {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
};

test('the leg in progress and the points left are on the first screen', async ({ page, isMobile }) => {
  await openNight(page);
  const focus = page.getByTestId('focus-card');
  await expect(focus.getByTestId('live-leg')).toContainText('シングルス1');
  await expect(focus.getByTestId('live-leg')).toContainText('Leg 3 進行中');
  await expect(focus.getByTestId('next-thrower')).toContainText('256');
  // Tiles: the game and leg in progress, and who is playing it.
  const tile = page.getByTestId('board-tile').first();
  await expect(tile).toContainText('LIVE');
  await expect(tile).toContainText('S1 ・ Leg 3 (1-1)');
  await expect(tile).toContainText('青木 一郎 vs 加藤 健');
  if (isMobile) {
    // Nothing to scroll for: the points left end above the bottom bar.
    const left = (await focus.getByTestId('next-thrower').boundingBox())!;
    const bar = (await page.locator('.tab-bar').boundingBox())!;
    expect(await page.evaluate(() => window.scrollY)).toBe(0);
    expect(left.y + left.height).toBeLessThanOrEqual(bar.y);
  }
  await noSidewaysScroll(page);
});

test('the chosen card’s ring is drawn whole, inside the row that scrolls sideways', async ({ page }) => {
  await openNight(page);
  for (const index of [0, 1]) {
    const tile = page.getByTestId('board-tile').nth(index);
    await tile.click();
    await expect(tile).toHaveAttribute('aria-pressed', 'true');
    const drawn = await tile.evaluate((el) => {
      const style = getComputedStyle(el);
      const row = el.closest('.board')!.getBoundingClientRect();
      const box = el.getBoundingClientRect();
      // Everything the ring is made of (border, inset shadow) is inside the tile's own box;
      // an outline would be outside it, where the scrolling row clips.
      return { outline: style.outlineStyle, shadow: style.boxShadow, inside: box.top >= row.top && box.left >= row.left && box.bottom <= row.bottom };
    });
    expect(drawn.outline).toBe('none');
    expect(drawn.shadow).toContain('inset');
    expect(drawn.inside).toBe(true);
  }
});

test('an earlier leg of the live game opens in place and one tap returns to the live leg', async ({ page }) => {
  await openNight(page);
  const board = page.getByTestId('live-board');
  const tabs = board.getByTestId('leg-tabs').getByRole('button');
  await expect(tabs).toHaveCount(3);
  await expect(tabs.nth(0)).toContainText('青木 18本');
  await expect(tabs.nth(1)).toContainText('加藤 18本');
  await expect(tabs.nth(2)).toContainText('進行中');
  await expect(tabs.nth(2)).toHaveAttribute('aria-pressed', 'true');

  await tabs.nth(0).click();
  const past = board.getByTestId('past-leg');
  await expect(past).toContainText('Leg 1 (終了) のスコアを表示中');
  // Leg 1's own sheet: its last visits (61, then the finish) — not the live leg's.
  await expect(past.getByTestId('score-sheet')).toContainText('261');
  await expect(past.getByTestId('score-sheet')).toContainText('x2');
  await expect(board.getByTestId('live-scroll')).toBeHidden();
  // The live points left stay in sight.
  await expect(board.getByTestId('next-thrower')).toContainText('256');

  await tabs.nth(1).click();
  await expect(past).toContainText('Leg 2 (終了)');
  await expect(past.getByTestId('score-sheet')).toContainText('361');

  await board.getByTestId('back-to-live-leg').click();
  await expect(past).toHaveCount(0);
  await expect(board.getByTestId('live-scroll')).toBeVisible();
  await expect(tabs.nth(2)).toHaveAttribute('aria-pressed', 'true');
  await noSidewaysScroll(page);
});

test('an earlier game of the card opens in place; the live game stays one tap away', async ({ page }) => {
  await openNight(page);
  const focus = page.getByTestId('focus-card');
  const games = focus.getByTestId('game-tab');
  await expect(games).toHaveCount(5);
  await expect(games.nth(0)).toContainText('1-0');
  await expect(games.nth(1)).toContainText('1-2');
  await expect(games.nth(3)).toContainText('LIVE');
  await expect(games.nth(3)).toHaveAttribute('aria-pressed', 'true');
  await expect(games.nth(4)).toBeDisabled();

  await games.nth(1).click();
  const block = focus.getByTestId('game-block');
  await expect(block).toContainText('ダブルス1');
  await expect(block).toContainText('青木 一郎 / 井上 次郎');
  await expect(block.getByTestId('game-view')).toContainText('Legs');
  await expect(focus.getByTestId('live-board')).toBeHidden();
  // One line keeps the live game in sight, and returns to it.
  const back = focus.getByTestId('back-to-live');
  await expect(back).toContainText('シングルス1 ・ Leg 3');
  await expect(back).toContainText('残り 120 / 256');
  await back.click();
  await expect(focus.getByTestId('live-board')).toBeVisible();
  await expect(block).toHaveCount(0);
  await expect(games.nth(3)).toHaveAttribute('aria-pressed', 'true');
});

test('right after a game ends, the previous game’s tab opens that game (the list of games is a few seconds behind)', async ({ page }) => {
  let next = false;
  await serveNight(page, { nextGameStarted: () => next });
  await page.goto('/');
  await page.getByRole('group', { name: 'よく使われるリーグ' }).getByRole('button', { name: 'ATDO' }).click();
  const focus = page.getByTestId('focus-card');
  const games = focus.getByTestId('game-tab');
  await expect(games.nth(3)).toContainText('LIVE');

  // Singles 2 starts: the live game says so at once; the game list still has Singles 1 unfinished.
  next = true;
  await expect(focus.getByTestId('live-leg')).toContainText('シングルス2');
  await expect(games.nth(4)).toContainText('LIVE');
  await expect(games.nth(4)).toHaveAttribute('aria-pressed', 'true');
  await expect(games.nth(4)).toBeEnabled();
  await expect(games.nth(3)).not.toContainText('LIVE');

  // The previous game's tab opens the previous game — not the live one again.
  await games.nth(3).click();
  await expect(games.nth(3)).toHaveAttribute('aria-pressed', 'true');
  await expect(focus.getByTestId('game-block')).toContainText('シングルス1');
  await expect(focus.getByTestId('game-block')).toContainText('青木 一郎');
  await expect(focus.getByTestId('live-board')).toBeHidden();
  await focus.getByTestId('back-to-live').click();
  await expect(focus.getByTestId('live-leg')).toContainText('シングルス2');
  await expect(games.nth(4)).toHaveAttribute('aria-pressed', 'true');
});

test('another team’s card is one tap away from anywhere on the page', async ({ page }) => {
  await openNight(page);
  // Scrolling down: the tiles stay under the header, shrink to two lines, and nothing below moves.
  const sheet = page.getByTestId('score-sheet').first();
  await page.evaluate(() => window.scrollTo(0, 900));
  const other = page.getByTestId('board-tile').nth(1);
  await expect(other).toBeInViewport();
  await expect(page.locator('.board')).toHaveClass(/is-stuck/u);
  const docTop = (): Promise<number> => sheet.evaluate((el) => Math.round(el.getBoundingClientRect().top + window.scrollY));
  const stuckAt = await docTop();
  await page.evaluate(() => window.scrollTo(0, 0));
  await expect(page.locator('.board')).not.toHaveClass(/is-stuck/u);
  expect(await docTop()).toBe(stuckAt);
  await page.evaluate(() => window.scrollTo(0, 900));
  await expect(page.locator('.board')).toHaveClass(/is-stuck/u);
  await other.click();
  await expect(page.getByTestId('focus-card')).toHaveAttribute('aria-label', 'Bulls 対 Doubles');
  await expect(page.getByTestId('focus-card').getByTestId('live-leg')).toContainText('ダブルス1');
  await noSidewaysScroll(page);
});

test('the players’ season figures sit with the scoreboard and open the player card', async ({ page }) => {
  await openNight(page);
  const focus = page.getByTestId('focus-card');
  const levels = focus.getByTestId('player-levels');
  await expect(levels).toContainText('75.15');
  await expect(levels).toContainText('Leg 21/30');
  await expect(levels).toContainText('60.00');
  await expect(levels).toContainText('Leg 13/30');
  // Who plays next, with their season average.
  await expect(focus.getByTestId('upcoming')).toContainText('シングルス2 井上 次郎 (60.0) vs 木村 守 (49.1)');
  await levels.getByRole('button', { name: '加藤 健' }).click();
  await expect(page.getByRole('dialog')).toContainText('加藤 健');
});

test('a league whose event is a knockout tournament (JDO) shows its matches', async ({ page }) => {
  await serveNight(page);
  await page.goto('/');
  await page.getByRole('button', { name: 'JDO の大会・リーグを探す' }).click();
  await page.getByRole('button', { name: /Sample Open Darts Tournament/ }).click();
  await expect(page.getByTestId('watch-page')).toBeVisible();
  const hub = page.getByTestId('tournament-hub');
  await expect(hub).toBeVisible();
  await page.getByRole('tab', { name: '試合' }).click();
  await expect(hub.getByTestId('competition-match')).toContainText('山田 太郎');
  await expect(hub.getByTestId('competition-match')).toContainText('3 - 1');
  await noSidewaysScroll(page);
});
