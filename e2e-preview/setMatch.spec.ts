import { expect, test, type Page } from '@playwright/test';
import { tab } from '../e2e/nav';
import { N01_API_BASE_URL } from '../src/integrations/n01/endpoints';
import { setMatchReply } from '../src/test/n01/setMatch';

/**
 * The made-up set-format match (src/test/n01/setMatch.ts) on the preview's app page: 観戦 →
 * いま n01 で進行中 → 個別の試合 opens it on a page of its own, which moves to the next set by
 * itself, and an earlier set opens with one tap.
 *
 * - A preview built with `PREVIEW_DEMO_N01=1` (the review page) answers n01 itself
 *   (src/preview/demoN01.ts, a phase every 25 s): the page clock is driven through two phases.
 * - Any other preview build would read n01: here every n01 read is answered from the same
 *   fictional match instead (nothing reaches n01), and the test moves the phase.
 */

const DEMO = process.env.PREVIEW_DEMO_N01 === '1';

async function canned(page: Page): Promise<{ phase: number }> {
  const control = { phase: 0 };
  await page.route(`${N01_API_BASE_URL}/**`, async (route) => {
    const url = new URL(route.request().url());
    const operation = url.pathname.replace(/^.*\/api\/v1\//u, '');
    const body = setMatchReply(operation, Object.fromEntries(url.searchParams.entries()), control.phase) ?? { result: -1, error: 'not found' };
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body), headers: { 'access-control-allow-origin': '*' } });
  });
  return control;
}

test('preview: the set-format match moves to the next set on its own, and an earlier set opens', async ({ page }) => {
  const control = DEMO ? null : await canned(page);
  if (DEMO) await page.clock.install();
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/index.html');
  await page.getByRole('button', { name: 'サンプルで試す' }).click();
  await expect(page.getByRole('heading', { name: 'サンプルチーム', level: 1, exact: true })).toBeVisible();
  await tab(page, '観戦').click();
  await page.getByRole('button', { name: /^いま n01 で進行中/ }).first().click();
  await page.getByTestId('now-single').filter({ hasText: 'Alpha 選手1-1' }).click();
  const shown = page.getByTestId('shown-set');
  await expect(shown).toContainText('シングルス1');
  // Two phases on: シングルス1 over, ダブルス1 under way.
  if (control) control.phase = 2;
  else await page.clock.runFor(51_000);
  await expect(shown).toContainText('ダブルス1');
  await expect(page.getByTestId('set-item')).toHaveCount(2);
  await page.getByTestId('set-item').first().click();
  await expect(shown).toContainText('シングルス1');
  await expect(page.getByTestId('set-score').getByTestId('score-sheet')).toBeVisible();
  await page.getByTestId('back-to-live').click();
  await expect(shown).toContainText('ダブルス1');
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
});
