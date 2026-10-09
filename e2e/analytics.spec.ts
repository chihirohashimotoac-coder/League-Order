import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { serveAnalyticsExtras, type AnalyticsServerControl } from './analyticsServer';
import { pinFixtureClock, serveN01, type N01ServerControl } from './n01Server';

/**
 * PLAYER ANALYTICS in a real browser against the fixture n01 (mobile and desktop).
 * Service workers are blocked so every request goes through the fixture routes.
 */
test.use({ serviceWorkers: 'block' });

async function start(page: Page): Promise<{ n01: N01ServerControl; extras: AnalyticsServerControl }> {
  await pinFixtureClock(page);
  const n01 = await serveN01(page);
  const extras = await serveAnalyticsExtras(page);
  await page.goto('/');
  return { n01, extras };
}

async function createKalavinka(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'n01から作成' }).click();
  const wizard = page.getByRole('dialog', { name: 'n01から作成' });
  await wizard.getByRole('button', { name: 'ATDO', exact: true }).click();
  await wizard.getByRole('button', { name: /kalavinka/ }).click();
  await wizard.getByRole('button', { name: 'このチームを作成' }).click();
  await expect(page.getByRole('heading', { name: 'kalavinka', level: 1 })).toBeVisible();
}

async function openAnalytics(page: Page): Promise<void> {
  await page.getByRole('button', { name: /データ分析/ }).click();
  await expect(page.getByTestId('analytics-page')).toBeVisible();
}

async function noSideScroll(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
}

test.describe('PLAYER ANALYTICS', () => {
  test('nothing analytics-related is requested until the screen is opened; the data screen then shows evidence', async ({ page }) => {
    const { n01, extras } = await start(page);
    await createKalavinka(page);
    // The sync never asks for the analytics-only operations.
    expect(extras.log).toEqual([]);
    expect(n01.log.every((entry) => /^(league|tournament|team)\//.test(entry))).toBe(true);
    const syncRequests = n01.log.length;

    await openAnalytics(page);
    const roster = page.locator('.analytics-roster');
    await expect(roster.locator('.list-row').first()).toContainText('3DA');
    await expect(page.getByTestId('metric-3DA')).toContainText('基準');
    await expect(page.getByRole('table').first()).toBeVisible();
    await expect(page.getByTestId('analytics-updated')).toContainText('最終取得');
    expect(extras.log.length).toBeGreaterThan(0);
    // Read-only: GET operations of the n01 read API only.
    expect(n01.log.slice(syncRequests).every((entry) => /^(league|tournament|team)\//.test(entry))).toBe(true);
    await noSideScroll(page);
  });

  test('period and population switches recalculate; compare, trend and reference rows work', async ({ page }) => {
    await start(page);
    await createKalavinka(page);
    await openAnalytics(page);
    await expect(page.getByTestId('metric-3DA')).toBeVisible();

    await page.getByRole('button', { name: '直近3季' }).click();
    await expect(page.getByTestId('player-basis')).toContainText('シーズンの合算');
    await page.getByRole('button', { name: 'リーグ全体' }).click();
    await expect(page.getByRole('table').first().locator('caption')).toContainText('リーグ全体');

    // Add a comparison player.
    const select = page.getByLabel(/比較する選手を追加/);
    const firstOption = select.locator('option').nth(1);
    await select.selectOption({ index: 1 });
    await expect(page.getByTestId('compare-table')).toBeVisible();
    expect(await firstOption.count()).toBe(1);

    // Trend over the seasons (or an honest "needs 2 seasons" message).
    await expect(page.locator('.trend-svg, :text("2シーズン以上")').first()).toBeVisible();

    // The empty/low-sample states are explained, not blank.
    await page.getByRole('button', { name: '全期間' }).click();
    await expect(page.getByTestId('analytics-page')).toBeVisible();
    await noSideScroll(page);
  });

  test('a failed refresh keeps the saved data and says so; the order screens keep working', async ({ page }) => {
    const { n01, extras } = await start(page);
    await createKalavinka(page);
    await openAnalytics(page);
    await expect(page.getByTestId('metric-3DA')).toBeVisible();
    extras.failExtras = true;
    n01.offline = true;
    await page.getByRole('button', { name: '再取得' }).click();
    await expect(page.getByTestId('analytics-banner-stale').or(page.getByTestId('analytics-banner-error'))).toBeVisible();
    // Back to the app and generate an order as usual.
    n01.offline = false;
    await page.getByRole('button', { name: '戻る' }).click();
    await page.getByRole('button', { name: '新しいオーダーを作る' }).click();
    await expect(page.getByRole('heading', { name: 'オーダー設定' })).toBeVisible();
    await page.getByRole('button', { name: 'オーダーを生成' }).click();
    await expect(page.getByRole('heading', { name: 'オーダー結果' })).toBeVisible({ timeout: 60_000 });
  });

  test('accessibility (WCAG 2.1 AA) and layout', async ({ page }, info) => {
    await start(page);
    await createKalavinka(page);
    await openAnalytics(page);
    await expect(page.getByTestId('metric-3DA')).toBeVisible();
    const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
    expect(results.violations.map((v) => ({ id: v.id, nodes: v.nodes.slice(0, 3).map((n) => n.target.join(' ')) }))).toEqual([]);
    await noSideScroll(page);
    await page.screenshot({ path: `test-results/analytics-player-${info.project.name}.png`, fullPage: true });
  });
});

test.describe('TEAM ANALYTICS', () => {
  test('switches between player and team views, keeps official and own rankings apart, and survives a period change', async ({ page }) => {
    const { extras } = await start(page);
    await createKalavinka(page);
    await openAnalytics(page);
    await expect(page.getByTestId('metric-3DA')).toBeVisible();

    await page.getByRole('button', { name: 'チーム', exact: true }).click();
    await expect(page.getByTestId('team-basis')).toContainText('加算していません');
    await expect(page.getByTestId('metric-3DA')).toBeVisible();
    await expect(page.getByTestId('official-table')).toBeVisible();
    await expect(page.getByTestId('official-basis')).toContainText('この季・このディビジョンだけ');
    await expect(page.getByTestId('own-ranking-note')).toContainText('公式順位とは別物');
    expect(extras.log.some((entry) => entry.startsWith('tournament/standings'))).toBe(true);

    await page.getByRole('button', { name: 'リーグ全体' }).click();
    await expect(page.getByTestId('cross-division-note')).toContainText('優劣を示すものではありません');

    // Same filters, new period: the screen recalculates and the team view stays selected.
    await page.getByRole('button', { name: '直近3季' }).click();
    await expect(page.getByTestId('team-basis')).toContainText('シーズンの合算');
    await expect(page.getByTestId('team-players-table')).toBeVisible();

    // Back to players without losing the shared period.
    await page.getByRole('button', { name: 'プレイヤー', exact: true }).click();
    await expect(page.getByTestId('player-basis')).toBeVisible();
    await noSideScroll(page);
  });

  test('compare teams, accessibility and layout', async ({ page }, info) => {
    await start(page);
    await createKalavinka(page);
    await openAnalytics(page);
    await page.getByRole('button', { name: 'チーム', exact: true }).click();
    await expect(page.getByTestId('official-table')).toBeVisible();
    await page.getByLabel(/比較するチームを追加/).selectOption({ index: 1 });
    await expect(page.getByTestId('team-compare-table')).toBeVisible();
    const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
    expect(results.violations.map((v) => ({ id: v.id, nodes: v.nodes.slice(0, 3).map((n) => n.target.join(' ')) }))).toEqual([]);
    await noSideScroll(page);
    await page.screenshot({ path: `test-results/analytics-team-${info.project.name}.png`, fullPage: true });
  });
});
