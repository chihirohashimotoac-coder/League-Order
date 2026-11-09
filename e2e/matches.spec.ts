import { expect, test, type Page } from '@playwright/test';
import { pinFixtureClock, serveN01 } from './n01Server';
import { N01_API_BASE_URL } from '../src/integrations/n01/endpoints';
import { LGID, TDID, c001Rows as rawC001Rows, fixtures, gameRow, list, liveBody, side, tournamentDoc } from '../src/features/matches/testFixtures';

/**
 * The 2026-11 update in a real browser: the appearance-count questions, ATDO's caps applied
 * without asking, MATCH RESULTS and LIVE MATCH on canned n01 responses (no network).
 */

test.use({ serviceWorkers: 'block' });

async function openSample(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByRole('button', { name: 'サンプルで試す' }).click();
  await expect(page.getByRole('heading', { name: 'サンプルチーム', level: 1 })).toBeVisible();
  await expect(page.locator('.toast')).toHaveCount(0, { timeout: 6000 });
}

async function noSidewaysScroll(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
}

test.describe('appearance-count questions (出場回数の確認)', () => {
  test('asks only the kinds played twice, generates nothing unanswered, and keeps the answer', async ({ page }) => {
    await openSample(page);
    await page.getByRole('button', { name: '新しいオーダーを作る' }).click();
    // 標準6ゲーム: Singles ×3, Doubles ×2, Trios ×1.
    await expect(page.getByTestId('rule-conditions-pending')).toContainText('ダブルス・シングルス');
    await page.getByRole('button', { name: 'オーダーを生成' }).click();
    const dialog = page.getByRole('dialog', { name: '出場回数の確認' });
    await expect(dialog.getByRole('radiogroup')).toHaveCount(2);
    await expect(dialog).toContainText('同じ選手がダブルスに2回出場しても良いですか？');
    await expect(dialog).toContainText('同じ選手がシングルスに2回出場しても良いですか？');
    await expect(dialog).not.toContainText('トリオス');
    await expect(dialog.getByTestId('rule-questions-confirm')).toBeDisabled();
    await dialog.getByRole('radiogroup').nth(0).getByRole('radio', { name: 'いいえ' }).click();
    await expect(dialog.getByTestId('rule-questions-confirm')).toBeDisabled();
    await dialog.getByRole('radiogroup').nth(1).getByRole('radio', { name: 'はい' }).click();
    await dialog.getByTestId('rule-questions-confirm').click();
    await expect(page.getByRole('heading', { name: 'オーダー結果' })).toBeVisible();
    // The order keeps to it: nobody in both Doubles.
    const doubles = await page.locator('.order-game').filter({ hasText: 'Doubles' }).allInnerTexts();
    expect(doubles).toHaveLength(2);

    await page.reload();
    await expect(page.getByRole('heading', { name: 'サンプルチーム', level: 1 })).toBeVisible();
    await page.getByRole('button', { name: '新しいオーダーを作る' }).click();
    await expect(page.getByTestId('rule-conditions-pending')).toHaveCount(0);
    await expect(page.getByTestId('rule-conditions-own')).toContainText('ダブルス: 1人1回まで');
    await expect(page.getByTestId('rule-conditions-own')).toContainText('シングルス: 1人2回まで');
    await noSidewaysScroll(page);
  });

  test('ATDO: Singles and Doubles are capped once per player with no question, labelled as the league’s rule', async ({ page }) => {
    await pinFixtureClock(page);
    await serveN01(page);
    await page.goto('/');
    await page.getByRole('button', { name: 'n01から作成' }).click();
    const wizard = page.getByRole('dialog', { name: 'n01から作成' });
    await wizard.getByRole('button', { name: 'ATDO', exact: true }).click();
    await wizard.getByRole('button', { name: /kalavinka/ }).click();
    await wizard.getByRole('button', { name: 'このチームを作成' }).click();
    await expect(page.getByRole('heading', { name: 'kalavinka', level: 1 })).toBeVisible();
    await page.locator('.tab-bar').getByRole('button', { name: 'オーダー', exact: true }).click();
    const league = page.getByTestId('rule-conditions-league');
    await expect(league).toContainText('大会の規則: ATDO の出場規則 (利用者の確定要件・公式規約は未確認)');
    await expect(league).toContainText('シングルス: 1人1回まで');
    await expect(league).toContainText('ダブルス: 1人1回まで');
    await expect(league).toContainText('1 対戦カード');
    await expect(page.getByTestId('rule-conditions-pending')).toHaveCount(0);
  });
});

/** n01 writes one tmid per card. */
const c001Rows = (): unknown[] => rawC001Rows().map((row) => ({ ...(row as object), tmid: `${TDID}_lg_0_c001_AAAA_BBBB` }));
const officialC001 = { '0_c001': { AAAA: { BBBB: { r: 3, a: 55.5 } }, BBBB: { AAAA: { r: 2, a: 50.1 } } } };
/** Today: c003 under way — the team game won by Arrows, Doubles 1 in progress. */
const today = (): unknown[] => [
  gameRow('c003', 'AAAA', 'CCCC', 'tm01', [side('AAAA', [['a1', 'A1'], ['a2', 'A2'], ['a3', 'A3'], ['a4', 'A4']], 1, 1001, 54), side('CCCC', [['c1', 'C1'], ['c2', 'C2'], ['c3', 'C3'], ['c4', 'C4']], 0, 880, 54)], { start: 1_800_000_000, mid: 'c003_tm01' }),
  gameRow('c003', 'AAAA', 'CCCC', 'db01', [side('AAAA', [['a1', 'A1'], ['a2', 'A2']], 1, 400, 30), side('CCCC', [['c1', 'C1'], ['c2', 'C2']], 0, 300, 30)], { start: 1_800_000_900, finished: false, mid: 'c003_db01' }),
];
const throwsBody = (mid: string): unknown => ({
  result: 0,
  changed: 1,
  mid,
  match_type: '01',
  end_match: 1,
  updateTime: 1_800_000_500_000,
  leg_data: [
    { leg: 0, first: 0, end: 1, winner: 0, darts: [15, 15], throws: [{ p: 0, r: 1, score: 180, left: 321 }, { p: 1, r: 1, score: 60, left: 441 }, { p: 0, r: 2, score: 140, left: 181 }, { p: 1, r: 2, score: 100, left: 341 }, { p: 0, r: 3, score: 100, left: 81 }, { p: 1, r: 3, score: 45, left: 296 }, { p: 0, r: 4, score: 41, left: 40 }, { p: 1, r: 4, score: 85, left: 211 }, { p: 0, r: 5, score: 40, left: 0, darts: 3, finish: 1 }] },
  ],
});

async function serveN01Canned(page: Page, live?: () => unknown): Promise<string[]> {
  const log: string[] = [];
  await page.route(`${N01_API_BASE_URL}/**`, async (route) => {
    const url = new URL(route.request().url());
    const operation = url.pathname.replace(/^.*\/api\/v1\//u, '');
    const q = url.searchParams;
    log.push(`${operation}?${q.toString()}`);
    let body: unknown = null;
    if (operation === 'league/tournament/list') body = { result: 0, league: { lgid: 'lg_l3hI_3397', title: 'ATDO' }, list: [{ tdid: TDID, title: 'Test League 1st', status: 30, t_date: 1_800_000_000, createTime: 1_790_000_000 }] };
    else if (operation === 'tournament/get' && q.get('tdid') === TDID) body = tournamentDoc(officialC001);
    else if (operation === 'tournament/get' && q.get('tdid') === 't_Tour_0001')
      body = { result: 0, url: 'https://n01darts.com/n01/tournament/comp.php?id=t_Tour_0001', tournament: { tdid: 't_Tour_0001', title: 'Autumn Open', status: 30, entry_list: [{ tpid: 'p1', name: 'Ann' }, { tpid: 'p2', name: 'Bo' }, { tpid: 'p3', name: 'Cy' }], rr_title: ['Group A'] } };
    else if (operation === 'league/schedule/get') body = fixtures();
    else if (operation === 'tournament/standings' && q.get('tdid') === TDID)
      body = { result: 0, tdid: TDID, groups: [{ kind: 'lg', index: 0, title: 'A Division', players: [{ tpid: 'AAAA', name: 'Arrows', rank: 1, p: 1, w: 1, d: 0, l: 0, pts: 5 }, { tpid: 'BBBB', name: 'Bulls', rank: 2, p: 1, w: 0, d: 0, l: 1, pts: 2 }, { tpid: 'CCCC', name: 'Corks', rank: 0, p: 0, w: 0, d: 0, l: 0, pts: 0 }, { tpid: 'DDDD', name: 'Doubles', rank: 0, p: 0, w: 0, d: 0, l: 0, pts: 0 }] }] };
    else if (operation === 'tournament/standings') body = { result: 0, groups: [{ kind: 'rr', index: 0, title: 'Group A', players: [{ tpid: 'p1', name: 'Ann', rank: 1, p: 1, w: 1, d: 0, l: 0, diff: 2 }] }] };
    else if (operation === 'match/list' && q.get('tdid') === 't_Tour_0001')
      body = list([
        { mid: 'tour_1', tdid: 't_Tour_0001', tmid: 't_Tour_0001_rr_0_p1_p2', schid: '', match_type: '01', title: 'Autumn Open Group A', startTime: 1_800_000_000, endMatch: 1, statsData: [{ name: 'Ann', tpid: 'p1', winLegs: 3, allScore: 1503, allDarts: 60 }, { name: 'Bo', tpid: 'p2', winLegs: 1, allScore: 1200, allDarts: 60 }] },
        { mid: 'tour_2', tdid: 't_Tour_0001', tmid: 't_Tour_0001_rr_0_p2_p3', schid: '', match_type: '01', title: 'Autumn Open Group A', startTime: 1_800_000_500, endMatch: 0, statsData: [{ name: 'Bo', tpid: 'p2', winLegs: 1, allScore: 300, allDarts: 15 }, { name: 'Cy', tpid: 'p3', winLegs: 0, allScore: 250, allDarts: 15 }] },
      ]);
    else if (operation === 'match/list' && q.get('startTime__gte')) body = list(today());
    else if (operation === 'match/list' && q.get('mid')) body = list([{ mid: q.get('mid'), tdid: 't_Tour_0001', tmid: 't_Tour_0001_rr_0_p1_p2', match_type: '01', title: 'Autumn Open Group A', endMatch: 1, statsData: [{ name: 'Ann', tpid: 'p1', winLegs: 1 }, { name: 'Bo', tpid: 'p2', winLegs: 0 }] }]);
    else if (operation === 'match/list') body = list([...c001Rows(), ...today()]);
    else if (operation === 'match/throws') body = throwsBody(q.get('mid') ?? '');
    else if (operation === 'match/live' && live) body = live();
    else if (operation === 'team/order/list')
      body = { result: 0, list: [{ tpid: 'AAAA', schid: 'sg01', fix: 1, order: [{ oid: 'a1', oname: 'A1' }] }, { tpid: 'CCCC', schid: 'sg01', fix: 1, order: [{ oid: 'c1', oname: 'C1' }] }] };
    else if (operation === 'tournament/stats') body = { result: 0, stats: { a1: { tpid: 'AAAA', score: 3006, darts: 120, leg: 10, winLeg: 7, ton80: 2, highOut: 120, best: 15 }, b1: { tpid: 'BBBB', score: 2400, darts: 120, leg: 10, winLeg: 3, ton80: 0 } } };
    else if (operation === 'team/player/list') body = { result: 0, list: [{ tpid: 'AAAA', oid: 'a1', oname: 'A1' }, { tpid: 'BBBB', oid: 'b1', oname: 'B1' }] };
    if (body === null) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ result: -1, error: 'not found' }) });
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body), headers: { 'access-control-allow-origin': '*' } });
  });
  return log;
}

async function watchWithoutTeam(page: Page): Promise<void> {
  await page.goto('/');
  // 「リーグ・大会を見る」: no team needed.
  await page.getByRole('group', { name: 'よく使われるリーグ' }).getByRole('button', { name: 'ATDO' }).click();
  await expect(page.getByTestId('watch-page')).toBeVisible();
}

test.describe('player card (選手カード)', () => {
  test('a registered team’s player: season figures from the throws, and the next order one tap away', async ({ page }) => {
    // A team made from n01 (ATDO) ...
    await pinFixtureClock(page);
    await serveN01(page);
    await page.goto('/');
    await page.getByRole('button', { name: 'n01から作成' }).click();
    const wizard = page.getByRole('dialog', { name: 'n01から作成' });
    await wizard.getByRole('button', { name: 'ATDO', exact: true }).click();
    await wizard.getByRole('button', { name: /kalavinka/ }).click();
    await wizard.getByRole('button', { name: 'このチームを作成' }).click();
    await expect(page.getByRole('heading', { name: 'kalavinka', level: 1 })).toBeVisible();
    // ... found by its exact name in a season of the same league (Arrows renamed kalavinka).
    await page.unroute(`${N01_API_BASE_URL}/**`);
    await serveN01Canned(page);
    await page.route(
      (url) => url.pathname.endsWith('/tournament/get') && url.searchParams.get('tdid') === TDID,
      (route) =>
        route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(tournamentDoc(officialC001)).replaceAll('"Arrows"', '"kalavinka"').replaceAll(LGID, 'lg_l3hI_3397') }),
    );
    await page.getByTestId('home-results').click();
    await page.getByRole('tab', { name: 'スタッツ' }).click();
    await page.getByTestId('stats-tab').getByRole('button', { name: 'A1', exact: true }).click();
    const card = page.getByTestId('player-card');
    await expect(card).toContainText('Singles 01 平均');
    await expect(card).toContainText('上がり圏');
    await expect(card).not.toContainText('集計中');
    await expect(card).toContainText('180');
    await noSidewaysScroll(page);
    await card.getByRole('button', { name: 'kalavinka の次戦オーダーを作る' }).click();
    await expect(page.getByTestId('rule-conditions-league')).toBeVisible();
  });
});

test.describe('watching without a team (リーグ・大会を見る)', () => {
  test('live: today’s cards, the card’s flow, scoreboard, estimate, upcoming lineup; it stops when the card ends', async ({ page }) => {
    let n = 0;
    const log = await serveN01Canned(page, () => {
      n += 1;
      const body = liveBody({ mid: 'c003_db01', schid: 'db01', title: 'Test League A Division ダブルス1', sets: [1, 0] });
      if (n < 3) return body;
      return { ...body, updateTime: 1_800_000_020_000, end_match: 1, end_schedule: 1, sets: [3, 2] };
    });
    await watchWithoutTeam(page);
    await expect(page.getByTestId('board-tile')).toHaveCount(1);
    await expect(page.getByTestId('board-tile')).toContainText('Arrows');
    await expect(page.getByTestId('board-tile')).toContainText('1-0');
    const focus = page.getByTestId('focus-card');
    await expect(focus.locator('.flow .dot')).toHaveCount(5);
    await expect(focus.getByTestId('estimate')).toContainText('予測');
    await expect(focus.getByTestId('card-trail')).toContainText('Arrows の勝率 (予測) の推移');
    await expect(focus.getByTestId('next-thrower')).toContainText('C1');
    await expect(focus.getByTestId('upcoming')).toContainText('シングルス1 A1 vs C1');
    // The game in progress as a scoreboard: Scored / To Go, the points left, the game's figures,
    // then League Order's own figures (leg / game chance).
    const board = focus.getByTestId('live-board');
    await expect(board.getByTestId('score-sheet')).toContainText('To Go');
    await expect(board.getByTestId('score-sheet')).toContainText('321');
    await expect(board.getByTestId('race-chart')).toContainText('点先行');
    await expect(board).toContainText('3 Darts');
    await expect(board.getByTestId('league-order-plus')).toBeVisible();
    await expect(board.getByTestId('leg-chance')).toContainText('%');
    await expect(focus.getByTestId('live-status')).toContainText('終了しました', { timeout: 15_000 });
    await expect(focus.locator('.focus-head')).toContainText('3 - 2');
    const lives = log.filter((entry) => entry.startsWith('match/live'));
    expect(lives.slice(1).every((entry) => entry.includes('since='))).toBe(true);
    const count = lives.length;
    await page.waitForTimeout(3500);
    expect(log.filter((entry) => entry.startsWith('match/live')).length).toBe(count);
    await noSidewaysScroll(page);
  });

  test('results → match center → a game’s Details and score sheet; standings with the round robin; stats', async ({ page }) => {
    const log = await serveN01Canned(page);
    await watchWithoutTeam(page);
    await page.getByRole('tab', { name: '日程・結果' }).click();
    const cards = page.getByTestId('match-card');
    await expect(cards).toHaveCount(4);
    await expect(page.getByTestId('results-tab')).toContainText('第1戦');
    await cards.filter({ hasText: '結果確定' }).first().click();
    const detail = page.getByTestId('match-detail');
    await expect(detail).toContainText('公式結果 (n01)');
    await detail.locator('.game-row').nth(3).click();
    const view = detail.getByTestId('game-view');
    await expect(view).toContainText('180');
    await expect(view).toContainText('High Out');
    await expect(view.getByTestId('score-sheet')).toContainText('x3');
    // League Order's own figures: the points-left race of the leg, the visits started on a finish.
    await expect(view.getByTestId('race-chart')).toContainText('15 本で上がり');
    await expect(view.getByTestId('finish-chances')).toContainText('1/2');
    // 見どころ: read from every finished game's throws; a line opens that leg with the visit marked.
    const highlights = detail.getByTestId('highlights');
    await expect(highlights).toContainText('180');
    await expect(highlights).toContainText('最短');
    await expect(detail.getByTestId('card-trail')).toContainText('このカードを除く');
    await highlights.locator('.hl-row').filter({ hasText: '180' }).first().click();
    await expect(detail.getByTestId('game-view').locator('tr.marked td.mark')).toHaveText('180');
    await expect(detail.getByTestId('intel-opponent')).toContainText('対戦 (公式)');
    await noSidewaysScroll(page);
    await detail.getByRole('button', { name: /一覧に戻る/ }).click();

    await page.getByRole('tab', { name: '順位' }).click();
    await expect(page.getByTestId('standings-tab')).toContainText('Arrows');
    await page.getByText('星取表 (獲得ゲーム数)').first().click();
    await expect(page.getByTestId('round-robin')).toContainText('3-2');
    await page.getByRole('tab', { name: 'スタッツ' }).click();
    await expect(page.getByTestId('stats-tab').locator('tbody tr').first()).toContainText('A1');
    await expect(page.getByTestId('stats-tab').locator('tbody tr').first()).toContainText('75.15');
    await noSidewaysScroll(page);
    // Read operations only.
    expect(log.every((entry) => /^(league\/tournament\/list|tournament\/(get|standings|stats)|league\/schedule\/get|match\/(list|get|live|throws)|team\/(order|player)\/list)\?/u.test(entry))).toBe(true);
  });

  test('a tournament by id: matches by stage, a game in a sheet, round-robin standings', async ({ page }) => {
    await serveN01Canned(page);
    await watchWithoutTeam(page);
    await page.getByRole('button', { name: /見るものを変更/ }).click();
    await page.getByLabel('リーグ・大会を検索').fill('https://n01darts.com/n01/tournament/comp.php?id=t_Tour_0001');
    await page.getByRole('button', { name: '検索' }).click();
    const hub = page.getByTestId('tournament-hub');
    await expect(hub).toContainText('Autumn Open');
    await expect(hub.getByTestId('competition-match')).toHaveCount(1);
    await page.getByRole('tab', { name: '試合' }).click();
    await expect(hub).toContainText('ラウンドロビン Group A');
    await expect(hub.getByTestId('competition-match')).toHaveCount(2);
    await hub.getByTestId('competition-match').filter({ hasText: '終了' }).click();
    await expect(page.getByTestId('match-sheet').getByTestId('score-sheet')).toBeVisible();
    await page.keyboard.press('Escape');
    await page.getByRole('tab', { name: '順位' }).click();
    await expect(hub).toContainText('Ann');
    await noSidewaysScroll(page);
  });

  test('a failed read says so and offers a retry, never an empty season', async ({ page }) => {
    await page.route(`${N01_API_BASE_URL}/**`, (route) => route.abort('internetdisconnected'));
    await watchWithoutTeam(page);
    await expect(page.getByRole('alert').first()).toContainText('取得エラー');
    await expect(page.getByRole('button', { name: '再試行' }).first()).toBeVisible();
    await expect(page.getByTestId('match-card')).toHaveCount(0);
  });
});
