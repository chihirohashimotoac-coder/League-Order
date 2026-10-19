import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

/**
 * League rules (リーグ規則・必須条件) end to end, in a real browser on the production build
 * (Web Worker generation, IndexedDB): add rules to the sample format → generate → break a rule
 * by hand → finalize is refused → undo → finalize v1 → reload keeps everything. The same
 * screens are then checked at 320 / 390 / 768 / 1440 px for sideways scroll, 44px targets and
 * the WCAG AA audit.
 */

const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

function tab(page: Page, name: string) {
  return page.locator('.tab-bar').getByRole('button', { name, exact: true });
}

async function openSample(page: Page): Promise<void> {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
  await page.getByRole('button', { name: 'サンプルで試す' }).click();
  await expect(page.getByRole('heading', { name: 'サンプルチーム', level: 1 })).toBeVisible();
}

/** Singles: 1 per player, helpers: 1 — on the standard six-game sample format. */
async function addRules(page: Page): Promise<void> {
  await tab(page, 'フォーマット').click();
  await page.locator('.list-row').filter({ hasText: '標準6ゲーム' }).click();
  const editor = page.getByTestId('league-rules-editor');
  await editor.getByText('リーグ規則 (必須条件)').click();
  await expect(editor.getByTestId('rule-counting-note')).toContainText('総出場は 1 回のまま');
  await editor.getByLabel('Singles').fill('1');
  await editor.getByLabel('助っ人').fill('1');
  await page.getByRole('button', { name: '保存' }).click();
  await expect(page.locator('.list-row').filter({ hasText: '標準6ゲーム' }).getByTestId('format-rules-tag')).toBeVisible();
}

async function noSideways(page: Page, label: string): Promise<void> {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow, `${label}: horizontal overflow`).toBeLessThanOrEqual(0);
}

async function audit(page: Page, label: string): Promise<void> {
  const results = await new AxeBuilder({ page }).withTags(TAGS).analyze();
  expect(
    results.violations.map((violation) => ({ id: violation.id, nodes: violation.nodes.slice(0, 3).map((n) => n.target.join(' ')) })),
    label,
  ).toEqual([]);
}

test('rules → generate → hand-made breach refuses finalize → undo → v1 keeps the rules', async ({ page }) => {
  await openSample(page);
  await addRules(page);

  // An invalid cap is refused with a reason, and nothing is saved.
  await page.locator('.list-row').filter({ hasText: '標準6ゲーム' }).click();
  const editor = page.getByTestId('league-rules-editor');
  await editor.getByLabel('Doubles').fill('1.5');
  await expect(editor.getByRole('alert')).toContainText('0 以上の整数');
  await page.getByRole('button', { name: '保存' }).click();
  await expect(page.getByText(/リーグ規則: 0 以上の整数/)).toBeVisible();
  await editor.getByLabel('Doubles').fill('');
  await page.getByRole('button', { name: '閉じる' }).first().click();

  await tab(page, 'ホーム').click();
  await page.getByRole('button', { name: '新しいオーダーを作る' }).click();
  await expect(page.getByRole('heading', { name: 'オーダー設定' })).toBeVisible();
  await expect(page.getByTestId('league-rules-summary')).toContainText('Singles: 1人 1 回まで');
  await expect(page.getByTestId('league-rules-summary')).toContainText('助っ人: 1 名まで');

  // The helper cap needs every status; nothing is generated (or assumed) until it is stated.
  const notice = page.getByTestId('league-status-notice');
  await expect(notice).toContainText('未設定');
  await page.getByRole('button', { name: 'オーダーを生成' }).click();
  await expect(page.getByText(/大会資格が未設定の参加者がいます/)).toBeVisible();
  await expect(page.getByRole('heading', { name: 'オーダー設定' })).toBeVisible();

  // One roster member is today's helper, the others regulars.
  await page.locator('.participant').filter({ hasText: '遠藤' }).getByRole('button', { name: '条件' }).click();
  await page.getByRole('dialog').getByRole('radio', { name: /^助っ人/ }).check();
  await page.getByRole('dialog').getByRole('button', { name: '閉じる' }).click();
  await notice.getByRole('button', { name: '名簿メンバーを正規登録にする' }).click();
  await expect(notice).toBeHidden();
  await expect(page.locator('.participant').filter({ hasText: '遠藤' }).getByTestId('league-status-tag')).toHaveText('大会: 助っ人');

  await page.getByRole('button', { name: 'オーダーを生成' }).click();
  await expect(page.getByRole('heading', { name: 'オーダー結果' })).toBeVisible();
  const panel = page.getByTestId('league-rules-panel');
  await expect(panel.getByTestId('rules-status')).toHaveText(/すべて満たしています/);
  await expect(panel).toContainText('Singles: 1人 1 回まで');
  await expect(panel).toContainText('大会側の登録確認ではありません');

  // Three Singles, five players, cap 1 each: put Game 1's player in Game 6 too.
  const first = await page.getByRole('combobox', { name: 'Game 1 Singles 501 のスロット 1' }).inputValue();
  await page.getByRole('combobox', { name: 'Game 6 Singles 501 のスロット 1' }).selectOption(first);
  await expect(panel.getByTestId('rules-status')).toHaveText(/違反/);
  await expect(page.locator('.notice.danger')).toContainText('Singles の出場上限 1 回');
  await expect(page.getByRole('button', { name: /オーダーを確定/ })).toBeDisabled();

  await page.getByRole('button', { name: '元に戻す' }).click();
  await expect(panel.getByTestId('rules-status')).toHaveText(/すべて満たしています/);
  await page.getByRole('button', { name: /オーダーを確定/ }).click();
  await expect(page.getByText('v1 として確定しました')).toBeVisible();

  // The format is loosened afterwards; the saved order keeps the rules it was made under.
  await tab(page, 'フォーマット').click();
  await page.locator('.list-row').filter({ hasText: '標準6ゲーム' }).click();
  await page.getByTestId('league-rules-editor').getByLabel('Singles').fill('');
  await page.getByTestId('league-rules-editor').getByLabel('助っ人').fill('');
  await page.getByRole('button', { name: '保存' }).click();
  await expect(page.locator('.list-row').filter({ hasText: '標準6ゲーム' }).getByTestId('format-rules-tag')).toHaveCount(0);

  await page.reload();
  await tab(page, '履歴').click();
  await page.locator('.history-row').first().click();
  await page.getByRole('button', { name: 'このオーダーを開いて編集' }).click();
  await expect(page.getByTestId('league-rules-panel')).toContainText('Singles: 1人 1 回まで');
  await expect(page.getByTestId('rules-status')).toHaveText(/すべて満たしています/);
});

test('rule screens fit 320 / 390 / 768 / 1440 px with 44px targets and pass the WCAG AA audit', async ({ page }) => {
  await openSample(page);
  await addRules(page);
  await tab(page, 'ホーム').click();
  await page.getByRole('button', { name: '新しいオーダーを作る' }).click();
  await page.getByTestId('league-status-notice').getByRole('button', { name: '名簿メンバーを正規登録にする' }).click();
  await page.getByRole('button', { name: 'オーダーを生成' }).click();
  await expect(page.getByTestId('league-rules-panel')).toBeVisible();
  const first = await page.getByRole('combobox', { name: 'Game 1 Singles 501 のスロット 1' }).inputValue();
  await page.getByRole('combobox', { name: 'Game 6 Singles 501 のスロット 1' }).selectOption(first);
  await expect(page.getByTestId('rules-status')).toHaveText(/違反/);

  for (const width of [320, 390, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(page.getByTestId('league-rules-panel')).toBeVisible();
    await noSideways(page, `RESULT ${width}`);
    await page.getByTestId('league-rules-panel').screenshot({ path: test.info().outputPath(`rules-panel-${width}.png`) });
    if (width === 390) await audit(page, 'RESULT with a rule breach');

    // SETUP is behind the header's back arrow once an order exists.
    await page.getByRole('button', { name: '戻る' }).click();
    await expect(page.getByTestId('league-rules-summary')).toBeVisible();
    await noSideways(page, `SETUP ${width}`);
    if (width === 390) await audit(page, 'SETUP with rules');

    await tab(page, 'フォーマット').click();
    await page.locator('.list-row').filter({ hasText: '標準6ゲーム' }).click();
    const editor = page.getByTestId('league-rules-editor');
    await expect(editor).toHaveAttribute('open', '');
    await noSideways(page, `FORMAT EDITOR ${width}`);
    for (const input of await editor.locator('input').all()) {
      const box = await input.boundingBox();
      expect(box?.height ?? 0, `rule input height at ${width}`).toBeGreaterThanOrEqual(44);
    }
    await editor.screenshot({ path: test.info().outputPath(`rules-editor-${width}.png`) });
    if (width === 390) await audit(page, 'FORMAT EDITOR with rules');
    await page.getByRole('button', { name: '閉じる' }).first().click();

    // The ORDER tab returns to the order being worked on.
    await tab(page, 'オーダー').click();
  }
});
