import { expect, test, type Page } from '@playwright/test';
import { serveNight } from './liveNight';
import { serveNowCompetition, serveSetMatch } from './setMatchWorld';
import type { SetMatchControl } from './setMatchWorld';
import { setLive, setMid, setRow } from '../src/test/n01/setMatch';
import { N01_API_BASE_URL } from '../src/integrations/n01/endpoints';
import { fakeWakeLock, setPageHidden, wakeHeld, wakeRecord } from './wakeLockFake';
import { tab } from './nav';

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

// ---------------------------------------------------------------------------
// 観戦中は画面を自動スリープさせない (Screen Wake Lock)
// ---------------------------------------------------------------------------

/** `failing()` の間、`match/live` に 503 を返す (n01 に一時的につながらない)。ほかの固定データのサーバーの上に重ねる。 */
async function failLiveWhile(page: Page, failing: () => boolean): Promise<void> {
  await page.route(`${N01_API_BASE_URL}/**`, async (route) => {
    if (failing() && new URL(route.request().url()).pathname.endsWith('/match/live')) return route.fulfill({ status: 503, body: '{}', headers: { 'access-control-allow-origin': '*' } });
    return route.fallback();
  });
}

test('wake lock: a set-format match keeps the screen on through the next set, an earlier set and a failed read; hidden, it lets go; end_schedule ends it', async ({ page }) => {
  await fakeWakeLock(page);
  const control: SetMatchControl = { phase: 0, log: [] };
  let failing = false;
  await openNow(page, control);
  await failLiveWhile(page, () => failing);
  await expect.poll(() => wakeHeld(page)).toBe(0); // 進行中の試合の一覧はライブ観戦ではない
  await page.getByTestId('now-single').filter({ hasText: 'Alpha 選手1-1' }).click();
  await expect(page.getByTestId('live-leg')).toBeVisible();
  await expect.poll(() => wakeHeld(page)).toBe(1);

  control.phase = 1; // シングルス1 が終了し、次のセットはまだ: 対戦は進行中
  await expect(page.getByTestId('set-wait')).toBeVisible();
  expect(await wakeHeld(page)).toBe(1);
  control.phase = 2; // ダブルス1 が開始: 自動で切り替わり、保持したまま
  await expect(shown(page)).toContainText('ダブルス1');
  expect(await wakeHeld(page)).toBe(1);

  await page.getByTestId('set-item').first().click(); // 対戦が進む間に、過去のセットを表示
  await expect(shown(page)).toContainText('シングルス1');
  await page.getByTestId('leg-chips').getByRole('tab').first().click(); // さらに、そのセットの過去のレッグを表示
  await expect(page.getByTestId('leg-sheet')).toContainText('Leg 1');
  expect(await wakeHeld(page)).toBe(1);

  failing = true; // n01 に一時的につながらない: 最後に確認した状態 (進行中) のまま
  await expect(page.getByTestId('set-page-status')).toContainText('取得失敗');
  expect(await wakeHeld(page)).toBe(1);
  failing = false;
  await expect(page.getByTestId('set-page-status')).toContainText('自動更新中', { timeout: 20_000 });
  expect(await wakeHeld(page)).toBe(1);

  await setPageHidden(page, true); // 別のアプリに切り替え・画面オフ
  await expect.poll(() => wakeHeld(page)).toBe(0);
  await setPageHidden(page, false);
  await expect.poll(() => wakeHeld(page)).toBe(1);

  control.phase = 7; // 対戦の終了 (end_schedule)
  await expect(page.getByTestId('set-page-status')).toContainText('終了');
  await expect.poll(() => wakeHeld(page)).toBe(0);
  const record = await wakeRecord(page);
  expect(record.max).toBe(1); // ロックを同時に 2 つ持たない
  await setPageHidden(page, true);
  await setPageHidden(page, false);
  await page.waitForTimeout(500);
  expect((await wakeRecord(page)).requests).toBe(record.requests); // 終了後: 再要求しない
});

test('wake lock: let go when the page is left (back, the browser’s back), taken again on the way back; a finished match takes none', async ({ page }) => {
  await fakeWakeLock(page);
  const control: SetMatchControl = { phase: 4, log: [] };
  await openNow(page, control);
  await page.getByTestId('now-single').first().click();
  await expect.poll(() => wakeHeld(page)).toBe(1);
  await page.getByTestId('set-page-back').click();
  await expect(page.getByTestId('now-view')).toBeVisible();
  await expect.poll(() => wakeHeld(page)).toBe(0);
  await page.goForward();
  await expect(page.getByTestId('set-page')).toBeVisible();
  await expect.poll(() => wakeHeld(page)).toBe(1);
  await page.goBack();
  await expect(page.getByTestId('now-view')).toBeVisible();
  await expect.poll(() => wakeHeld(page)).toBe(0);
  // アプリの別の画面へ移る。
  await page.getByTestId('now-single').first().click();
  await expect.poll(() => wakeHeld(page)).toBe(1);
  await tab(page, 'ホーム').click();
  await expect(page.getByTestId('set-page')).toHaveCount(0);
  await expect.poll(() => wakeHeld(page)).toBe(0);

  // 終了した対戦をリンクから開く: 結果の表示のみで、ロックは取らない。
  control.phase = 7;
  await page.goto(`/#/watch?m=${setMid(2)}`);
  await expect(page.getByTestId('set-page-status')).toContainText('終了');
  await page.waitForTimeout(500);
  expect(await wakeHeld(page)).toBe(0);
  expect((await wakeRecord(page)).max).toBe(1);
});

test('wake lock: a game outside any set (followed by mid) keeps the screen on until end_match', async ({ page }) => {
  await fakeWakeLock(page);
  let over = false;
  const solo = setMid(0);
  await serveNight(page);
  await page.route(`${N01_API_BASE_URL}/**`, async (route) => {
    const url = new URL(route.request().url());
    const operation = url.pathname.replace(/^.*\/api\/v1\//u, '');
    const q = url.searchParams;
    const json = (body: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body), headers: { 'access-control-allow-origin': '*' } });
    const phase = over ? 1 : 0;
    // 固定データのシングルス1 から scid を除いたもの: 単独の試合 (end_match で終了)。
    const strip = (body: Record<string, unknown>): Record<string, unknown> => ({ ...body, scid: '', end_schedule: 0, currentSet: undefined, current_set: undefined });
    if (operation === 'match/list' && q.get('mid') === solo) return json({ result: 0, list: (q.get('live') === '1') === !over ? [strip(setRow(0, phase))] : [] });
    if (operation === 'match/live' && q.get('mid') === solo) return json(strip(setLive(0, phase)));
    return route.fallback();
  });
  await page.goto(`/#/watch?m=${solo}`);
  await expect(page.getByTestId('live-leg')).toBeVisible();
  await expect(page.getByTestId('set-list')).toHaveCount(0); // セットなし: 単独の試合
  await expect.poll(() => wakeHeld(page)).toBe(1);
  over = true;
  await expect(page.getByTestId('set-page-status')).toContainText('終了');
  await expect.poll(() => wakeHeld(page)).toBe(0);
});

test('wake lock: the live tab kept hidden under a match page holds nothing; back to it, it holds again', async ({ page }) => {
  await fakeWakeLock(page);
  await serveNight(page);
  await serveSetMatch(page, { phase: 7, log: [] }); // ライブタブの上に開く対戦は終了済み
  await page.goto('/');
  await page.getByRole('group', { name: 'よく使われるリーグ' }).getByRole('button', { name: 'ATDO' }).click();
  await expect(page.getByTestId('live-board')).toBeVisible();
  await expect.poll(() => wakeHeld(page)).toBe(1); // ライブタブで c003 の対戦が進行中
  await page.evaluate((hash) => {
    window.location.hash = hash;
  }, `#/watch?l=lg_l3hI_3397&t=t_Test_0001&m=${setMid(3)}`);
  await expect(page.getByTestId('set-page')).toBeVisible();
  await expect(page.getByTestId('set-page-status')).toContainText('終了');
  await expect(page.getByTestId('live-hub')).toBeHidden(); // 下に隠して保持 (マウントされたまま)
  await expect.poll(() => wakeHeld(page)).toBe(0);
  await page.getByTestId('set-page-back').click();
  await expect(page.getByTestId('live-hub')).toBeVisible();
  await expect.poll(() => wakeHeld(page)).toBe(1);
  expect((await wakeRecord(page)).max).toBe(1);
});

test('wake lock: 日程・結果 — a card in progress keeps the screen on, also on an earlier game, until the card ends', async ({ page }) => {
  await fakeWakeLock(page);
  let phase = 0;
  await serveNight(page, { nextGameStarted: () => phase >= 1, cardEnded: () => phase >= 2 });
  await page.goto('/');
  await page.getByRole('group', { name: 'よく使われるリーグ' }).getByRole('button', { name: 'ATDO' }).click();
  await page.getByRole('tab', { name: '日程・結果' }).click();
  await expect(page.getByTestId('results-tab')).toBeVisible();
  await expect.poll(() => wakeHeld(page)).toBe(0); // 対戦カードの一覧はライブ観戦ではない
  await page.getByTestId('match-card').filter({ hasText: 'Corks' }).filter({ hasText: '進行中' }).first().click();
  const detail = page.getByTestId('match-detail');
  await expect(detail.getByTestId('live-leg')).toBeVisible();
  await expect.poll(() => wakeHeld(page)).toBe(1);
  await detail.getByTestId('game-tab').nth(1).click(); // 過去のゲームを表示
  await expect(detail.getByTestId('game-panel')).toContainText('ダブルス1');
  phase = 1; // 次のゲームが開始
  await expect(detail.getByTestId('back-to-live')).toBeVisible();
  expect(await wakeHeld(page)).toBe(1);
  phase = 2; // 対戦の終了 (end_schedule)
  await expect(detail.getByTestId('back-to-live')).toHaveCount(0);
  await expect.poll(() => wakeHeld(page)).toBe(0);
  await page.getByRole('button', { name: '一覧に戻る' }).click();
  await expect(page.getByTestId('results-tab')).toBeVisible();
  expect(await wakeHeld(page)).toBe(0);
  expect((await wakeRecord(page)).max).toBe(1);
});

for (const mode of ['deny', 'none'] as const) {
  test(`wake lock: ${mode === 'deny' ? 'refused' : 'missing (an older browser)'}, watching goes on as before`, async ({ page }) => {
    await fakeWakeLock(page, mode);
    const control: SetMatchControl = { phase: 0, log: [] };
    await openNow(page, control);
    await page.getByTestId('now-single').filter({ hasText: 'Alpha 選手1-1' }).click();
    await expect(page.getByTestId('live-leg')).toBeVisible();
    control.phase = 2;
    await expect(shown(page)).toContainText('ダブルス1');
    await expect(page.getByTestId('set-page-status')).toContainText('自動更新中');
    await page.getByTestId('set-item').first().click();
    await expect(shown(page)).toContainText('シングルス1');
    const record = await wakeRecord(page);
    expect(record.active).toBe(0);
    if (mode === 'deny') {
      expect(record.denied).toBeGreaterThan(0);
      // 拒否された場合: 表示が続いている間、繰り返し要求しない。
      const asked = record.requests;
      await page.waitForTimeout(3000);
      expect((await wakeRecord(page)).requests).toBe(asked);
    } else expect(record.requests).toBe(0);
  });
}
