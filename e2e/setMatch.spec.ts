import { expect, test, type Page } from '@playwright/test';
import { serveNight } from './liveNight';
import { serveSetMatch } from './setMatchWorld';
import type { SetMatchControl } from './setMatchWorld';
import { setMid } from '../src/test/n01/setMatch';

/**
 * 「観戦 → いま n01 で進行中 → 個別の試合」 (and 注目選手) on canned n01, in a real browser: a
 * set-format match (one `scid`, a `mid` per set) on a page of its own. The case of 2026-11-16
 * (Light League): the screen stayed on ダブルス1 after ダブルス2 began, the earlier sets could
 * not be opened, and the bottom sheet left margins on both sides (PC) and on top (phone).
 *
 * The match is fictional (src/test/n01/setMatch.ts); the league around it is liveNight's.
 */

test.use({ serviceWorkers: 'block' });

const noSidewaysScroll = async (page: Page): Promise<void> => {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
};

async function openNow(page: Page, control: SetMatchControl): Promise<void> {
  await serveNight(page);
  await serveSetMatch(page, control);
  await page.goto('/');
  await page.getByRole('group', { name: 'よく使われるリーグ' }).getByRole('button', { name: 'ATDO' }).click();
  await expect(page.getByTestId('live-board')).toBeVisible();
  await page.getByRole('button', { name: /いま n01 で進行中の試合を見る/ }).click();
  await expect(page.getByTestId('now-view')).toBeVisible();
}

const shown = (page: Page) => page.getByTestId('shown-set');

test('a set ends, the next begins, the match ends — followed on one page, without reopening', async ({ page }) => {
  const control: SetMatchControl = { phase: 0, log: [] };
  await openNow(page, control);
  await page.getByTestId('now-single').filter({ hasText: 'Alpha 選手1-1' }).click();
  const setPage = page.getByTestId('set-page');
  await expect(setPage).toBeVisible();
  await expect(page.getByTestId('now-view')).toHaveCount(0);
  await expect(page.getByTestId('match-sheet')).toHaveCount(0);
  await expect(shown(page)).toContainText('シングルス1');
  await expect(page.getByTestId('set-page-title')).toHaveText('【デモリーグ】R3 Alpha Darts vs Bravo Arrows');
  await expect(page.getByTestId('live-leg')).toBeVisible();
  expect(page.url()).toContain(`m=${setMid(0)}`);

  control.phase = 1; // シングルス1 over: waiting for the next set, not the end
  await expect(page.getByTestId('set-wait')).toBeVisible();
  await expect(page.getByTestId('set-legs')).toHaveText('2 - 0');
  await expect(page.getByTestId('set-page-status')).not.toContainText('終了');

  control.phase = 2; // ダブルス1 began
  await expect(shown(page)).toContainText('ダブルス1');
  await expect(page.getByTestId('set-legs')).toHaveText('1 - 1');
  await expect(page.getByTestId('set-score')).toContainText('Alpha 選手2-1');
  await expect(page.getByTestId('set-score')).not.toContainText('Alpha 選手1-1');
  await expect(page.getByTestId('sets-won')).toContainText('1 - 0');
  await expect.poll(() => page.url()).toContain(`m=${setMid(1)}`);

  control.phase = 4; // ダブルス2 — the case of 2026-11-16
  await expect(shown(page)).toContainText('ダブルス2');
  await expect(page.getByTestId('set-score')).toContainText('Alpha 選手3-1');
  await expect(page.getByTestId('set-item')).toHaveCount(3);

  control.phase = 7; // the match is over
  await expect(page.getByTestId('set-page-status')).toContainText('終了');
  await expect(page.getByTestId('set-item')).toHaveCount(4);
  await expect(page.getByTestId('sets-won')).toContainText('2 - 2');
  const polled = control.log.filter((entry) => entry.startsWith('match/live')).length;
  await page.waitForTimeout(4000);
  expect(control.log.filter((entry) => entry.startsWith('match/live')).length).toBe(polled);
  // Followed by scid, as the manual says, and nothing but GETs of the public API were read.
  expect(control.log.some((entry) => entry.startsWith('match/live?scid='))).toBe(true);
  await noSidewaysScroll(page);
});

test('opened mid-match: the earlier sets from the first screen, each with its own score sheet, the live set still followed', async ({ page }) => {
  const control: SetMatchControl = { phase: 4, log: [] };
  await openNow(page, control);
  await page.getByTestId('now-single').filter({ hasText: 'Alpha 選手3-1' }).click();
  const items = page.getByTestId('set-item');
  await expect(items).toHaveCount(3);
  await expect(items.nth(0)).toContainText('シングルス1');
  await expect(items.nth(0)).toContainText('2 - 0');
  await expect(items.nth(1)).toContainText('ダブルス1');
  await expect(items.nth(1)).toContainText('1 - 2');
  await expect(items.nth(2)).toContainText('LIVE');

  await items.nth(1).click();
  await expect(shown(page)).toContainText('ダブルス1');
  await expect(page.getByTestId('set-score').getByTestId('score-sheet')).toBeVisible();
  await expect(page.getByTestId('set-score')).toContainText('Alpha 選手2-1');

  control.phase = 6; // シングルス2 began while ダブルス1 is open: the choice stays
  await expect(items).toHaveCount(4);
  await expect(items.nth(3)).toContainText('LIVE');
  await expect(shown(page)).toContainText('ダブルス1');

  await page.getByTestId('back-to-live').click();
  await expect(shown(page)).toContainText('シングルス2');
  await expect(page.getByTestId('live-leg')).toBeVisible();
  await expect(page.getByTestId('back-to-live')).toHaveCount(0);

  // Keyboard: the sets are one tab stop, chosen with the arrow keys.
  await items.nth(3).focus();
  await page.keyboard.press('Home');
  await expect(shown(page)).toContainText('シングルス1');
  await expect(items.nth(0)).toBeFocused();
});

test('back (on the page, and the browser’s) returns to the list; a reload and a copied link open the same set', async ({ page }) => {
  const control: SetMatchControl = { phase: 4, log: [] };
  await openNow(page, control);
  await page.getByTestId('now-single').first().click();
  await expect(shown(page)).toContainText('ダブルス2');
  await page.goBack();
  await expect(page.getByTestId('now-view')).toBeVisible();

  await page.getByTestId('now-single').first().click();
  await expect(page.getByTestId('set-item')).toHaveCount(3);
  await page.getByTestId('set-item').first().click();
  await expect(shown(page)).toContainText('シングルス1');
  await expect.poll(() => page.url()).toContain(`m=${setMid(0)}`);
  const copied = page.url();
  await page.reload();
  await expect(shown(page)).toContainText('シングルス1');
  await expect(page.getByTestId('back-to-live')).toBeVisible();
  // Opened directly: no list behind it in the history, so back shows the list in place.
  const back = page.getByTestId('set-page-back');
  const box = (await back.boundingBox())!;
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.y + box.height).toBeLessThanOrEqual(page.viewportSize()!.height);
  await back.click();
  await expect(page.getByTestId('now-view')).toBeVisible();

  await page.goto(copied);
  await expect(shown(page)).toContainText('シングルス1');
});

test('the page fills the screen: sets above the score on a phone, beside it on a PC', async ({ page, isMobile }) => {
  const control: SetMatchControl = { phase: 4, log: [] };
  await openNow(page, control);
  await page.getByTestId('now-single').first().click();
  await expect(page.getByTestId('set-item')).toHaveCount(3);
  await expect(page.getByTestId('live-leg')).toBeVisible();
  if (!isMobile) await expect(page.locator('.set-page.is-split')).toBeVisible();
  const nav = (await page.locator('.set-nav').boundingBox())!;
  const score = (await page.getByTestId('set-score').boundingBox())!;
  const main = (await page.locator('.app-main').boundingBox())!;
  if (isMobile) {
    expect(nav.y + nav.height).toBeLessThanOrEqual(score.y + 1);
    // As wide as the page, not a sheet with margins.
    expect(score.width).toBeGreaterThan(main.width - 40);
  } else {
    expect(nav.x + nav.width).toBeLessThanOrEqual(score.x);
    expect(Math.abs(nav.y - score.y)).toBeLessThan(40);
    expect(score.width).toBeGreaterThan(600);
  }
  await noSidewaysScroll(page);
  await page.setViewportSize({ width: 320, height: 640 });
  await expect(page.getByTestId('set-item').first()).toBeVisible();
  await noSidewaysScroll(page);
});

test('a followed player’s match (注目選手) opens the same page', async ({ page }) => {
  const control: SetMatchControl = { phase: 2, log: [], followedName: '青木 一郎' };
  await serveNight(page);
  await serveSetMatch(page, control);
  await page.goto('/');
  await page.getByRole('group', { name: 'よく使われるリーグ' }).getByRole('button', { name: 'ATDO' }).click();
  await page.getByRole('tab', { name: 'スタッツ' }).click();
  await page.getByTestId('stats-tab').getByRole('button', { name: '青木 一郎', exact: true }).click();
  await page.getByTestId('player-card').getByRole('button', { name: /注目選手に追加/ }).click();
  await page.getByRole('button', { name: '閉じる' }).click();
  await page.getByRole('tab', { name: 'ライブ' }).click();
  await page.getByRole('button', { name: /いま n01 で進行中の試合を見る/ }).click();
  const followed = page.getByTestId('followed-now');
  await expect(followed).toContainText('青木 一郎');
  await followed.getByRole('button').first().click();
  await expect(page.getByTestId('set-page')).toBeVisible();
  await expect(shown(page)).toContainText('ダブルス1');
  await expect(page.getByTestId('set-item')).toHaveCount(2);
});

test('an existing game link (#/watch?m=…) still opens that game, as before', async ({ page }) => {
  const control: SetMatchControl = { phase: 4, log: [] };
  await serveNight(page);
  await serveSetMatch(page, control);
  await page.goto(`/#/watch?m=${setMid(1)}`);
  const sheet = page.getByTestId('match-sheet');
  await expect(sheet).toBeVisible();
  await expect(sheet).toContainText('Alpha 選手2-1');
  await expect(sheet.getByTestId('score-sheet')).toBeVisible();
});

test('a finished set opens on its last leg played; with the live list failing, the 11 published sets stay listed', async ({ page }) => {
  // 2026-11-16 Light League: ダブルス1 ended at Leg 1 and n01 also held a Leg 2 with no throw.
  const control: SetMatchControl = { phase: 20, sets: 11, log: [], unstartedLegAfterEnd: true, liveListFails: true };
  await openNow(page, control);
  await page.getByTestId('now-single').first().click();
  const items = page.getByTestId('set-item');
  await expect(items).toHaveCount(11);
  await expect(page.getByTestId('sets-error')).toContainText('進行中のセットの一覧を取得できませんでした');
  await expect(page.getByTestId('live-leg')).toBeVisible();
  await items.nth(1).click(); // ダブルス1: 3 legs played, a 4th never begun
  await expect(shown(page)).toContainText('ダブルス1');
  await expect(page.getByTestId('leg-sheet')).toContainText('Leg 3 のスコア表');
  control.phase = 21; // the live score goes on while the list still fails
  await page.getByTestId('back-to-live').click();
  await expect(page.getByTestId('set-legs')).toHaveText('2 - 1');
  await expect(items).toHaveCount(11);
  await expect(page.getByTestId('set-page-title')).toHaveText('【デモリーグ】R3 Alpha Darts vs Bravo Arrows');
});
