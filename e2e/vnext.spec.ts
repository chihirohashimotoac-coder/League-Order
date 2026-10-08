import { expect, test, type Page } from '@playwright/test';

/**
 * vNext regressions in a real browser: text selection inside sheets, Rating + PPR,
 * soft / steel formats, the "01" kind chip, the strength basis, candidate switching and
 * the Light Match Sheet theme.
 */

async function openFresh(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByRole('button', { name: 'サンプルで試す' }).click();
  await expect(page.getByRole('heading', { name: 'サンプルチーム', level: 1 })).toBeVisible();
}

function tab(page: Page, name: string) {
  return page.locator('.tab-bar').getByRole('button', { name, exact: true });
}

/**
 * Wait for every finite CSS animation on the page to end. A sheet slides up over 0.2s
 * (`sheet-up`, 24px), so a bounding box read while it is still moving is up to 24px low —
 * more than half the height of a 44px input — and a mouse press at those coordinates lands
 * beside the field and selects nothing. The drag tests below read coordinates, so they
 * must wait for the sheet to be at rest first.
 */
async function animationsSettled(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const finite = document
      .getAnimations()
      .filter((animation) => Number.isFinite(animation.effect?.getComputedTiming().endTime as number));
    await Promise.all(finite.map((animation) => animation.finished.catch(() => undefined)));
  });
}

async function openPlayer(page: Page, name: string): Promise<void> {
  await tab(page, 'メンバー').click();
  await page.locator('.list-row').filter({ hasText: name }).click();
  await expect(page.getByRole('dialog', { name: 'メンバーを編集' })).toBeVisible();
  await animationsSettled(page);
}

async function generate(page: Page): Promise<void> {
  await tab(page, 'ホーム').click();
  await page.getByRole('button', { name: '新しいオーダーを作る' }).click();
  await expect(page.getByRole('heading', { name: 'オーダー設定' })).toBeVisible();
  await page.getByRole('button', { name: 'オーダーを生成' }).click();
  await expect(page.getByRole('heading', { name: 'オーダー結果' })).toBeVisible();
}

async function selectionLength(page: Page, label: string): Promise<number> {
  return page.getByLabel(label).evaluate((node) => {
    const field = node as HTMLInputElement | HTMLTextAreaElement;
    return (field.selectionEnd ?? 0) - (field.selectionStart ?? 0);
  });
}

// ---------------------------------------------------------------------------
// Issue 1: text selection must not close the sheet
// ---------------------------------------------------------------------------

test.describe('text selection inside a sheet', () => {
  test('a mouse selection dragged out onto the backdrop keeps the sheet open', async ({ page }) => {
    await openFresh(page);
    await openPlayer(page, '青木');
    const dialog = page.getByRole('dialog', { name: 'メンバーを編集' });
    const input = page.getByLabel('名前 (必須)');
    await input.fill('ちひろ テスト選手');

    const box = (await input.boundingBox())!;
    const sheet = (await dialog.boundingBox())!;
    await page.mouse.move(box.x + box.width - 8, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + 6, box.y + box.height / 2, { steps: 6 });
    // Finish the drag above the sheet, on the backdrop.
    await page.mouse.move(box.x + 6, Math.max(2, sheet.y - 30), { steps: 6 });
    await page.mouse.up();

    await expect(dialog).toBeVisible();
    expect(await selectionLength(page, '名前 (必須)')).toBeGreaterThan(0);
  });

  test('a textarea selection dragged onto the backdrop keeps the sheet open', async ({ page }) => {
    await openFresh(page);
    await openPlayer(page, '青木');
    const dialog = page.getByRole('dialog', { name: 'メンバーを編集' });
    const memo = page.getByLabel('メモ (任意)');
    await memo.fill('ダブルスが得意。今日は少し遅れて到着予定。');
    // Centre it in the sheet body so the sticky footer does not cover where the drag starts.
    await memo.evaluate((node) => node.scrollIntoView({ block: 'center' }));

    const box = (await memo.boundingBox())!;
    const sheet = (await dialog.boundingBox())!;
    // Anchor at the end of the text and drag towards its start, then out above the sheet:
    // the selection keeps its anchor and extends to the beginning.
    await page.mouse.move(box.x + box.width - 10, box.y + 14);
    await page.mouse.down();
    await page.mouse.move(box.x + 12, box.y + 14, { steps: 6 });
    await page.mouse.move(box.x + 12, Math.max(2, sheet.y - 30), { steps: 6 });
    await page.mouse.up();

    await expect(dialog).toBeVisible();
    expect(await selectionLength(page, 'メモ (任意)')).toBeGreaterThan(0);
  });

  test('keyboard selection, copy, cut, paste and the context menu keep it open', async ({ page, context, browserName }) => {
    test.skip(browserName !== 'chromium', 'clipboard permissions are Chromium-only');
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await openFresh(page);
    await openPlayer(page, '青木');
    const dialog = page.getByRole('dialog', { name: 'メンバーを編集' });
    const input = page.getByLabel('名前 (必須)');
    await input.fill('青木テスト');
    await input.focus();

    await page.keyboard.press('End');
    for (let i = 0; i < 3; i += 1) await page.keyboard.press('Shift+ArrowLeft');
    expect(await selectionLength(page, '名前 (必須)')).toBe(3);

    await page.keyboard.press('ControlOrMeta+c');
    await page.keyboard.press('ControlOrMeta+x');
    await expect(input).toHaveValue('青木');
    await page.keyboard.press('ControlOrMeta+v');
    await expect(input).toHaveValue('青木テスト');
    await page.keyboard.press('ControlOrMeta+a');
    expect(await selectionLength(page, '名前 (必須)')).toBe(5);

    // Context menu on the field (and a double-click word selection) leave it open too.
    await input.click({ button: 'right' });
    await input.dblclick();
    await expect(dialog).toBeVisible();
  });

  test('a touch drag from an input onto the backdrop keeps the sheet open', async ({ page, browserName }) => {
    test.skip(browserName !== 'chromium', 'raw touch events are sent over CDP');
    await openFresh(page);
    await openPlayer(page, '青木');
    const dialog = page.getByRole('dialog', { name: 'メンバーを編集' });
    const box = (await page.getByLabel('名前 (必須)').boundingBox())!;
    const sheet = (await dialog.boundingBox())!;

    const cdp = await page.context().newCDPSession(page);
    const point = (x: number, y: number) => [{ x, y, id: 1 }];
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: point(box.x + 10, box.y + box.height / 2) });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: point(box.x + 60, box.y + box.height / 2) });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: point(box.x + 60, Math.max(2, sheet.y - 30)) });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await expect(dialog).toBeVisible();
  });

  test('a genuine backdrop tap and Escape still close it', async ({ page }) => {
    await openFresh(page);
    await openPlayer(page, '青木');
    const dialog = page.getByRole('dialog', { name: 'メンバーを編集' });
    await page.mouse.click(8, 8);
    await expect(dialog).toBeHidden();

    await page.locator('.list-row').filter({ hasText: '青木' }).click();
    await expect(dialog).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
  });
});

// ---------------------------------------------------------------------------
// Rating + PPR, soft / steel, "01"
// ---------------------------------------------------------------------------

test.describe('Rating and PPR', () => {
  test('are entered side by side and listed as "Rt.14 · PPR 68.4"', async ({ page }) => {
    await openFresh(page);
    await openPlayer(page, '青木');
    await expect(page.getByLabel('Rating (任意)')).toHaveValue('14');
    await page.getByLabel('PPR Average (任意)').fill('68.4');
    await page.getByRole('button', { name: '保存' }).click();
    await expect(page.locator('.list-row').filter({ hasText: '青木' })).toContainText('Rt.14 · PPR 68.4');
    // Only Rating known: only Rating shown.
    await expect(page.locator('.list-row').filter({ hasText: '馬場' })).toContainText('Rt.14');
    await expect(page.locator('.list-row').filter({ hasText: '馬場' })).not.toContainText('PPR');
  });

  test('an out-of-range PPR is refused with a message, and blank means Unknown', async ({ page }) => {
    await openFresh(page);
    await openPlayer(page, '青木');
    await page.getByLabel('PPR Average (任意)').fill('200');
    await expect(page.getByRole('alert').filter({ hasText: 'PPR は 0〜180' })).toBeVisible();
    await expect(page.getByRole('button', { name: '保存' })).toBeDisabled();

    await page.getByLabel('PPR Average (任意)').fill('');
    await page.getByLabel('Rating (任意)').fill('');
    await page.getByRole('button', { name: '保存' }).click();
    await expect(page.locator('.list-row').filter({ hasText: '青木' })).toContainText('戦力データ未設定');
  });
});

test.describe('soft / steel formats', () => {
  test('an old format reads "未設定", a choice is saved and shown as a badge', async ({ page }) => {
    await openFresh(page);
    await tab(page, 'フォーマット').click();
    const row = page.locator('.list-row').first();
    await expect(row).toContainText('未設定');
    await row.click();

    const dialog = page.getByRole('dialog', { name: 'フォーマットを編集' });
    await expect(dialog.getByText('ダーツ種別', { exact: true })).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Soft Darts' })).toHaveAttribute('aria-pressed', 'false');
    await expect(dialog.getByRole('button', { name: 'Steel Darts' })).toHaveAttribute('aria-pressed', 'false');
    await expect(dialog.getByText(/^未設定/)).toBeVisible();

    await dialog.getByRole('button', { name: 'Steel Darts' }).click();
    await expect(dialog.getByRole('button', { name: 'Steel Darts' })).toHaveAttribute('aria-pressed', 'true');
    await expect(dialog.getByText('戦力評価 PPR 70% / Rating 30%')).toBeVisible();
    await dialog.getByRole('button', { name: '保存' }).click();
    await expect(page.locator('.list-row').first().locator('.discipline-badge')).toHaveText('STEEL');
  });

  test('the 501 kind chip reads "01" while game names keep "501"', async ({ page }) => {
    await openFresh(page);
    await tab(page, 'フォーマット').click();
    await page.locator('.list-row').first().click();
    const dialog = page.getByRole('dialog', { name: 'フォーマットを編集' });
    const firstGame = dialog.locator('.format-game').first();
    await expect(firstGame.getByRole('button', { name: '01', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await expect(firstGame.getByRole('button', { name: '501', exact: true })).toHaveCount(0);
    await expect(firstGame.getByRole('textbox')).toHaveValue('Singles 501');
  });
});

test.describe('strength basis', () => {
  test('setup and result say how Rating and PPR are weighed', async ({ page }) => {
    await openFresh(page);
    for (const [name, ppr] of [
      ['青木', '78'],
      ['馬場', '74'],
      ['千葉', '58'],
    ] as const) {
      await openPlayer(page, name);
      await page.getByLabel('PPR Average (任意)').fill(ppr);
      await page.getByRole('button', { name: '保存' }).click();
    }
    await tab(page, 'フォーマット').click();
    await page.locator('.list-row').first().click();
    await page.getByRole('button', { name: 'Steel Darts' }).click();
    await page.getByRole('button', { name: '保存' }).click();

    await tab(page, 'ホーム').click();
    await page.getByRole('button', { name: '新しいオーダーを作る' }).click();
    const setupBasis = page.getByTestId('setup-strength-basis');
    await expect(setupBasis).toContainText('STEEL');
    await expect(setupBasis).toContainText('戦力評価 PPR 70% / Rating 30%');

    await page.getByRole('button', { name: 'オーダーを生成' }).click();
    await expect(page.getByRole('heading', { name: 'オーダー結果' })).toBeVisible();
    const resultBasis = page.getByTestId('result-strength-basis');
    await expect(resultBasis).toContainText('STEEL');
    await expect(resultBasis).toContainText('戦力評価 PPR 70% / Rating 30%');

    // The same blend is quoted in the reasons.
    await page.getByText('詳細分析', { exact: true }).click();
    await expect(page.locator('.reason-list').first()).toContainText('PPR 70% / Rating 30%');
  });
});

// ---------------------------------------------------------------------------
// Candidates
// ---------------------------------------------------------------------------

test.describe('candidate switching', () => {
  test('each candidate tab shows its own line-up in the game cards', async ({ page }) => {
    await openFresh(page);
    await generate(page);
    const tabs = page.locator('.candidate-tab');
    const count = await tabs.count();
    expect(count).toBe(3);
    await expect(tabs.nth(0)).toContainText('バランス');
    await expect(tabs.nth(1)).toContainText('勝利優先');
    await expect(tabs.nth(2)).toContainText('公平性優先');

    const seen: string[] = [];
    for (let index = 0; index < count; index += 1) {
      await tabs.nth(index).click();
      await expect(tabs.nth(index)).toHaveAttribute('aria-pressed', 'true');
      const values = await page
        .locator('.slot select')
        .evaluateAll((nodes) => nodes.map((node) => (node as HTMLSelectElement).value));
      seen.push(values.join(','));
    }
    // Three different candidates, three different sets of cards — not just aria-pressed.
    expect(new Set(seen).size).toBe(count);

    // Going back restores the first line-up exactly.
    await tabs.nth(0).click();
    const again = await page
      .locator('.slot select')
      .evaluateAll((nodes) => nodes.map((node) => (node as HTMLSelectElement).value));
    expect(again.join(',')).toBe(seen[0]);
  });
});

// ---------------------------------------------------------------------------
// Light Match Sheet
// ---------------------------------------------------------------------------

test.describe('light theme', () => {
  for (const width of [320, 375, 390, 412, 768, 1280]) {
    test(`paper background, white cards and no sideways scroll at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: width >= 1000 ? 900 : 760 });
      await openFresh(page);
      const colours = await page.evaluate(() => ({
        body: getComputedStyle(document.body).backgroundColor,
        card: getComputedStyle(document.querySelector('.card') ?? document.body).backgroundColor,
        text: getComputedStyle(document.body).color,
        scheme: getComputedStyle(document.documentElement).colorScheme,
      }));
      expect(colours.body).toBe('rgb(244, 243, 239)');
      expect(colours.card).toBe('rgb(255, 255, 255)');
      expect(colours.text).toBe('rgb(23, 32, 38)');
      expect(colours.scheme).toBe('light');

      for (const name of ['ホーム', 'メンバー', 'フォーマット', '履歴']) {
        await tab(page, name).click();
        const overflow = await page.evaluate(
          () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
        );
        expect(overflow, name).toBeLessThanOrEqual(1);
      }
      await generate(page);
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow).toBeLessThanOrEqual(1);
      // Selection reads as solid accent + border + check, not a glow.
      const selected = page.locator('.candidate-tab[aria-pressed="true"]');
      await expect(selected.locator('.c-current')).toBeVisible();
      const style = await selected.evaluate((node) => getComputedStyle(node));
      expect(style.boxShadow).toBe('none');
      expect(style.borderTopColor).toBe('rgb(8, 127, 140)');
    });
  }

  test('the PWA chrome is light too', async ({ page, request }) => {
    await page.goto('/');
    await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute('content', '#ffffff');
    const manifestHref = await page.locator('link[rel="manifest"]').getAttribute('href');
    expect(manifestHref).toBeTruthy();
    const manifest = await (await request.get(new URL(manifestHref!, page.url()).toString())).json();
    expect(manifest.theme_color).toBe('#ffffff');
    expect(manifest.background_color).toBe('#f4f3ef');
  });
});
