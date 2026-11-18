import { expect, test, type Page } from '@playwright/test';
import { tab } from './nav';

/**
 * ハリマル (PR1: ホームだけ・待機 / 歩行 / 睡眠)。
 * - ホームに 1 体だけ現れ、表示枠は 20 CSS px。ボタン・文字・固定バーに重ならず、横スクロールを出さない。
 * - クリック・タップは下の要素にそのまま届く (pointer-events: none)。
 * - モーダルを開くと隠れ、閉じると戻る。ホーム以外の画面・表示 OFF・「動きを減らす」では描画しない。
 * 時計は Playwright の page.clock で進め、乱数に頼らず「実際に歩く」ことを確かめる。
 */

const sprite = (page: Page) => page.getByTestId('harimaru');

/** 次に「隠れた」瞬間を記録し始める (短い非表示もポーリングで取りこぼさない)。返り値で、隠れたときの不透明度を得る。 */
async function watchHide(page: Page): Promise<() => Promise<string | null>> {
  await page.evaluate(() => {
    const el = document.querySelector<HTMLElement>('[data-testid="harimaru"]')!;
    const w = window as unknown as { __harimaruHidden: string | null; __harimaruObserver?: MutationObserver };
    w.__harimaruHidden = null;
    w.__harimaruObserver?.disconnect();
    w.__harimaruObserver = new MutationObserver(() => {
      if (el.dataset.visible === 'false' && w.__harimaruHidden === null) w.__harimaruHidden = getComputedStyle(el).opacity;
    });
    w.__harimaruObserver.observe(el, { attributes: true, attributeFilter: ['data-visible'] });
  });
  return () => page.evaluate(() => (window as unknown as { __harimaruHidden: string | null }).__harimaruHidden);
}

async function openSampleHome(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByRole('button', { name: 'サンプルで試す' }).click();
  await expect(page.getByRole('heading', { name: 'サンプルチーム', level: 1 })).toBeVisible();
  // サンプルの読み込み後、アプリはホームを少し下までスクロールする (既存の動作)。PC の低い画面では
  // その位置に安全な足場がなく、ハリマルは出ないのが正しい。足場の見える先頭へ戻してから確かめる。
  await page.evaluate(() => window.scrollTo(0, 0));
  // 画面の入場アニメーション (CSS、実時間で進む) が終わるのを待つ。page.clock はタイマーだけを進めるため。
  await page.waitForTimeout(1_500);
}

/** 表示枠の見える部分に重なるボタン・リンク・入力・文字・固定バーの一覧 (0.5px 未満の接触は除く)。 */
async function overlaps(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const el = document.querySelector('[data-testid="harimaru"]');
    if (!el) return ['no sprite'];
    const r = el.getBoundingClientRect();
    const box = { left: r.left + 2.5, right: r.right - 2.5, top: r.top + 0.5, bottom: r.bottom - 0.5 };
    const hit = (q: { left: number; right: number; top: number; bottom: number }): boolean =>
      q.right > box.left && q.left < box.right && q.bottom > box.top && q.top < box.bottom;
    const found: string[] = [];
    for (const node of Array.from(document.querySelectorAll('.app *'))) {
      const rect = node.getBoundingClientRect();
      if (!hit(rect)) continue;
      if (node.matches('button, a, input, select, textarea, label, [role="button"], [tabindex="0"], .app-header, .tab-bar, .action-bar')) {
        found.push(`${node.tagName}.${node.className}`);
      }
      for (const child of Array.from(node.childNodes)) {
        if (child.nodeType !== 3 || !child.textContent?.trim()) continue;
        const range = document.createRange();
        range.selectNodeContents(child);
        if (Array.from(range.getClientRects()).some(hit)) found.push(`TEXT:${child.textContent.trim().slice(0, 16)}`);
      }
    }
    return found;
  });
}

test('ホームに 1 体だけ現れ、UI に重ならずに歩き、クリックを妨げない', async ({ page }) => {
  await page.clock.install();
  await openSampleHome(page);
  await page.clock.runFor(4_000);
  await expect(sprite(page)).toHaveAttribute('data-visible', 'true');
  await expect(page.getByTestId('harimaru-layer')).toHaveCount(1);
  await expect(sprite(page)).toHaveCount(1);
  await expect(page.getByTestId('harimaru-layer')).toHaveAttribute('aria-hidden', 'true');

  const size = await sprite(page).evaluate((el) => el.getBoundingClientRect().height);
  expect(size).toBe(20);

  const xs = new Set<number>();
  for (let i = 0; i < 80; i += 1) {
    await page.clock.runFor(1_500);
    const state = await sprite(page).evaluate((el) => ({ x: Math.round(el.getBoundingClientRect().left), visible: el.getAttribute('data-visible') }));
    if (state.visible !== 'true') continue;
    xs.add(state.x);
    expect(await overlaps(page), `step ${i}`).toEqual([]);
  }
  expect(xs.size, 'ハリマルが実際に移動する').toBeGreaterThan(2);

  const sideways = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(sideways).toBeLessThanOrEqual(1);

  // 表示枠の中心を指しても、ハリマルではなく下の要素 (ページ) に届く。
  const below = await sprite(page).evaluate((el) => {
    const r = el.getBoundingClientRect();
    const target = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return target ? !target.closest('[data-testid="harimaru-layer"]') : true;
  });
  expect(below).toBe(true);
});

test('既存のボタンはハリマルの有無で同じように動く (ライブへの移動)', async ({ page }) => {
  await page.clock.install();
  await openSampleHome(page);
  await page.clock.runFor(4_000);
  await expect(sprite(page)).toHaveAttribute('data-visible', 'true');
  await page.getByTestId('home-results').click();
  await expect(page.getByTestId('harimaru-layer')).toHaveCount(0);
  await tab(page, 'ホーム').click();
  await page.clock.runFor(4_000);
  await expect(sprite(page)).toHaveAttribute('data-visible', 'true');
});

test('モーダル・シートを開くと隠れ、閉じると戻る', async ({ page }) => {
  await page.clock.install();
  await openSampleHome(page);
  await page.clock.runFor(4_000);
  await expect(sprite(page)).toHaveAttribute('data-visible', 'true');
  await page.getByRole('button', { name: /チーム切替/ }).first().click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(sprite(page)).toHaveAttribute('data-visible', 'false');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.clock.runFor(3_000);
  await expect(sprite(page)).toHaveAttribute('data-visible', 'true');
});

test('設定で OFF にすると表示されず、再読み込み後も OFF のまま。ON で戻る', async ({ page }) => {
  await openSampleHome(page);
  await tab(page, '設定 / バックアップ').click();
  await page.getByText('ハリマル', { exact: true }).click();
  const toggle = page.getByTestId('harimaru-toggle');
  await expect(toggle).toBeChecked();
  await toggle.uncheck();
  await tab(page, 'ホーム').click();
  await page.waitForTimeout(3_500);
  await expect(page.getByTestId('harimaru-layer')).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'サンプルチーム', level: 1 })).toBeVisible();
  await page.waitForTimeout(3_500);
  await expect(page.getByTestId('harimaru-layer')).toHaveCount(0);

  await tab(page, '設定 / バックアップ').click();
  await page.getByText('ハリマル', { exact: true }).click();
  await page.getByTestId('harimaru-toggle').check();
  await tab(page, 'ホーム').click();
  await expect(sprite(page)).toHaveAttribute('data-visible', 'true', { timeout: 10_000 });
});

test('「動きを減らす」設定では描画しない', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await openSampleHome(page);
  await page.waitForTimeout(3_500);
  await expect(page.getByTestId('harimaru-layer')).toHaveCount(0);
  // 設定が変わったら追従する。
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await expect(sprite(page)).toHaveAttribute('data-visible', 'true', { timeout: 10_000 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect(page.getByTestId('harimaru-layer')).toHaveCount(0);
});

test('安全な足場がなくなると即座に消え、足場が戻ると安全な場所から現れる', async ({ page }) => {
  await page.clock.install();
  await openSampleHome(page);
  // フィクスチャ: 枠の付いた透明な板でホーム全体を覆い、すべての足場の上をふさぐ (見た目以外は既存と同じ)。
  const block = async (): Promise<void> => {
    await page.evaluate(() => {
      const cover = document.createElement('div');
      cover.id = 'harimaru-blocker';
      cover.style.cssText = 'position:absolute;inset:0;border:1px solid rgb(0 0 0 / 5%);pointer-events:none';
      const main = document.querySelector<HTMLElement>('.app-main')!;
      main.style.position = 'relative';
      main.append(cover);
    });
  };
  await block();
  await page.clock.runFor(6_000);
  await expect(sprite(page)).toHaveAttribute('data-visible', 'false');
  expect(await sprite(page).evaluate((el) => getComputedStyle(el).opacity)).toBe('0');

  await page.evaluate(() => document.getElementById('harimaru-blocker')?.remove());
  await page.clock.runFor(4_000);
  await expect(sprite(page)).toHaveAttribute('data-visible', 'true');
  expect(await overlaps(page)).toEqual([]);

  // 表示中に足場がふさがれたら、検出した時点 (DOM 変化のまとめ待ち 200ms) でフェードせずに消える。
  await block();
  await page.clock.runFor(250);
  await expect(sprite(page)).toHaveAttribute('data-visible', 'false');
  // 消えた直後でも不透明度は 0 (残像のフェードがない)。
  expect(await sprite(page).evaluate((el) => getComputedStyle(el).opacity)).toBe('0');
});

test('PC: 足場のタイルにホバーして浮いても消えず、浮いたタイルに重ならない', async ({ page }, info) => {
  test.skip(info.project.name !== 'desktop', 'ホバーで浮くのはマウスのある画面だけ');
  await openSampleHome(page);
  await expect(sprite(page)).toHaveAttribute('data-visible', 'true', { timeout: 10_000 });
  // 足元のタイル・同じ列のほかのタイル・列の外を順に指す。トランジションの途中も含めて、
  // 消えずに (足場を失った場合を除く)、ボタンや文字に重ならないことを確かめる。
  let onTile = 0;
  for (let i = 0; i < 6; i += 1) {
    await expect(sprite(page)).toHaveAttribute('data-visible', 'true', { timeout: 10_000 });
    const targets = await sprite(page).evaluate((el) => {
      const r = el.getBoundingClientRect();
      const feet = { x: r.left + r.width / 2, y: r.bottom + 12 };
      const row = document.elementFromPoint(feet.x, feet.y)?.closest('.quick-grid');
      const others = row ? Array.from(row.querySelectorAll('.quick-tile')).map((t) => { const q = t.getBoundingClientRect(); return { x: q.left + q.width / 2, y: q.top + q.height / 2 }; }) : [];
      return { feet, onTile: !!row, others };
    });
    if (targets.onTile) onTile += 1;
    const hidden = await watchHide(page);
    for (const point of [targets.feet, ...targets.others, { x: 5, y: 300 }]) {
      await page.mouse.move(point.x, point.y);
      for (let k = 0; k < 6; k += 1) {
        await page.waitForTimeout(40);
        if ((await sprite(page).getAttribute('data-visible')) === 'true') expect(await overlaps(page), `hover ${i}`).toEqual([]);
      }
    }
    if (targets.onTile) expect(await hidden(), 'ホバーで消えない').toBeNull();
    await page.waitForTimeout(2_000);
  }
  expect(onTile, 'タイル列の上でホバーした回数').toBeGreaterThan(0);
});
