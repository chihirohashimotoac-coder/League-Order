import { expect, test, type Page } from '@playwright/test';
import { serveNight } from './liveNight';

/**
 * UI / UX audit of 2026-11-12 (three rounds), on canned n01 in a real browser:
 * - live: each name right above its own points left; refresh state and n01's time under the score;
 *   the leg in progress fully in view when the row of legs scrolls sideways;
 * - 観戦 tabs: Left / Right move between tabs, Tab leaves the tab list;
 * - a card's link: it opens again after a reload, the browser's back returns to the list with
 *   focus on the card;
 * - a phone shows rank, team, points and the movement of the standings without scrolling sideways.
 */

test.use({ serviceWorkers: 'block' });

async function openNight(page: Page): Promise<void> {
  await serveNight(page);
  await page.goto('/');
  await page.getByRole('group', { name: 'よく使われるリーグ' }).getByRole('button', { name: 'ATDO' }).click();
  await expect(page.getByTestId('live-board')).toBeVisible();
}

test('live: names sit above their own points left, the refresh state is under the score', async ({ page }) => {
  await openNight(page);
  const board = page.getByTestId('live-board');
  const names = board.getByTestId('ns-name');
  const scores = board.locator('.ns-big');
  for (const side of [0, 1]) {
    const name = (await names.nth(side).boundingBox())!;
    const score = (await scores.nth(side).boundingBox())!;
    expect(Math.abs(name.x + name.width / 2 - (score.x + score.width / 2))).toBeLessThanOrEqual(2);
    expect(name.y).toBeLessThan(score.y);
  }
  const status = board.getByTestId('score-status');
  await expect(status).toContainText(/自動更新中|接続中/u);
  await expect(status).toContainText(/n01 更新|未取得/u);
  const below = (await status.boundingBox())!.y - (await scores.first().boundingBox())!.y;
  expect(below).toBeLessThan(200);
});

test('live: the leg in progress is fully visible at the end of a row of legs that scrolls sideways', async ({ page }) => {
  // Wide leg tabs make three legs overflow the row, as eight or more do at normal width.
  await page.addInitScript(() => {
    document.addEventListener('DOMContentLoaded', () => {
      const style = document.createElement('style');
      style.textContent = '.ns-legtabs { grid-auto-columns: 260px !important; }';
      document.head.append(style);
    });
  });
  await openNight(page);
  const row = page.getByTestId('live-board').getByTestId('leg-tabs');
  await expect(row.getByRole('button')).toHaveCount(3);
  const fits = async (): Promise<boolean> =>
    row.evaluate((el) => {
      const live = el.querySelector('.leg-tab.is-live')!.getBoundingClientRect();
      const box = el.getBoundingClientRect();
      return el.scrollWidth > el.clientWidth && live.left >= box.left - 1 && live.right <= box.right + 1;
    });
  await expect.poll(fits).toBe(true);
  // Reading an earlier leg keeps that leg where the viewer put it; returning shows the live one again.
  await row.getByRole('button').first().click();
  await expect(page.getByTestId('past-leg')).toBeVisible();
  await page.getByTestId('back-to-live-leg').click();
  await expect.poll(fits).toBe(true);
});

test('観戦 tabs: arrow keys move between tabs, Tab leaves the list for the panel', async ({ page }) => {
  await openNight(page);
  const live = page.getByRole('tab', { name: 'ライブ' });
  await live.focus();
  await page.keyboard.press('ArrowRight');
  const results = page.getByRole('tab', { name: '日程・結果' });
  await expect(results).toBeFocused();
  await expect(results).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByTestId('results-tab')).toBeVisible();
  await page.keyboard.press('ArrowLeft');
  await expect(live).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Tab');
  // The next stop is in the panel, not another tab.
  expect(await page.evaluate(() => document.activeElement?.getAttribute('role'))).not.toBe('tab');
});

test('a card link opens the same card after a reload; back returns to the list and the card', async ({ page }) => {
  await openNight(page);
  await page.getByRole('tab', { name: '日程・結果' }).click();
  await page.getByRole('radio', { name: 'すべて' }).click();
  const card = page.getByTestId('match-card').first();
  const key = await card.getAttribute('data-card-key');
  await card.click();
  await expect(page.getByTestId('match-detail')).toBeVisible();
  expect(page.url()).toContain('#/watch?');
  expect(page.url()).toContain(`c=${key}`);
  const title = await page.getByTestId('match-detail').locator('.focus-head').innerText();

  await page.reload();
  await expect(page.getByTestId('match-detail')).toBeVisible();
  await expect(page.getByTestId('match-detail').locator('.focus-head')).toHaveText(title);

  // Opened from a link: 一覧に戻る leads to the season's list (not out of the app).
  await page.getByRole('button', { name: /一覧に戻る/ }).click();
  await expect(page.getByTestId('results-tab')).toBeVisible();

  // Opened from the list: the browser's back returns to it, focus on the card.
  await page.getByRole('radio', { name: 'すべて' }).click();
  await page.locator(`[data-card-key="${key}"]`).click();
  await expect(page.getByTestId('match-detail')).toBeVisible();
  await page.goBack();
  await expect(page.getByTestId('results-tab')).toBeVisible();
  await expect(page.locator(`[data-card-key="${key}"]`)).toBeFocused();
});

test('a link to a card that does not exist says so and leads to the list', async ({ page }) => {
  await serveNight(page);
  await page.goto('/#/watch?l=lg_l3hI_3397&c=9_none');
  await expect(page.getByTestId('watch-page')).toBeVisible();
  await expect(page.getByTestId('card-not-found')).toBeVisible({ timeout: 30_000 });
  await page.getByTestId('card-not-found').getByRole('button', { name: '一覧を表示' }).click();
  await expect(page.getByTestId('card-not-found')).toHaveCount(0);
});

test('standings on a 390 px phone: rank, team, points and the movement without scrolling sideways', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openNight(page);
  await page.getByRole('tab', { name: '順位' }).click();
  const table = page.getByTestId('standings-table').first();
  await expect(table).toBeVisible();
  const wrap = table.locator('xpath=..');
  expect(await wrap.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
  await expect(table).toContainText('n01 公式');
});
