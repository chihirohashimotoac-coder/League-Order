import { expect, test, type Page } from '@playwright/test';
import { tab } from '../e2e/nav';
import { N01_API_BASE_URL } from '../src/integrations/n01/endpoints';
import { browseReply } from '../src/test/n01/browse';

/**
 * プレビューのアプリ画面で、観戦の 3 つの一覧 (n01オンライン → n01トーナメント → n01リーグ) を開き、
 * 一覧 → 詳細 → 戻るで一覧の状態が残ることを確かめる。
 *
 * - `PREVIEW_DEMO_N01=1` のプレビュー (レビュー用) は、架空の一覧をプレビュー自身が答える。
 * - それ以外のビルドでは n01 を読むため、同じ架空の一覧をここで答える (n01 には届かない)。
 */

const DEMO = process.env.PREVIEW_DEMO_N01 === '1';

async function canned(page: Page): Promise<void> {
  await page.route(`${N01_API_BASE_URL}/**`, async (route) => {
    const url = new URL(route.request().url());
    const operation = url.pathname.replace(/^.*\/api\/v1\//u, '');
    const body = browseReply(operation, Object.fromEntries(url.searchParams.entries())) ?? { result: -1, error: 'not found' };
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body), headers: { 'access-control-allow-origin': '*' } });
  });
}

test('preview: 観戦の 3 つの一覧を公式メニューの順に開き、一覧から開いた試合から戻ると一覧のまま', async ({ page }) => {
  if (!DEMO) await canned(page);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/index.html');
  await page.getByRole('button', { name: 'サンプルで試す' }).click();
  await expect(page.getByRole('heading', { name: 'サンプルチーム', level: 1, exact: true })).toBeVisible();
  await tab(page, '観戦').click();
  const links = page.getByRole('navigation', { name: 'n01 の一覧から探す' });
  await expect(links.getByRole('button')).toHaveText(['n01オンライン', 'n01トーナメント', 'n01リーグ']);

  await links.getByRole('button', { name: 'n01トーナメント' }).click();
  await expect(page.getByTestId('browse-tournament')).toHaveCount(30);
  await page.getByRole('tab', { name: 'n01リーグ' }).click();
  await expect(page.getByTestId('browse-league')).toHaveCount(30);
  await page.getByRole('tab', { name: 'n01オンライン' }).click();
  await expect(page.getByTestId('official-lobby')).toHaveAttribute('href', 'https://n01darts.com/n01/online/');
  const rows = page.getByTestId('browse-online');
  await expect(rows).toHaveCount(4);
  await rows.first().click();
  await expect(page.getByTestId('set-page')).toBeVisible();
  await page.getByTestId('set-page-back').click();
  await expect(rows.first()).toBeFocused();
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
});
