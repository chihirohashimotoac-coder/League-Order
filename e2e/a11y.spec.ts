import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

/**
 * Automated accessibility audit (axe-core, WCAG 2.0 / 2.1 A + AA rules) of every main
 * screen of the Light Match Sheet UI, including colour contrast. Manual checks that axe
 * cannot do (44px targets, reduced motion, no colour-only meaning) are covered by the
 * layout tests and the stylesheet.
 */

const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

async function audit(page: Page, label: string): Promise<void> {
  const results = await new AxeBuilder({ page }).withTags(TAGS).analyze();
  const summary = results.violations.map((violation) => ({
    id: violation.id,
    impact: violation.impact,
    nodes: violation.nodes.slice(0, 3).map((node) => node.target.join(' ')),
  }));
  expect(summary, label).toEqual([]);
}

function tab(page: Page, name: string) {
  return page.locator('.tab-bar').getByRole('button', { name, exact: true });
}

test('every main screen passes the WCAG AA audit', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
  await audit(page, 'WELCOME');
  await page.getByRole('button', { name: 'サンプルで試す' }).click();
  await expect(page.getByRole('heading', { name: 'サンプルチーム', level: 1 })).toBeVisible();
  // Let the "loaded" toast leave so it is not audited over the page.
  await expect(page.locator('.toast')).toHaveCount(0, { timeout: 6000 });
  await audit(page, 'HOME');

  await tab(page, 'メンバー').click();
  await audit(page, 'PLAYERS');
  await page.locator('.list-row').filter({ hasText: '青木' }).click();
  await page.getByLabel('PPR Average (任意)').fill('300');
  await audit(page, 'PLAYER EDITOR (with a validation error)');
  await page.getByLabel('PPR Average (任意)').fill('72.5');
  await page.getByRole('button', { name: '保存' }).click();

  await tab(page, 'フォーマット').click();
  await audit(page, 'FORMAT LIST');
  await page.locator('.list-row').first().click();
  await page.getByRole('button', { name: 'Soft Darts' }).click();
  await audit(page, 'FORMAT EDITOR');
  await page.getByRole('button', { name: '保存' }).click();
  await expect(page.locator('.toast')).toHaveCount(0, { timeout: 6000 });

  await tab(page, 'ホーム').click();
  await page.getByRole('button', { name: '新しいオーダーを作る' }).click();
  await expect(page.getByRole('heading', { name: 'オーダー設定' })).toBeVisible();
  await audit(page, 'SETUP');

  await page.getByRole('button', { name: 'オーダーを生成' }).click();
  await expect(page.getByRole('heading', { name: 'オーダー結果' })).toBeVisible();
  for (const [index, name] of ['RESULT Balanced', 'RESULT Win First', 'RESULT Fairness First'].entries()) {
    await page.locator('.candidate-tab').nth(index).click();
    await audit(page, name);
  }
  await page.getByText('詳細分析', { exact: true }).click();
  await audit(page, 'RESULT analysis');

  await page.locator('.action-bar .btn.primary').click();
  await expect(page.locator('.toast')).toHaveCount(0, { timeout: 6000 });
  await page.locator('.action-bar').getByRole('button', { name: /共有/ }).click();
  await expect(page.getByRole('dialog', { name: '共有' })).toBeVisible();
  await audit(page, 'SHARE');
  await page.keyboard.press('Escape');

  await tab(page, '履歴').click();
  await audit(page, 'HISTORY');
});
