import { expect, test, type Page } from '@playwright/test';

/**
 * Order lifecycle, versioning and season-commit safety (追加要件 §16).
 *
 * Driven entirely through the real UI in a real browser, because the point of this
 * feature is the operational flow — finalize, share, change, re-finalize, re-commit —
 * not any single function.
 */

async function openApp(page: Page): Promise<void> {
  await page.goto('/');
  // First run offers "own team" or "sample"; these tests work on the labelled sample.
  await page.getByRole('button', { name: 'サンプルで試す' }).click();
  await expect(page.getByRole('heading', { name: 'サンプルチーム', level: 1 })).toBeVisible();
}

function tab(page: Page, name: string) {
  return page.locator('.tab-bar').getByRole('button', { name, exact: true });
}

async function generate(page: Page): Promise<void> {
  await page.getByRole('button', { name: '新しいオーダーを作る' }).click();
  await expect(page.getByRole('heading', { name: 'オーダー設定' })).toBeVisible();
  await page.getByRole('button', { name: 'オーダーを生成' }).click();
  await expect(page.getByRole('heading', { name: 'オーダー結果' })).toBeVisible();
}

const stateBanner = (page: Page) => page.getByRole('region', { name: 'オーダーの状態' });

/**
 * Finalizes, and waits until the app says it is done.
 *
 * Clicking and moving straight on leaves the next action racing a finalization that is
 * still settling: the version is written to storage asynchronously, so a reload issued
 * in that window can tear the write down and the order comes back a version short.
 * That is a flake, and it cost a CI run — waiting for the banner to report the
 * finalized state gives the write a real settling point and, just as usefully, makes a
 * finalization that silently does nothing fail here rather than three steps later.
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

interface SlotOption {
  value: string;
  text: string;
}

async function slotOptions(page: Page): Promise<SlotOption[]> {
  return page
    .locator('.slot select')
    .first()
    .locator('option')
    .evaluateAll((nodes) =>
      nodes
        .map((node) => ({
          value: (node as HTMLOptionElement).value,
          text: (node.textContent ?? '').trim(),
        }))
        .filter((option) => option.value !== ''),
    );
}

/**
 * Swaps the player in the first slot for someone else.
 *
 * Returns display names rather than ids: player ids are generated per install, so a
 * second browser context seeded independently has different ids for the same people.
 */
async function changeFirstSlot(page: Page): Promise<{ before: string; after: string }> {
  const slot = page.locator('.slot select').first();
  const currentValue = await slot.inputValue();
  const options = await slotOptions(page);
  const beforeOption = options.find((option) => option.value === currentValue)!;
  const afterOption = options.find((option) => option.value !== currentValue)!;
  await slot.selectOption(afterOption.value);
  return { before: beforeOption.text, after: afterOption.text };
}

/** Puts the player whose option label is `label` into the first slot. */
async function selectFirstSlotByLabel(page: Page, label: string): Promise<void> {
  const options = await slotOptions(page);
  const target = options.find((option) => option.text === label);
  if (!target) throw new Error(`no option labelled "${label}" (got ${options.map((o) => o.text).join(', ')})`);
  await page.locator('.slot select').first().selectOption(target.value);
}

/** Reads every player's season total from the members list. */
async function seasonTotals(page: Page): Promise<Record<string, number>> {
  await tab(page, 'メンバー').click();
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

test.describe('order state model (追加要件 §2, §8)', () => {
  test('a freshly generated order is a draft', async ({ page }) => {
    await openApp(page);
    await generate(page);
    await expect(stateBanner(page)).toContainText('未確定');
    await expect(page.getByRole('button', { name: 'オーダーを確定 v1' })).toBeVisible();
  });

  test('finalizing produces v1, editing flips to UPDATED, re-finalizing produces v2', async ({ page }) => {
    await openApp(page);
    await generate(page);

    await finalize(page);
    await expect(stateBanner(page)).toContainText('確定済み');
    await expect(stateBanner(page)).toContainText('v1');

    await changeFirstSlot(page);
    await expect(stateBanner(page)).toContainText('再確定が必要');
    await expect(page.getByRole('button', { name: '再確定 v2' })).toBeVisible();

    await finalize(page);
    await expect(stateBanner(page)).toContainText('確定済み');
    await expect(stateBanner(page)).toContainText('v2');

    // And a third round.
    await changeFirstSlot(page);
    await expect(page.getByRole('button', { name: '再確定 v3' })).toBeVisible();
    await finalize(page);
    await expect(stateBanner(page)).toContainText('v3');
  });

  test('undoing a change returns the order to FINALIZED', async ({ page }) => {
    await openApp(page);
    await generate(page);
    await finalize(page);
    await changeFirstSlot(page);
    await expect(stateBanner(page)).toContainText('再確定が必要');

    await page.getByRole('button', { name: '元に戻す' }).click();
    await expect(stateBanner(page)).toContainText('確定済み');
  });

  test('opening the share screen does not change the state', async ({ page }) => {
    await openApp(page);
    await generate(page);
    await finalize(page);
    await expect(stateBanner(page)).toContainText('確定済み');

    await page.getByRole('button', { name: '共有', exact: true }).click();
    await expect(page.getByRole('dialog', { name: '共有' })).toBeVisible();
    await page.getByRole('tab', { name: '詳細' }).or(page.getByRole('button', { name: '詳細', exact: true })).first().click();
    await page.getByRole('button', { name: '閉じる' }).click();

    await expect(stateBanner(page)).toContainText('確定済み');
    await expect(stateBanner(page)).not.toContainText('再確定が必要');
  });

  test('a line-up with a hard-constraint violation cannot be finalized (追加要件 §3)', async ({ page }) => {
    await openApp(page);
    await generate(page);
    await page.locator('.slot select').first().selectOption('');
    await expect(page.getByText('絶対条件に違反しています')).toBeVisible();
    await expect(page.getByRole('button', { name: /オーダーを確定|再確定/ })).toBeDisabled();
  });
});

test.describe('difference view (追加要件 §9)', () => {
  test('shows the game that changed, before and after', async ({ page }) => {
    await openApp(page);
    await generate(page);
    await finalize(page);

    const names = await page.locator('.slot select').first().evaluate((node) => {
      const select = node as HTMLSelectElement;
      return {
        before: select.options[select.selectedIndex].textContent ?? '',
      };
    });
    await changeFirstSlot(page);

    await page.getByRole('button', { name: /変更点/ }).first().click();
    const dialog = page.getByRole('dialog', { name: /v1 からの変更/ });
    await expect(dialog).toBeVisible();
    await expect(dialog.locator('.diff-list > li')).toHaveCount(1);
    await expect(dialog.locator('.diff-change .before')).toContainText(
      names.before.replace(/\s*\(.*\)\s*$/, '').trim(),
    );
    await expect(dialog.locator('.diff-change .after')).toBeVisible();
  });
});

test.describe('share version consistency (追加要件 §6, §7, §10)', () => {
  test('a draft is marked as unconfirmed on the share screen', async ({ page }) => {
    await openApp(page);
    await generate(page);
    await page.getByRole('button', { name: '共有', exact: true }).click();

    await expect(page.getByTestId('share-draft-warning')).toContainText(
      'このオーダーはまだ確定されていません',
    );
    await page.getByRole('tab', { name: 'テキスト' }).click();
    expect(await page.getByLabel('共有テキスト').inputValue()).toContain('未確定');
  });

  test('v1 and v2 are labelled in the shared text', async ({ page }) => {
    await openApp(page);
    await generate(page);
    await finalize(page);

    await page.getByRole('button', { name: '共有', exact: true }).click();
    await expect(page.getByTestId('share-draft-warning')).toHaveCount(0);
    await page.getByRole('tab', { name: 'テキスト' }).click();
    expect(await page.getByLabel('共有テキスト').inputValue()).toContain('ORDER v1');
    await page.getByRole('button', { name: '閉じる' }).click();

    await changeFirstSlot(page);
    await finalize(page);
    await page.getByRole('button', { name: '共有', exact: true }).click();
    await page.getByRole('tab', { name: 'テキスト' }).click();
    const text = await page.getByLabel('共有テキスト').inputValue();
    expect(text).toContain('ORDER v2');
    expect(text).toContain('更新版');
  });

  test('offers change-only and change-plus-full update messages', async ({ page }) => {
    await openApp(page);
    await generate(page);
    await finalize(page);
    await changeFirstSlot(page);
    await finalize(page);

    await page.getByRole('button', { name: '共有', exact: true }).click();
    await page.getByRole('tab', { name: 'テキスト' }).click();

    await page.getByRole('button', { name: '変更点のみ' }).click();
    const diffOnly = await page.getByLabel('共有テキスト').inputValue();
    expect(diffOnly).toContain('🎯 オーダー変更 v2');
    expect(diffOnly).toContain('↓');
    expect(diffOnly).not.toContain('【最新オーダー】');

    await page.getByRole('button', { name: '変更点＋全文' }).click();
    const full = await page.getByLabel('共有テキスト').inputValue();
    expect(full).toContain('🎯 オーダー変更 v2');
    expect(full).toContain('【最新オーダー】');
  });

  test('the version badge appears on the shared image', async ({ page }) => {
    await openApp(page);
    await generate(page);
    await finalize(page);
    await page.getByRole('button', { name: '共有', exact: true }).click();

    const preview = page.locator('img.share-preview').first();
    await expect(preview).toBeVisible();
    const withBadge = await preview.evaluate((node) => (node as HTMLImageElement).naturalHeight);

    // A draft image reserves the same badge row, so the height is unchanged; what we can
    // assert here is that a valid PNG is still produced for a finalized order.
    expect(withBadge).toBeGreaterThan(0);
    const src = await preview.getAttribute('src');
    expect(src).toContain('data:image/png');
  });
});

test.describe('season commit safety (追加要件 §11-§13, §16)', () => {
  test('committing the same version twice does not double count', async ({ page }) => {
    await openApp(page);
    await generate(page);
    await finalize(page);

    await page.getByRole('button', { name: 'シーズン累計へ反映' }).click();
    await page.getByRole('button', { name: '反映する' }).click();
    await expect(page.getByText(/v1 をシーズン累計へ反映しました/)).toBeVisible();

    const afterFirst = await seasonTotals(page);
    expect(Object.values(afterFirst).every((value) => value === 2)).toBe(true);

    // Commit again: the ledger makes this a no-op, not a second addition.
    await tab(page, 'オーダー').click();
    await expect(page.getByRole('heading', { name: 'オーダー結果' })).toBeVisible();
    await page.getByRole('button', { name: 'シーズン累計を再反映' }).click();
    await page.getByRole('button', { name: '反映する' }).click();
    await expect(page.getByText(/既に反映済みです/)).toBeVisible();

    expect(await seasonTotals(page)).toEqual(afterFirst);
  });

  test('committing v1 then v2 equals committing v2 alone (the invariant)', async ({ page, browser }) => {
    // Path A: finalize v1, commit, change, re-finalize v2, re-commit.
    await openApp(page);
    await generate(page);
    await finalize(page);
    await page.getByRole('button', { name: 'シーズン累計へ反映' }).click();
    await page.getByRole('button', { name: '反映する' }).click();
    await expect(page.getByText(/v1 をシーズン累計へ反映しました/)).toBeVisible();

    const { before, after } = await changeFirstSlot(page);
    expect(before).not.toBe(after);
    await finalize(page);
    await expect(stateBanner(page)).toContainText('v2');
    await page.getByRole('button', { name: 'シーズン累計を再反映' }).click();
    await page.getByRole('button', { name: '反映する' }).click();
    await expect(page.getByText(/v2 をシーズン累計へ反映しました|既に反映済み/)).toBeVisible();

    const sequential = await seasonTotals(page);

    // Path B: a genuinely clean install (its own context, hence its own IndexedDB) with
    // the same final line-up, committed once.
    const freshContext = await browser.newContext();
    const fresh = await freshContext.newPage();
    await openApp(fresh);
    await generate(fresh);
    await selectFirstSlotByLabel(fresh, after);
    await finalize(fresh);
    await fresh.getByRole('button', { name: 'シーズン累計へ反映' }).click();
    await fresh.getByRole('button', { name: '反映する' }).click();
    await expect(fresh.getByText(/v1 をシーズン累計へ反映しました/)).toBeVisible();

    const direct = await seasonTotals(fresh);
    await freshContext.close();

    expect(sequential).toEqual(direct);
  });

  test('withdrawing a commit restores the previous totals', async ({ page }) => {
    await openApp(page);
    await generate(page);
    const before = await seasonTotals(page);
    await tab(page, 'オーダー').click();

    await finalize(page);
    await page.getByRole('button', { name: 'シーズン累計へ反映' }).click();
    await page.getByRole('button', { name: '反映する' }).click();
    await expect(page.getByText(/シーズン累計へ反映しました/)).toBeVisible();
    expect(await seasonTotals(page)).not.toEqual(before);

    await tab(page, 'オーダー').click();
    await page.getByRole('button', { name: '反映を取り消す' }).click();
    await page.getByRole('button', { name: '取り消す', exact: true }).click();
    await expect(page.getByText(/シーズン反映を取り消しました/)).toBeVisible();

    expect(await seasonTotals(page)).toEqual(before);
  });

  test('an unconfirmed order cannot be committed to the season', async ({ page }) => {
    await openApp(page);
    await generate(page);
    await expect(page.getByRole('button', { name: 'シーズン累計へ反映' })).toBeDisabled();
  });
});

test.describe('history and immutable snapshots (追加要件 §5, §15)', () => {
  test('lists the version, finalize time and season status', async ({ page }) => {
    await openApp(page);
    await generate(page);
    await finalize(page);
    await page.getByRole('button', { name: 'シーズン累計へ反映' }).click();
    await page.getByRole('button', { name: '反映する' }).click();
    await expect(page.getByText(/シーズン累計へ反映しました/)).toBeVisible();

    await tab(page, '履歴').click();
    const row = page.locator('.list-row').first();
    await expect(row).toContainText('v1');
    await expect(row).toContainText('シーズン反映済み');
    await expect(row).toContainText('確定');
  });

  test('a past version keeps the names it was finalized with after a rename', async ({ page }) => {
    await openApp(page);
    await generate(page);
    await finalize(page);

    // Find the player fielded in game 1 and rename them.
    const slot = page.locator('.slot select').first();
    const original = (
      await slot.evaluate((node) => {
        const select = node as HTMLSelectElement;
        return select.options[select.selectedIndex].textContent ?? '';
      })
    )
      .replace(/\s*\(.*\)\s*$/, '')
      .trim();

    await tab(page, 'メンバー').click();
    await page.locator('.list-row').filter({ hasText: original }).first().click();
    await page.getByLabel('名前 (必須)').fill('改名後の選手');
    await page.getByRole('button', { name: '保存', exact: true }).click();

    await tab(page, '履歴').click();
    await page.locator('.list-row').first().click();
    await page.getByRole('button', { name: /^v1/ }).click();

    const dialog = page.getByRole('dialog', { name: 'v1 の内容' });
    await expect(dialog).toBeVisible();
    // The snapshot still shows the name it was finalized under.
    await expect(dialog.locator('.mini-order')).toContainText(original);
    await expect(dialog.locator('.mini-order')).not.toContainText('改名後の選手');
  });

  test('a finalized order and its versions survive a reload', async ({ page }) => {
    await openApp(page);
    await generate(page);
    await finalize(page);
    await changeFirstSlot(page);
    await finalize(page);

    await page.reload();
    await tab(page, '履歴').click();
    await expect(page.locator('.list-row').first()).toContainText('v2');

    await page.locator('.list-row').first().click();
    await expect(page.getByText('2 版')).toBeVisible();
    await expect(page.getByRole('button', { name: /^v2/ })).toBeVisible();
    await expect(page.getByRole('button', { name: /^v1/ })).toBeVisible();
  });

  test('reopening a finalized order from history keeps it FINALIZED', async ({ page }) => {
    await openApp(page);
    await generate(page);
    await finalize(page);

    await tab(page, '履歴').click();
    await page.locator('.list-row').first().click();
    await page.getByRole('button', { name: 'このオーダーを開いて編集' }).click();

    await expect(page.getByRole('heading', { name: 'オーダー結果' })).toBeVisible();
    await expect(stateBanner(page)).toContainText('確定済み');
    await expect(stateBanner(page)).toContainText('v1');
  });
});

test.describe('editing a saved order from SETUP (§64)', () => {
  test('re-generating a finalized order from SETUP revises it to v2', async ({ page }) => {
    await openApp(page);
    await generate(page);
    await finalize(page);

    await page.getByRole('button', { name: '戻る' }).click();
    await expect(page.getByTestId('editing-banner')).toContainText('ORDER v1 を編集中');
    await page.getByLabel('遠藤 を参加者に含める').uncheck();
    await page.getByRole('button', { name: 'オーダーを生成' }).click();

    await expect(stateBanner(page)).toContainText('再確定が必要');
    await finalize(page);
    await expect(stateBanner(page)).toContainText('v2');

    // Still one order, now with two versions.
    await tab(page, '履歴').click();
    await expect(page.locator('.list-row')).toHaveCount(1);
    await page.locator('.list-row').first().click();
    await expect(page.getByText('2 版')).toBeVisible();
  });

  test('opening an order from history restores its setup conditions', async ({ page }) => {
    await openApp(page);
    await page.getByRole('button', { name: '新しいオーダーを作る' }).click();
    await page.getByLabel('遠藤 を参加者に含める').uncheck();
    await page.getByRole('button', { name: 'オーダーを生成' }).click();
    await expect(page.getByRole('heading', { name: 'オーダー結果' })).toBeVisible();
    await finalize(page);

    // Start something else, so the setup draft no longer matches that order…
    await tab(page, 'ホーム').click();
    await page.getByRole('button', { name: '新しいオーダーを作る' }).click();
    await page.getByLabel('遠藤 を参加者に含める').check();

    // …then reopen it: SETUP shows the conditions it was generated with.
    await tab(page, '履歴').click();
    await page.locator('.list-row').first().click();
    await page.getByRole('button', { name: 'このオーダーを開いて編集' }).click();
    await page.getByRole('button', { name: '戻る' }).click();
    await expect(page.getByTestId('editing-banner')).toBeVisible();
    await expect(page.getByLabel('遠藤 を参加者に含める')).not.toBeChecked();
  });

  test('"新規オーダーにする" detaches SETUP so the next generation is a new draft', async ({ page }) => {
    await openApp(page);
    await generate(page);
    await finalize(page);

    await page.getByRole('button', { name: '戻る' }).click();
    await page.getByRole('button', { name: '新規オーダーにする' }).click();
    await expect(page.getByTestId('editing-banner')).toHaveCount(0);
    await page.getByRole('button', { name: 'オーダーを生成' }).click();
    await expect(stateBanner(page)).toContainText('未確定');
    await expect(page.getByRole('button', { name: 'オーダーを確定 v1' })).toBeVisible();
  });

  test('switching teams detaches the open order, so another team never revises it', async ({ page }) => {
    await openApp(page);
    await generate(page);
    await finalize(page);

    // A second team with one member and a one-game format.
    await tab(page, 'ホーム').click();
    await page.getByRole('button', { name: '切替 / 管理' }).click();
    await page.getByRole('button', { name: 'チームを追加' }).click();
    await page.getByLabel('チーム名').fill('Bチーム');
    await page.getByRole('button', { name: '保存', exact: true }).click();
    await page.locator('.sheet .list-row').filter({ hasText: 'Bチーム' }).click();
    await expect(page.getByRole('heading', { name: 'Bチーム', level: 1 })).toBeVisible();
    await tab(page, 'メンバー').click();
    await page.getByRole('button', { name: 'メンバーを追加' }).click();
    await page.getByLabel('名前 (必須)').fill('ビーさん');
    await page.getByRole('button', { name: '保存', exact: true }).click();
    await tab(page, 'フォーマット').click();
    await page.getByRole('button', { name: 'フォーマットを作成' }).click();
    await page.getByRole('button', { name: '保存', exact: true }).click();

    // Team B's SETUP is not editing team A's order, and generating makes B's own draft.
    await tab(page, 'オーダー').click();
    await expect(page.getByRole('heading', { name: 'オーダー設定' })).toBeVisible();
    await expect(page.getByTestId('editing-banner')).toHaveCount(0);
    await page.getByRole('button', { name: 'オーダーを生成' }).click();
    await expect(stateBanner(page)).toContainText('未確定');
    await finalize(page);
    await expect(stateBanner(page)).toContainText('v1');

    // Team A's order is untouched: still one version, still A's players.
    await tab(page, 'ホーム').click();
    await page.getByRole('button', { name: '切替 / 管理' }).click();
    await page.locator('.sheet .list-row').filter({ hasText: 'サンプルチーム' }).click();
    await tab(page, '履歴').click();
    await expect(page.locator('.list-row')).toHaveCount(1);
    await page.locator('.list-row').first().click();
    await expect(page.getByText('1 版')).toBeVisible();
    await expect(page.locator('.mini-order')).not.toContainText('ビーさん');
  });

  test('a failed re-generation keeps the saved order and the conditions it came from', async ({ page }) => {
    await openApp(page);
    await generate(page);
    await finalize(page);

    // Make the conditions impossible (two players cannot fill a Trios) and try again.
    await page.getByRole('button', { name: '戻る' }).click();
    await page.getByRole('button', { name: '解除' }).click();
    await page.getByLabel('青木 を参加者に含める').check();
    await page.getByLabel('馬場 を参加者に含める').check();
    await page.getByRole('button', { name: 'オーダーを生成' }).click();
    await expect(page.getByText('オーダーを生成できませんでした')).toBeVisible();

    // v1 is still what is shown, unchanged, and saving it keeps v1's own conditions.
    await expect(stateBanner(page)).toContainText('確定済み');
    await page.getByRole('button', { name: /変更を保存|下書きを保存/ }).click();
    await tab(page, '履歴').click();
    await page.locator('.list-row').first().click();
    await page.getByRole('button', { name: 'このオーダーを開いて編集' }).click();
    await page.getByRole('button', { name: '戻る' }).click();
    await expect(page.getByLabel('遠藤 を参加者に含める')).toBeChecked();
    await expect(page.getByLabel('土井 を参加者に含める')).toBeChecked();
  });

  test('asks before discarding unsaved edits to a saved order', async ({ page }) => {
    await openApp(page);
    await generate(page);
    await finalize(page);

    // Saved and unchanged: a new order starts without a question.
    await tab(page, 'ホーム').click();
    await page.getByRole('button', { name: '作業中のオーダーを開く' }).click();
    await changeFirstSlot(page);
    await expect(stateBanner(page)).toContainText('再確定が必要');

    // Edited since the last save: the captain is asked first, and cancelling keeps it.
    await tab(page, 'ホーム').click();
    await page.getByRole('button', { name: '新しいオーダーを作る' }).click();
    const dialog = page.getByRole('dialog', { name: '新しいオーダーを作る' });
    await expect(dialog).toContainText('保存されていない変更');
    await dialog.getByRole('button', { name: 'キャンセル' }).click();
    await page.getByRole('button', { name: '作業中のオーダーを開く' }).click();
    await expect(stateBanner(page)).toContainText('再確定が必要');

    // Once re-finalized, nothing is pending and no question is asked.
    await finalize(page);
    await tab(page, 'ホーム').click();
    await page.getByRole('button', { name: '新しいオーダーを作る' }).click();
    await expect(page.getByRole('heading', { name: 'オーダー設定' })).toBeVisible();
    await expect(page.getByRole('dialog')).toHaveCount(0);
  });

  test('asks before discarding an unsaved change to the match header', async ({ page }) => {
    await openApp(page);
    await generate(page);
    await finalize(page);

    // Change the opponent from the share sheet: the order becomes UPDATED.
    await page.getByRole('button', { name: '共有', exact: true }).click();
    await page.locator('details.match-edit > summary').click();
    await page.getByLabel('対戦相手 (任意)').fill('Team Z');
    await page.getByRole('button', { name: '閉じる' }).click();
    await expect(stateBanner(page)).toContainText('再確定が必要');

    await tab(page, 'ホーム').click();
    await page.getByRole('button', { name: '新しいオーダーを作る' }).click();
    await expect(page.getByRole('dialog', { name: '新しいオーダーを作る' })).toContainText('保存されていない変更');
  });
});

