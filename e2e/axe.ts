import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, type TestInfo } from '@playwright/test';

const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

/**
 * Waits until the screen is at rest: nothing is marked `aria-busy`, and every finite
 * animation or transition has finished. Entrance fades (section-in, sheet-up) run on
 * opacity, so a check taken mid-fade measures blended colours (e.g. #148591 instead of
 * the accent #087f8c, 4.34:1 instead of 4.75:1) and reports contrast the resting screen
 * does not have. Infinite animations (the spinner) never finish and are not waited for.
 */
export async function waitForRest(page: Page): Promise<void> {
  await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
  await page.waitForFunction(() =>
    document.getAnimations().every((animation) => animation.playState !== 'running' || animation.effect?.getComputedTiming().endTime === Infinity),
  );
}

/**
 * WCAG 2.1 A/AA audit of the resting screen (normal motion). The full axe violations are
 * attached to the report, and the assertion lists every node with axe's own summary (for
 * colour contrast: the colours, the ratio and the expected ratio), so a failure is readable
 * from the job log alone.
 */
export async function expectNoAxeViolations(page: Page, testInfo: TestInfo): Promise<void> {
  await waitForRest(page);
  const results = await new AxeBuilder({ page }).withTags(TAGS).analyze();
  if (results.violations.length > 0) {
    await testInfo.attach('axe-violations.json', { body: JSON.stringify(results.violations, null, 2), contentType: 'application/json' });
  }
  expect(
    results.violations.map((violation) => ({
      id: violation.id,
      impact: violation.impact,
      nodes: violation.nodes.map((node) => `${node.target.join(' ')} — ${node.failureSummary ?? ''}`),
    })),
  ).toEqual([]);
}
