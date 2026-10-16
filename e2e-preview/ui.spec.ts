import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

/**
 * v1.4 navigation and controls on the preview's app page (its sample team, no service worker):
 * hamburger menu, breadcrumbs, carousel, modal, accordion, radio buttons and pull-downs, each
 * operated the way a captain would, plus a WCAG 2.1 AA audit of the open menu and modal.
 * The full app suite (e2e/) covers the same screens on the production build from `main`.
 */

async function audit(page: Page, label: string): Promise<void> {
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  const summary = results.violations.map((violation) => ({
    id: violation.id,
    nodes: violation.nodes.slice(0, 3).map((node) => node.target.join(' ')),
  }));
  expect(summary, label).toEqual([]);
}

const tab = (page: Page, name: string) => page.locator('.tab-bar').getByRole('button', { name, exact: true });

test.beforeEach(async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/index.html');
  await page.getByRole('button', { name: 'サンプルで試す' }).click();
  // The animated letters are decoration: the heading is named by the text in one piece.
  await expect(page.getByRole('heading', { name: 'サンプルチーム', level: 1, exact: true })).toBeVisible();
  await expect(page.locator('.toast')).toHaveCount(0, { timeout: 6000 });
});

test('the preview page lists where to check the v1.4 UI', async ({ page }) => {
  await page.goto('/preview.html');
  const guide = page.getByTestId('preview-ui-guide');
  await guide.getByText(/UI 確認ポイント/u).click();
  await expect(guide).toContainText('ハンバーガーメニュー');
  await expect(guide.getByRole('link', { name: 'アプリ本体を開く' })).toHaveAttribute('href', './index.html');
});

test('hamburger menu: every screen, the current one marked, and it closes on the way', async ({ page }) => {
  const button = page.getByRole('button', { name: 'メニューを開く' });
  await expect(button).toHaveAttribute('aria-expanded', 'false');
  await button.click();
  const menu = page.getByRole('dialog', { name: 'メニュー' });
  await expect(menu).toBeVisible();
  await expect(button).toHaveAttribute('aria-expanded', 'true');
  await expect(menu.getByRole('button', { name: /^ホーム/u })).toHaveAttribute('aria-current', 'page');
  await audit(page, 'menu');

  await menu.getByRole('button', { name: /^ペア相性/u }).click();
  await expect(menu).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'ペア相性', level: 1 })).toBeVisible();

  // Escape closes it too, and focus goes back to the button.
  await button.click();
  await expect(menu).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
  await expect(button).toBeFocused();
});

test('breadcrumbs: the trail to the current screen, and each step leads back', async ({ page }) => {
  await expect(page.getByRole('navigation', { name: 'パンくずリスト' })).toHaveCount(0);
  await page.getByRole('button', { name: '新しいオーダーを作る' }).first().click();
  await page.getByRole('button', { name: 'オーダーを生成' }).click();
  await expect(page.getByRole('heading', { name: 'オーダー結果', level: 1 })).toBeVisible();

  const crumbs = page.getByRole('navigation', { name: 'パンくずリスト' });
  await expect(crumbs.getByRole('listitem')).toHaveText(['ホーム', 'オーダー設定', 'オーダー結果']);
  await expect(crumbs.locator('[aria-current="page"]')).toHaveText('オーダー結果');
  await crumbs.getByRole('button', { name: 'オーダー設定' }).click();
  await expect(page.getByRole('heading', { name: 'オーダー設定', level: 1 })).toBeVisible();
  await crumbs.getByRole('button', { name: 'ホーム' }).click();
  await expect(page.getByRole('heading', { name: 'サンプルチーム', level: 1 })).toBeVisible();
});

test('carousel: buttons, dots and arrow keys move it; it never moves on its own', async ({ page }) => {
  const carousel = page.getByRole('region', { name: 'はじめかた' });
  await expect(carousel).toHaveAttribute('aria-roledescription', 'carousel');
  const current = carousel.locator('.carousel-dot[aria-current="true"]');
  await expect(current).toHaveAccessibleName('スライド 1 を表示');
  await expect(carousel.getByRole('button', { name: '前のスライド' })).toBeDisabled();

  await carousel.getByRole('button', { name: '次のスライド' }).click();
  await expect(current).toHaveAccessibleName('スライド 2 を表示');
  await carousel.getByRole('button', { name: 'スライド 1 を表示' }).click();
  await expect(current).toHaveAccessibleName('スライド 1 を表示');
  await page.keyboard.press('ArrowRight');
  await expect(current).toHaveAccessibleName('スライド 2 を表示');

  // A slide's action goes where it says.
  await carousel.getByRole('button', { name: 'フォーマットを見る' }).click();
  await expect(page.getByRole('heading', { name: 'フォーマット', level: 1 })).toBeVisible();
});

test('modal: the strength chart, with Rating / PPR as radio buttons', async ({ page }) => {
  await page.getByRole('button', { name: 'メンバーの戦力分布' }).click();
  const modal = page.getByRole('dialog', { name: 'メンバーの戦力分布' });
  await expect(modal).toBeVisible();
  await expect(modal.getByRole('list', { name: 'メンバー別 Rating' }).getByRole('listitem')).toHaveCount(5);
  await audit(page, 'strength modal');

  const rating = modal.getByRole('radio', { name: 'Rating' });
  await expect(rating).toBeChecked();
  await rating.focus();
  await page.keyboard.press('ArrowRight');
  await expect(modal.getByRole('radio', { name: 'PPR' })).toBeChecked();
  await expect(modal.getByRole('list', { name: 'メンバー別 PPR' })).toBeVisible();

  await page.keyboard.press('Escape');
  await expect(modal).toHaveCount(0);
});

test('accordion: settings open one section at a time', async ({ page }) => {
  await page.getByRole('button', { name: 'メニューを開く' }).click();
  await page.getByRole('dialog', { name: 'メニュー' }).getByRole('button', { name: /^設定/u }).click();
  await expect(page.getByRole('heading', { name: '設定', level: 1 })).toBeVisible();

  const weights = page.locator('details.accordion').filter({ hasText: 'カスタムウェイト' });
  const engine = page.locator('details.accordion').filter({ hasText: '最適化エンジン' });
  await weights.locator('summary').click();
  await expect(weights).toHaveAttribute('open', '');
  await expect(page.getByRole('slider', { name: 'ゲーム適性' })).toBeVisible();
  await expect(page.getByRole('list', { name: 'ウェイトの配分' })).toBeVisible();

  await engine.locator('summary').click();
  await expect(engine).toHaveAttribute('open', '');
  await expect(weights).not.toHaveAttribute('open', '');

  // The default fairness scope is now a radio pair.
  await page.getByRole('radio', { name: 'シーズン込み' }).check();
  // Stored like any other setting: still chosen after a reload (the app reopens on HOME).
  await page.reload();
  await page.getByRole('button', { name: 'メニューを開く' }).click();
  await page.getByRole('dialog', { name: 'メニュー' }).getByRole('button', { name: /^設定/u }).click();
  await expect(page.getByRole('heading', { name: '設定', level: 1 })).toBeVisible();
  await page.locator('details.accordion').filter({ hasText: '最適化エンジン' }).locator('summary').click();
  await expect(page.getByRole('radio', { name: 'シーズン込み' })).toBeChecked();
  await audit(page, 'settings');
});

test('radio buttons: presets move with the arrow keys; conditions are radio cards', async ({ page }) => {
  await page.getByRole('button', { name: '新しいオーダーを作る' }).first().click();
  const presets = page.getByRole('radiogroup', { name: 'プリセット' });
  const checked = presets.locator('[role="radio"][aria-checked="true"]');
  const before = await checked.textContent();
  await checked.focus();
  await page.keyboard.press('ArrowRight');
  await expect(checked).not.toHaveText(before ?? '');
  await expect(checked).toBeFocused();
  // One tab stop for the whole group.
  await expect(presets.locator('[role="radio"][tabindex="0"]')).toHaveCount(1);

  await page.getByRole('button', { name: /詳細条件/u }).click();
  const sheet = page.getByRole('dialog', { name: '詳細条件' });
  const hard = sheet.getByRole('group', { name: '最大連続出場の扱い' }).getByRole('radio', { name: /絶対条件/u });
  await hard.check();
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: /詳細条件/u }).click();
  await expect(hard).toBeChecked();
  await expect(page.getByRole('button', { name: /詳細条件/u })).toContainText('連続 絶対条件');
});

test('pull-downs: history filter and order (view only)', async ({ page }) => {
  await page.getByRole('button', { name: '新しいオーダーを作る' }).first().click();
  await page.getByRole('button', { name: 'オーダーを生成' }).click();
  await expect(page.getByRole('heading', { name: 'オーダー結果', level: 1 })).toBeVisible();
  await page.locator('.action-bar .btn.primary').click();
  await expect(page.locator('.toast')).toHaveCount(0, { timeout: 6000 });

  await tab(page, '履歴').click();
  const rows = page.locator('.history-row');
  await expect(rows).toHaveCount(1);
  await page.getByLabel('表示').selectOption('draft');
  await expect(rows).toHaveCount(0);
  await expect(page.getByRole('status').filter({ hasText: '当てはまるオーダーはありません' })).toBeVisible();
  await page.getByLabel('表示').selectOption('finalized');
  await expect(rows).toHaveCount(1);
  await page.getByLabel('並び順').selectOption('oldest');
  await expect(rows).toHaveCount(1);

  // The saved order now shows on HOME as a carousel slide that opens it.
  await tab(page, 'ホーム').click();
  const recent = page.getByRole('region', { name: '最近のオーダー' });
  await expect(recent.getByRole('group')).toHaveCount(1);
  await recent.getByRole('button', { name: /開いて編集/u }).click();
  await expect(page.getByRole('heading', { name: 'オーダー結果', level: 1 })).toBeVisible();
});
