import { expect, test, type Page } from '@playwright/test';
import { pinFixtureClock, serveN01 } from './n01Server';
import { expectNoAxeViolations } from './axe';

/**
 * Watching without a team (no team registered, a league chosen to watch): the bottom bar is
 * the same five tabs as with a team, in the same places. Every tab is reachable and leads
 * somewhere — ORDER and the team screens offer to register a team (or the sample) right there —
 * and the watch screen keeps the league chosen. Fixture n01 only (no network).
 */

test.use({ serviceWorkers: 'block' });

async function watchWithoutTeam(page: Page): Promise<void> {
  await pinFixtureClock(page);
  await serveN01(page);
  await page.goto('/');
  await page.getByRole('group', { name: 'よく使われるリーグ' }).getByRole('button', { name: 'ATDO' }).click();
  await expect(page.getByTestId('watch-page')).toBeVisible();
}

const tabBar = (page: Page) => page.getByRole('navigation', { name: 'メインナビゲーション' });
const tab = (page: Page, name: string) => tabBar(page).getByRole('button', { name, exact: true });
const noSidewaysScroll = async (page: Page): Promise<void> => {
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
};

test.describe('watching without a team: the same bottom bar', () => {
  test('five tabs; each one leads somewhere; back to watching keeps the league', async ({ page }, testInfo) => {
    await watchWithoutTeam(page);
    // The same five tabs, 観戦 current.
    await expect(tabBar(page).getByRole('button')).toHaveText(['ホーム', '観戦', '分析', 'オーダー', 'その他']);
    await expect(tab(page, '観戦')).toHaveAttribute('aria-current', 'page');
    const league = (await page.locator('.app-header h1').textContent()) ?? '';
    expect(league.length).toBeGreaterThan(0);

    // ホーム: what is watched, and what a team adds.
    await tab(page, 'ホーム').click();
    const home = page.getByTestId('viewer-home');
    await expect(home).toContainText(league);
    await expect(home.getByRole('button', { name: 'チームを登録' })).toBeVisible();
    await expect(home.getByRole('button', { name: 'サンプルで試す' })).toBeVisible();
    await expectNoAxeViolations(page, testInfo);
    await home.getByRole('button', { name: '観戦を開く' }).click();
    await expect(page.getByTestId('watch-page')).toBeVisible();
    await expect(page.locator('.app-header h1')).toHaveText(league);

    // 分析: needs a team linked to n01; says so, with the ways on.
    await tab(page, '分析').click();
    await expect(page.getByText('n01 と連携したチームで使えます')).toBeVisible();
    await page.getByRole('button', { name: 'ホームでチームを連携' }).click();
    await expect(page.getByTestId('viewer-home')).toBeVisible();
    await expect(tab(page, 'ホーム')).toHaveAttribute('aria-current', 'page');

    // オーダー: needs a team; registering and coming back lands on the same tab.
    await tab(page, 'オーダー').click();
    await expect(page.getByText('オーダー作成にはチームが必要です')).toBeVisible();
    await page.getByRole('main').getByRole('button', { name: 'チームを登録' }).click();
    await expect(page.getByRole('button', { name: '観戦に戻る' })).toBeVisible();
    await page.getByRole('button', { name: '観戦に戻る' }).click();
    await expect(page.getByText('オーダー作成にはチームが必要です')).toBeVisible();
    await expect(tabBar(page)).toBeVisible();

    // その他: settings and the change log work; the team screens point to registering.
    await tab(page, 'その他').click();
    const more = page.getByTestId('more-page');
    await expect(more.getByRole('button', { name: /チームを登録/ })).toBeVisible();
    await expect(more).not.toContainText('ペア相性 0');
    await expectNoAxeViolations(page, testInfo);
    await more.getByRole('button', { name: /更新履歴/ }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await page.keyboard.press('Escape');
    await more.getByRole('button', { name: /設定 \/ バックアップ/ }).click();
    await expect(page.getByText('保存とバックアップ')).toBeVisible();
    await expect(tab(page, 'その他')).toHaveAttribute('aria-current', 'page');
    await page.getByRole('button', { name: '戻る' }).click();
    await expect(page.getByTestId('more-page')).toBeVisible();

    // Back to 観戦: the same league; a reload opens on 観戦 again.
    await tab(page, '観戦').click();
    await expect(page.getByTestId('watch-page')).toBeVisible();
    await expect(page.locator('.app-header h1')).toHaveText(league);
    await page.reload();
    await expect(page.getByTestId('watch-page')).toBeVisible();
    await expect(tab(page, '観戦')).toHaveAttribute('aria-current', 'page');
  });

  test('the sample from ORDER opens the order setup of the sample team (same bar)', async ({ page }) => {
    await watchWithoutTeam(page);
    await tab(page, 'オーダー').click();
    await page.getByRole('main').getByRole('button', { name: 'サンプルで試す' }).click();
    await expect(page.locator('.app-header')).toContainText('サンプルチーム');
    await expect(page.getByRole('heading', { name: 'オーダー設定', level: 1 })).toBeVisible();
    await expect(tab(page, 'オーダー')).toHaveAttribute('aria-current', 'page');
    await expect(tabBar(page).getByRole('button')).toHaveText(['ホーム', '観戦', '分析', 'オーダー', 'その他']);
  });

  test('phone widths: nothing sideways, the bar does not cover the content, tabs keep their size', async ({ page }) => {
    await watchWithoutTeam(page);
    for (const width of [320, 393]) {
      await page.setViewportSize({ width, height: 740 });
      for (const name of ['ホーム', '観戦', 'オーダー', 'その他']) {
        await tab(page, name).click();
        await noSidewaysScroll(page);
        const box = await tab(page, name).boundingBox();
        expect(box!.height).toBeGreaterThanOrEqual(44);
      }
      // The last content of a page can be scrolled clear of the bar.
      await tab(page, 'その他').click();
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      const last = await page.getByTestId('more-page').locator('.list-row').last().boundingBox();
      const bar = await tabBar(page).boundingBox();
      expect(last!.y + last!.height).toBeLessThanOrEqual(bar!.y + 1);
    }
  });
});
