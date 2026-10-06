import { expect, test, type Page } from '@playwright/test';

/**
 * Final acceptance coverage: the operational guarantees a captain depends on at a venue.
 *
 * Everything here is driven through the real UI against the production build, because
 * these are claims about the *app*, not about any one function:
 *
 * - delete safety for an order that is already reflected in the season standings
 * - the full league-day flow, from team setup to withdrawing a commit
 * - double-tap safety on the actions that write (finalize, commit, delete)
 * - player names are data, never markup
 * - layout holds at the phone widths the app is actually used on
 */

async function openFresh(page: Page): Promise<void> {
  await page.goto('/');
  // First run offers "own team" or "sample"; these tests work on the labelled sample.
  await page.getByRole('button', { name: 'サンプルで試す' }).click();
  await expect(page.getByRole('heading', { name: 'サンプルチーム', level: 1 })).toBeVisible();
}

function tab(page: Page, name: string) {
  return page.locator('.tab-bar').getByRole('button', { name, exact: true });
}

async function generate(page: Page): Promise<void> {
  // "New order" lives on the home screen; these tests reach it from wherever they are.
  await goTab(page, 'ホーム');
  await page.getByRole('button', { name: '新しいオーダーを作る' }).click();
  await expect(page.getByRole('heading', { name: 'オーダー設定' })).toBeVisible();
  await page.getByRole('button', { name: 'オーダーを生成' }).click();
  await expect(page.getByRole('heading', { name: 'オーダー結果' })).toBeVisible();
}

/**
 * Finalizes, and waits until the app says it is done.
 *
 * The version is persisted asynchronously, so moving straight on leaves the next action
 * racing a finalization that is still settling — a reload in that window can tear the
 * write down and the order comes back a version short.
 */
async function finalize(page: Page): Promise<void> {
  const before = await versionBadge(page);
  await page.getByRole('button', { name: /オーダーを確定|再確定/ }).click();
  await expect(stateBanner(page)).toContainText('確定済み');
  await expect
    .poll(async () => versionBadge(page), {
      message: `the finalized version should advance past v${before}`,
    })
    .toBeGreaterThan(before);
}

/** The version number in the state banner, or 0 while the order is still a draft. */
async function versionBadge(page: Page): Promise<number> {
  const banner = page.locator('[aria-label="オーダーの状態"] .state-title');
  if ((await banner.count()) === 0) return 0;
  const match = /v(\d+)/.exec(await banner.innerText());
  return match ? Number(match[1]) : 0;
}

async function commitSeason(page: Page): Promise<void> {
  await page.getByRole('button', { name: /シーズン累計へ反映|シーズン累計を再反映/ }).click();
  await page.getByRole('button', { name: '反映する' }).click();
  await expect(page.getByText(/シーズン累計へ反映しました|既に反映済み/)).toBeVisible();
}

const stateBanner = (page: Page) => page.getByRole('region', { name: 'オーダーの状態' });

/** Taps a tab, after dismissing any open sheet whose backdrop would swallow the tap. */
async function goTab(page: Page, name: string): Promise<void> {
  await closeSheets(page);
  await tab(page, name).click();
}

/** Dismisses any open sheet, whose backdrop would otherwise swallow a tab tap. */
async function closeSheets(page: Page): Promise<void> {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    if ((await page.locator('.sheet-backdrop').count()) === 0) return;
    await page.keyboard.press('Escape');
    await page.waitForTimeout(100);
  }
}

/** Every player's season total, read off the members list. */
async function seasonTotals(page: Page): Promise<Record<string, number>> {
  await goTab(page, 'メンバー');
  const rows = await page.locator('.list-row').evaluateAll((nodes) =>
    nodes.map((node) => ({
      name: node.querySelector('.title')?.textContent?.trim() ?? '',
      meta: node.querySelector('.meta')?.textContent ?? '',
    })),
  );
  const totals: Record<string, number> = {};
  for (const row of rows) {
    const match = /シーズン (\d+) 回/.exec(row.meta);
    totals[row.name.replace(/\s+/g, '')] = match ? Number(match[1]) : 0;
  }
  return totals;
}

/** Opens the first history entry's detail sheet. */
async function openHistoryDetail(page: Page): Promise<void> {
  await goTab(page, '履歴');
  await page.locator('.list-row').first().click();
}

/** The refusal sheet shown when a committed order is targeted for deletion. */
const blockedDialog = (page: Page) => page.getByRole('dialog', { name: '削除できません' });

/** SETTINGS and PAIRS are reached from the home screen, not from the tab bar. */
async function openFromHome(page: Page, label: string | RegExp): Promise<void> {
  await goTab(page, 'ホーム');
  await page.locator('.list-row').filter({ hasText: label }).first().click();
}

// ---------------------------------------------------------------------------
// §9–§12 Delete safety
// ---------------------------------------------------------------------------

test.describe('delete safety for a season-committed order (追加要件 §9-§12)', () => {
  // Case A
  test('an order that was never committed can be deleted', async ({ page }) => {
    await openFresh(page);
    await generate(page);
    await finalize(page);

    await openHistoryDetail(page);
    await page.getByRole('button', { name: '削除', exact: true }).click();
    await page.getByRole('button', { name: '削除する' }).click();
    await expect(page.getByText('削除しました')).toBeVisible();
    await expect(page.getByText('保存されたオーダーがありません。')).toBeVisible();
  });

  // Cases B, D, E
  test('a committed order cannot be deleted, and nothing changes when it is refused', async ({ page }) => {
    await openFresh(page);
    await generate(page);
    await finalize(page);
    await commitSeason(page);

    const totalsBefore = await seasonTotals(page);
    expect(Object.values(totalsBefore).every((value) => value === 2)).toBe(true);

    await openHistoryDetail(page);
    await page.getByRole('button', { name: '削除', exact: true }).click();

    // Case B: refused, with the reason and the remedy.
    await expect(page.getByTestId('delete-blocked')).toContainText('シーズン成績へ反映されています');
    await expect(page.getByTestId('delete-blocked')).toContainText('シーズン反映を取り消す');
    // There is no way to force it through from here.
    await expect(page.getByRole('button', { name: '削除する' })).toHaveCount(0);
    // The sheet's ✕ and its footer button must not share an accessible name (§25).
    await expect(blockedDialog(page).getByRole('button', { name: '閉じる' })).toHaveCount(1);
    await blockedDialog(page).getByRole('button', { name: 'キャンセル', exact: true }).click();

    // Case E: the order is still there, still flagged as reflected.
    await goTab(page, '履歴');
    await expect(page.locator('.list-row').first()).toContainText('シーズン反映済み');

    // Case D: the season totals did not move.
    expect(await seasonTotals(page)).toEqual(totalsBefore);
  });

  // Case C
  test('withdrawing the reflection, then deleting, is the explicit two-step path', async ({ page }) => {
    await openFresh(page);
    const totalsAtStart = await seasonTotals(page);
    await goTab(page, 'オーダー');

    await generate(page);
    await finalize(page);
    await commitSeason(page);
    expect(await seasonTotals(page)).not.toEqual(totalsAtStart);

    await openHistoryDetail(page);
    await page.getByRole('button', { name: '削除', exact: true }).click();
    await blockedDialog(page).getByRole('button', { name: 'シーズン反映を取り消す' }).click();

    // Step 1: withdrawing is its own confirmed action, and it does not delete anything.
    await page.getByRole('button', { name: '取り消す', exact: true }).click();
    await expect(page.getByText(/シーズン反映を取り消しました/)).toBeVisible();
    expect(await seasonTotals(page)).toEqual(totalsAtStart);

    await goTab(page, '履歴');
    await expect(page.locator('.list-row').first()).toContainText('シーズン未反映');

    // Step 2: now — and only now — the delete goes through.
    await page.locator('.list-row').first().click();
    await page.getByRole('button', { name: '削除', exact: true }).click();
    await page.getByRole('button', { name: '削除する' }).click();
    await expect(page.getByText('削除しました')).toBeVisible();
    await expect(page.getByText('保存されたオーダーがありません。')).toBeVisible();
    // The totals stay where the withdrawal left them: deleting moved nothing.
    expect(await seasonTotals(page)).toEqual(totalsAtStart);
  });

  // Case F
  test('the refusal still applies after a reload', async ({ page }) => {
    await openFresh(page);
    await generate(page);
    await finalize(page);
    await commitSeason(page);

    await page.reload();
    await openHistoryDetail(page);
    await page.getByRole('button', { name: '削除', exact: true }).click();
    await expect(page.getByTestId('delete-blocked')).toBeVisible();
    await expect(page.getByRole('button', { name: '削除する' })).toHaveCount(0);
  });

  // Case G
  test('the refusal survives a JSON export and import', async ({ page }) => {
    await openFresh(page);
    await generate(page);
    await finalize(page);
    await commitSeason(page);
    const totals = await seasonTotals(page);

    // Export the live database.
    await openFromHome(page, '設定 / バックアップ');
    const downloadPromise = page.waitForEvent('download');
    await page.getByRole('button', { name: 'JSON エクスポート' }).click();
    const path = await (await downloadPromise).path();
    expect(path).toBeTruthy();

    // Re-import it over itself, then check the ledger still locks the order.
    await page.setInputFiles('input[type="file"]', path!);
    await page.getByRole('button', { name: '置き換える' }).click();
    await expect(page.getByText('インポートしました')).toBeVisible();

    expect(await seasonTotals(page)).toEqual(totals);
    await openHistoryDetail(page);
    await page.getByRole('button', { name: '削除', exact: true }).click();
    await expect(page.getByTestId('delete-blocked')).toBeVisible();
    await expect(page.getByRole('button', { name: '削除する' })).toHaveCount(0);
  });
});

// ---------------------------------------------------------------------------
// §23 Concurrency / double action
// ---------------------------------------------------------------------------

test.describe('double actions do not write twice (追加要件 §23)', () => {
  test('double-tapping finalize produces one version, not two', async ({ page }) => {
    await openFresh(page);
    await generate(page);

    const button = page.getByRole('button', { name: /オーダーを確定/ });
    await button.click({ clickCount: 2, delay: 0 });

    await expect(stateBanner(page)).toContainText('v1');
    await goTab(page, '履歴');
    // One order, one version — not two orders and not v2.
    await expect(page.locator('.list-row')).toHaveCount(1);
    await page.locator('.list-row').first().click();
    await expect(page.getByText('1 版')).toBeVisible();
  });

  test('double-tapping season commit does not double count', async ({ page }) => {
    await openFresh(page);
    await generate(page);
    await finalize(page);

    await page.getByRole('button', { name: 'シーズン累計へ反映' }).click();
    await page.getByRole('button', { name: '反映する' }).click({ clickCount: 2, delay: 0 });
    await expect(page.getByText(/シーズン累計へ反映しました|既に反映済み/).first()).toBeVisible();

    const totals = await seasonTotals(page);
    // Ten slots over five players is two each; a double commit would read four.
    expect(Object.values(totals).every((value) => value === 2)).toBe(true);
  });

  test('double-tapping generate leaves one usable order', async ({ page }) => {
    await openFresh(page);
    await page.getByRole('button', { name: '新しいオーダーを作る' }).click();
    const generateButton = page.getByRole('button', { name: 'オーダーを生成' });
    await generateButton.click({ clickCount: 2, delay: 0 });

    await expect(page.getByRole('heading', { name: 'オーダー結果' })).toBeVisible();
    await expect(page.locator('.order-game')).toHaveCount(6);
    await expect(page.getByText('絶対条件に違反しています')).toHaveCount(0);
  });
});

// ---------------------------------------------------------------------------
// §27 Security: player names are data, not markup
// ---------------------------------------------------------------------------

test.describe('player names are never executed (追加要件 §27)', () => {
  test('a script tag in a player name is rendered as text everywhere it appears', async ({ page }) => {
    const injected = '<script>window.__xss = 1</script>';

    await openFresh(page);
    await goTab(page, 'メンバー');
    await page.locator('.list-row').first().click();
    await page.getByLabel('名前 (必須)').fill(injected);
    await page.getByRole('button', { name: '保存', exact: true }).click();

    // Nothing ran, and no element was injected.
    expect(await page.evaluate(() => (window as unknown as { __xss?: number }).__xss)).toBeUndefined();
    expect(await page.locator('script:not([src])').evaluateAll((nodes) =>
      nodes.some((node) => (node.textContent ?? '').includes('window.__xss')),
    )).toBe(false);

    // And it still reads as the literal name the captain typed.
    await expect(page.locator('.list-row').first()).toContainText(injected);

    // Through generation, the order screen and the shared text.
    await goTab(page, 'オーダー');
    await generate(page);
    expect(await page.evaluate(() => (window as unknown as { __xss?: number }).__xss)).toBeUndefined();

    await page.getByRole('button', { name: '共有', exact: true }).click();
    await page.getByRole('tab', { name: 'テキスト' }).click();
    const text = await page.getByLabel('共有テキスト').inputValue();
    expect(text).toContain(injected);
    expect(await page.evaluate(() => (window as unknown as { __xss?: number }).__xss)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// §18 Mobile layout at the widths the app is used on
// ---------------------------------------------------------------------------

const PHONE_WIDTHS = [320, 375, 390, 412];

test.describe('layout holds at phone widths (追加要件 §18)', () => {
  for (const width of PHONE_WIDTHS) {
    test(`no sideways scroll and no buried controls at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 740 });
      await openFresh(page);
      await generate(page);

      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow).toBeLessThanOrEqual(1);

      // The action bar must not sit on top of the tab bar, and both must be reachable.
      const bars = await page.evaluate(() => {
        const action = document.querySelector('.action-bar')?.getBoundingClientRect();
        const tabs = document.querySelector('.tab-bar')?.getBoundingClientRect();
        return action && tabs ? { actionBottom: action.bottom, tabsTop: tabs.top } : null;
      });
      expect(bars).not.toBeNull();
      expect(bars!.actionBottom).toBeLessThanOrEqual(bars!.tabsTop + 1);

      // Game names stay distinguishable: "Doubles 501" vs "Doubles Cricket".
      const names = await page.locator('.order-game-head .name').allInnerTexts();
      expect(names).toContain('Doubles 501');
      expect(names).toContain('Doubles Cricket');

      // Every tap target in the fixed bars is big enough.
      const heights = await page
        .locator('.action-bar button, .tab-bar button')
        .evaluateAll((nodes) => nodes.map((node) => node.getBoundingClientRect().height));
      for (const height of heights) expect(height).toBeGreaterThanOrEqual(44);

      // No tab label and no primary action label is cut off with an ellipsis.
      const clipped = await page
        .locator('.tab-bar .tab-label, .action-bar .btn-label')
        .evaluateAll((nodes) =>
          nodes.filter((node) => node.scrollWidth > node.clientWidth + 1).map((node) => node.textContent),
        );
      expect(clipped).toEqual([]);

      // Every control on the result screen is at least 44px tall (§56).
      const small = await page
        .locator('main button:visible, main select:visible')
        .evaluateAll((nodes) =>
          nodes
            .map((node) => {
              // A slot's <select> is laid over its card, so the card is the target.
              const target = node.closest('.slot-field') ?? node;
              const box = target.getBoundingClientRect();
              return { text: (node.textContent ?? '').trim().slice(0, 20), h: box.height, w: box.width };
            })
            .filter((box) => box.h < 44 || box.w < 44),
        );
      expect(small).toEqual([]);
    });
  }

  test('no screen scrolls sideways at 320px', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 640 });
    await openFresh(page);
    const sideways = () =>
      page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

    for (const name of ['ホーム', 'メンバー', 'フォーマット', 'オーダー', '履歴']) {
      await goTab(page, name);
      expect(await sideways(), name).toBeLessThanOrEqual(1);
    }
    for (const label of ['ペア相性', '設定 / バックアップ']) {
      await openFromHome(page, label);
      expect(await sideways(), label).toBeLessThanOrEqual(1);
    }
  });

  test('a dialog stays inside the viewport at 320px', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 640 });
    await openFresh(page);
    await generate(page);
    await finalize(page);
    await page.getByRole('button', { name: 'シーズン累計へ反映' }).click();

    const dialog = page.getByRole('dialog', { name: 'シーズン累計へ反映' });
    await expect(dialog).toBeVisible();
    const box = await dialog.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(-1);
    expect(box!.x + box!.width).toBeLessThanOrEqual(321);
  });
});

// ---------------------------------------------------------------------------
// §19–§21 The full league-day scenario
// ---------------------------------------------------------------------------

test.describe('realistic league flow (追加要件 §19-§21)', () => {
  test.setTimeout(180_000);

  test('team setup through to withdrawing a season commit', async ({ page }) => {
    await openFresh(page);

    // 1-4. The seed provides the team, the five players (Rt 14/14/11/8/4), the six-game
    // Singles/Doubles/Trios format and the per-player aptitudes.
    await goTab(page, 'メンバー');
    await expect(page.locator('.list-row')).toHaveCount(5);
    await expect(page.locator('.list-row').filter({ hasText: '青木' })).toBeVisible();

    // 5. Pair settings are reachable and list the roster.
    await openFromHome(page, 'ペア相性');
    await expect(page.getByRole('heading', { name: 'ペア相性' })).toBeVisible();

    // 6-7. Today's participants, with 遠藤 barred from the Trios game.
    await goTab(page, 'ホーム');
    await page.getByRole('button', { name: '新しいオーダーを作る' }).click();
    await expect(page.getByRole('heading', { name: 'オーダー設定' })).toBeVisible();

    await page
      .locator('li')
      .filter({ has: page.getByLabel('遠藤 を参加者に含める') })
      .getByRole('button', { name: '条件' })
      .click();
    const detail = page.getByRole('dialog', { name: /遠藤/ });
    await expect(detail).toBeVisible();
    await detail.getByRole('button', { name: 'Trios', exact: true }).click();
    await page.getByRole('button', { name: '閉じる' }).click();
    await expect(
      page.locator('li').filter({ has: page.getByLabel('遠藤 を参加者に含める') }).locator('.p-meta'),
    ).toContainText('Trios');

    // 8. Generate.
    await page.getByRole('button', { name: 'オーダーを生成' }).click();
    await expect(page.getByRole('heading', { name: 'オーダー結果' })).toBeVisible();
    // The hard exclusion held: 遠藤 is not in the Trios game.
    const trios = page.locator('.order-game').filter({ hasText: 'Trios' });
    await expect(trios).toHaveCount(1);
    for (const value of await trios.locator('select').evaluateAll((nodes) =>
      nodes.map((node) => {
        const select = node as HTMLSelectElement;
        return select.options[select.selectedIndex]?.textContent ?? '';
      }),
    )) {
      expect(value).not.toContain('遠藤');
    }

    // 9. Compare the alternatives.
    const candidateTabs = page.locator('.candidate-tab');
    expect(await candidateTabs.count()).toBeGreaterThan(1);
    await candidateTabs.nth(1).click();
    await candidateTabs.nth(0).click();

    // 10-11. One manual change, then pin it.
    const slot = page.locator('.slot select').first();
    const current = await slot.inputValue();
    const options = await slot.locator('option').evaluateAll((nodes) =>
      nodes.map((node) => (node as HTMLOptionElement).value).filter((value) => value !== ''),
    );
    const replacement = options.find((value) => value !== current)!;
    await slot.selectOption(replacement);
    await expect(page.getByText('手動編集中です。', { exact: false })).toBeVisible();
    await page.locator('.slot .lock-toggle').first().click();
    await expect(page.locator('.slot.locked').first()).toBeVisible();

    // 12. Re-optimise one game while the rest stays put.
    await page.locator('.order-game').nth(2).getByRole('button', { name: /だけ再計算/ }).click();
    await expect(page.getByRole('heading', { name: 'オーダー結果' })).toBeVisible();
    // The pinned slot survived.
    await expect(page.locator('.slot select').first()).toHaveValue(replacement);

    // 13-14. Undo and redo.
    await page.getByRole('button', { name: '元に戻す' }).click();
    await page.getByRole('button', { name: 'やり直す' }).click();

    // 15. Finalize v1.
    await finalize(page);
    await expect(stateBanner(page)).toContainText('確定済み');
    await expect(stateBanner(page)).toContainText('v1');

    // 16-17. The shared image and the LINE text.
    await page.getByRole('button', { name: '共有', exact: true }).click();
    await expect(page.getByRole('img', { name: /オーダー画像/ })).toBeVisible();
    await page.getByRole('tab', { name: 'テキスト' }).click();
    const v1Text = await page.getByLabel('共有テキスト').inputValue();
    expect(v1Text).toContain('v1');
    expect(v1Text).toContain('青木');
    await page.getByRole('button', { name: '閉じる' }).click();

    // 18. Commit to the season.
    await commitSeason(page);
    const afterV1 = await seasonTotals(page);
    expect(Object.values(afterV1).reduce((a, b) => a + b, 0)).toBe(10);

    // 19-20. A reload keeps v1 exactly as it was.
    await page.reload();
    await goTab(page, '履歴');
    await expect(page.locator('.list-row').first()).toContainText('v1');
    await expect(page.locator('.list-row').first()).toContainText('シーズン反映済み');
    await page.locator('.list-row').first().click();
    await page.getByRole('button', { name: 'このオーダーを開いて編集' }).click();
    await expect(stateBanner(page)).toContainText('確定済み');
    await expect(stateBanner(page)).toContainText('v1');

    // 21-22. One player drops out; re-generate around the gap from SETUP. The setup
    // screen knows it is editing v1 and restored the conditions v1 was generated with.
    await page.getByRole('button', { name: '戻る' }).click();
    await expect(page.getByRole('heading', { name: 'オーダー設定' })).toBeVisible();
    await expect(page.getByTestId('editing-banner')).toContainText('ORDER v1 を編集中');
    await expect(page.getByLabel('土井 を参加者に含める')).toBeChecked();
    await page.getByLabel('土井 を参加者に含める').uncheck();
    await page.getByRole('button', { name: 'オーダーを生成' }).click();
    await expect(page.getByRole('heading', { name: 'オーダー結果' })).toBeVisible();

    // 23-24. Re-generating the reopened order revises it (§64): it is UPDATED against
    // v1, not a brand-new draft, and the change is readable as a diff.
    await expect(stateBanner(page)).toContainText('再確定が必要');
    await expect(page.getByRole('button', { name: '再確定 v2' })).toBeVisible();
    await page.getByRole('button', { name: /変更点/ }).first().click();
    const diff = page.getByRole('dialog', { name: /v1 からの変更/ });
    await expect(diff).toBeVisible();
    expect(await diff.locator('.diff-list > li').count()).toBeGreaterThan(0);
    // 土井 dropped out, so they appear only on the "before" side.
    const after = await diff.locator('.diff-change .after').allInnerTexts();
    expect(after.some((text) => text.includes('土井'))).toBe(false);
    await page.getByRole('button', { name: '閉じる' }).click();

    // 25-26. Finalize v2 and share the update message.
    await finalize(page);
    await expect(stateBanner(page)).toContainText('v2');
    await page.getByRole('button', { name: '共有', exact: true }).click();
    await page.getByRole('tab', { name: 'テキスト' }).click();
    await page.getByRole('button', { name: '変更点のみ', exact: true }).click();
    const updateText = await page.getByLabel('共有テキスト').inputValue();
    expect(updateText).toContain('v2');
    expect(updateText).toContain('変更');
    await page.getByRole('button', { name: '閉じる' }).click();

    // 27-28. Re-committing lands on exactly the v2 numbers, with no double counting.
    await commitSeason(page);
    const afterV2 = await seasonTotals(page);
    expect(Object.values(afterV2).reduce((a, b) => a + b, 0)).toBe(10);

    // 29. Both versions are in the history.
    await goTab(page, '履歴');
    await page.locator('.list-row').filter({ hasText: 'v2' }).first().click();
    await expect(page.getByText('2 版')).toBeVisible();
    await expect(page.getByRole('button', { name: /^v1/ })).toBeVisible();
    await expect(page.getByRole('button', { name: /^v2/ })).toBeVisible();

    // 30-31. Deleting it is refused while the season reflects it.
    await page.getByRole('button', { name: '削除', exact: true }).click();
    await expect(page.getByTestId('delete-blocked')).toBeVisible();
    await expect(page.getByRole('button', { name: '削除する' })).toHaveCount(0);

    // 32-33. Withdraw, then delete.
    await page.getByRole('button', { name: 'シーズン反映を取り消す' }).click();
    await page.getByRole('button', { name: '取り消す', exact: true }).click();
    await expect(page.getByText(/シーズン反映を取り消しました/)).toBeVisible();

    await goTab(page, '履歴');
    await page.locator('.list-row').filter({ hasText: 'v2' }).first().click();
    await page.getByRole('button', { name: '削除', exact: true }).click();
    await page.getByRole('button', { name: '削除する' }).click();
    await expect(page.getByText('削除しました')).toBeVisible();
  });
});

// ---------------------------------------------------------------------------
// §21 Persistence at each stage
// ---------------------------------------------------------------------------

test.describe('a reload keeps the intended state (追加要件 §21)', () => {
  test('after generating, after locking, after v1, after commit, after v2', async ({ page }) => {
    await openFresh(page);
    await generate(page);

    // After generation: a draft, saved only once the captain saves or finalizes it.
    await page.getByRole('button', { name: '下書きを保存' }).click();
    await expect(page.getByText('履歴に保存しました')).toBeVisible();
    await page.reload();
    await goTab(page, '履歴');
    await expect(page.locator('.list-row').first()).toContainText('未確定');

    // After locking.
    await page.locator('.list-row').first().click();
    await page.getByRole('button', { name: 'このオーダーを開いて編集' }).click();
    await page.locator('.slot .lock-toggle').first().click();
    await expect(page.locator('.slot.locked').first()).toBeVisible();

    // After v1.
    await finalize(page);
    await page.reload();
    await goTab(page, '履歴');
    await expect(page.locator('.list-row').first()).toContainText('v1');

    // After the season commit.
    await page.locator('.list-row').first().click();
    await page.getByRole('button', { name: 'このオーダーを開いて編集' }).click();
    await commitSeason(page);
    await page.reload();
    await goTab(page, '履歴');
    await expect(page.locator('.list-row').first()).toContainText('シーズン反映済み');
    const committed = await seasonTotals(page);

    // After v2.
    await goTab(page, '履歴');
    await page.locator('.list-row').first().click();
    await page.getByRole('button', { name: 'このオーダーを開いて編集' }).click();
    // The lock from earlier survived the reload, so slot 1 is disabled: that is the
    // point of the lock, and the edit has to go somewhere else.
    await expect(page.locator('.slot select').first()).toBeDisabled();
    const slot = page.locator('.slot select:not([disabled])').first();
    const value = await slot.inputValue();
    const options = await slot.locator('option').evaluateAll((nodes) =>
      nodes.map((node) => (node as HTMLOptionElement).value).filter((entry) => entry !== ''),
    );
    await slot.selectOption(options.find((entry) => entry !== value)!);
    await finalize(page);
    await page.reload();
    await goTab(page, '履歴');
    await expect(page.locator('.list-row').first()).toContainText('v2');
    // v2 is finalized but not yet committed, so the standings still show v1's numbers.
    expect(await seasonTotals(page)).toEqual(committed);
    await goTab(page, '履歴');
    await expect(page.locator('.list-row').first()).toContainText('旧版のまま');
  });
});

// ---------------------------------------------------------------------------
// §22 Offline: the whole match-day loop with no network
// ---------------------------------------------------------------------------

test.describe('the full loop works offline (追加要件 §22)', () => {
  test('generate, edit, finalize, image and text with the network cut', async ({ page, context }) => {
    await openFresh(page);

    // Let the service worker finish pre-caching before the network goes away.
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
    await expect(page.getByRole('heading', { name: 'サンプルチーム', level: 1 })).toBeVisible();

    // 4. Generate.
    await generate(page);
    await expect(page.locator('.slot select')).toHaveCount(10);

    // 5. Edit by hand, with the numbers recomputed live.
    const slot = page.locator('.slot select').first();
    const value = await slot.inputValue();
    const options = await slot.locator('option').evaluateAll((nodes) =>
      nodes.map((node) => (node as HTMLOptionElement).value).filter((entry) => entry !== ''),
    );
    await slot.selectOption(options.find((entry) => entry !== value)!);
    await expect(page.getByText('手動編集中です。', { exact: false })).toBeVisible();

    // 6. Finalize.
    await finalize(page);
    await expect(stateBanner(page)).toContainText('確定済み');
    await expect(stateBanner(page)).toContainText('v1');

    // 7-8. The shared PNG and the shared text are both produced locally.
    await page.getByRole('button', { name: '共有', exact: true }).click();
    const image = page.getByRole('img', { name: /オーダー画像/ });
    await expect(image).toBeVisible();
    const src = await image.getAttribute('src');
    expect(src?.startsWith('data:image/png;base64,')).toBe(true);
    expect((src ?? '').length).toBeGreaterThan(5_000);

    await page.getByRole('tab', { name: 'テキスト' }).click();
    const text = await page.getByLabel('共有テキスト').inputValue();
    expect(text).toContain('v1');
    expect(text).toContain('青木');

    // And the season commit — the one write that matters most — also works offline.
    await page.getByRole('button', { name: '閉じる' }).click();
    await commitSeason(page);
    // The hand edit moved one appearance, so the totals are not all 2 — but the ten
    // slots must all be accounted for exactly once.
    expect(Object.values(await seasonTotals(page)).reduce((a, b) => a + b, 0)).toBe(10);

    // It all survives a reload that is still offline.
    await page.reload();
    await goTab(page, '履歴');
    await expect(page.locator('.list-row').first()).toContainText('v1');
    await expect(page.locator('.list-row').first()).toContainText('シーズン反映済み');

    await context.setOffline(false);
  });
});
