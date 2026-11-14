import { readFileSync } from 'node:fs';
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { clickGenerate } from './ruleQuestions';
import { waitForRest } from './axe';
import { tab } from './nav';
import { generateOrder } from '../src/optimizer/generateOrder';
import { PRESETS } from '../src/domain/orders/presets';
import type { OrderInput, SavedOrder } from '../src/domain/types';
import type { OpponentContext } from '../src/domain/prediction/opponentContext';

/**
 * RESULT → オーダー設定 from the underdog note (docs/UNDERDOG_PLAN.md §4.1) in the production
 * build, on a phone and a desktop. The sample team has no n01 opponent, so its saved order is
 * given one in the backup (a far stronger, fictional opponent) and re-generated as 勝利優先 with
 * the real engine: the estimate is a few %, the note says where to check the underdog plan, and
 * its button opens SETUP with the order's conditions — generating nothing.
 */

async function audit(page: Page, label: string): Promise<void> {
  await waitForRest(page);
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  const summary = results.violations.map((violation) => ({
    id: violation.id,
    nodes: violation.nodes.slice(0, 3).map((node) => node.target.join(' ')),
  }));
  expect(summary, label).toEqual([]);
}

async function noSidewaysScroll(page: Page, label: string): Promise<void> {
  const extra = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(extra, label).toBeLessThanOrEqual(1);
}

function strongOpponent(input: OrderInput): OpponentContext {
  return {
    version: 2,
    generatedAt: 0,
    matchId: 'e2e',
    matchDate: '2026-10-20',
    opponentName: '架空の強豪チーム',
    leagueMeanPpr: 52,
    players: Object.fromEntries(
      input.players.map((p) => [p.id, { strength: 42, confidence: 'HIGH', legs: 60, imputed: false, formAdjustment: 0, first9Adjustment: 0, first9Excess: null }]),
    ),
    games: Object.fromEntries(
      input.games.map((game) => [
        game.id,
        { gameId: game.id, signature: game.id, numPart: game.playerCount, legsToWin: 2, cricket: false, likely: [], samples: 8, confidence: 'MEDIUM', sides: [{ strength: 70, probability: 1 }] },
      ]),
    ),
    orderConfidence: 'MEDIUM',
    confidence: 'MEDIUM',
  } as OpponentContext;
}

test('勝利優先 ≤ 20%: the note opens オーダー設定 with the order\'s conditions, without generating', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'サンプルで試す' }).click();
  await expect(page.getByRole('heading', { name: 'サンプルチーム', level: 1 })).toBeVisible();
  await page.getByRole('button', { name: '新しいオーダーを作る' }).click();
  await expect(page.getByRole('heading', { name: 'オーダー設定' })).toBeVisible();
  await clickGenerate(page);
  await expect(page.getByRole('heading', { name: 'オーダー結果' })).toBeVisible();
  await page.getByRole('button', { name: '下書きを保存' }).click();
  await expect(page.getByText('履歴に保存しました')).toBeVisible();

  // The saved order, as 勝利優先 against a far stronger opponent (the real engine, in Node).
  await tab(page, '設定 / バックアップ').click();
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'JSON エクスポート' }).click();
  const backup = JSON.parse(readFileSync((await (await download).path())!, 'utf-8'));
  const order = backup.data.orders[0] as SavedOrder;
  const input: OrderInput = { ...order.input, preset: 'WIN_FIRST', weights: { ...PRESETS.WIN_FIRST.weights }, opponent: strongOpponent(order.input) };
  const result = generateOrder(input, { timeLimitMs: 3000 });
  if (!result.ok) throw new Error('the sample order should be satisfiable');
  const win = Math.round(result.candidates[0].prediction!.win * 100);
  expect(win).toBeLessThanOrEqual(20);
  backup.data.orders[0] = { ...order, input, solution: result.candidates[0] };
  await page.setInputFiles('input[type="file"]', { name: 'underdog.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(backup), 'utf-8') });
  await page.getByRole('button', { name: '置き換える' }).click();
  await expect(page.getByText('インポートしました')).toBeVisible();

  await tab(page, '履歴').click();
  await page.locator('.list-row').first().click();
  await page.getByRole('button', { name: 'このオーダーを開いて編集' }).click();
  await expect(page.getByRole('heading', { name: 'オーダー結果' })).toBeVisible();
  await expect(page.getByTestId('estimated-match-win')).toHaveText(`${win}%`);

  const note = page.getByTestId('underdog-note');
  await expect(note).toHaveAttribute('data-kind', 'other-preset');
  await expect(note).toContainText('格上対策は「対戦相手最適化」で確認できます');
  await expect(note).toContainText(`この候補の推定 Match 勝率は ${win}%`);
  await expect(page.getByTestId('underdog-panel')).toHaveCount(0);
  await noSidewaysScroll(page, 'result with the underdog note');
  await audit(page, 'RESULT (underdog note)');

  const fielded = input.participants.filter((config) => config.include).length;
  await note.getByRole('button', { name: 'オーダー設定を開く' }).click();
  await expect(page.getByRole('heading', { name: 'オーダー設定' })).toBeVisible();
  // Nothing generated, no preset chosen: 勝利優先 is still the one selected.
  await expect(page.getByRole('button', { name: /生成中/ })).toHaveCount(0);
  await expect(page.getByRole('radio', { name: /勝利優先/ })).toHaveAttribute('aria-checked', 'true');
  await expect(page.locator('.participant:not(.is-out)')).toHaveCount(fielded);
  await noSidewaysScroll(page, 'setup opened from the note');

  // The order is still the one on the result screen.
  await tab(page, 'オーダー').click();
  await expect(page.getByRole('heading', { name: 'オーダー結果' })).toBeVisible();
  await expect(page.getByTestId('underdog-note')).toBeVisible();
});
