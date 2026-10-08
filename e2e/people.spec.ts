import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { pinFixtureClock, serveN01 } from './n01Server';

/**
 * 今回限りの助っ人 and 次回から参加するメンバー in a real browser (mobile and desktop),
 * against the fixture n01 server: entered from 「次戦のオーダーを作る」, fielded now,
 * kept through a reload, and not carried to the next order.
 */
test.use({ serviceWorkers: 'block' });

async function createKalavinka(page: Page): Promise<void> {
  await pinFixtureClock(page);
  await serveN01(page);
  await page.goto('/');
  await page.getByRole('button', { name: 'n01から作成' }).click();
  const wizard = page.getByRole('dialog', { name: 'n01から作成' });
  await wizard.getByRole('button', { name: 'ATDO', exact: true }).click();
  await wizard.getByRole('button', { name: /kalavinka/ }).click();
  await expect(wizard.getByTestId('n01-preview')).toBeVisible();
  await wizard.getByRole('button', { name: 'このチームを作成' }).click();
  await expect(page.getByRole('heading', { name: 'kalavinka', level: 1 })).toBeVisible();
}

async function add(page: Page, opener: string, dialog: string, name: string, saveLabel: string): Promise<void> {
  await page.getByRole('button', { name: opener }).click();
  const editor = page.getByRole('dialog', { name: dialog });
  await editor.getByPlaceholder('例: ちひろ').fill(name);
  await editor.getByRole('button', { name: saveLabel }).click();
  await expect(editor).toHaveCount(0);
}

test('a helper and a next-time member, from the next-match flow to a reload', async ({ page }) => {
  await createKalavinka(page);
  await page.getByRole('button', { name: '次戦のオーダーを作る' }).click();
  const flow = page.getByRole('dialog', { name: '次戦のオーダーを作る' });
  await expect(flow.getByTestId('flow-attendance')).toBeVisible();

  await add(page, '今回だけ助っ人を追加', '今回だけ助っ人を追加', '助っ人 花子', '助っ人として追加');
  await add(page, '次回から参加するメンバーを追加', '次回から参加するメンバーを追加', '新人 次郎', 'メンバーに追加');
  await expect(flow.getByTestId('flow-attendance')).toContainText('本日参加 9 / 9');
  await expect(flow.getByTestId('guest-tag')).toHaveText('助っ人 (今回のみ)');
  await expect(flow.getByTestId('manual-tag')).toHaveText('n01 未連携');

  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  expect(results.violations.map((violation) => violation.id)).toEqual([]);

  await flow.getByRole('button', { name: 'このメンバーで作成' }).click();
  await expect(page.getByRole('heading', { name: 'オーダー結果' })).toBeVisible({ timeout: 30_000 });
  const fielded = await page.locator('.order-game select').evaluateAll((selects) =>
    selects.map((select) => (select as HTMLSelectElement).selectedOptions[0]?.textContent ?? ''),
  );
  expect(fielded.some((name) => name.includes('助っ人 花子'))).toBe(true);
  await expect(page.getByTestId('strength-basis-panel')).toContainText('助っ人 花子');

  // Saved, the order keeps the helper; after a reload the member is still on the roster and the helper is not.
  await page.getByRole('button', { name: /下書きを保存/ }).click();
  await page.reload();
  await expect(page.getByRole('heading', { name: 'kalavinka', level: 1 })).toBeVisible();
  await page.locator('.tab-bar').getByRole('button', { name: 'メンバー', exact: true }).click();
  await expect(page.getByText('新人 次郎')).toBeVisible();
  await expect(page.getByText('助っ人 花子')).toHaveCount(0);
  await page.locator('.tab-bar').getByRole('button', { name: '履歴', exact: true }).click();
  await page.locator('.list-row').first().click();
  await expect(page.getByRole('dialog')).toContainText('助っ人 花子');
});
