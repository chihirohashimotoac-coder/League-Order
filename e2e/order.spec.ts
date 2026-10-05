import { expect, test, type Page } from '@playwright/test';

/**
 * End-to-end coverage of the captain's actual workflow in a real browser.
 *
 * The app seeds a usable example on first run (one team, the five players from spec §38
 * and a six-game Singles/Doubles/Trios format), so these tests start from that and
 * exercise generation, locking, manual editing, undo, partial re-optimisation, sharing,
 * persistence across a reload and offline operation.
 */

/**
 * Opens the app on a clean slate.
 *
 * Playwright gives each test its own browser context, so IndexedDB is already empty and
 * the app seeds its first-run example. Nothing must clear storage on every navigation —
 * that would also wipe it on the reloads these tests rely on.
 */
async function openFresh(page: Page): Promise<void> {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Darts Order' })).toBeVisible();
}

/** Taps a bottom-tab-bar entry. Scoped so the name cannot collide with page content. */
function tab(page: Page, name: string) {
  return page.locator('.tab-bar').getByRole('button', { name, exact: true });
}

async function generate(page: Page): Promise<void> {
  await page.getByRole('button', { name: '新規オーダーを作成' }).click();
  await expect(page.getByRole('heading', { name: 'オーダー設定' })).toBeVisible();
  await page.getByRole('button', { name: 'オーダーを生成' }).click();
  await expect(page.getByRole('heading', { name: 'オーダー結果' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'オーダー', exact: true })).toBeVisible();
}

test.describe('order generation workflow', () => {
  test('seeds an example team and format on first run', async ({ page }) => {
    await openFresh(page);
    await expect(page.getByRole('strong').filter({ hasText: 'マイチーム' })).toBeVisible();
    await expect(page.getByText('標準6ゲーム (Singles/Doubles/Trios)')).toBeVisible();

    // The seeded roster from spec §38 is listed on the members screen.
    await tab(page, 'メンバー').click();
    for (const name of ['青木', '馬場', '千葉', '土井', '遠藤']) {
      await expect(page.locator('.list-row').filter({ hasText: name })).toHaveCount(1);
    }
  });

  test('generates an order where all five players get two appearances', async ({ page }) => {
    await openFresh(page);
    await generate(page);

    // 6 games, 10 slots.
    const selects = page.locator('.slot select');
    await expect(selects).toHaveCount(10);

    // Nobody is left empty, and the tally shows 2 for everyone.
    const tally = page.locator('table.data').first();
    for (const name of ['青木', '馬場', '千葉', '土井', '遠藤']) {
      await expect(tally.getByRole('row').filter({ hasText: name })).toContainText('2');
    }
    await expect(page.getByText('最大出場差', { exact: true })).toBeVisible();
    // 10 slots over 5 players divides evenly, so the spread must be 0.
    await expect(
      page.locator('.metric').filter({ hasText: '最大出場差' }).locator('.v'),
    ).toHaveText('0');
  });

  test('shows the reasons for each game', async ({ page }) => {
    await openFresh(page);
    await generate(page);

    await expect(page.getByRole('heading', { name: '生成理由' })).toBeVisible();
    const first = page.locator('details.reason-game').first();
    await first.locator('summary').click();
    await expect(first).toContainText('Rating');
    await expect(first).toContainText('Hard制約');
  });

  test('manual edit re-evaluates live and undo restores it', async ({ page }) => {
    await openFresh(page);
    await generate(page);

    const slot = page.locator('.slot select').first();
    const original = await slot.inputValue();
    const options = await slot.locator('option').evaluateAll((nodes) =>
      nodes.map((node) => (node as HTMLOptionElement).value).filter((value) => value !== ''),
    );
    const replacement = options.find((value) => value !== original)!;

    await slot.selectOption(replacement);
    await expect(page.getByText('手動編集中です。数値は編集内容で再計算されています。')).toBeVisible();
    await expect(slot).toHaveValue(replacement);

    await page.getByRole('button', { name: '元に戻す' }).click();
    await expect(slot).toHaveValue(original);
    await expect(page.getByText('手動編集中です。数値は編集内容で再計算されています。')).toBeHidden();
  });

  test('empty slot is reported as a hard-constraint violation', async ({ page }) => {
    await openFresh(page);
    await generate(page);
    await page.locator('.slot select').first().selectOption('');
    await expect(page.getByText('Hard制約に違反しています')).toBeVisible();
  });

  test('locking a slot disables it and survives re-optimisation', async ({ page }) => {
    await openFresh(page);
    await generate(page);

    const lockButtons = page.locator('.lock-toggle');
    const firstSlot = page.locator('.slot select').first();
    const pinned = await firstSlot.inputValue();

    await lockButtons.first().click();
    await expect(firstSlot).toBeDisabled();
    await expect(lockButtons.first()).toHaveAttribute('aria-pressed', 'true');

    await page.getByRole('button', { name: 'ロックを保ったまま再最適化' }).click();
    await expect(page.locator('.slot select').first()).toHaveValue(pinned);
    await expect(page.locator('.slot select').first()).toBeDisabled();
  });

  test('re-optimises a single game while keeping the others (spec §17)', async ({ page }) => {
    await openFresh(page);
    await generate(page);

    const before = await page.locator('.slot select').evaluateAll((nodes) =>
      nodes.map((node) => (node as HTMLSelectElement).value),
    );

    // Re-run only game 5 (Trios).
    await page.getByRole('button', { name: /Game 5 .* だけ再計算/ }).click();
    await expect(page.getByRole('heading', { name: 'オーダー', exact: true })).toBeVisible();

    const after = await page.locator('.slot select').evaluateAll((nodes) =>
      nodes.map((node) => (node as HTMLSelectElement).value),
    );
    // Games 1-4 and 6 occupy slots 0..5 and 9 of the flat slot list; the Trios game
    // occupies slots 6..8. Everything outside that range must be untouched.
    expect(after.slice(0, 6)).toEqual(before.slice(0, 6));
    expect(after[9]).toEqual(before[9]);
  });

  test('explains why an impossible configuration cannot be generated (spec §31)', async ({ page }) => {
    await openFresh(page);
    await page.getByRole('button', { name: '新規オーダーを作成' }).click();

    // Leave only two players available: Trios then becomes impossible.
    await page.getByRole('button', { name: '解除' }).click();
    await page.getByLabel('青木 を参加者に含める').check();
    await page.getByLabel('馬場 を参加者に含める').check();

    await page.getByRole('button', { name: 'オーダーを生成' }).click();
    await expect(page.getByText('オーダーを生成できませんでした')).toBeVisible();
    await expect(page.getByText(/3 名必要/)).toBeVisible();
    await expect(page.getByText('解決の候補').first()).toBeVisible();
  });

  test('restricts a late arrival to the second half', async ({ page }) => {
    await openFresh(page);
    await page.getByRole('button', { name: '新規オーダーを作成' }).click();

    // Open 遠藤's conditions and limit them to the second half.
    const row = page.locator('li').filter({ hasText: '遠藤' }).first();
    await row.getByRole('button', { name: '条件' }).click();
    await page.getByRole('button', { name: '後半のみ' }).click();
    await page.getByRole('button', { name: '閉じる' }).click();
    await expect(page.getByText(/範囲 G4/)).toBeVisible();

    await page.getByRole('button', { name: 'オーダーを生成' }).click();
    await expect(page.getByRole('heading', { name: 'オーダー結果' })).toBeVisible();

    // Games 1-3 are the first three order rows; 遠藤 must not appear in them.
    const firstThree = await page
      .locator('.order-game')
      .evaluateAll((nodes) =>
        nodes.slice(0, 3).flatMap((node) =>
          [...node.querySelectorAll('select')].map((select) => {
            const element = select as HTMLSelectElement;
            return element.options[element.selectedIndex]?.textContent ?? '';
          }),
        ),
      );
    expect(firstThree.join(' ')).not.toContain('遠藤');
  });

  // Smoke test for the entry point only; e2e/share.spec.ts covers the share screen itself.
  test('opens the share screen with an image and copyable text', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await openFresh(page);
    await generate(page);

    await page.getByRole('button', { name: '共有', exact: true }).click();
    await expect(page.getByRole('dialog', { name: '共有' })).toBeVisible();
    await expect(page.locator('img.share-preview').first()).toBeVisible();

    await page.getByRole('button', { name: 'テキストをコピー' }).click();
    const clipboard = await page.evaluate(() => navigator.clipboard.readText());
    for (const name of ['青木', '馬場', '千葉', '土井', '遠藤']) {
      expect(clipboard).toContain(name);
    }
  });
});

test.describe('persistence and offline', () => {
  test('keeps a new player across a reload (IndexedDB)', async ({ page }) => {
    await openFresh(page);
    await tab(page, 'メンバー').click();
    await page.getByRole('button', { name: '＋ メンバーを追加' }).click();

    await page.getByLabel('名前 (必須)').fill('新人テスト');
    // Leave Rating empty on purpose: it must persist as Unknown, not 0.
    await page.getByRole('button', { name: '保存', exact: true }).click();

    const row = page.locator('.list-row').filter({ hasText: '新人テスト' });
    await expect(row).toHaveCount(1);
    await expect(row).toContainText('Rating 未入力');

    await page.reload();
    await tab(page, 'メンバー').click();
    const reloaded = page.locator('.list-row').filter({ hasText: '新人テスト' });
    await expect(reloaded).toHaveCount(1);
    await expect(reloaded).toContainText('Rating 未入力');
    await expect(reloaded).not.toContainText('Rating 0');
  });

  test('saves an order to history and reopens it', async ({ page }) => {
    await openFresh(page);
    await generate(page);
    // Saving without finalizing keeps the order a draft; finalizing is covered in
    // e2e/lifecycle.spec.ts.
    await page.getByRole('button', { name: '下書きを保存' }).click();

    await tab(page, '履歴').click();
    await expect(page.getByRole('heading', { name: '履歴', level: 1 })).toBeVisible();
    const entry = page.locator('.list-row').first();
    await expect(entry).toBeVisible();
    await entry.click();
    await page.getByRole('button', { name: 'このオーダーを開いて編集' }).click();
    await expect(page.getByRole('heading', { name: 'オーダー結果' })).toBeVisible();
    await expect(page.locator('.slot select')).toHaveCount(10);
  });

  test('exports a JSON backup', async ({ page }) => {
    await openFresh(page);
    await tab(page, 'ホーム').click();
    await page.getByRole('button', { name: /設定 \/ バックアップ/ }).click();

    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: 'JSON エクスポート' }).click();
    const file = await download;
    expect(file.suggestedFilename()).toMatch(/^darts-order-backup-\d{4}-\d{2}-\d{2}\.json$/);
  });

  test('generates an order with the network offline (PWA)', async ({ page, context }) => {
    await openFresh(page);

    // Wait until the service worker is active and has pre-cached the bundle. The first
    // page load is not yet *controlled* by it (registration uses `prompt` mode, so no
    // clients.claim), but the next navigation is served by the active worker.
    await page.waitForFunction(
      async () => {
        const registration = await navigator.serviceWorker?.ready;
        return registration?.active?.state === 'activated';
      },
      undefined,
      { timeout: 60_000 },
    );

    await context.setOffline(true);
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Darts Order' })).toBeVisible();

    // The whole workflow must still run with no network at all.
    await generate(page);
    await expect(page.locator('.slot select')).toHaveCount(10);
    await expect(
      page.locator('.metric').filter({ hasText: '最大出場差' }).locator('.v'),
    ).toHaveText('0');

    await context.setOffline(false);
  });
});

test.describe('mobile layout', () => {
  test('has no horizontal page scroll on a phone viewport', async ({ page }) => {
    await openFresh(page);
    await generate(page);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(1);
  });

  test('primary controls are large enough to tap', async ({ page }) => {
    await openFresh(page);
    await generate(page);
    const sizes = await page.locator('.action-bar button, .tab-bar button').evaluateAll((nodes) =>
      nodes.map((node) => node.getBoundingClientRect().height),
    );
    expect(sizes.length).toBeGreaterThan(0);
    for (const height of sizes) expect(height).toBeGreaterThanOrEqual(40);
  });
});
