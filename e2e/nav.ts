import type { Page } from '@playwright/test';

/** Screens reached through その他 since v1.5.0 (the bottom bar is ホーム／観戦／分析／オーダー／その他). */
const UNDER_MORE = ['メンバー', 'フォーマット', 'ペア相性', '履歴', '設定 / バックアップ'];

/**
 * A main screen of the bottom bar, by its label. For a screen under その他, `click()` opens
 * その他 and then the screen by name.
 */
export function tab(page: Page, name: string): { click: () => Promise<void> } {
  const bar = page.locator('.tab-bar');
  if (!UNDER_MORE.includes(name)) return bar.getByRole('button', { name, exact: true });
  return {
    click: async () => {
      await bar.getByRole('button', { name: 'その他', exact: true }).click();
      await page.getByTestId('more-page').getByRole('button', { name: new RegExp(`^${name.replace(/[/]/g, '\\/')}`) }).click();
    },
  };
}
