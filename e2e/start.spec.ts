import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { pinFixtureClock, serveN01 } from './n01Server';

/**
 * Getting started, in a real browser, for every kind of captain:
 *
 * - manual entry for soft darts and for hard (steel) darts, with no n01 at all,
 * - an n01 League other than the three presets, found by name (fixture n01 server),
 * - an online league n01 does not have (Light League): explained, then manual entry,
 *   with n01 unreachable throughout.
 *
 * Plus the layout of the first-run, format, setup, result and share screens at 320 / 390 /
 * 768 / 1440 px: no horizontal page scroll, and the WCAG 2.1 AA audit on the new screens.
 * Screenshots are written to $SCREENSHOTS when it is set.
 */
test.use({ serviceWorkers: 'block' });

const SHOTS = process.env.SCREENSHOTS;

function tab(page: Page, name: string) {
  return page.locator('.tab-bar').getByRole('button', { name, exact: true });
}

async function audit(page: Page, label: string): Promise<void> {
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  const summary = results.violations.map((violation) => ({
    id: violation.id,
    nodes: violation.nodes.slice(0, 3).map((node) => node.target.join(' ')),
  }));
  expect(summary, label).toEqual([]);
}

async function noHorizontalScroll(page: Page, label: string): Promise<void> {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow, `${label}: page wider than the viewport`).toBeLessThanOrEqual(0);
}

async function manualTeam(
  page: Page,
  team: string,
  discipline: RegExp,
  rows: [string, string, string][],
  template: RegExp,
): Promise<void> {
  await page.getByRole('button', { name: '自分のチームを作る' }).click();
  await page.getByLabel('チーム名').fill(team);
  await page.getByRole('radio', { name: discipline }).check();
  await page.getByRole('button', { name: '次へ' }).click();
  for (const [index, [name, rating, ppr]] of rows.entries()) {
    if (index > 0) await page.getByRole('button', { name: 'メンバーを追加' }).click();
    await page.getByLabel(`メンバー ${index + 1} の名前`).fill(name);
    if (rating) await page.getByLabel(`メンバー ${index + 1} の Rating`).fill(rating);
    if (ppr) await page.getByLabel(`メンバー ${index + 1} の PPR (3投平均)`).fill(ppr);
  }
  await page.getByRole('button', { name: '次へ' }).click();
  await page.getByRole('radio', { name: template }).click();
  await page.getByRole('button', { name: 'チームを作成' }).click();
  await expect(page.getByRole('heading', { name: team, level: 1 })).toBeVisible();
}

async function generateFromNextStep(page: Page): Promise<void> {
  await page.getByTestId('next-step').getByRole('button', { name: 'オーダーを作る' }).click();
  await expect(page.getByRole('heading', { name: 'オーダー設定' })).toBeVisible();
  await page.getByRole('button', { name: 'オーダーを生成' }).click();
  await expect(page.getByRole('heading', { name: 'オーダー結果' })).toBeVisible();
}

test.describe('manual entry, no n01 needed', () => {
  test('soft darts: Rating, a 01 + Cricket example format checked, order generated, finalized and shared', async ({ page }) => {
    const server = await serveN01(page);
    server.offline = true;
    await page.goto('/');
    await manualTeam(
      page,
      'ソフトの会',
      /ソフトダーツ/,
      [
        ['あおき', '14', ''],
        ['ばば', '12', ''],
        ['ちば', '9', ''],
        ['どい', '6', ''],
        ['えんどう', '', ''],
      ],
      /標準6ゲーム/,
    );
    await expect(page.getByTestId('next-step')).toContainText('フォーマットの内容を確認');
    await expect(page.getByTestId('strength-coverage')).toContainText('戦力データあり 4 / 5 名 (Rating または PPR)');

    // The format is a starting point to check, not the league's rules.
    await page.getByTestId('next-step').getByRole('button', { name: '確認する' }).click();
    await expect(page.locator('.list-row').first()).toContainText('SOFT');
    await tab(page, 'ホーム').click();

    await generateFromNextStep(page);
    await expect(page.getByTestId('score-note')).toContainText('勝率ではありません');
    await page.getByRole('button', { name: /オーダーを確定/ }).click();
    await expect(page.getByRole('region', { name: 'オーダーの状態' })).toContainText('確定済み');
    await page.getByRole('button', { name: '共有', exact: true }).click();
    await expect(page.getByRole('dialog', { name: '共有' })).toBeVisible();
    expect(server.log).toEqual([]);
  });

  test('hard darts: PPR (3投平均), an 01-only example, PPR-only strength, order generated', async ({ page }) => {
    const server = await serveN01(page);
    server.offline = true;
    await page.goto('/');
    await manualTeam(
      page,
      'ハードの会',
      /ハードダーツ/,
      [
        ['いとう', '', '72.5'],
        ['うえだ', '', '61'],
        ['えのき', '', '55'],
        ['おの', '', '48'],
      ],
      /01のみ 5ゲーム/,
    );
    await tab(page, 'フォーマット').click();
    const row = page.locator('.list-row').first();
    await expect(row).toContainText('STEEL');
    await row.click();
    const editor = page.getByRole('dialog', { name: 'フォーマットを編集' });
    await expect(editor.getByRole('button', { name: 'Cricket', exact: true }).first()).toHaveAttribute('aria-pressed', 'false');
    await expect(editor.getByTestId('fixed-player-count').first()).toHaveText('1名 (Singles)');
    await page.keyboard.press('Escape');
    await tab(page, 'ホーム').click();

    await page.getByTestId('next-step').getByRole('button', { name: 'オーダーを作る' }).click();
    await expect(page.getByTestId('setup-strength-basis')).toContainText('戦力評価 PPR 100%');
    await expect(page.getByTestId('setup-strength-basis')).toContainText('PPR (3投平均) だけで評価します');
    await page.getByRole('button', { name: 'オーダーを生成' }).click();
    await expect(page.getByRole('heading', { name: 'オーダー結果' })).toBeVisible();
    await expect(page.getByTestId('result-strength-basis')).toContainText('PPR (3投平均) だけで評価しています');
    expect(server.log).toEqual([]);
  });
});

test.describe('online and other leagues', () => {
  test('another n01 League is found by name and imported', async ({ page }) => {
    await pinFixtureClock(page);
    const server = await serveN01(page);
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'n01 League から取り込み' })).toBeVisible();
    await page.getByRole('button', { name: 'n01から作成' }).click();
    const wizard = page.getByRole('dialog', { name: 'n01から作成' });
    await wizard.getByLabel('リーグ名で検索').fill('TDA');
    await wizard.getByRole('button', { name: '検索', exact: true }).click();
    await wizard.getByRole('button', { name: /TDA\s*lg_Ev9v_7379/ }).click();
    await wizard.getByRole('button', { name: /スターズ/ }).click();
    await expect(wizard.getByTestId('n01-preview')).toBeVisible();
    await wizard.getByRole('button', { name: 'このチームを作成' }).click();
    await expect(page.getByTestId('n01-team-status')).toContainText('TDA');
    expect(server.log).toContain('league/list?keyword=TDA');
  });

  test('an online league n01 does not have (Light League): explained, then made by hand, n01 offline', async ({ page }) => {
    const server = await serveN01(page);
    server.offline = true;
    await page.goto('/');
    await page.getByRole('button', { name: 'n01から作成' }).click();
    const wizard = page.getByRole('dialog', { name: 'n01から作成' });

    // Searching by name finds nothing (and says so without a network error).
    await wizard.getByLabel('リーグ名で検索').fill('Light League');
    await wizard.getByRole('button', { name: '検索', exact: true }).click();
    await expect(wizard.getByTestId('manual-fallback').first()).toBeVisible();

    // Its URL is refused with the reason, and the way out is right there.
    await wizard.getByText('リーグ ID / URL で指定').click();
    await wizard.getByLabel(/リーグ ID \/ n01 の URL/).fill('https://lightleague.example.com/league/42');
    await wizard.getByRole('button', { name: '決定' }).click();
    await expect(wizard.getByText('ほかのサービスのリーグは自動連携の対象外です')).toBeVisible();
    await wizard.getByTestId('manual-fallback').last().getByRole('button', { name: '手入力で作成する' }).click();

    await expect(page.getByRole('heading', { name: 'チームを作成' })).toBeVisible();
    await page.getByLabel('チーム名').fill('ライトの会');
    await page.getByLabel('リーグ名 (任意)').fill('Light League');
    await page.getByRole('radio', { name: /ソフトダーツ/ }).check();
    await page.getByRole('button', { name: '次へ' }).click();
    for (const [index, name] of ['A', 'B', 'C', 'D'].entries()) {
      if (index > 0) await page.getByRole('button', { name: 'メンバーを追加' }).click();
      await page.getByLabel(`メンバー ${index + 1} の名前`).fill(`選手${name}`);
      await page.getByLabel(`メンバー ${index + 1} の Rating`).fill(String(12 - index));
    }
    await page.getByRole('button', { name: '次へ' }).click();
    await page.getByRole('radio', { name: /ダブルス中心/ }).click();
    await page.getByRole('button', { name: 'チームを作成' }).click();
    await expect(page.getByRole('heading', { name: 'ライトの会', level: 1 })).toBeVisible();
    await generateFromNextStep(page);
  });
});

const VIEWPORTS = [
  { width: 320, height: 640 },
  { width: 390, height: 844 },
  { width: 768, height: 1024 },
  { width: 1440, height: 900 },
] as const;

test.describe('layout at 320 / 390 / 768 / 1440 px', () => {
  for (const viewport of VIEWPORTS) {
    test(`first run, format, setup, result and share at ${viewport.width}px`, async ({ page }, testInfo) => {
      test.skip(testInfo.project.name !== 'desktop', 'viewport sweep runs once');
      test.setTimeout(150_000);
      await page.setViewportSize(viewport);
      await page.emulateMedia({ reducedMotion: 'reduce' });
      const dir = SHOTS ? join(SHOTS, `${viewport.width}`) : null;
      if (dir) mkdirSync(dir, { recursive: true });
      const shot = async (name: string): Promise<void> => {
        await noHorizontalScroll(page, `${viewport.width}px ${name}`);
        if (dir) await page.screenshot({ path: join(dir, `${name}.png`), fullPage: true });
      };
      const server = await serveN01(page);
      server.offline = true;
      await page.goto('/');

      await shot('01-welcome');
      await page.getByRole('button', { name: '自分のチームを作る' }).click();
      await page.getByLabel('チーム名').fill('レイアウト確認チーム');
      await page.getByRole('radio', { name: /ハードダーツ/ }).check();
      await shot('02-onboarding-team');
      if (viewport.width === 390) await audit(page, 'onboarding team');
      await page.getByRole('button', { name: '次へ' }).click();
      for (const [index, [name, rating, ppr]] of [
        ['長い名前のメンバー一号', '14', '72.45'],
        ['メンバー二', '', '61'],
        ['メンバー三', '9', ''],
      ].entries()) {
        if (index > 0) await page.getByRole('button', { name: 'メンバーを追加' }).click();
        await page.getByLabel(`メンバー ${index + 1} の名前`).fill(name);
        if (rating) await page.getByLabel(`メンバー ${index + 1} の Rating`).fill(rating);
        if (ppr) await page.getByLabel(`メンバー ${index + 1} の PPR (3投平均)`).fill(ppr);
      }
      await shot('03-onboarding-members');
      if (viewport.width === 390) await audit(page, 'onboarding members');
      await page.getByRole('button', { name: '次へ' }).click();
      await page.getByRole('radio', { name: /01のみ 5ゲーム/ }).click();
      await shot('04-onboarding-format');
      if (viewport.width === 390) await audit(page, 'onboarding format');
      await page.getByRole('button', { name: 'チームを作成' }).click();
      await expect(page.getByRole('heading', { name: 'レイアウト確認チーム', level: 1 })).toBeVisible();
      await expect(page.locator('.toast')).toHaveCount(0, { timeout: 6000 });
      await shot('05-home');
      if (viewport.width === 390) await audit(page, 'home with next step');

      await tab(page, 'フォーマット').click();
      await page.locator('.list-row').first().click();
      await expect(page.getByRole('dialog', { name: 'フォーマットを編集' })).toBeVisible();
      await shot('06-format-editor');
      if (viewport.width === 390) await audit(page, 'format editor');
      await page.keyboard.press('Escape');

      await tab(page, 'オーダー').click();
      await expect(page.getByRole('heading', { name: 'オーダー設定' })).toBeVisible();
      await shot('07-setup');
      await page.getByRole('button', { name: 'オーダーを生成' }).click();
      await expect(page.getByRole('heading', { name: 'オーダー結果' })).toBeVisible();
      await shot('08-result');
      if (viewport.width === 390) await audit(page, 'result');
      await page.getByRole('button', { name: /オーダーを確定/ }).click();
      await expect(page.getByRole('region', { name: 'オーダーの状態' })).toContainText('確定済み');
      await page.getByRole('button', { name: '共有', exact: true }).click();
      await expect(page.getByRole('dialog', { name: '共有' })).toBeVisible();
      await shot('09-share');
    });
  }

  test('the n01 wizard with its manual way out at 320px', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop', 'runs once');
    await page.setViewportSize({ width: 320, height: 640 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const server = await serveN01(page);
    server.offline = true;
    await page.goto('/');
    await page.getByRole('button', { name: 'n01から作成' }).click();
    const wizard = page.getByRole('dialog', { name: 'n01から作成' });
    await wizard.getByRole('button', { name: 'ATDO', exact: true }).click();
    await expect(wizard.getByRole('alert')).toBeVisible();
    await expect(wizard.getByTestId('manual-fallback')).toBeVisible();
    await noHorizontalScroll(page, 'wizard error 320px');
    await audit(page, 'wizard error with manual fallback');
    if (SHOTS) {
      mkdirSync(join(SHOTS, '320'), { recursive: true });
      await page.screenshot({ path: join(SHOTS, '320', '10-wizard-error.png') });
    }
  });
});
