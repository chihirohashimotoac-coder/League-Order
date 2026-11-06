import { expect, test, type Page } from '@playwright/test';
import { pinFixtureClock, serveN01 } from './n01Server';
import { N01_API_BASE_URL } from '../src/integrations/n01/endpoints';
import { TDID, c001Rows, fixtures, gameRow, list, liveBody, side, tournamentDoc } from '../src/features/matches/testFixtures';

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

/** Canned n01 for MATCH RESULTS / LIVE MATCH under ATDO's league id. */
async function serveMatches(page: Page, live?: () => unknown): Promise<string[]> {
  const log: string[] = [];
  await page.route(`${N01_API_BASE_URL}/**`, async (route) => {
    const url = new URL(route.request().url());
    const operation = url.pathname.replace(/^.*\/api\/v1\//u, '');
    log.push(`${operation}?${url.searchParams.toString()}`);
    const live1 = url.searchParams.get('live') === '1';
    const officialC001 = { '0_c001': { AAAA: { BBBB: { r: 3, a: 55.5 } }, BBBB: { AAAA: { r: 2, a: 50.1 } } } };
    const body =
      operation === 'league/tournament/list'
        ? { result: 0, league: { lgid: 'lg_l3hI_3397', title: 'ATDO' }, list: [{ tdid: TDID, title: 'Test League 1st', status: 30, t_date: 1_800_000_000, createTime: 1_790_000_000 }] }
        : operation === 'tournament/get'
          ? tournamentDoc(officialC001)
          : operation === 'league/schedule/get'
            ? fixtures()
            : operation === 'tournament/standings'
              ? {
                  result: 0,
                  tdid: TDID,
                  groups: [
                    {
                      kind: 'lg',
                      index: 0,
                      title: 'A Division',
                      players: [
                        { tpid: 'AAAA', name: 'Arrows', rank: 1, p: 1, w: 1, d: 0, l: 0, pts: 5 },
                        { tpid: 'BBBB', name: 'Bulls', rank: 2, p: 1, w: 0, d: 0, l: 1, pts: 2 },
                        { tpid: 'CCCC', name: 'Corks', rank: 0, p: 0, w: 0, d: 0, l: 0, pts: 0 },
                        { tpid: 'DDDD', name: 'Doubles', rank: 0, p: 0, w: 0, d: 0, l: 0, pts: 0 },
                      ],
                    },
                  ],
                }
              : operation === 'match/list'
                ? list(
                    live1
                      ? [gameRow('c003', 'AAAA', 'CCCC', 'sg01', [side('AAAA', [['a1', 'A1']], 1, 300, 15), side('CCCC', [['c1', 'C1']], 0, 250, 15)], { finished: false })]
                      : [...c001Rows(), gameRow('c003', 'AAAA', 'CCCC', 'tm01', [side('AAAA', [['a1', 'A1']], 1, 1001, 60), side('CCCC', [['c1', 'C1']], 0, 900, 60)])],
                  )
                : operation === 'match/get'
                  ? {
                      result: 0,
                      match: {
                        mid: url.searchParams.get('mid'),
                        match_type: '01',
                        startScore: 501,
                        endMatch: 1,
                        legData: [{ first: 0, endFlag: 1, winner: 0, playerData: [[{ score: 0, left: 501 }, { score: 140, left: 361 }, { score: 100, left: 261 }, { score: 100, left: 161 }, { score: -3, left: 0 }], [{ score: 0, left: 501 }, { score: 60, left: 441 }, { score: 60, left: 381 }, { score: 60, left: 321 }]] }],
                      },
                    }
                  : operation === 'match/live' && live
                    ? live()
                    : null;
    if (body === null) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ result: -1, error: 'not found' }) });
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body), headers: { 'access-control-allow-origin': '*' } });
  });
  return log;
}

test.describe('MATCH RESULTS', () => {
  test('cards, a card in detail with its legs, official standings and player form', async ({ page }) => {
    const log = await serveMatches(page);
    await openSample(page);
    await page.locator('.list-row').filter({ hasText: '試合結果' }).click();
    await page.getByRole('button', { name: 'ATDO' }).click();
    const cards = page.getByTestId('match-card');
    await expect(cards).toHaveCount(4);
    // Played (newest first), then not yet played. c003 has a finished game and no card result.
    await expect(cards.nth(0)).toContainText('Arrows');
    await expect(cards.nth(0)).toContainText('3 - 2');
    await expect(cards.nth(0)).toContainText('結果確定 (n01)');
    await expect(cards.nth(1)).toContainText('結果未入力');
    await expect(cards.nth(1)).toContainText('ゲーム数は League Order の集計');
    await expect(cards.nth(2)).toContainText('未開催');
    await expect(cards.nth(3)).toContainText('未開催');
    await cards.nth(0).click();
    const detail = page.getByTestId('match-detail');
    await expect(detail).toContainText('公式結果 3 - 2');
    await expect(detail).toContainText('シングルス1');
    await expect(detail).toContainText('MPR');
    await detail.getByRole('button', { name: 'Leg' }).first().click();
    await expect(detail.locator('.leg-list')).toContainText('Leg 1');
    // Own team unknown for the sample team: no analysis is attributed to anyone.
    await expect(detail.getByTestId('intel-prediction')).toHaveCount(0);
    await noSidewaysScroll(page);

    await page.getByRole('tab', { name: '順位' }).click();
    await expect(page.locator('.standings')).toContainText('Arrows');
    await expect(page.getByText('勝ち点の計算規則を確認済み')).toBeVisible();
    await page.getByRole('tab', { name: '選手' }).click();
    await expect(page.getByTestId('player-forms')).toContainText('A1');
    await noSidewaysScroll(page);
    // Read operations only, and each season part read once.
    expect(log.every((entry) => /^(league\/tournament\/list|tournament\/(get|standings)|league\/schedule\/get|match\/(list|get))\?/u.test(entry))).toBe(true);
    expect(log.filter((entry) => entry.startsWith('tournament/get')).length).toBe(1);
  });

  test('a failed read says so and offers a retry, never an empty season', async ({ page }) => {
    await page.route(`${N01_API_BASE_URL}/**`, (route) => route.abort('internetdisconnected'));
    await openSample(page);
    await page.locator('.list-row').filter({ hasText: '試合結果' }).click();
    await page.getByRole('button', { name: 'ATDO' }).click();
    await expect(page.getByRole('alert')).toContainText('取得エラー');
    await expect(page.getByRole('button', { name: '再試行' }).first()).toBeVisible();
    await expect(page.getByTestId('match-card')).toHaveCount(0);
  });
});

test.describe('LIVE MATCH', () => {
  test('follows the card with since, shows left / next thrower / throws, and stops when it ends', async ({ page }) => {
    let n = 0;
    const log = await serveMatches(page, () => {
      n += 1;
      if (n === 1) return liveBody();
      if (n < 4) return { result: 0, changed: 0, mid: 'c003_sg01', updateTime: 1_800_000_010_000 };
      return liveBody({ updateTime: 1_800_000_020_000, end_match: 1, end_schedule: 1, sets: [3, 2], leg: { ...(liveBody().leg as object), end: 1, winner: 0, left: [0, 401], thrower: null } });
    });
    await openSample(page);
    await page.locator('.list-row').filter({ hasText: 'ライブ観戦' }).click();
    await page.getByRole('button', { name: 'ATDO' }).click();
    await page.getByTestId('live-card').first().click();
    const board = page.getByTestId('live-board');
    await expect(board).toContainText('2 - 1');
    await expect(board).toContainText('321');
    await expect(board.getByTestId('next-thrower')).toContainText('C1');
    await board.getByRole('button', { name: 'スロー履歴 (このLeg)' }).click();
    await expect(board.locator('.throws')).toContainText('R2 A1: 80 → 残り 321');
    await expect(page.getByTestId('live-status')).toContainText('終了しました', { timeout: 15_000 });
    await expect(board).toContainText('3 - 2');
    const lives = log.filter((entry) => entry.startsWith('match/live'));
    expect(lives[0]).not.toContain('since=');
    expect(lives.slice(1).every((entry) => entry.includes('since=1800000010000'))).toBe(true);
    // Stopped: no request after the end.
    const count = lives.length;
    await page.waitForTimeout(3500);
    expect(log.filter((entry) => entry.startsWith('match/live')).length).toBe(count);
    await noSidewaysScroll(page);
  });
});
