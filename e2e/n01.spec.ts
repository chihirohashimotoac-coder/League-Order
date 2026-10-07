import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { pinFixtureClock, serveN01, type N01ServerControl } from './n01Server';

/**
 * n01 integration in a real browser, against the fixture n01 server.
 *
 * Service workers are blocked so every request goes through the page and is served by
 * the fixture route; the app itself is the production build.
 */
test.use({ serviceWorkers: 'block' });

async function audit(page: Page, label: string): Promise<void> {
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  const summary = results.violations.map((violation) => ({
    id: violation.id,
    nodes: violation.nodes.slice(0, 3).map((node) => node.target.join(' ')),
  }));
  expect(summary, label).toEqual([]);
}

function tab(page: Page, name: string) {
  return page.locator('.tab-bar').getByRole('button', { name, exact: true });
}

async function start(page: Page): Promise<N01ServerControl> {
  await pinFixtureClock(page);
  const server = await serveN01(page);
  await page.goto('/');
  return server;
}

async function createKalavinka(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'n01から作成' }).click();
  const wizard = page.getByRole('dialog', { name: 'n01から作成' });
  await wizard.getByRole('button', { name: 'ATDO', exact: true }).click();
  await wizard.getByRole('button', { name: /kalavinka/ }).click();
  await expect(wizard.getByTestId('n01-preview')).toContainText('Team 1001 ×1 / Doubles 501 ×2 / Singles 501 ×4');
  await wizard.getByRole('button', { name: 'このチームを作成' }).click();
  await expect(page.getByRole('heading', { name: 'kalavinka', level: 1 })).toBeVisible();
}

test.describe('n01 league native sync (Phase 1)', () => {
  test('League → Team → preview → create builds the whole team', async ({ page }) => {
    const server = await start(page);
    await page.getByRole('button', { name: 'n01から作成' }).click();
    const wizard = page.getByRole('dialog', { name: 'n01から作成' });
    await wizard.getByRole('button', { name: 'ATDO', exact: true }).click();
    await expect(wizard.getByText('A DIVISION')).toBeVisible();
    await wizard.getByRole('button', { name: /kalavinka/ }).click();

    const preview = wizard.getByTestId('n01-preview');
    await expect(preview).toContainText('2026 3rd');
    await expect(preview).toContainText('STEEL');
    await expect(preview).toContainText('6 / 7 名が n01 から取得');
    await expect(preview.getByText('中村 蓮').locator('..')).toContainText('PPR なし');
    await wizard.getByRole('button', { name: 'このチームを作成' }).click();

    await expect(page.getByRole('heading', { name: 'kalavinka', level: 1 })).toBeVisible();
    await expect(page.getByTestId('n01-team-status')).toContainText('ATDO ・ 2026 3rd ・ A Division');
    await expect(page.getByTestId('n01-team-status')).toContainText('最終同期 たった今');
    // Read-only API only.
    expect(server.log.every((entry) => /^(league|tournament|team)\//.test(entry))).toBe(true);

    await tab(page, 'フォーマット').click();
    await expect(page.getByText('n01 管理')).toBeVisible();
    await tab(page, 'メンバー').click();
    await expect(page.locator('.list-row')).toHaveCount(7);

    // The data survives a reload.
    await page.reload();
    await expect(page.getByRole('heading', { name: 'kalavinka', level: 1 })).toBeVisible();
  });

  test('an n01 team generates an order with the existing optimizer', async ({ page }) => {
    await start(page);
    await createKalavinka(page);
    await page.getByRole('button', { name: '新しいオーダーを作る' }).click();
    await expect(page.getByRole('heading', { name: 'オーダー設定' })).toBeVisible();
    await page.getByRole('button', { name: 'オーダーを生成' }).click();
    await expect(page.getByRole('heading', { name: 'オーダー結果' })).toBeVisible();
    await expect(page.locator('.order-game')).toHaveCount(7);
    await expect(page.getByTestId('result-strength-basis')).toContainText('STEEL');
  });

  test('a failed n01 request is reported and can be retried', async ({ page }) => {
    const server = await start(page);
    server.offline = true;
    await page.getByRole('button', { name: 'n01から作成' }).click();
    const wizard = page.getByRole('dialog', { name: 'n01から作成' });
    await wizard.getByRole('button', { name: 'ATDO', exact: true }).click();
    await expect(wizard.getByRole('alert')).toContainText('n01 に接続できませんでした');
    server.offline = false;
    await wizard.getByRole('button', { name: '再試行' }).click();
    await expect(wizard.getByRole('button', { name: /kalavinka/ })).toBeVisible();
  });

  test('re-sync is offline-safe: the last sync time is shown, never "latest"', async ({ page }) => {
    const server = await start(page);
    await createKalavinka(page);
    server.offline = true;
    await page.getByRole('button', { name: 'n01を再同期' }).click();
    const sheet = page.getByRole('dialog', { name: 'n01を再同期' });
    await expect(sheet.getByRole('alert')).toContainText('前回の同期');
    await expect(sheet.getByRole('alert')).toContainText('このデータは最新ではありません');
    await expect(sheet.getByText('n01 ✓ 最新')).toHaveCount(0);
  });

  test('the manual flow is untouched', async ({ page }) => {
    await start(page);
    await expect(page.getByRole('button', { name: '自分のチームを作る' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'サンプルで試す' })).toBeVisible();
  });

  test('the n01 screens pass the WCAG AA audit', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await start(page);
    await page.getByRole('button', { name: 'n01から作成' }).click();
    const wizard = page.getByRole('dialog', { name: 'n01から作成' });
    await audit(page, 'WIZARD league');
    await wizard.getByRole('button', { name: 'ATDO', exact: true }).click();
    await expect(wizard.getByRole('button', { name: /kalavinka/ })).toBeVisible();
    await audit(page, 'WIZARD team');
    await wizard.getByRole('button', { name: /kalavinka/ }).click();
    await expect(wizard.getByTestId('n01-preview')).toBeVisible();
    await audit(page, 'WIZARD preview');
    await wizard.getByRole('button', { name: 'このチームを作成' }).click();
    await expect(page.locator('.toast')).toHaveCount(0, { timeout: 6000 });
    await audit(page, 'HOME (n01 team)');
    await tab(page, 'メンバー').click();
    await audit(page, 'PLAYERS (n01)');
    await page.locator('.list-row').filter({ hasText: '橋本 千尋' }).click();
    await expect(page.getByTestId('n01-player')).toBeVisible();
    await audit(page, 'PLAYER EDITOR (n01)');
    await page.keyboard.press('Escape');
    await tab(page, 'フォーマット').click();
    await page.locator('.list-row').filter({ hasText: 'n01 管理' }).click();
    await audit(page, 'MANAGED FORMAT');
  });

  test('対戦相手最適化 compares four candidates with estimated win probabilities (Phase 4)', async ({ page }) => {
    await start(page);
    await createKalavinka(page);
    await page.getByRole('button', { name: '新しいオーダーを作る' }).click();
    await expect(page.getByTestId('setup-opponent')).toContainText('次戦: vs スピンコブラ');
    await page.getByRole('radio', { name: /対戦相手最適化/ }).click();
    await page.getByRole('button', { name: 'オーダーを生成' }).click();
    await expect(page.getByRole('heading', { name: 'オーダー結果' })).toBeVisible();
    await expect(page.locator('.candidate-tab .c-label')).toHaveText(['対戦相手最適化', '勝利優先', 'バランス', '公平性優先']);
    const panel = page.getByTestId('opponent-panel');
    await expect(panel).toContainText('推定 Match 勝率');
    await expect(panel).toContainText('通常の勝利優先');
    await expect(page.locator('.tag.predict')).toHaveCount(7);
    await audit(page, 'RESULT (opponent-optimised)');
  });
});

test.describe('next match order in one flow (Phase 5)', () => {
  async function openFlow(page: Page) {
    await page.getByRole('button', { name: '次戦のオーダーを作る' }).click();
    return page.getByRole('dialog', { name: '次戦のオーダーを作る' });
  }

  test('HOME → 次戦のオーダーを作る → attendance → result, in one flow', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await start(page);
    await createKalavinka(page);
    const card = page.getByTestId('next-match-card');
    await expect(card).toContainText('vs スピンコブラ');
    await expect(card).toContainText('10/8');
    await expect(page.locator('.toast')).toHaveCount(0, { timeout: 6000 });
    await audit(page, 'HOME next-match card');

    const flow = await openFlow(page);
    const attendance = flow.getByTestId('flow-attendance');
    await expect(attendance).toContainText('本日参加 7 / 7');
    await audit(page, 'NEXT MATCH attendance');
    await attendance.getByRole('checkbox', { name: /伊藤 由佳/ }).uncheck();
    await expect(attendance).toContainText('本日参加 6 / 7');
    await attendance.getByRole('button', { name: 'このメンバーで作成' }).click();

    await expect(page.getByRole('heading', { name: 'オーダー結果' })).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId('opponent-panel')).toContainText('スピンコブラ');
    await expect(page.locator('.order-game')).toHaveCount(7);
    const fielded = await page
      .locator('.order-game select')
      .evaluateAll((selects) => selects.map((select) => (select as HTMLSelectElement).selectedOptions[0]?.textContent ?? ''));
    expect(fielded).toHaveLength(12);
    expect(fielded.some((name) => name.includes('伊藤 由佳'))).toBe(false);
  });

  test('offline: shows the last sync and continues with that data only when asked', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const server = await start(page);
    await createKalavinka(page);
    await expect(page.locator('.toast')).toHaveCount(0, { timeout: 6000 });
    server.offline = true;
    const flow = await openFlow(page);
    const offline = flow.getByTestId('flow-offline');
    await expect(offline).toContainText('n01 に接続できませんでした');
    await expect(offline).toContainText('このデータは最新ではありません');
    await expect(flow.getByTestId('flow-attendance')).toHaveCount(0);
    await audit(page, 'NEXT MATCH offline');
    await offline.getByRole('button', { name: '前回データで続ける' }).click();
    await expect(flow.getByTestId('flow-stale')).toContainText('最新ではありません');
    await flow.getByRole('button', { name: 'このメンバーで作成' }).click();
    await expect(page.getByRole('heading', { name: 'オーダー結果' })).toBeVisible({ timeout: 20_000 });
  });
});
