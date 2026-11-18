import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { expectNoAxeViolations, waitForRest } from './axe';
import { serveNight } from './liveNight';
import { clickGenerate } from './ruleQuestions';
import { tab } from './nav';

/**
 * 表示テーマ (設定 › 表示テーマ): 設定画面から選ぶと画面全体に反映され、再読み込み後も残る。
 * 追加の 2 テーマ (スタジアム / クリーン) でも主要画面が WCAG 2.1 AA (色のコントラストを含む) を
 * 満たし、横スクロールが出ないことを確かめる。既定のテーマは a11y.spec.ts などが確かめている。
 * テーマは見た目だけで、オーダー生成・観戦の動作は同じ (既存の各 spec が既定テーマで確かめている)。
 */

const THEMES = [
  { id: 'stadium', label: /スタジアム/u },
  { id: 'clean', label: /クリーン/u },
] as const;

async function noSidewaysScroll(page: Page, label: string): Promise<void> {
  const extra = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(extra, label).toBeLessThanOrEqual(1);
}

async function chooseTheme(page: Page, label: RegExp): Promise<void> {
  await tab(page, '設定 / バックアップ').click();
  await page.getByText('表示テーマ', { exact: true }).click();
  await page.getByRole('group', { name: '画面の配色' }).getByRole('radio', { name: label }).check();
}

async function audit(page: Page, info: TestInfo, label: string): Promise<void> {
  await noSidewaysScroll(page, label);
  await test.step(`axe: ${label}`, async () => expectNoAxeViolations(page, info));
}

for (const theme of THEMES) {
  test(`theme ${theme.id}: chosen in settings, kept after a reload, and the order screens pass WCAG AA`, async ({ page }, info) => {
    test.skip(info.project.name !== 'mobile', 'one project is enough for the colours');
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto('/');
    await page.getByRole('button', { name: 'サンプルで試す' }).click();
    await expect(page.getByRole('heading', { name: 'サンプルチーム', level: 1 })).toBeVisible();
    await expect(page.locator('.toast')).toHaveCount(0, { timeout: 6000 });
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'sheet');

    await chooseTheme(page, theme.label);
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme.id);
    await audit(page, info, 'SETTINGS');

    // この端末に保存され、再読み込みしても同じテーマで始まる。
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme.id);
    await expect(page.getByRole('heading', { name: 'サンプルチーム', level: 1 })).toBeVisible();
    await audit(page, info, 'HOME');

    await page.getByRole('button', { name: /^(次戦の)?オーダーを作る$/u }).click();
    await expect(page.getByRole('heading', { name: 'オーダー設定' })).toBeVisible();
    await audit(page, info, 'SETUP');

    await clickGenerate(page);
    await expect(page.getByRole('heading', { name: 'オーダー結果' })).toBeVisible();
    for (const index of [0, 1, 2]) {
      await page.locator('.candidate-tab').nth(index).click();
      await audit(page, info, `RESULT candidate ${index + 1}`);
    }
    await page.getByText('詳細分析', { exact: true }).click();
    await audit(page, info, 'RESULT analysis');

    await page.locator('.action-bar .btn.primary').click();
    await expect(page.locator('.toast')).toHaveCount(0, { timeout: 6000 });
    await page.locator('.action-bar').getByRole('button', { name: /共有/u }).click();
    await expect(page.getByRole('dialog', { name: '共有' })).toBeVisible();
    await audit(page, info, 'SHARE');
    await page.keyboard.press('Escape');

    await tab(page, '履歴').click();
    await audit(page, info, 'HISTORY');
  });
}

/*
 * 観戦の画面には、テーマと関係なく既定のテーマでも出る既存の ARIA の指摘が 2 つある
 * (タブの aria-pressed、スコア表の読み込み中の印 .ns-dot の aria-label)。マークアップの問題で、
 * このテーマの変更の範囲外 (PR に報告済み)。ここでは色のコントラストを含むその他の規則を確かめる。
 */
/** 既知の指摘: 規則と、その指摘を受けている要素 (axe の target) の組だけを除く。 */
const KNOWN_WATCH_ARIA: { id: string; target: RegExp }[] = [
  { id: 'aria-allowed-attr', target: /^#watch-tab-/u },
  { id: 'aria-prohibited-attr', target: /\.ns-dot$/u },
];

async function auditWatch(page: Page, info: TestInfo, label: string): Promise<void> {
  await noSidewaysScroll(page, label);
  await waitForRest(page);
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  const violations = results.violations
    .map((violation) => ({
      id: violation.id,
      nodes: violation.nodes
        .filter((node) => !KNOWN_WATCH_ARIA.some((known) => known.id === violation.id && known.target.test(node.target.join(' '))))
        .map((node) => `${node.target.join(' ')} — ${node.failureSummary ?? ''}`),
    }))
    .filter((violation) => violation.nodes.length > 0);
  if (violations.length > 0) await info.attach(`axe-${label}.json`, { body: JSON.stringify(results.violations, null, 2), contentType: 'application/json' });
  expect(violations, label).toEqual([]);
}

for (const theme of [{ id: 'sheet' }, ...THEMES]) {
  test(`theme ${theme.id}: watching a league night (live, schedule, standings, stats) passes WCAG AA`, async ({ page }, info) => {
    await page.addInitScript((id) => window.localStorage.setItem('league-order:theme', id), theme.id);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await serveNight(page);
    await page.goto('/');
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme.id);
    await page.getByRole('group', { name: 'よく使われるリーグ' }).getByRole('button', { name: 'ATDO' }).click();
    await expect(page.getByTestId('live-board')).toBeVisible();
    await auditWatch(page, info, 'LIVE');
    await page.getByRole('tab', { name: '日程・結果' }).click();
    await expect(page.getByTestId('results-tab')).toBeVisible();
    await auditWatch(page, info, 'SCHEDULE');
    await page.getByRole('tab', { name: '順位' }).click();
    await expect(page.getByTestId('standings-table').first()).toBeVisible();
    await auditWatch(page, info, 'STANDINGS');
    await page.getByRole('tab', { name: 'スタッツ' }).click();
    await auditWatch(page, info, 'STATS');
  });
}

for (const theme of THEMES) {
  test(`theme ${theme.id}: the other screens, sheets and the menu pass WCAG AA`, async ({ page }, info) => {
    test.skip(info.project.name !== 'mobile', 'one project is enough for the colours');
    await page.addInitScript((id) => window.localStorage.setItem('league-order:theme', id), theme.id);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto('/');
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme.id);
    await audit(page, info, 'WELCOME');
    await page.getByRole('button', { name: 'サンプルで試す' }).click();
    await expect(page.getByRole('heading', { name: 'サンプルチーム', level: 1 })).toBeVisible();
    await expect(page.locator('.toast')).toHaveCount(0, { timeout: 6000 });

    await page.getByRole('button', { name: 'メニューを開く' }).click();
    await expect(page.getByRole('dialog', { name: 'メニュー' })).toBeVisible();
    await audit(page, info, 'MENU');
    await page.keyboard.press('Escape');

    await page.getByRole('button', { name: '切替 / 管理', exact: true }).click();
    await audit(page, info, 'TEAM MANAGER');
    await page.keyboard.press('Escape');

    await tab(page, 'メンバー').click();
    await audit(page, info, 'PLAYERS');
    await page.locator('.list-row').filter({ hasText: '青木' }).click();
    await page.getByLabel('PPR Average (任意)').fill('300');
    await audit(page, info, 'PLAYER EDITOR (with a validation error)');
    await page.keyboard.press('Escape');

    await tab(page, 'フォーマット').click();
    await audit(page, info, 'FORMATS');
    await page.locator('.list-row').first().click();
    await audit(page, info, 'FORMAT EDITOR');
    await page.keyboard.press('Escape');

    await tab(page, 'ペア相性').click();
    await audit(page, info, 'PAIRS');
    await tab(page, '分析').click();
    await audit(page, info, 'ANALYTICS (no n01 team)');
    await tab(page, 'その他').click();
    await audit(page, info, 'MORE');
    await page.getByTestId('more-page').getByRole('button', { name: /^更新履歴/u }).click();
    await audit(page, info, 'CHANGELOG');
  });
}
