import { expect, test, type Page } from '@playwright/test';
import { serveNight } from './liveNight';
import { serveNowCompetition, serveSetMatch } from './setMatchWorld';
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
  await expect(page.getByTestId('now-view')).toBeHidden(); // kept underneath, for the way back
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
  await expect(items.nth(0)).toContainText('2-0');
  await expect(items.nth(1)).toContainText('ダブルス1');
  await expect(items.nth(1)).toContainText('1-2');
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

test('the page fills the screen: the sets above the score, on a phone and on a PC alike', async ({ page, isMobile }) => {
  const control: SetMatchControl = { phase: 4, log: [] };
  await openNow(page, control);
  await page.getByTestId('now-single').first().click();
  await expect(page.getByTestId('set-item')).toHaveCount(3);
  await expect(page.getByTestId('live-leg')).toBeVisible();
  const chips = (await page.getByTestId('set-list').boundingBox())!;
  const score = (await page.getByTestId('set-score').boundingBox())!;
  const main = (await page.locator('.app-main').boundingBox())!;
  // The same order as every match view: the units, then the score under them.
  expect(chips.y + chips.height).toBeLessThanOrEqual(score.y + 1);
  // As wide as the page, not a sheet with margins.
  expect(score.width).toBeGreaterThan(main.width - (isMobile ? 40 : 80));
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

test('an existing game link (#/watch?m=…) still opens that game — on the same page as every game', async ({ page }) => {
  const control: SetMatchControl = { phase: 4, log: [] };
  await serveNight(page);
  await serveSetMatch(page, control);
  await page.goto(`/#/watch?m=${setMid(1)}`);
  const setPage = page.getByTestId('set-page');
  await expect(setPage).toBeVisible();
  await expect(page.getByTestId('match-sheet')).toHaveCount(0);
  await expect(page.getByTestId('shown-set')).toContainText('ダブルス1');
  await expect(setPage.getByTestId('score-sheet')).toBeVisible();
  await page.getByTestId('set-page-back').click();
  await expect(page.getByTestId('set-page')).toHaveCount(0);
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

test('大会・リーグ: a game of a competition opens on the same page; back (on the page, and the browser’s) returns to the competition', async ({ page }) => {
  await serveNight(page);
  await serveSetMatch(page, { phase: 4, log: [] });
  await serveNowCompetition(page);
  await page.goto('/');
  await page.getByRole('group', { name: 'よく使われるリーグ' }).getByRole('button', { name: 'ATDO' }).click();
  await page.getByRole('button', { name: /いま n01 で進行中の試合を見る/ }).click();
  await page.getByTestId('now-view').getByRole('button', { name: /Sample Open/ }).click();
  const hub = page.getByTestId('tournament-hub');
  await expect(hub.getByTestId('competition-match').first()).toBeVisible();
  // By keyboard: the page takes the focus (the list under it is hidden), and back returns it.
  await hub.getByTestId('competition-match').first().focus();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('set-page')).toBeVisible();
  await expect(page.locator('.match-page')).toBeFocused();
  await page.getByTestId('set-page-back').focus();
  await page.keyboard.press('Enter');
  await expect(hub.getByTestId('competition-match').first()).toBeFocused();
  await hub.getByTestId('competition-match').first().click();
  await expect(page.getByTestId('set-page')).toBeVisible();
  await expect(page.getByTestId('set-page-title')).toContainText('Sample Open');
  await expect(page.getByTestId('match-sheet')).toHaveCount(0);
  await expect(page.getByTestId('set-page-back')).toContainText('に戻る');
  await expect(hub).toBeHidden();
  await noSidewaysScroll(page);
  await page.goBack();
  await expect(hub).toBeVisible();
  await expect(page.getByTestId('set-page')).toHaveCount(0);
  await hub.getByTestId('competition-match').first().click();
  await page.getByTestId('set-page-back').click();
  await expect(hub).toBeVisible();
});

test('日程・結果: a card in progress is followed live, as on the live tab, with ライブに戻る from an earlier game', async ({ page }) => {
  await serveNight(page);
  await page.goto('/');
  await page.getByRole('group', { name: 'よく使われるリーグ' }).getByRole('button', { name: 'ATDO' }).click();
  await page.getByRole('tab', { name: '日程・結果' }).click();
  await page.getByTestId('match-card').filter({ hasText: 'Corks' }).filter({ hasText: '進行中' }).first().click();
  const detail = page.getByTestId('match-detail');
  // The game being played: the live scoreboard, the same as on the live tab.
  await expect(detail.getByTestId('live-leg')).toContainText('Leg 3 進行中');
  await expect(detail.getByTestId('game-tab').nth(3)).toContainText('LIVE');
  await detail.getByTestId('game-tab').nth(1).click();
  await expect(detail.getByTestId('game-panel')).toContainText('ダブルス1');
  await detail.getByTestId('back-to-live').click();
  await expect(detail.getByTestId('live-leg')).toBeVisible();
  await expect(detail.getByTestId('back-to-live')).toHaveCount(0);
});

test('日程・結果: the card followed to its end while the season list stays behind — the last game, its chip, the end and n01’s score agree, and polling stops', async ({ page }) => {
  let phase = 0; // 0: シングルス1 in play, 1: シングルス2 in play, 2: the card over
  const log = await serveNight(page, { nextGameStarted: () => phase >= 1, cardEnded: () => phase >= 2 });
  await page.goto('/');
  await page.getByRole('group', { name: 'よく使われるリーグ' }).getByRole('button', { name: 'ATDO' }).click();
  await page.getByRole('tab', { name: '日程・結果' }).click();
  await page.getByTestId('match-card').filter({ hasText: 'Corks' }).filter({ hasText: '進行中' }).first().click();
  const detail = page.getByTestId('match-detail');
  const chips = detail.getByTestId('game-tab');
  await expect(detail.getByTestId('live-leg')).toContainText('Leg 3 進行中');
  await expect(chips.nth(3)).toContainText('LIVE');

  phase = 1;
  await expect(chips.nth(4)).toContainText('LIVE');
  await expect(chips.nth(3)).not.toContainText('LIVE');
  await expect(detail.getByTestId('game-panel')).toContainText('シングルス2');

  phase = 2;
  // The last game, over: its own legs on its chip and in the panel, the card over, n01's score.
  await expect(chips.nth(4)).toContainText('1-2');
  await expect(chips.nth(4)).not.toContainText('LIVE');
  await expect(chips.nth(4)).toBeEnabled();
  await expect(detail.getByTestId('live-leg')).toHaveCount(0);
  await expect(detail.getByTestId('game-panel')).toContainText('シングルス2');
  await expect(detail.getByTestId('game-panel')).toContainText('終了');
  await expect(detail.getByTestId('game-panel')).not.toContainText('進行中');
  await expect(detail.locator('.focus-head strong')).toHaveText('3 - 2');
  await expect(detail.locator('.match-note')).not.toContainText('進行中');
  await expect(detail.getByTestId('game-tab').filter({ hasText: 'LIVE' })).toHaveCount(0);
  // No more live reads once the card is over, and nothing goes back while the list stays behind.
  const reads = (): number => log.filter((entry) => entry.startsWith('match/live')).length;
  const before = reads();
  await page.waitForTimeout(4_000);
  expect(reads()).toBe(before);
  await expect(detail.getByTestId('game-panel')).toContainText('シングルス2');
  await expect(chips.nth(4)).toContainText('1-2');
});

test('日程・結果: an earlier game chosen stays chosen through the next game and the end, and the last game can still be opened', async ({ page }) => {
  let phase = 0;
  await serveNight(page, { nextGameStarted: () => phase >= 1, cardEnded: () => phase >= 2 });
  await page.goto('/');
  await page.getByRole('group', { name: 'よく使われるリーグ' }).getByRole('button', { name: 'ATDO' }).click();
  await page.getByRole('tab', { name: '日程・結果' }).click();
  await page.getByTestId('match-card').filter({ hasText: 'Corks' }).filter({ hasText: '進行中' }).first().click();
  const detail = page.getByTestId('match-detail');
  const chips = detail.getByTestId('game-tab');
  await expect(detail.getByTestId('live-leg')).toBeVisible();
  await chips.nth(1).click();
  await expect(detail.getByTestId('game-panel')).toContainText('ダブルス1');
  phase = 1;
  await expect(chips.nth(4)).toContainText('LIVE');
  await expect(detail.getByTestId('back-to-live')).toBeVisible();
  await expect(detail.getByTestId('game-panel')).toContainText('ダブルス1');
  phase = 2;
  await expect(chips.nth(4)).toContainText('1-2');
  await expect(detail.getByTestId('back-to-live')).toHaveCount(0);
  await expect(detail.getByTestId('game-panel')).toContainText('ダブルス1');
  await chips.nth(4).click();
  await expect(detail.getByTestId('game-panel')).toContainText('シングルス2');
  await expect(detail.getByTestId('game-panel')).toContainText('終了');
});

test('日程・結果: a slot replayed — a late end of the old game neither ends the new one nor stops the live reads; the new game is followed to its own end', async ({ page }) => {
  let stage: 'old' | 'current' | 'ended' = 'old';
  const log = await serveNight(page, { replayed: () => stage });
  const reads = (): number => log.filter((entry) => entry.startsWith('match/live') && entry.includes('c003')).length;
  await page.goto('/');
  await page.getByRole('group', { name: 'よく使われるリーグ' }).getByRole('button', { name: 'ATDO' }).click();
  await page.getByRole('tab', { name: '日程・結果' }).click();
  await page.getByTestId('match-card').filter({ hasText: 'Corks' }).filter({ hasText: '進行中' }).first().click();
  const detail = page.getByTestId('match-detail');
  const chips = detail.getByTestId('game-tab');
  // 1. The old game's late end: the new game stays in progress with its own legs (1-1), the card
  // in progress with the list's score, nothing of the old answer shown — and the reads go on.
  await expect(chips.nth(3)).toContainText('LIVE');
  await expect(detail.getByTestId('game-panel')).toContainText('シングルス1');
  await expect(detail.getByTestId('game-panel')).toContainText('進行中');
  await expect(detail.getByTestId('game-panel')).toContainText('1 - 1');
  await expect(detail.locator('.match-note')).toContainText('進行中');
  await expect(detail.locator('.focus-head strong')).toHaveText('2 - 1');
  await expect(detail.getByTestId('live-leg')).toHaveCount(0);
  const afterOld = reads();
  await expect.poll(reads, { timeout: 5_000 }).toBeGreaterThan(afterOld + 1);

  // 2. The new game answers, on the same page: its live scoreboard (third leg) is shown.
  stage = 'current';
  await expect(detail.getByTestId('live-leg')).toContainText('Leg 3 進行中');
  await expect(chips.nth(3)).toContainText('LIVE');

  // 3. The new game's own end: shown as over (2-1, the card 3-1), and the reads stop.
  stage = 'ended';
  await expect(chips.nth(3)).toContainText('2-1');
  await expect(chips.nth(3)).not.toContainText('LIVE');
  await expect(detail.getByTestId('live-leg')).toHaveCount(0);
  await expect(detail.locator('.focus-head strong')).toHaveText('3 - 1');
  await expect(detail.locator('.match-note')).not.toContainText('進行中');
  const afterEnd = reads();
  await page.waitForTimeout(4_000);
  expect(reads()).toBe(afterEnd);
});
