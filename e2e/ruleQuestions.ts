import type { Page } from '@playwright/test';

/**
 * Presses オーダーを生成 and, when SETUP first asks the appearance-count questions (出場回数の
 * 確認 — the sample formats play Singles and Doubles more than once and state no cap), answers
 * each with the largest count offered: as many appearances as the format has games of that
 * kind, i.e. the same unrestricted generation these suites were written against. Suites about
 * the questions themselves answer them explicitly instead (leagueRules.spec.ts).
 */
export async function clickGenerate(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'オーダーを生成' }).click();
  await answerUnrestricted(page);
}

export async function answerUnrestricted(page: Page, timeout = 1500): Promise<boolean> {
  const dialog = page.getByRole('dialog', { name: '出場回数の確認' });
  try {
    await dialog.waitFor({ state: 'visible', timeout });
  } catch {
    return false;
  }
  const groups = dialog.getByRole('radiogroup');
  const count = await groups.count();
  for (let index = 0; index < count; index += 1) {
    await groups.nth(index).getByRole('radio', { name: '回数を指定' }).click();
  }
  const increase = dialog.getByRole('button', { name: /を1増やす$/ });
  for (let index = 0; index < (await increase.count()); index += 1) {
    const button = increase.nth(index);
    while (await button.isEnabled()) await button.click();
  }
  await dialog.getByTestId('rule-questions-confirm').click();
  return true;
}
