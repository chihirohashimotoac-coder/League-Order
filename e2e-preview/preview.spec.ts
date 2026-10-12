import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

/**
 * The non-production preview page (docs/THROW_ORDER_MODEL.md §10) in a real browser: every
 * scenario shows what it promises, the controls work by button (no drag), the page passes
 * WCAG 2.1 AA (axe) and never scrolls sideways on a phone. Synthetic data only.
 */

async function audit(page: Page, label: string): Promise<void> {
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  const summary = results.violations.map((violation) => ({
    id: violation.id,
    nodes: violation.nodes.slice(0, 3).map((node) => node.target.join(' ')),
  }));
  expect(summary, label).toEqual([]);
}

async function noSidewaysScroll(page: Page, label: string): Promise<void> {
  const extra = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(extra, label).toBeLessThanOrEqual(1);
}

async function open(page: Page, title: RegExp): Promise<void> {
  const tab = page.getByRole('navigation', { name: 'シナリオ' }).getByRole('button', { name: title });
  await tab.click();
  await expect(tab).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('heading', { name: 'オーダー', exact: true, level: 2 })).toBeVisible();
}

const selected = (page: Page, game: RegExp) =>
  page
    .locator('.order-game')
    .filter({ hasText: game })
    .locator('select')
    .evaluateAll((selects) =>
      // Option labels end with the rating ("名前 (Rt. —)"); the name is what the order is about.
      selects.map((select) => ((select as HTMLSelectElement).selectedOptions[0]?.textContent ?? '').replace(/ \(Rt\. [^)]*\)$/u, '')),
    );

test.beforeEach(async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/preview.html');
  await expect(page.getByRole('heading', { name: '投順モデルと格上対策の確認ページ' })).toBeVisible();
});

test('A: the estimate changes the throwing order, and says why, by how much and on what', async ({ page }) => {
  await open(page, /^A\./u);
  const note = page.locator('.order-game').filter({ hasText: 'Trios 701' }).getByTestId('throw-order-note');
  await expect(note).toHaveClass(/deviates/u);
  await expect(note).toContainText(/投順: 推定勝率で選択 \(強い順より \+\d+\.\dpt\)/u);
  await expect(note).toContainText('通常 (強い順) なら 赤井 (エース) → 黄田 (スコアラー) → 青木');
  await expect(note).toContainText(/信頼度 高/u);
  await expect(note).toContainText('利用した相手の傾向: 相手の 1 投目の予想');
  await expect(note).toContainText('推定値であり、結果を保証するものではありません');
  await expect(note).not.toContainText(/確実|必勝/u);
  const labels = await page.locator('.order-game').filter({ hasText: 'Trios 701' }).locator('.slot-top > span:first-child').allTextContents();
  expect(labels).toEqual(['1投目', '2投目', '3投目']);
  await audit(page, 'preview A');
});

test('B: the same members against another opponent order keep the strong order', async ({ page }) => {
  await open(page, /^B\./u);
  const note = page.locator('.order-game').filter({ hasText: 'Trios 701' }).getByTestId('throw-order-note');
  await expect(note).not.toHaveClass(/deviates/u);
  await expect(note).toContainText('投順: 強い順 (このゲームの役割別強度の高い順)');
  expect(await selected(page, /Trios 701/u)).toEqual(['赤井 (エース)', '黄田 (スコアラー)', '青木']);
});

test('C: no data — role strength decides, never the id; a swap button re-estimates and Undo restores', async ({ page }) => {
  await open(page, /^C\./u);
  const doubles = page.locator('.order-game').filter({ hasText: 'Doubles 501' });
  const before = await selected(page, /Doubles 501/u);
  expect(before[0]).toContain('白石 (Doubles型)');
  await doubles.getByRole('button', { name: /1投目と2投目を入れ替え/u }).click();
  expect(await selected(page, /Doubles 501/u)).toEqual([...before].reverse());
  await expect(doubles.getByTestId('throw-order-note')).toContainText('投順: 手動で変更');
  await page.getByRole('button', { name: '元に戻す' }).click();
  expect(await selected(page, /Doubles 501/u)).toEqual(before);
  await audit(page, 'preview C');
});

test('D: the underdog plan is one tap away, never applied on its own, and one tap back', async ({ page }) => {
  await open(page, /^D\./u);
  const panel = page.getByTestId('underdog-panel');
  await expect(panel).toContainText(/標準案の推定 Match 勝率 (1?\d|20)%/u);
  await expect(panel).toContainText(/1ゲーム以上取る確率を \+\d+\.\dpt 改善|期待勝ちゲーム数を \d\.\d\d 改善/u);
  await expect(panel).toContainText(/標準案から失われる推定 Match 勝率|推定 Match 勝率は標準案より/u);
  const standard = await page.locator('.order-game select').evaluateAll((s) => s.map((x) => (x as HTMLSelectElement).value));
  await panel.getByRole('button', { name: '格上対策案を試す' }).click();
  await expect(panel).toContainText('格上対策案を表示中');
  const plan = await page.locator('.order-game select').evaluateAll((s) => s.map((x) => (x as HTMLSelectElement).value));
  expect(plan).not.toEqual(standard);
  await audit(page, 'preview D (underdog plan shown)');
  await panel.getByRole('button', { name: '標準案に戻す' }).click();
  await expect(panel).toContainText('標準案の推定 Match 勝率');
  expect(await page.locator('.order-game select').evaluateAll((s) => s.map((x) => (x as HTMLSelectElement).value))).toEqual(standard);
});

test('E: Singles — no fixed ace-vs-ace rule; the comparison is shown', async ({ page }) => {
  await open(page, /^E\./u);
  const ace = page.getByTestId('opponent-ace');
  await expect(ace).toContainText('エース同士を当てる固定ルールは使わず');
  await expect(ace).toContainText('エースを相手エース枠に当てた場合の推定 Match 勝率');
  await audit(page, 'preview E');
});

for (const width of [360, 390]) {
  test(`every scenario fits ${width}px without sideways scroll`, async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'mobile', 'widths are set explicitly; one project is enough');
    await page.setViewportSize({ width, height: 800 });
    for (const title of [/^A\./u, /^B\./u, /^C\./u, /^D\./u, /^E\./u]) {
      await open(page, title);
      await noSidewaysScroll(page, `${title.source} at ${width}px`);
    }
    await page.getByRole('navigation', { name: 'シナリオ' }).getByRole('button', { name: /^D\./u }).click();
    await page.getByTestId('underdog-panel').getByRole('button', { name: '格上対策案を試す' }).click();
    await noSidewaysScroll(page, `underdog plan at ${width}px`);
  });
}
