import { expect, test, type Locator, type Page } from '@playwright/test';
import { C003, C004, C006, servePreStart } from './preStartWorld';
import type { OrderStage } from './preStartWorld';
import { fakeWakeLock } from './wakeLockFake';

/**
 * 観戦: 開始前のゲームと確定済みオーダー (2026-11-27)。canned n01 の上で、実ブラウザで確かめる:
 * - 未開始のゲームも選べて、両チームが確定したオーダーの選手名が出る (0-0 や Leg は出さない)
 * - 全ゲームのオーダー一覧 (初期は閉じている・選ぶとそのゲームへ)
 * - 未確定・片側だけ確定・取得失敗・確定解除・選手変更・別カードの行
 * - ゲームの開始でライブ表示に切り替わる。開始前を見ているだけでは画面の点灯を保たない
 * - 日程・結果からも同じ表示 (共有 URL・再読み込み・戻る / 進む)
 * - スマートフォン 320〜414 px でも 7 ゲームが 1 行 (寸法を計測)
 * - オーダーはカード単位で 30 秒ごと (ゲームごとに読まない)。非表示の間は読まない
 */

test.use({ serviceWorkers: 'block' });

async function openLive(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByRole('group', { name: 'よく使われるリーグ' }).getByRole('button', { name: 'ATDO' }).click();
  await expect(page.getByTestId('live-hub')).toBeVisible();
}

const tile = (page: Page, text: string): Locator => page.getByTestId('board-tile').filter({ hasText: text });
const chip = (scope: Locator, short: string): Locator => scope.getByTestId('game-tab').filter({ has: scope.page().locator('.n', { hasText: new RegExp(`^${short}$`, 'u') }) });

async function openPending(page: Page): Promise<Locator> {
  await openLive(page);
  await tile(page, 'Bulls').click();
  const focus = page.getByTestId('focus-card');
  await expect(focus).toContainText('Bulls');
  await expect(focus.getByTestId('planned-game')).toBeVisible();
  return focus;
}

const orderReads = (log: readonly string[], tmid: string): number => log.filter((entry) => entry.startsWith('team/order/list?') && entry.includes(`tmid=${tmid}`)).length;

test('a card before its first game: on the board as 開始前 (never live), its seven games open with the confirmed players', async ({ page }) => {
  await servePreStart(page);
  await openLive(page);
  await expect(page.locator('.live-meta')).toContainText('進行中 1 ・ 本日 2 カード (開始前 1)');
  const pending = tile(page, 'Bulls');
  await expect(pending).toContainText('開始前');
  await expect(pending).toContainText('vs');
  await expect(pending).not.toContainText('LIVE');
  // Next week's card is not today's: not on the live tab.
  await expect(page.getByTestId('board-tile')).toHaveCount(2);

  await pending.click();
  const focus = page.getByTestId('focus-card');
  await expect(focus.locator('.focus-head')).toContainText('VS');
  await expect(focus.locator('.focus-head')).not.toContainText('0 - 0');
  const chips = focus.getByTestId('game-tab');
  await expect(chips).toHaveCount(7);
  for (let i = 0; i < 7; i += 1) {
    await expect(chips.nth(i)).toBeEnabled();
    await expect(chips.nth(i)).toContainText('予定');
  }
  // The first game is shown: its kind, both teams, the players in n01's order, the state, the source.
  const planned = focus.getByTestId('planned-game');
  await expect(planned.getByTestId('planned-title')).toContainText('ガロン');
  await expect(planned.getByTestId('planned-title')).toContainText('Gallon 1001');
  await expect(planned.getByTestId('planned-title')).toContainText('開始前');
  await expect(planned.locator('.planned-team').nth(0).locator('.planned-name')).toHaveText(['佐藤 B1', '鈴木 B2', '瀬川 B3', '曽根 B4（助っ人）']);
  await expect(planned.locator('.planned-team').nth(1).locator('.planned-name')).toHaveText(['田中 D1', '千葉 D2', '津田 D3', '寺田 とても長い名前の選手ですね']);
  await expect(planned.getByTestId('planned-status')).toHaveText('オーダー確定済み (両チーム)');
  await expect(planned.getByTestId('planned-wait')).toContainText('ゲーム開始待ち');
  await expect(planned).toContainText('n01 確定済みオーダー');
  await expect(planned).not.toContainText('Leg');
  await expect(planned).not.toContainText('0 - 0');
  await expect(focus.getByTestId('live-board')).toHaveCount(0);
  await expect(focus.getByTestId('live-status')).toContainText('開始前');

  // Another game to come, by tap and by the arrow keys.
  await chip(focus, 'S2').click();
  await expect(chip(focus, 'S2')).toHaveAttribute('aria-pressed', 'true');
  await expect(planned.getByTestId('planned-title')).toContainText('シングルス2');
  await expect(planned.locator('.planned-team').nth(0).locator('.planned-name')).toHaveText(['鈴木 B2']);
  await page.keyboard.press('ArrowRight');
  await expect(chip(focus, 'S3')).toHaveAttribute('aria-pressed', 'true');
  await expect(chip(focus, 'S3')).toBeFocused();
  await expect(planned.getByTestId('planned-title')).toContainText('シングルス3');
});

test('the order list: closed at first, every game with both sides and its state; a row opens its game', async ({ page }) => {
  await servePreStart(page);
  await openLive(page);
  // The card in progress: finished, live and planned games in one list.
  const focus = page.getByTestId('focus-card');
  await expect(chip(focus, 'S1')).toContainText('LIVE');
  const panel = focus.getByTestId('order-overview-panel');
  await expect(panel).toBeHidden();
  await expect(focus.getByTestId('order-overview-toggle')).toHaveAttribute('aria-expanded', 'false');
  await focus.getByTestId('order-overview-toggle').click();
  await expect(panel).toBeVisible();
  const rows = panel.locator('tbody');
  await expect(rows).toHaveCount(7);
  await expect(rows.nth(0)).toContainText('ガロン');
  await expect(rows.nth(0)).toContainText('1 - 0／終了');
  await expect(rows.nth(0)).toContainText('青木 一郎');
  // ダブルス1: n01 listed Corks first; Arrows' players are still on Arrows' side (left).
  await expect(rows.nth(1).locator('td').nth(0)).toContainText('青木 一郎');
  await expect(rows.nth(1).locator('td').nth(1)).toContainText('加藤 健');
  await expect(rows.nth(1)).toContainText('1 - 2／終了');
  // シングルス1 in progress: who actually plays (上田 三郎), not who was planned (青木 一郎).
  await expect(rows.nth(3)).toContainText('LIVE');
  await expect(rows.nth(3).locator('td').nth(0)).toHaveText('上田 三郎');
  await expect(rows.nth(4)).toContainText('開始前・確定済み');
  await expect(rows.nth(4).locator('td').nth(0)).toHaveText('井上 次郎');
  await expect(rows.nth(4).locator('td').nth(1)).toHaveText('木村 守');

  await rows.nth(5).getByTestId('order-row').click();
  await expect(panel).toBeHidden();
  await expect(chip(focus, 'S3')).toHaveAttribute('aria-pressed', 'true');
  await expect(focus.getByTestId('planned-game')).toContainText('シングルス3');
  await expect(focus.getByTestId('planned-game')).toContainText('上田 三郎');
});

test('a planned game opened while another is live: the live game keeps being read; ライブに戻る returns to it', async ({ page }) => {
  const log = await servePreStart(page);
  await openLive(page);
  const focus = page.getByTestId('focus-card');
  await expect(focus.getByTestId('live-board')).toBeVisible();
  await chip(focus, 'S4').click();
  await expect(focus.getByTestId('planned-game')).toContainText('シングルス4');
  await expect(focus.getByTestId('live-board')).toBeHidden();
  const back = focus.getByTestId('back-to-live');
  await expect(back).toContainText('シングルス1');
  const reads = log.filter((entry) => entry.startsWith('match/live?') && entry.includes(C003)).length;
  await expect.poll(() => log.filter((entry) => entry.startsWith('match/live?') && entry.includes(C003)).length).toBeGreaterThan(reads + 1);
  await back.click();
  await expect(focus.getByTestId('live-board')).toBeVisible();
  await expect(chip(focus, 'S1')).toHaveAttribute('aria-pressed', 'true');
  await expect(focus.getByTestId('planned-game')).toHaveCount(0);
});

const stages: [OrderStage, string, string][] = [
  ['unfixed', '未確定', 'オーダー未確定'],
  ['oneSide', '未確定', '片方のチームのみ確定 (選手名は両チームの確定後に表示)'],
  ['none', '—', 'n01 に公開されたオーダーはありません'],
  ['foreign', '—', 'n01 に公開されたオーダーはありません'],
  ['fail', '失敗', 'オーダーを取得できませんでした'],
];
for (const [stage, short, text] of stages) {
  test(`orders ${stage}: the chips say 「${short}」, the detail says so, and no player name is shown`, async ({ page }) => {
    await servePreStart(page, { c004: () => stage });
    const focus = await openPending(page);
    await expect(focus.getByTestId('game-tab').nth(0)).toContainText(short);
    await expect(focus.getByTestId('game-tab').nth(0)).toBeEnabled();
    const planned = focus.getByTestId('planned-game');
    await expect(planned.getByTestId('planned-status')).toHaveText(text);
    await expect(planned.locator('.planned-name')).toHaveCount(0);
    await expect(planned).not.toContainText('佐藤 B1');
    await expect(planned).not.toContainText('未提出');
  });
}

test('orders read again: taken back (no names), a player changed, a failure after a good read (kept, marked), then back', async ({ page }) => {
  let stage: OrderStage = 'fixed';
  await page.clock.install();
  await servePreStart(page, { c004: () => stage });
  const focus = await openPending(page);
  await chip(focus, 'S2').click();
  const planned = focus.getByTestId('planned-game');
  await expect(planned.locator('.planned-team').nth(0).locator('.planned-name')).toHaveText(['鈴木 B2']);

  stage = 'changed';
  await page.clock.runFor(31_000);
  await expect(planned.locator('.planned-team').nth(0).locator('.planned-name')).toHaveText(['曽根 B4（助っ人）']);

  stage = 'fail';
  await page.clock.runFor(31_000);
  await expect(planned.getByTestId('orders-stale')).toContainText('更新に失敗しました');
  await expect(planned.locator('.planned-team').nth(0).locator('.planned-name')).toHaveText(['曽根 B4（助っ人）']);

  stage = 'unfixed';
  await planned.getByTestId('orders-refresh').click();
  await expect(planned.getByTestId('planned-status')).toHaveText('オーダー未確定');
  await expect(planned.locator('.planned-name')).toHaveCount(0);
  await expect(planned.getByTestId('orders-stale')).toHaveCount(0);
  await expect(chip(focus, 'S2')).toContainText('未確定');
});

test('a failed first read says so; the manual 再取得 recovers', async ({ page }) => {
  let down = true;
  await servePreStart(page, { ordersDown: () => down });
  const focus = await openPending(page);
  const planned = focus.getByTestId('planned-game');
  await expect(planned.getByTestId('planned-status')).toHaveText('オーダーを取得できませんでした');
  down = false;
  await planned.getByTestId('orders-refresh').click();
  await expect(planned.getByTestId('planned-status')).toHaveText('オーダー確定済み (両チーム)');
  await expect(planned.locator('.planned-name').first()).toHaveText('佐藤 B1');
});

test('the same game twice in n01’s reply is not shown', async ({ page }) => {
  await servePreStart(page, { c004: () => 'duplicate' });
  const focus = await openPending(page);
  await chip(focus, 'S2').click();
  await expect(focus.getByTestId('planned-status')).toHaveText('n01 の応答に同じゲームのオーダーが重複していたため表示しません');
  await expect(focus.getByTestId('planned-game').locator('.planned-name')).toHaveCount(0);
  await chip(focus, 'S3').click();
  await expect(focus.getByTestId('planned-game').locator('.planned-name').first()).toHaveText('瀬川 B3');
});

test('the card starts: the game watched turns into the live view; the screen is kept on only from then', async ({ page }) => {
  let started = false;
  await fakeWakeLock(page);
  await page.clock.install();
  await servePreStart(page, { c004Started: () => started });
  const focus = await openPending(page);
  await expect(chip(focus, 'G')).toHaveAttribute('aria-pressed', 'true');
  // The live card shown first had the screen kept on; the card before its start releases it.
  await page.clock.runFor(5_000);
  await expect.poll(() => page.evaluate(() => (window as unknown as { __wake: { active: number } }).__wake.active)).toBe(0);

  started = true;
  await page.clock.runFor(31_000);
  await expect(focus.getByTestId('live-board')).toBeVisible();
  await expect(chip(focus, 'G')).toContainText('LIVE');
  await expect(focus.getByTestId('planned-game')).toHaveCount(0);
  await expect(focus.locator('.focus-head')).toContainText('0 - 0');
  await expect.poll(() => page.evaluate(() => (window as unknown as { __wake: { active: number } }).__wake.active)).toBe(1);
  // The other games are still to come.
  await expect(chip(focus, 'S4')).toContainText('予定');
});

test('a planned game picked before another game of the card starts stays picked', async ({ page }) => {
  let started = false;
  await page.clock.install();
  await servePreStart(page, { c004Started: () => started });
  const focus = await openPending(page);
  await chip(focus, 'S3').click();
  started = true;
  await page.clock.runFor(31_000);
  await expect(chip(focus, 'G')).toContainText('LIVE');
  await expect(chip(focus, 'S3')).toHaveAttribute('aria-pressed', 'true');
  await expect(focus.getByTestId('planned-game')).toContainText('シングルス3');
  await expect(focus.getByTestId('back-to-live')).toContainText('ガロン');
});

test('orders: one read per card every 30 s (never per game); none while the page is hidden; read on return', async ({ page }) => {
  await fakeWakeLock(page);
  await page.clock.install();
  const log = await servePreStart(page);
  await openPending(page);
  await expect.poll(() => orderReads(log, C004)).toBe(1);
  await page.clock.runFor(30_500);
  await expect.poll(() => orderReads(log, C004)).toBe(2);
  await page.clock.runFor(30_500);
  await expect.poll(() => orderReads(log, C004)).toBe(3);
  // Never by game: no read names a game slot.
  expect(log.filter((entry) => entry.startsWith('team/order/list?') && entry.includes('schid='))).toEqual([]);
  // Hidden: nothing for two minutes.
  await page.evaluate(() => {
    (window as unknown as { __wakeControl: { hidden: boolean } }).__wakeControl.hidden = true;
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await page.clock.runFor(120_000);
  expect(orderReads(log, C004)).toBe(3);
  await page.evaluate(() => {
    (window as unknown as { __wakeControl: { hidden: boolean } }).__wakeControl.hidden = false;
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect.poll(() => orderReads(log, C004)).toBe(4);
});

test('日程・結果: a card before its first game opens with its planned games; its link opens a planned game directly, survives a reload and back / forward', async ({ page }) => {
  await servePreStart(page);
  await openLive(page);
  await page.getByRole('tab', { name: '日程・結果' }).click();
  await page.locator('[data-card-key="0_c004"]').click();
  const detail = page.getByTestId('match-detail');
  await expect(detail.locator('.focus-head')).toContainText('vs');
  await expect(detail.getByTestId('game-tab')).toHaveCount(7);
  await expect(detail.getByTestId('planned-game')).toContainText('ガロン');
  await expect(detail.getByTestId('planned-game').locator('.planned-name').first()).toHaveText('佐藤 B1');

  await chip(detail, 'S2').click();
  await expect(page).toHaveURL(/g=sg02/u);
  await expect(detail.getByTestId('planned-game')).toContainText('シングルス2');
  await page.reload();
  await expect(page.getByTestId('match-detail').getByTestId('planned-game')).toContainText('シングルス2');
  await expect(chip(page.getByTestId('match-detail'), 'S2')).toHaveAttribute('aria-pressed', 'true');

  // Order list in 日程・結果 too.
  await page.getByTestId('match-detail').getByTestId('order-overview-toggle').click();
  await page.getByTestId('match-detail').getByTestId('order-row').nth(6).click();
  await expect(page).toHaveURL(/g=sg04/u);
  await expect(page.getByTestId('match-detail').getByTestId('planned-game')).toContainText('シングルス4');

  await page.goBack();
  await expect(page.getByTestId('results-tab')).toBeVisible();
  await page.goForward();
  await expect(page.getByTestId('match-detail').getByTestId('planned-game')).toContainText('シングルス4');
});

test('日程・結果: the card in progress — finished, live and planned games; a planned game opens, ライブに戻る returns', async ({ page }) => {
  await servePreStart(page);
  await openLive(page);
  await page.getByRole('tab', { name: '日程・結果' }).click();
  await page.getByTestId('match-card').filter({ hasText: 'Arrows' }).filter({ hasText: 'Corks' }).click();
  const detail = page.getByTestId('match-detail');
  await expect(chip(detail, 'S1')).toContainText('LIVE');
  await expect(chip(detail, 'S2')).toContainText('予定');
  await chip(detail, 'S2').click();
  await expect(detail.getByTestId('planned-game').locator('.planned-team').nth(0).locator('.planned-name')).toHaveText(['井上 次郎']);
  await detail.getByTestId('back-to-live').click();
  await expect(chip(detail, 'S1')).toHaveAttribute('aria-pressed', 'true');
});

test('日程・結果: a card of next week is read once (no polling) and never watched live', async ({ page }) => {
  await page.clock.install();
  const log = await servePreStart(page);
  await openLive(page);
  await page.getByRole('tab', { name: '日程・結果' }).click();
  await page.getByTestId('match-card').filter({ hasText: 'Doubles' }).filter({ hasText: 'Arrows' }).click();
  const detail = page.getByTestId('match-detail');
  await expect(detail.getByTestId('planned-game').locator('.planned-name').first()).toHaveText('青木 一郎');
  await page.clock.runFor(95_000);
  expect(orderReads(log, C006)).toBe(1);
  expect(log.filter((entry) => entry.startsWith('match/live?') && entry.includes(C006))).toEqual([]);
});

test('日程・結果: the card starts while a planned game of it is open — it follows the live game', async ({ page }) => {
  let started = false;
  await fakeWakeLock(page);
  await page.clock.install();
  await servePreStart(page, { c004Started: () => started });
  await openLive(page);
  await page.getByRole('tab', { name: '日程・結果' }).click();
  await page.locator('[data-card-key="0_c004"]').click();
  const detail = page.getByTestId('match-detail');
  await expect(detail.getByTestId('planned-game')).toContainText('ガロン');
  await expect.poll(() => page.evaluate(() => (window as unknown as { __wake: { active: number } }).__wake.active)).toBe(0);
  started = true;
  await page.clock.runFor(31_000);
  await expect(chip(detail, 'G')).toContainText('LIVE');
  await expect(detail.getByTestId('game-panel')).toBeVisible();
  await expect(detail.getByTestId('planned-game')).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => (window as unknown as { __wake: { active: number } }).__wake.active)).toBe(1);
});

/** Every chip on one line, nothing clipped, no sideways scroll — measured, not looked at. */
async function measureRow(page: Page, scope: Locator): Promise<void> {
  const m = await scope.getByTestId('game-tabs').evaluate((list) => {
    const chips = [...list.querySelectorAll<HTMLElement>('button.game-tab')];
    const rect = (el: Element) => el.getBoundingClientRect();
    const clipped = chips.some((el) => [...el.querySelectorAll<HTMLElement>('.n, .r')].some((part) => part.scrollWidth > part.clientWidth + 1 || rect(part).right > rect(el).right + 0.5 || rect(part).left < rect(el).left - 0.5));
    return {
      tops: chips.map((el) => Math.round(rect(el).top)),
      widths: chips.map((el) => rect(el).width),
      heights: chips.map((el) => rect(el).height),
      lefts: chips.map((el) => rect(el).left),
      rights: chips.map((el) => rect(el).right),
      clientWidth: list.clientWidth,
      scrollWidth: list.scrollWidth,
      listRight: rect(list).right,
      clipped,
      page: { scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth },
    };
  });
  expect(m.tops.length).toBe(7);
  expect(new Set(m.tops).size).toBe(1);
  expect(m.scrollWidth).toBeLessThanOrEqual(m.clientWidth);
  expect(m.page.scroll).toBeLessThanOrEqual(m.page.client);
  expect(m.clipped).toBe(false);
  // Equal widths (a chip's state never changes its width); WCAG 2.2 2.5.8: at least 24 × 24 CSS px (44 px tall here).
  expect(Math.max(...m.widths) - Math.min(...m.widths)).toBeLessThan(0.5);
  for (const w of m.widths) expect(w).toBeGreaterThanOrEqual(24);
  for (const h of m.heights) expect(h).toBeGreaterThanOrEqual(44);
  for (let i = 1; i < m.lefts.length; i += 1) expect(m.lefts[i]).toBeGreaterThanOrEqual(m.rights[i - 1]);
  expect(Math.max(...m.rights)).toBeLessThanOrEqual(m.listRight + 0.5);
}

for (const width of [320, 360, 375, 390, 414]) {
  test(`phone ${width} px: seven game chips in one row (live, finished, planned, selected), no sideways scroll`, async ({ page }, info) => {
    test.skip(info.project.name !== 'mobile', 'phone widths');
    await page.setViewportSize({ width, height: 800 });
    await servePreStart(page);
    await openLive(page);
    const focus = page.getByTestId('focus-card');
    await expect(chip(focus, 'S1')).toContainText('LIVE');
    await measureRow(page, focus);
    await chip(focus, 'D1').click();
    await measureRow(page, focus);
    await page.screenshot({ path: info.outputPath(`chips-${width}.png`) });
    await tile(page, 'Bulls').click();
    await expect(page.getByTestId('focus-card').getByTestId('planned-game')).toBeVisible();
    await measureRow(page, page.getByTestId('focus-card'));
    await page.getByRole('tab', { name: '日程・結果' }).click();
    await page.getByTestId('match-card').filter({ hasText: 'Arrows' }).filter({ hasText: 'Corks' }).click();
    await expect(chip(page.getByTestId('match-detail'), 'S1')).toContainText('LIVE');
    await measureRow(page, page.getByTestId('match-detail'));
  });
}

test('PC: two cards side by side — one pane on a planned game, the other live', async ({ page }, info) => {
  test.skip(info.project.name !== 'desktop', 'wide screen');
  await page.setViewportSize({ width: 1440, height: 900 });
  await servePreStart(page);
  await openLive(page);
  await page.getByTestId('pair-toggle').click();
  const panes = page.getByTestId('focus-pair').getByTestId('focus-card');
  await expect(panes).toHaveCount(2);
  const right = panes.nth(1);
  await expect(right).toContainText('Bulls');
  await expect(right.getByTestId('planned-game')).toContainText('ガロン');
  await expect(panes.nth(0).getByTestId('live-board')).toBeVisible();
  await measureRow(page, right);
  await measureRow(page, panes.nth(0));
});
