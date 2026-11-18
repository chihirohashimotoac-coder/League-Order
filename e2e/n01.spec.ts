import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { pinFixtureClock, serveN01, type N01ServerControl } from './n01Server';
import { clickGenerate } from './ruleQuestions';
import { waitForRest } from './axe';
import { tab } from './nav';

/**
 * n01 integration in a real browser, against the fixture n01 server.
 *
 * Service workers are blocked so every request goes through the page and is served by
 * the fixture route; the app itself is the production build.
 */
test.use({ serviceWorkers: 'block' });

async function audit(page: Page, label: string): Promise<void> {
  // Measured at rest: an entrance fade blends colours and reports contrast the screen does not have.
  await waitForRest(page);
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  const summary = results.violations.map((violation) => ({
    id: violation.id,
    nodes: violation.nodes.slice(0, 3).map((node) => node.target.join(' ')),
  }));
  expect(summary, label).toEqual([]);
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
    // Read-only API only (`match/list` is the played-games read behind the role evidence,
    // docs/THROW_ORDER_MODEL.md §4.1).
    expect(server.log.every((entry) => /^(league|tournament|team|match)\//.test(entry))).toBe(true);

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
    await page.getByRole('button', { name: /^(次戦の)?オーダーを作る$/ }).click();
    await expect(page.getByRole('heading', { name: 'オーダー設定' })).toBeVisible();
    await clickGenerate(page);
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

  test('その他のリーグ: searched by league/list?keyword=, then chosen like a known league', async ({ page }) => {
    const server = await start(page);
    await page.getByRole('button', { name: 'n01から作成' }).click();
    const wizard = page.getByRole('dialog', { name: 'n01から作成' });
    // The search for any other n01 League is visible straight away (not hidden behind a toggle).
    await wizard.getByLabel('リーグ名で検索').fill('TDA');
    await wizard.getByRole('button', { name: '検索', exact: true }).click();
    await wizard.getByRole('button', { name: /TDA\s*lg_Ev9v_7379/ }).click();
    await expect(wizard.getByRole('button', { name: /スターズ/ })).toBeVisible();
    expect(server.log).toContain('league/list?keyword=TDA');
    expect(server.log.some((entry) => entry.startsWith('league/search'))).toBe(false);
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
    await page.getByRole('button', { name: /^(次戦の)?オーダーを作る$/ }).click();
    await expect(page.getByTestId('setup-opponent')).toContainText('次戦: vs スピンコブラ');
    await page.getByRole('radio', { name: /対戦相手最適化/ }).click();
    await clickGenerate(page);
    await expect(page.getByRole('heading', { name: 'オーダー結果' })).toBeVisible();
    await expect(page.locator('.candidate-tab .c-label')).toHaveText(['対戦相手最適化', '勝利優先', 'バランス', '公平性優先']);
    const panel = page.getByTestId('opponent-panel');
    await expect(panel).toContainText('推定 Match 勝率');
    await expect(panel).toContainText('通常の勝利優先');
    await expect(page.locator('.tag.predict')).toHaveCount(7);
    await audit(page, 'RESULT (opponent-optimised)');
  });
});

test.describe('throw order in the result (docs/THROW_ORDER_MODEL.md §7)', () => {
  test('Doubles show 1投目 / 2投目 and why; a swap button re-estimates, Undo restores', async ({ page }) => {
    await start(page);
    await createKalavinka(page);
    await page.getByRole('button', { name: /^(次戦の)?オーダーを作る$/ }).click();
    await expect(page.getByTestId('flow-ready')).toBeVisible();
    await page.getByRole('radio', { name: /対戦相手最適化/ }).click();
    await clickGenerate(page);
    await expect(page.getByRole('heading', { name: 'オーダー結果' })).toBeVisible();

    const doubles = page.locator('.order-game').filter({ hasText: 'Doubles 501' }).first();
    await expect(doubles.locator('.slot-top > span:first-child')).toHaveText(['1投目', '2投目']);
    await expect(doubles.getByRole('combobox', { name: /Doubles 501 の1投目$/u })).toBeVisible();
    await expect(doubles.getByRole('combobox', { name: /Doubles 501 の2投目$/u })).toBeVisible();
    const note = doubles.getByTestId('throw-order-note');
    // The fixture's role evidence is thin (LOW): the strong order, by role strength, never by id.
    await expect(note).toContainText('投順: 強い順 (このゲームの役割別強度の高い順)');
    await expect(page.locator('body')).not.toContainText(/PLAYER \d/u);

    const values = () => doubles.locator('select').evaluateAll((selects) => selects.map((select) => (select as HTMLSelectElement).value));
    const before = await values();
    // Hold the edit flash at its first, strongest frame, so the audit sees it whatever the runner's speed.
    const hold = await page.addStyleTag({ content: '.slot.edited .slot-field { animation-play-state: paused !important; }' });
    const flashes = () => page.evaluate(() => document.getAnimations().filter((animation) => (animation as CSSAnimation).animationName === 'edit-flash').length);
    await doubles.getByRole('button', { name: /1投目と2投目を入れ替え/u }).click();
    expect(await values()).toEqual([...before].reverse());
    await expect(note).toContainText('投順: 手動で変更');
    await expect(note).toContainText('推定ゲーム勝率は強い順と比べて');
    await expect(page.getByTestId('opponent-panel')).toContainText('推定 Match 勝率');
    expect(await flashes()).toBe(2);
    await audit(page, 'RESULT throw order (hand-swapped, edit flash)');
    await hold.evaluate((style) => style.remove());
    await expect.poll(flashes).toBe(0);
    await audit(page, 'RESULT throw order (hand-swapped)');

    await page.getByRole('button', { name: '元に戻す' }).click();
    expect(await values()).toEqual(before);
    await expect(note).toContainText('投順: 強い順');
  });
});

test.describe('next match order on ORDER SETUP (Phase 5)', () => {
  async function openSetup(page: Page) {
    await page.getByRole('button', { name: '次戦のオーダーを作る' }).click();
    await expect(page.getByRole('heading', { name: 'オーダー設定' })).toBeVisible();
    return page.getByTestId('match-source');
  }
  const generate = (page: Page) => page.getByRole('button', { name: 'オーダーを生成' });
  const box = (page: Page, name: string) => page.getByLabel(`${name} を参加者に含める`);

  test('HOME → 次戦のオーダーを作る → ORDER SETUP (synced there) → result', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await start(page);
    await createKalavinka(page);
    const card = page.getByTestId('next-match-card');
    await expect(card).toContainText('vs スピンコブラ');
    await expect(card).toContainText('10/8');
    await expect(page.getByRole('button', { name: '新しいオーダーを作る' })).toHaveCount(0);
    await expect(page.locator('.toast')).toHaveCount(0, { timeout: 6000 });
    await audit(page, 'HOME next-match card');

    const source = await openSetup(page);
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(source.getByTestId('flow-ready')).toContainText('n01 ✓ 最新');
    await expect(source).toContainText('vs スピンコブラ');
    await expect(page.getByRole('heading', { name: /参加者 7 \/ 7/ })).toBeVisible();
    await expect(page.getByRole('radio', { name: /対戦相手最適化/ })).toHaveAttribute('aria-checked', 'true');
    await expect(page.getByTestId('setup-opponent')).toContainText('データの信頼度');
    await expect(page.locator('.match-summary')).toContainText('vs スピンコブラ ・ 2026-10-08');
    await audit(page, 'NEXT MATCH setup');
    await box(page, '伊藤 由佳').uncheck();
    await expect(page.getByRole('heading', { name: /参加者 6 \/ 7/ })).toBeVisible();
    await clickGenerate(page);

    await expect(page.getByRole('heading', { name: 'オーダー結果' })).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId('opponent-panel')).toContainText('スピンコブラ');
    await expect(page.locator('.order-game')).toHaveCount(7);
    const fielded = await page
      .locator('.order-game select')
      .evaluateAll((selects) => selects.map((select) => (select as HTMLSelectElement).selectedOptions[0]?.textContent ?? ''));
    expect(fielded).toHaveLength(12);
    expect(fielded.some((name) => name.includes('伊藤 由佳'))).toBe(false);
  });

  test('a slow n01: SETUP opens first, locked; a match by hand is never overwritten by the late answer', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const server = await start(page);
    await createKalavinka(page);
    await expect(page.locator('.toast')).toHaveCount(0, { timeout: 6000 });
    server.delayMs = 2500;
    const source = await openSetup(page);
    await expect(source.getByTestId('setup-syncing')).toContainText('n01から試合情報を取得中…');
    await expect(generate(page)).toBeDisabled();
    await expect(box(page, '伊藤 由佳')).toBeDisabled();
    await audit(page, 'NEXT MATCH syncing');

    // Keyboard only: to the match by hand, type an opponent, leave a player out.
    await source.getByRole('button', { name: '別の試合を作る' }).focus();
    await page.keyboard.press('Enter');
    await expect(source).toContainText('手動で設定');
    await expect(source.getByRole('button', { name: 'n01の次戦を使う' })).toBeFocused();
    await expect(page.getByRole('radio', { name: /対戦相手最適化/ })).toHaveCount(0);
    await page.locator('details.disclosure > summary').filter({ hasText: '試合情報' }).click();
    await page.getByLabel('対戦相手 (任意)').fill('手入力クラブ');
    await box(page, '伊藤 由佳').uncheck();
    await expect(page.locator('.match-summary')).toContainText('vs 手入力クラブ');

    // Long after n01 has answered, nothing typed or ticked by hand has changed.
    await page.waitForTimeout(6000);
    server.delayMs = 0;
    await expect(source).toContainText('手動で設定');
    await expect(page.getByLabel('対戦相手 (任意)')).toHaveValue('手入力クラブ');
    await expect(box(page, '伊藤 由佳')).not.toBeChecked();
    await expect(page.getByTestId('setup-opponent')).toHaveCount(0);
    await clickGenerate(page);
    await expect(page.getByRole('heading', { name: 'オーダー結果' })).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId('opponent-panel')).toHaveCount(0);
  });

  test('offline: shows the last sync and continues with that data only when asked', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const server = await start(page);
    await createKalavinka(page);
    await expect(page.locator('.toast')).toHaveCount(0, { timeout: 6000 });
    server.offline = true;
    const source = await openSetup(page);
    const offline = source.getByTestId('flow-offline');
    await expect(offline).toContainText('n01 に接続できませんでした');
    await expect(offline).toContainText('このデータは最新ではありません');
    await expect(generate(page)).toBeDisabled();
    await audit(page, 'NEXT MATCH offline');
    await offline.getByRole('button', { name: '前回データで続ける' }).click();
    await expect(source.getByTestId('flow-stale')).toContainText('最新ではありません');
    await clickGenerate(page);
    await expect(page.getByRole('heading', { name: 'オーダー結果' })).toBeVisible({ timeout: 20_000 });
  });
});

test.describe('n01 screens at every supported width (Phase 6 §8)', () => {
  for (const width of [320, 375, 390, 412, 768, 1280]) {
    test(`WCAG AA and no sideways scroll at ${width}px`, async ({ page }, testInfo) => {
      test.skip(testInfo.project.name !== 'mobile', 'widths are set explicitly; one project is enough');
      await page.setViewportSize({ width, height: width >= 1000 ? 900 : 760 });
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await start(page);
      const overflow = async (label: string): Promise<void> => {
        const extra = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
        expect(extra, label).toBeLessThanOrEqual(1);
      };

      await page.getByRole('button', { name: 'n01から作成' }).click();
      const wizard = page.getByRole('dialog', { name: 'n01から作成' });
      await wizard.getByRole('button', { name: 'ATDO', exact: true }).click();
      await expect(wizard.getByRole('button', { name: /kalavinka/ })).toBeVisible();
      await overflow('team picker');
      await wizard.getByRole('button', { name: /kalavinka/ }).click();
      await expect(wizard.getByTestId('n01-preview')).toBeVisible();
      await overflow('preview');
      await wizard.getByRole('button', { name: 'このチームを作成' }).click();
      await expect(page.getByTestId('next-match-card')).toBeVisible();
      await expect(page.locator('.toast')).toHaveCount(0, { timeout: 6000 });
      await overflow('HOME');
      await audit(page, `HOME ${width}`);

      await page.getByRole('button', { name: '次戦のオーダーを作る' }).click();
      await expect(page.getByTestId('flow-ready')).toBeVisible();
      await overflow('setup');
      await audit(page, `NEXT MATCH SETUP ${width}`);
      // The collapsed match info and detailed conditions still read their summaries.
      await expect(page.locator('.match-summary')).toContainText('vs スピンコブラ');
      await expect(page.getByRole('button', { name: /詳細条件/ })).toContainText('公平性');
      await clickGenerate(page);
      await expect(page.getByTestId('opponent-panel')).toBeVisible({ timeout: 20_000 });
      await overflow('result');
      await audit(page, `RESULT ${width}`);
    });
  }
});
