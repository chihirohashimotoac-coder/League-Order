import { expect, test, type Page } from '@playwright/test';
import { serveAnalyticsExtras } from './analyticsServer';
import { pinFixtureClock, serveN01 } from './n01Server';

/** Layout at the smallest supported phone width (320px), a tablet and a wide desktop. */
test.use({ serviceWorkers: 'block' });

const VIEWPORTS = [
  { name: '320', width: 320, height: 700 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'wide', width: 1440, height: 900 },
];

async function open(page: Page): Promise<void> {
  await pinFixtureClock(page);
  await serveN01(page);
  await serveAnalyticsExtras(page);
  await page.goto('/');
  await page.getByRole('button', { name: 'n01から作成' }).click();
  const wizard = page.getByRole('dialog', { name: 'n01から作成' });
  await wizard.getByRole('button', { name: 'ATDO', exact: true }).click();
  await wizard.getByRole('button', { name: /kalavinka/ }).click();
  await wizard.getByRole('button', { name: 'このチームを作成' }).click();
  await expect(page.getByRole('heading', { name: 'kalavinka', level: 1 })).toBeVisible();
  await page.getByRole('button', { name: /データ分析/ }).click();
  await expect(page.getByTestId('metric-3DA')).toBeVisible();
}

for (const vp of VIEWPORTS) {
  test(`no sideways scroll or clipped text at ${vp.name} (${vp.width}px)`, async ({ page }, info) => {
    test.skip(info.project.name === 'desktop' && vp.width < 768, 'phone widths run in the mobile project');
    await page.setViewportSize({ width: vp.width, height: vp.height });
    await open(page);
    for (const view of ['プレイヤー', 'チーム']) {
      await page.getByRole('button', { name: view, exact: true }).click();
      await page.getByRole('button', { name: '直近3季' }).click();
      await expect(page.getByTestId('analytics-page')).toBeVisible();
      await page.waitForTimeout(300);
      const overflow = await page.evaluate(() => ({
        page: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        // Any element wider than the viewport (clipped text / table spill).
        wide: [...document.querySelectorAll('.analytics *')].filter((el) => el.getBoundingClientRect().right > window.innerWidth + 1).length,
      }));
      expect(overflow, view).toEqual({ page: 0, wide: 0 });
      await page.screenshot({ path: `test-results/vp-${vp.name}-${view === 'チーム' ? 'team' : 'player'}-${info.project.name}.png`, fullPage: true });
    }
  });
}
