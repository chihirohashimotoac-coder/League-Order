import { expect, test, type Page } from '@playwright/test';

/**
 * End-to-end coverage of the share feature (追加要件 §13, §14).
 *
 * Runs against the production build in a real browser, so the Canvas renderer, the
 * device pixel ratio handling and the Web Share API detection are all genuinely
 * exercised rather than mocked out.
 */

async function openApp(page: Page): Promise<void> {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Darts Order' })).toBeVisible();
}

async function generate(page: Page): Promise<void> {
  await page.getByRole('button', { name: '新規オーダーを作成' }).click();
  await expect(page.getByRole('heading', { name: 'オーダー設定' })).toBeVisible();
  await page.getByRole('button', { name: 'オーダーを生成' }).click();
  await expect(page.getByRole('heading', { name: 'オーダー結果' })).toBeVisible();
}

async function openShare(page: Page): Promise<void> {
  await page.getByRole('button', { name: '共有', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '共有' })).toBeVisible();
}

async function fillMatchInfo(
  page: Page,
  values: { league?: string; opponent?: string; date?: string },
): Promise<void> {
  await page.getByRole('button', { name: '新規オーダーを作成' }).click();
  if (values.league !== undefined) await page.getByLabel('リーグ名 (任意)').fill(values.league);
  if (values.opponent !== undefined) await page.getByLabel('対戦相手 (任意)').fill(values.opponent);
  if (values.date !== undefined) await page.getByLabel('試合日 (任意)').fill(values.date);
}

/** A backup containing a 20-game format, used to exercise the long-order path. */
function longOrderBackup(): string {
  const now = Date.now();
  const teamId = 'team_long';
  const players = Array.from({ length: 8 }, (_, index) => ({
    id: `pl_${index}`,
    teamId,
    name: `せんしゅ${index + 1}`,
    rating: 4 + index,
    skills: { SINGLES: 3, DOUBLES: 3, G501: 3, CRICKET: 3, TRIOS: 3 },
    seasonAppearances: 0,
    seasonAppearancesByKind: {},
    archived: false,
    createdAt: now + index,
  }));
  const games = Array.from({ length: 20 }, (_, index) => ({
    id: `gm_${index}`,
    order: index + 1,
    name: index % 2 === 0 ? `Singles 501 第${index + 1}試合` : `Doubles Cricket 第${index + 1}試合`,
    kinds: index % 2 === 0 ? ['SINGLES', 'G501'] : ['DOUBLES', 'CRICKET'],
    playerCount: index % 2 === 0 ? 1 : 2,
  }));

  return JSON.stringify({
    app: 'darts-league-order',
    schemaVersion: 1,
    exportedAt: new Date().toISOString(),
    data: {
      teams: [{ id: teamId, name: 'ロングチーム', leagueName: '長丁場リーグ', createdAt: now }],
      players,
      formats: [{ id: 'fmt_long', teamId, name: '20ゲーム', games, createdAt: now }],
      pairs: [],
      orders: [],
      settings: { activeTeamId: teamId },
    },
  });
}

test.describe('share screen', () => {
  test('offers image, text and per-player tabs', async ({ page }) => {
    await openApp(page);
    await generate(page);
    await openShare(page);

    for (const name of ['画像', 'テキスト', 'プレイヤー別']) {
      await expect(page.getByRole('tab', { name })).toBeVisible();
    }
    await expect(page.getByRole('tab', { name: '画像' })).toHaveAttribute('aria-selected', 'true');
  });

  test('renders a high-resolution portrait PNG (追加要件 §2, §9)', async ({ page }) => {
    await openApp(page);
    await generate(page);
    await openShare(page);

    const preview = page.locator('img.share-preview').first();
    await expect(preview).toBeVisible();

    const size = await preview.evaluate((node) => ({
      width: (node as HTMLImageElement).naturalWidth,
      height: (node as HTMLImageElement).naturalHeight,
      src: (node as HTMLImageElement).src.slice(0, 20),
    }));

    expect(size.src).toContain('data:image/png');
    // Logical width 540 at a scale of 2 or 3 depending on the device pixel ratio.
    expect([1080, 1620]).toContain(size.width);
    // Portrait, and not absurdly tall.
    expect(size.height).toBeGreaterThan(size.width);
    expect(size.height / size.width).toBeLessThan(3);
  });

  test('switches between the compact and detail images (追加要件 §3, §4)', async ({ page }) => {
    await openApp(page);
    await generate(page);
    await openShare(page);

    const preview = page.locator('img.share-preview').first();
    const compactHeight = await preview.evaluate((node) => (node as HTMLImageElement).naturalHeight);

    await page.getByRole('button', { name: '詳細', exact: true }).click();
    await expect(page.getByRole('button', { name: '詳細', exact: true })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    const detailHeight = await page
      .locator('img.share-preview')
      .first()
      .evaluate((node) => (node as HTMLImageElement).naturalHeight);

    // Detail adds the appearance table, the order type and the notes.
    expect(detailHeight).toBeGreaterThan(compactHeight);
  });

  test('shows the match header in the image and the text', async ({ page }) => {
    await openApp(page);
    await fillMatchInfo(page, { league: '秋季リーグ', opponent: 'Team B', date: '2026-10-08' });
    await page.getByRole('button', { name: 'オーダーを生成' }).click();
    await expect(page.getByRole('heading', { name: 'オーダー結果' })).toBeVisible();
    await openShare(page);

    await page.getByRole('tab', { name: 'テキスト' }).click();
    const text = await page.getByLabel('共有テキスト').inputValue();
    expect(text).toContain('🎯 10/8 秋季リーグ');
    expect(text).toContain('マイチーム vs Team B');
  });

  test('generates LINE, simple and detail text (追加要件 §6)', async ({ page }) => {
    await openApp(page);
    await generate(page);
    await openShare(page);
    await page.getByRole('tab', { name: 'テキスト' }).click();

    const read = () => page.getByLabel('共有テキスト').inputValue();

    const lineText = await read();
    expect(lineText).toContain('🎯');
    expect(lineText).toContain('G1｜Singles 501');

    await page.getByRole('button', { name: 'シンプル' }).click();
    const simple = await read();
    expect(simple).not.toContain('🎯');
    expect(simple).toMatch(/G1 Singles 501 : /);

    await page.getByRole('button', { name: '詳細', exact: true }).click();
    const detail = await read();
    expect(detail).toContain('--- 出場回数 ---');
    expect(detail).toContain('オーダータイプ');
    // Internal evaluation must never reach a shared message.
    for (const forbidden of ['総合', '戦力', '公平性', 'ノード']) {
      expect(detail).not.toContain(forbidden);
    }
  });

  test('copies the text to the clipboard (追加要件 §1)', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await openApp(page);
    await generate(page);
    await openShare(page);
    await page.getByRole('tab', { name: 'テキスト' }).click();
    await page.getByRole('button', { name: 'テキストをコピー' }).click();

    const clipboard = await page.evaluate(() => navigator.clipboard.readText());
    expect(clipboard).toContain('🎯');
    for (const name of ['青木', '馬場', '千葉', '土井', '遠藤']) {
      expect(clipboard).toContain(name);
    }
  });

  test('shows each player their own games (追加要件 §5)', async ({ page }) => {
    await openApp(page);
    await generate(page);
    await openShare(page);
    await page.getByRole('tab', { name: 'プレイヤー別' }).click();

    const chips = page.locator('.player-chips .chip');
    await expect(chips).toHaveCount(5);

    await chips.first().click();
    const schedule = page.locator('.player-schedule');
    await expect(schedule).toBeVisible();
    const name = await schedule.locator('h3').innerText();

    const entries = schedule.locator('li');
    await expect(entries.first()).toBeVisible();
    // A player is never listed as their own partner.
    await expect(schedule).not.toContainText(`Partner: ${name}`);
    await expect(entries.first()).toContainText(/Game \d/);
  });

  test('copies every player’s schedule at once', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await openApp(page);
    await generate(page);
    await openShare(page);
    await page.getByRole('tab', { name: 'プレイヤー別' }).click();
    await page.getByRole('button', { name: '全員分をコピー' }).click();

    const clipboard = await page.evaluate(() => navigator.clipboard.readText());
    for (const name of ['青木', '馬場', '千葉', '土井', '遠藤']) {
      expect(clipboard).toContain(`■ ${name}`);
    }
  });

  test('saves the image as a PNG file', async ({ page }) => {
    await openApp(page);
    await generate(page);
    await openShare(page);

    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: '画像を保存' }).click();
    const file = await download;
    expect(file.suggestedFilename()).toMatch(/^darts-order.*\.png$/);
  });
});

test.describe('Web Share API', () => {
  test('falls back to save and copy when the API is unavailable (追加要件 §1)', async ({ page }) => {
    await page.addInitScript(() => {
      // Headless Chromium on Linux has no Web Share API; make that explicit and stable.
      Object.defineProperty(navigator, 'share', { value: undefined, configurable: true });
      Object.defineProperty(navigator, 'canShare', { value: undefined, configurable: true });
    });
    await openApp(page);
    await generate(page);
    await openShare(page);

    await expect(page.getByRole('button', { name: /標準共有/ })).toHaveCount(0);
    await expect(page.getByRole('button', { name: '画像を保存' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'テキストをコピー' })).toBeVisible();
    await expect(page.getByText('端末標準の共有メニューに対応していない', { exact: false })).toBeVisible();
  });

  test('hands the PNG to the OS share sheet when the API is available', async ({ page }) => {
    await page.addInitScript(() => {
      const record: { files: string[]; title: string }[] = [];
      Object.defineProperty(window, '__shareCalls', { value: record, writable: true });
      Object.defineProperty(navigator, 'canShare', { value: () => true, configurable: true });
      Object.defineProperty(navigator, 'share', {
        configurable: true,
        value: async (data: { files?: File[]; title?: string }) => {
          record.push({
            files: (data.files ?? []).map((file) => `${file.name}:${file.type}:${file.size}`),
            title: data.title ?? '',
          });
        },
      });
    });
    await openApp(page);
    await generate(page);
    await openShare(page);

    const shareButton = page.getByRole('button', { name: /標準共有/ });
    await expect(shareButton).toBeVisible();
    await shareButton.click();

    const calls = await page.evaluate(
      () => (window as unknown as { __shareCalls: { files: string[]; title: string }[] }).__shareCalls,
    );
    expect(calls).toHaveLength(1);
    expect(calls[0].files).toHaveLength(1);
    expect(calls[0].files[0]).toMatch(/^darts-order.*\.png:image\/png:\d+$/);
    // A real PNG, not an empty placeholder.
    expect(Number(calls[0].files[0].split(':')[2])).toBeGreaterThan(5000);
  });

  test('does not treat a dismissed share sheet as a failure', async ({ page }) => {
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'canShare', { value: () => true, configurable: true });
      Object.defineProperty(navigator, 'share', {
        configurable: true,
        value: async () => {
          const error = new Error('cancelled');
          error.name = 'AbortError';
          throw error;
        },
      });
    });
    await openApp(page);
    await generate(page);
    await openShare(page);
    await page.getByRole('button', { name: /標準共有/ }).click();

    await expect(page.getByText('共有を中止しました')).toBeVisible();
    // The sheet stays open so the captain can try another route.
    await expect(page.getByRole('dialog', { name: '共有' })).toBeVisible();
  });
});

test.describe('long orders and Japanese text', () => {
  test('splits a 20-game order across pages instead of shrinking it (追加要件 §10)', async ({ page }) => {
    await openApp(page);
    await page.getByRole('button', { name: /設定 \/ バックアップ/ }).click();
    await page.setInputFiles('input[type="file"]', {
      name: 'long.json',
      mimeType: 'application/json',
      buffer: Buffer.from(longOrderBackup(), 'utf-8'),
    });
    await page.getByRole('button', { name: '置き換える' }).click();
    await expect(page.getByText('インポートしました')).toBeVisible();

    await page.locator('.tab-bar').getByRole('button', { name: 'オーダー', exact: true }).click();
    await page.getByRole('button', { name: 'オーダーを生成' }).click();
    await expect(page.getByRole('heading', { name: 'オーダー結果' })).toBeVisible();
    await openShare(page);

    await expect(page.getByText(/2 枚に分割しました|枚に分割しました/)).toBeVisible();
    const previews = page.locator('img.share-preview');
    expect(await previews.count()).toBeGreaterThan(1);

    // Every page keeps the full-resolution width: nothing was squeezed.
    const widths = await previews.evaluateAll((nodes) =>
      nodes.map((node) => (node as HTMLImageElement).naturalWidth),
    );
    for (const width of widths) expect([1080, 1620]).toContain(width);
    expect(new Set(widths).size).toBe(1);
  });

  test('renders long Japanese names without clipping the layout (追加要件 §11, §13)', async ({ page }) => {
    await openApp(page);
    await page.locator('.tab-bar').getByRole('button', { name: 'メンバー', exact: true }).click();
    await page.getByRole('button', { name: '＋ メンバーを追加' }).click();
    await page.getByLabel('名前 (必須)').fill('ながいなまえのせんしゅさんです');
    await page.getByRole('button', { name: '保存', exact: true }).click();
    await expect(page.locator('.list-row').filter({ hasText: 'ながいなまえのせんしゅさんです' })).toHaveCount(1);

    await page.locator('.tab-bar').getByRole('button', { name: 'オーダー', exact: true }).click();
    await page.getByLabel('対戦相手 (任意)').fill('とてもながいあいてチームのなまえ');
    await page.getByRole('button', { name: 'オーダーを生成' }).click();
    await expect(page.getByRole('heading', { name: 'オーダー結果' })).toBeVisible();
    await openShare(page);

    const preview = page.locator('img.share-preview').first();
    await expect(preview).toBeVisible();
    const size = await preview.evaluate((node) => ({
      width: (node as HTMLImageElement).naturalWidth,
      height: (node as HTMLImageElement).naturalHeight,
    }));
    // The long names grow the image vertically; the width never changes.
    expect([1080, 1620]).toContain(size.width);

    await page.getByRole('tab', { name: 'テキスト' }).click();
    const text = await page.getByLabel('共有テキスト').inputValue();
    expect(text).toContain('ながいなまえのせんしゅさんです');
    expect(text).toContain('とてもながいあいてチームのなまえ');
  });

  test('the share screen itself does not scroll sideways on a phone', async ({ page }) => {
    await openApp(page);
    await generate(page);
    await openShare(page);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(1);
  });
});

test.describe('offline sharing (追加要件 §12)', () => {
  test('generates the image and the text with no network', async ({ page, context }) => {
    await openApp(page);
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

    await generate(page);
    await openShare(page);

    const preview = page.locator('img.share-preview').first();
    await expect(preview).toBeVisible();
    const width = await preview.evaluate((node) => (node as HTMLImageElement).naturalWidth);
    expect([1080, 1620]).toContain(width);

    await page.getByRole('tab', { name: 'テキスト' }).click();
    expect(await page.getByLabel('共有テキスト').inputValue()).toContain('🎯');

    await context.setOffline(false);
  });
});
