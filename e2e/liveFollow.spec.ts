import { expect, test, type Locator, type Page } from '@playwright/test';
import { N01_API_BASE_URL } from '../src/integrations/n01/endpoints';
import { TDID, fixtures, gameRow, list, liveBody, side, tournamentDoc } from '../src/features/matches/testFixtures';

/**
 * Re-audit of 2026-11-09 in a real browser (canned n01, no network):
 * - U02: the live score sheet follows the newest visit only while the viewer is at it — opened
 *   at the newest row; kept there on each update, a changed cell, an undo; left alone while the
 *   viewer reads earlier rounds (mouse wheel, touch, keyboard); 「最新へ」 and a hand scroll back
 *   to the bottom follow again; a new game starts following; only the sheet's own box moves.
 * - U01: on a large screen the score sheet and the figures sit side by side; phones keep one
 *   column; no sideways scroll at any width; the match sheet alone is widened.
 */

test.use({ serviceWorkers: 'block' });

interface Game {
  mid: string;
  schid: string;
  /** Points of each visit, alternating sides from the left (all small: nobody finishes). */
  visits: number[];
  /** Bumped on every change: n01's updateTime only ever moves forward (a correction or undo too). */
  rev: number;
}

function liveOf(game: Game): unknown {
  const left: [number, number] = [501, 501];
  const throws = game.visits.map((score, i) => {
    const p = (i % 2) as 0 | 1;
    left[p] -= score;
    return { p, r: Math.floor(i / 2) + 1, score, left: left[p], darts: 3 };
  });
  return liveBody({
    mid: game.mid,
    schid: game.schid,
    title: `Test League A Division ${game.schid === 'db01' ? 'ダブルス1' : 'シングルス1'}`,
    sets: [1, 0],
    legs: [0, 0],
    current_leg: 0,
    updateTime: 1_800_000_010_000 + game.rev * 1000,
    leg: { leg: 0, first: 0, end: 0, winner: null, start: [501, 501], left, thrower: game.visits.length % 2, round: Math.floor(game.visits.length / 2) + 1, throws },
  });
}

const today = (game: Game): unknown[] => [
  gameRow('c003', 'AAAA', 'CCCC', 'tm01', [side('AAAA', [['a1', 'A1'], ['a2', 'A2'], ['a3', 'A3'], ['a4', 'A4']], 1, 1001, 54), side('CCCC', [['c1', 'C1'], ['c2', 'C2'], ['c3', 'C3'], ['c4', 'C4']], 0, 880, 54)], { start: 1_800_000_000, mid: 'c003_tm01' }),
  gameRow('c003', 'AAAA', 'CCCC', game.schid, [side('AAAA', [['a1', 'A1'], ['a2', 'A2']], 0, 400, 30), side('CCCC', [['c1', 'C1'], ['c2', 'C2']], 0, 300, 30)], { start: 1_800_000_900, finished: false, mid: game.mid }),
  // A second card today, so the board has more than one tile (the wide layout's card column).
  gameRow('c004', 'BBBB', 'DDDD', 'tm01', [side('BBBB', [['b1', 'B1'], ['b2', 'B2'], ['b3', 'B3'], ['b4', 'B4']], 1, 1001, 60), side('DDDD', [['d1', 'D1'], ['d2', 'D2'], ['d3', 'D3'], ['d4', 'D4']], 0, 700, 60)], { start: 1_800_000_100, mid: 'c004_tm01' }),
];

async function serve(page: Page, game: Game): Promise<string[]> {
  const log: string[] = [];
  await page.route(`${N01_API_BASE_URL}/**`, async (route) => {
    const url = new URL(route.request().url());
    const operation = url.pathname.replace(/^.*\/api\/v1\//u, '');
    const q = url.searchParams;
    log.push(`${operation}?${q.toString()}`);
    let body: unknown = null;
    if (operation === 'league/tournament/list') body = { result: 0, league: { lgid: 'lg_l3hI_3397', title: 'ATDO' }, list: [{ tdid: TDID, title: 'Test League 1st', status: 30, t_date: 1_800_000_000, createTime: 1_790_000_000 }] };
    else if (operation === 'tournament/get') body = tournamentDoc();
    else if (operation === 'league/schedule/get') body = fixtures();
    else if (operation === 'tournament/standings') body = { result: -51 };
    else if (operation === 'match/list') body = list(today(game));
    else if (operation === 'match/live') body = liveOf(game);
    else if (operation === 'match/throws') body = { result: 0, changed: 1, mid: q.get('mid'), match_type: '01', end_match: 0, current_leg: 0, updateTime: 1_800_000_010_000, leg_data: [] };
    else if (operation === 'team/order/list') body = { result: 0, list: [] };
    else if (operation === 'tournament/stats') body = { result: 0, stats: {} };
    else if (operation === 'team/player/list') body = { result: 0, list: [] };
    if (body === null) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ result: -1, error: 'not found' }) });
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body), headers: { 'access-control-allow-origin': '*' } });
  });
  return log;
}

async function openLive(page: Page): Promise<Locator> {
  await page.goto('/');
  await page.getByRole('group', { name: 'よく使われるリーグ' }).getByRole('button', { name: 'ATDO' }).click();
  await expect(page.getByTestId('watch-page')).toBeVisible();
  const box = page.getByTestId('live-scroll');
  await expect(box).toBeVisible();
  return box;
}

/** Distance (px) between the box's bottom and the newest row: ≤ 2 means "at the newest row". */
const gap = (box: Locator): Promise<number> => box.evaluate((el) => el.scrollHeight - el.clientHeight - el.scrollTop);
const top = (box: Locator): Promise<number> => box.evaluate((el) => el.scrollTop);
const pageTop = (page: Page): Promise<number> => page.evaluate(() => document.scrollingElement!.scrollTop);
const following = (box: Locator): Promise<string | null> => box.getAttribute('data-following');
/** Visits drawn in the box (Scored cells holding a number). */
const drawn = (box: Locator): Promise<number> => box.evaluate((el) => [...el.querySelectorAll('tbody tr:not(.start) td.sc')].filter((td) => /^\d+$/u.test(td.textContent ?? '')).length);

/** Scrolls the box up like a person would: the wheel on desktop, a touch drag on a phone. */
async function readHistory(page: Page, box: Locator, isMobile: boolean, distance = 300): Promise<void> {
  const b = (await box.boundingBox())!;
  if (isMobile) {
    // A finger drag inside the box (raw touch events: Chromium scrolls the box under the finger).
    const cdp = await page.context().newCDPSession(page);
    const x = Math.round(b.x + b.width / 2);
    const steps = 12;
    const span = Math.min(Math.abs(distance), b.height - 40);
    const from = distance > 0 ? Math.round(b.y + 20) : Math.round(b.y + b.height - 20);
    const sign = distance > 0 ? 1 : -1;
    const rounds = Math.max(1, Math.ceil(Math.abs(distance) / span));
    for (let round = 0; round < rounds; round += 1) {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y: from }] });
      for (let i = 1; i <= steps; i += 1) {
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: from + sign * Math.round((span * i) / steps) }] });
      }
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    }
    await cdp.detach();
  } else {
    await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
    await page.mouse.wheel(0, -distance);
  }
}

test.describe('U02: the live score sheet follows the newest visit', () => {
  test('opened → updates → reading history → 「最新へ」 → back by hand → keyboard → undo → new game', async ({ page, isMobile }) => {
    const game: Game = { mid: 'c003_db01', schid: 'db01', visits: Array.from({ length: 24 }, (_, i) => 10 + (i % 7)), rev: 0 };
    await serve(page, game);
    const box = await openLive(page);
    await expect.poll(() => drawn(box)).toBe(24);
    // Taller than its box: there is history above.
    expect(await box.evaluate((el) => el.scrollHeight > el.clientHeight + 100)).toBe(true);

    // Opened at the newest visit (and the next one's cell), following.
    await expect.poll(() => gap(box)).toBeLessThanOrEqual(2);
    expect(await following(box)).toBe('true');
    await expect(page.getByTestId('follow-latest')).toHaveCount(0);

    // The page itself is put somewhere and must never be moved by the sheet.
    await box.evaluate((el) => el.scrollIntoView({ block: 'center' }));
    const pageBefore = await pageTop(page);

    // New visits (a new row, then the right cell of the same row): still at the newest.
    game.visits.push(20);
    game.rev += 1;
    await expect.poll(() => drawn(box)).toBe(25);
    expect(await gap(box)).toBeLessThanOrEqual(2);
    game.visits.push(21);
    game.rev += 1;
    await expect.poll(() => drawn(box)).toBe(26);
    expect(await gap(box)).toBeLessThanOrEqual(2);
    expect(await pageTop(page)).toBe(pageBefore);

    // Reading earlier rounds: following stops, the position is kept through two more updates.
    await readHistory(page, box, isMobile);
    await expect.poll(() => following(box)).toBe('false');
    const reading = await top(box);
    expect(await gap(box)).toBeGreaterThan(40);
    await expect(page.getByTestId('follow-latest')).toBeVisible();
    game.visits.push(22, 23);
    game.rev += 1;
    await expect.poll(() => drawn(box)).toBe(28);
    expect(Math.abs((await top(box)) - reading)).toBeLessThanOrEqual(1);
    expect(await following(box)).toBe('false');
    expect(await pageTop(page)).toBe(pageBefore);

    // 「最新へ」: back to the newest visit and following again.
    await page.getByTestId('follow-latest').click();
    await expect.poll(() => gap(box)).toBeLessThanOrEqual(2);
    expect(await following(box)).toBe('true');
    await expect(page.getByTestId('follow-latest')).toHaveCount(0);
    expect(await pageTop(page)).toBe(pageBefore);

    // A corrected visit (same number of rows): stays at the newest.
    game.visits[game.visits.length - 1] = 30;
    game.rev += 1;
    await expect.poll(() => box.evaluate((el) => el.textContent?.includes('30') ?? false)).toBe(true);
    expect(await gap(box)).toBeLessThanOrEqual(2);

    // Up, then back down by hand: following again on its own.
    await readHistory(page, box, isMobile);
    await expect.poll(() => following(box)).toBe('false');
    await readHistory(page, box, isMobile, -2000);
    await expect.poll(() => following(box)).toBe('true');

    // Keyboard: the box takes focus; Home reads the start, End follows again. Focus stays put.
    await box.focus();
    await page.keyboard.press('Home');
    await expect.poll(() => following(box)).toBe('false');
    game.visits.push(24);
    game.rev += 1;
    await expect.poll(() => drawn(box)).toBe(29);
    expect(await top(box)).toBeLessThanOrEqual(1);
    await page.keyboard.press('End');
    await expect.poll(() => following(box)).toBe('true');
    expect(await box.evaluate((el) => document.activeElement === el)).toBe(true);
    // 「最新へ」 from the keyboard keeps the focus in the sheet.
    await page.keyboard.press('Home');
    await expect(page.getByTestId('follow-latest')).toBeVisible();
    await expect.poll(() => top(box)).toBe(0); // the keyboard scroll has finished
    await page.getByTestId('follow-latest').focus();
    await page.keyboard.press('Enter');
    await page.waitForTimeout(600); // nothing may pull it back afterwards
    await expect.poll(() => gap(box)).toBeLessThanOrEqual(2);
    expect(await box.evaluate((el) => document.activeElement === el)).toBe(true);

    // An undo (one visit fewer) while following: still at the newest.
    game.visits.pop();
    game.rev += 1;
    await expect.poll(() => drawn(box)).toBe(28);
    expect(await gap(box)).toBeLessThanOrEqual(2);

    // Resized (a phone turned, a window widened) while following: still at the newest.
    const size = page.viewportSize()!;
    await page.setViewportSize({ width: size.height > size.width ? Math.min(size.height, 900) : 1440, height: size.height > size.width ? size.width : 900 });
    await expect.poll(() => gap(box)).toBeLessThanOrEqual(2);
    await page.setViewportSize(size);
    await expect.poll(() => gap(box)).toBeLessThanOrEqual(2);

    // Reading history, then the next game of the card starts: the new game opens at its newest.
    await readHistory(page, box, isMobile);
    await expect.poll(() => following(box)).toBe('false');
    game.mid = 'c003_sg01';
    game.schid = 'sg01';
    game.visits = Array.from({ length: 22 }, (_, i) => 15 + (i % 5));
    game.rev += 1;
    await expect.poll(() => drawn(page.getByTestId('live-scroll'))).toBe(22);
    await expect.poll(() => gap(page.getByTestId('live-scroll'))).toBeLessThanOrEqual(2);
    expect(await following(page.getByTestId('live-scroll'))).toBe('true');
  });

  test('with reduced motion the sheet jumps to the newest visit (no animation to pile up)', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const game: Game = { mid: 'c003_db01', schid: 'db01', visits: Array.from({ length: 24 }, () => 12), rev: 0 };
    await serve(page, game);
    const box = await openLive(page);
    await expect.poll(() => gap(box)).toBeLessThanOrEqual(2);
    game.visits.push(13, 14);
    game.rev += 1;
    await expect.poll(() => drawn(box)).toBe(26);
    // Read straight after the render: already there, nothing in flight.
    expect(await gap(box)).toBeLessThanOrEqual(2);
    expect(await box.evaluate((el) => getComputedStyle(el).scrollBehavior)).toBe('auto');
  });
});

test.describe('U01: watching on a large screen', () => {
  const sideBySide = async (page: Page): Promise<boolean> =>
    page.evaluate(() => {
      const a = document.querySelector('.ns-board')!.getBoundingClientRect();
      const b = document.querySelector('.ns-side')!.getBoundingClientRect();
      return a.right <= b.left + 1 && Math.abs(a.top - b.top) < 2;
    });
  const noSidewaysScroll = async (page: Page): Promise<void> => {
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
  };

  test('score sheet and figures side by side from about 1200 px; one column on phones; nothing sideways', async ({ page }) => {
    const game: Game = { mid: 'c003_db01', schid: 'db01', visits: Array.from({ length: 24 }, (_, i) => 10 + (i % 7)), rev: 0 };
    const log = await serve(page, game);
    await page.setViewportSize({ width: 1440, height: 900 });
    const box = await openLive(page);
    await expect.poll(() => drawn(box)).toBe(24);
    expect(await sideBySide(page)).toBe(true);
    // Both visible in one screen: the sheet's head row and the figures' first row.
    await page.getByTestId('live-board').scrollIntoViewIfNeeded();
    await expect(page.getByTestId('live-board').getByTestId('score-sheet')).toBeInViewport();
    await expect(page.getByLabel('このゲームのスタッツ')).toBeInViewport();
    await expect(page.getByTestId('live-estimate')).toBeInViewport();
    await noSidewaysScroll(page);

    // Widening does not start the game over (same box, same following state, no extra reads).
    const reads = log.filter((entry) => entry.startsWith('match/throws')).length;
    await box.evaluate((el) => el.setAttribute('data-probe', 'same'));
    await page.setViewportSize({ width: 1920, height: 1080 });
    await expect(page.getByTestId('live-scroll')).toHaveAttribute('data-probe', 'same');
    expect(await sideBySide(page)).toBe(true);
    // Two cards today: the cards become a column on the left of the chosen card.
    const tiles = await page.evaluate(() => {
      const board = document.querySelector('.live-hub > .board')!.getBoundingClientRect();
      const focus = document.querySelector('.live-hub > .focus-card')!.getBoundingClientRect();
      return { boardRight: board.right, focusLeft: focus.left, mainWidth: document.querySelector('.app-main')!.getBoundingClientRect().width };
    });
    expect(tiles.boardRight).toBeLessThanOrEqual(tiles.focusLeft);
    expect(tiles.mainWidth).toBeGreaterThan(1180);
    await noSidewaysScroll(page);
    expect(log.filter((entry) => entry.startsWith('match/throws')).length).toBe(reads);

    for (const [width, height] of [
      [320, 640],
      [393, 852],
      [768, 1024],
      [1024, 768],
    ]) {
      await page.setViewportSize({ width, height });
      await expect(page.getByTestId('live-scroll')).toHaveAttribute('data-probe', 'same');
      if (width < 1024) expect(await sideBySide(page)).toBe(false);
      await noSidewaysScroll(page);
      // Tap targets keep their size on a phone.
      const tile = await page.getByTestId('board-tile').first().boundingBox();
      expect(tile!.height).toBeGreaterThanOrEqual(44);
    }
  });
});
