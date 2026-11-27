import { readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import { tab } from './nav';
import { blocking, harimaruOverlaps } from './harimaruOverlap';
import { seedRandom } from './seededRandom';

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
  await scrollToEntry(page);
  // 画面の入場アニメーション (CSS、実時間で進む) が終わるのを待つ。page.clock はタイマーだけを進めるため。
  await page.waitForTimeout(1_500);
}

/**
 * ハリマルが画面の端から入れる位置 (先頭) へスクロールする。登場は左右の端からだけで、画面の端と要素の間の空白が
 * entryMaxGap (24px) 以下の足場が要る。スマホは先頭の「次の試合」のカード・タイル (端から 12px)。PC は幅 1100
 * (下の beforeEach) の先頭 (端から 20px)。サンプルの読み込み後にアプリがホームを少し下へスクロールする既存の動作は、
 * ここで置き換える。
 */
async function scrollToEntry(page: Page): Promise<void> {
  await page.evaluate(() => window.scrollTo(0, 0));
}

/**
 * PC は幅 1100 で確かめる (PC の配置のまま、左右の端から 20px にカードがある)。1189 以上はコンテンツの列の外の空白が
 * 24px を超え (1280 で 70px)、左右から入れないので画面の外で待つ (harimaruEntry.spec.ts で確かめる)。
 */
test.beforeEach(async ({ page }, info) => {
  if (info.project.name === 'desktop') await page.setViewportSize({ width: 1100, height: 720 });
});

/** 時計を少しずつ進めて、端からの登場が終わり、足場に立つまで待つ (のぞいて引っ込む回・引っ込んだあとの間も含む)。 */
async function appear(page: Page, maxMs = 30_000): Promise<void> {
  for (let spent = 0; spent <= maxMs; spent += 250) {
    const standing = await sprite(page).evaluate((el) => el.dataset.visible === 'true' && el.dataset.action !== 'enter');
    if (standing) return;
    await page.clock.runFor(250);
  }
  throw new Error('ハリマルが端から現れない');
}

/** 表示枠の見える部分が重なってはいけないもの (harimaruOverlap.ts の規則。移動中の文字の短いかぶりは除く)。 */
async function overlaps(page: Page): Promise<string[]> {
  return blocking(await page.evaluate(harimaruOverlaps));
}

test('ホームに 1 体だけ現れ、入力欄・固定バー・重要な表示に重ならず、文字に長くかぶらずに歩き、クリックを妨げない', async ({ page }) => {
  // 気まぐれな動作の抽選と時計を固定する。固定しないと、眠り・待機が続いて 120 秒の間に 2 か所以下しか
  // 立たない回があった (CI の run #60 と手元で 60 回に 1 回)。本番の抽選は変えない (seededRandom.ts)。
  // 時計は読み込みの前から決まった時刻で止め、runFor でだけ進める (実時間で進むと、抽選の時刻・回数が実行ごとに変わる)。
  const start = Date.parse('2026-11-26T03:00:00Z');
  await seedRandom(page, 20261126);
  await page.clock.install({ time: start });
  await page.clock.pauseAt(start + 1_000);
  await openSampleHome(page);
  await appear(page);
  await expect(page.getByTestId('harimaru-layer')).toHaveCount(1);
  await expect(sprite(page)).toHaveCount(1);
  await expect(page.getByTestId('harimaru-layer')).toHaveAttribute('aria-hidden', 'true');

  const size = await sprite(page).evaluate((el) => el.getBoundingClientRect().height);
  expect(size).toBe(20);

  const xs = new Set<number>();
  // 移動中に文字へかぶったもの (前の標本)。1.5 秒おきの標本で続けて同じ文字にかぶっていれば、長く隠している。
  let passed: string[] = [];
  for (let i = 0; i < 80; i += 1) {
    await page.clock.runFor(1_500);
    const state = await sprite(page).evaluate((el) => ({ x: Math.round(el.getBoundingClientRect().left), visible: el.getAttribute('data-visible') }));
    if (state.visible !== 'true') {
      passed = [];
      continue;
    }
    xs.add(state.x);
    const found = await page.evaluate(harimaruOverlaps);
    expect(blocking(found), `step ${i}`).toEqual([]);
    const now = found.filter((f) => f.startsWith('pass:'));
    expect(now.filter((f) => passed.includes(f)), `step ${i}: 同じ文字に長くかぶり続けない`).toEqual([]);
    passed = now;
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

test('既存のボタンはハリマルの有無で同じように動く (日程・結果への移動と、ホームへの戻り)', async ({ page }) => {
  await page.clock.install();
  await openSampleHome(page);
  await appear(page);
  await page.getByTestId('home-results').click();
  // ボタンの操作はそのまま届き、画面が移る (ハリマルは移った先で足場を探し直す)。
  await expect(page.locator('.app-header h1')).not.toHaveText('サンプルチーム');
  await tab(page, 'ホーム').click();
  await scrollToEntry(page);
  await appear(page);
});

test('モーダル・シートを開くと隠れ、閉じると戻る', async ({ page }) => {
  await page.clock.install();
  await openSampleHome(page);
  await appear(page);
  await page.getByRole('button', { name: /チーム切替/ }).first().click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(sprite(page)).toHaveAttribute('data-visible', 'false');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.clock.runFor(1_000);
  await appear(page);
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
  await scrollToEntry(page);
  await expect(sprite(page)).toHaveAttribute('data-visible', 'true', { timeout: 20_000 });
});

test('「動きを減らす」設定では描画しない', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await openSampleHome(page);
  await page.waitForTimeout(3_500);
  await expect(page.getByTestId('harimaru-layer')).toHaveCount(0);
  // 設定が変わったら追従する。
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await expect(sprite(page)).toHaveAttribute('data-visible', 'true', { timeout: 20_000 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect(page.getByTestId('harimaru-layer')).toHaveCount(0);
});

test('安全な足場がなくなると即座に消え、足場が戻ると安全な場所から現れる', async ({ page }) => {
  await page.clock.install();
  await openSampleHome(page);
  // フィクスチャ: 透明な板 (デザインなし) でホーム全体を覆い、すべての足場の辺を隠す (覆われた辺は足場にしない)。
  const block = async (): Promise<void> => {
    await page.evaluate(() => {
      const cover = document.createElement('div');
      cover.id = 'harimaru-blocker';
      cover.style.cssText = 'position:absolute;inset:0;z-index:5';
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
  await appear(page);
  expect(await overlaps(page)).toEqual([]);

  // 表示中に足場がふさがれたら、検出した時点 (DOM 変化のまとめ待ち 200ms) でフェードせずに消える。
  await block();
  await page.clock.runFor(250);
  await expect(sprite(page)).toHaveAttribute('data-visible', 'false');
  // 消えた直後でも不透明度は 0 (残像のフェードがない)。
  expect(await sprite(page).evaluate((el) => getComputedStyle(el).opacity)).toBe('0');
});

test('PC: 足場のタイルにホバーして浮いても消えず、浮いたタイルに重ならない', async ({ browser }, info) => {
  test.skip(info.project.name !== 'desktop', 'ホバーで浮くのはマウスのある画面だけ');
  test.setTimeout(240_000);
  // タイルの浮き上がり (CSS のトランジション) は時計を止めると進まないので、実時間で動かす。幅 1100 ではタイルの列の
  // 上に立つ回が少ないので、乱数の種を変えた新しいページで、タイルの列の上に立つまで試す。
  let page: Page | null = null;
  let last: Page | null = null;
  for (let seed = 1; seed <= 6 && !page; seed += 1) {
    const context = await browser.newContext({ ...info.project.use, viewport: { width: 1100, height: 900 }, serviceWorkers: 'block' });
    const candidate = await context.newPage();
    await seedRandom(candidate, seed);
    await openSampleHome(candidate);
    // 次の試合のカードが固定ヘッダーの裏に隠れる位置 (幅いっぱいのカードの上からは、下のタイルへ降りる場所がない)。
    await candidate.evaluate(() => {
      const card = document.querySelector('.next-match-card')!.getBoundingClientRect();
      window.scrollTo(0, Math.round(card.bottom + window.scrollY - document.querySelector('.app-header')!.getBoundingClientRect().bottom + 6));
    });
    for (let spent = 0; spent < 12_000 && !page; spent += 250) {
      await candidate.waitForTimeout(250);
      const onTile = await sprite(candidate).evaluate((el) => {
        if (el.dataset.visible !== 'true' || el.dataset.action === 'enter') return false;
        const r = el.getBoundingClientRect();
        return !!document.elementFromPoint(r.left + r.width / 2, r.bottom + 12)?.closest('.quick-tile');
      });
      if (onTile) page = candidate;
    }
    if (!page && seed < 6) await context.close();
    last = candidate;
  }
  // 幅 1100 のタイルの上辺は、中のラベルで左右の端が切れていて (要素の角まで届かない)、画面の端から直接は入らない。
  // タイルの上に立つ回がなければ、ほかの足場に立った姿で、タイルが浮く間も消えず・重ならないことを確かめる。
  const standing = page !== null;
  test.info().annotations.push({ type: 'タイルの上に立った回', description: standing ? 'あり' : 'なし (ほかの足場で確かめた)' });
  page ??= last!;
  // 足元のタイル・同じ列のほかのタイル・列の外を順に指す。トランジションの途中も含めて、
  // 消えずに (足場を失った場合を除く)、ボタンや文字に重ならないことを確かめる。
  let onTile = 0;
  for (let i = 0; i < 6; i += 1) {
    await expect(sprite(page)).toHaveAttribute('data-visible', 'true', { timeout: 20_000 });
    const targets = await sprite(page).evaluate((el) => {
      const r = el.getBoundingClientRect();
      const feet = { x: r.left + r.width / 2, y: r.bottom + 12 };
      const row = document.elementFromPoint(feet.x, feet.y)?.closest('.quick-grid');
      const others = row ? Array.from(row.querySelectorAll('.quick-tile')).map((t) => { const q = t.getBoundingClientRect(); return { x: q.left + q.width / 2, y: q.top + q.height / 2 }; }) : [];
      return { feet, onTile: !!row, others };
    });
    if (targets.onTile) onTile += 1;
    // タイルの上でなければ、ホバーする先はタイルの列 (同じ画面の最初の列) にする。
    if (!targets.onTile) {
      targets.others = await page.evaluate(() => Array.from(document.querySelectorAll('.quick-tile')).slice(0, 3).map((t) => { const q = t.getBoundingClientRect(); return { x: q.left + q.width / 2, y: q.top + q.height / 2 }; }));
    }
    const hidden = await watchHide(page);
    for (const point of [targets.feet, ...targets.others, { x: 5, y: 300 }]) {
      await page.mouse.move(point.x, point.y);
      for (let k = 0; k < 6; k += 1) {
        await page.waitForTimeout(40);
        if ((await sprite(page).getAttribute('data-visible')) === 'true') expect(await overlaps(page), `hover ${i}`).toEqual([]);
      }
    }
    expect(await hidden(), 'ホバーで消えない').toBeNull();
    await page.waitForTimeout(2_000);
  }
  if (standing) expect(onTile, 'タイル列の上でホバーした回数').toBeGreaterThan(0);
});

// ---------------------------------------------------------------- PR2: 触れ合い・全画面

/** data-action の移り変わりを記録し始める (短い反応もポーリングで取りこぼさない)。 */
async function watchActions(page: Page): Promise<() => Promise<string[]>> {
  await page.evaluate(() => {
    const el = document.querySelector<HTMLElement>('[data-testid="harimaru"]')!;
    const w = window as unknown as { __harimaruActions: string[]; __harimaruActionObserver?: MutationObserver };
    w.__harimaruActions = [];
    w.__harimaruActionObserver?.disconnect();
    w.__harimaruActionObserver = new MutationObserver(() => w.__harimaruActions.push(el.dataset.action ?? ''));
    w.__harimaruActionObserver.observe(el, { attributes: true, attributeFilter: ['data-action'] });
  });
  return () => page.evaluate(() => (window as unknown as { __harimaruActions: string[] }).__harimaruActions);
}

/** ハリマルの体の中心 (画面座標)。 */
async function body(page: Page): Promise<{ x: number; y: number; faceX: number; dir: number }> {
  return sprite(page).evaluate((el) => {
    const r = el.getBoundingClientRect();
    const dir = /scaleX\(-1\)/.test(el.style.transform) ? 1 : -1;
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, faceX: dir < 0 ? r.left + 7 : r.right - 7, dir };
  });
}

async function waitStanding(page: Page): Promise<void> {
  await expect(sprite(page)).toHaveAttribute('data-visible', 'true', { timeout: 20_000 });
  // 隠れている・跳ねている間は待つ。
  await expect.poll(async () => sprite(page).evaluate((el) => !el.style.clipPath && ['idle', 'look', 'rest'].includes(el.dataset.action ?? '')), { timeout: 20_000 }).toBe(true);
}

test('顔をタップ・クリックすると喜び、下の画面の操作には何も起きない', async ({ page }) => {
  test.setTimeout(150_000);
  // 乱数の種と時計を固定し、時計を進めて、顔の近くに操作部品のない位置で静かにしている瞬間を待つ。体はボタンに
  // 重なってよく、ボタンの上の顔を触ると、触った操作はボタンに届く (ハリマルはクリックを受け取らない。その場合は
  // 喜ばない)。タッチ (スマホ) は位置の補正が届く周り 16px も確かめる (足元の側は足場なので除く)。
  // 種 7: スマホ・PC (幅 1100) とも、顔の近くに操作部品のない位置に立つ (本番のビルドで 1〜8 を試した。スマホで
  // 立ったのは 3・7 だけ。ほかの種はタイル (ボタン) の中の要素の上辺に立ち、顔がボタンの中にある)。
  const start = Date.parse('2026-11-26T03:00:00Z');
  await seedRandom(page, 7);
  await page.clock.install({ time: start });
  await page.clock.pauseAt(start + 1_000);
  await openSampleHome(page);
  const touch = page.viewportSize()!.width < 600;
  let clear = false;
  for (let spent = 0; spent < 120_000 && !clear; spent += 250) {
    await page.clock.runFor(250);
    clear = await sprite(page).evaluate((el, touch) => {
      if (el.dataset.visible !== 'true' || el.style.clipPath || !['idle', 'look', 'rest'].includes(el.dataset.action ?? '')) return false;
      const r = el.getBoundingClientRect();
      const dir = /scaleX\(-1\)/.test(el.style.transform) ? 1 : -1;
      const x = dir < 0 ? r.left + 7 : r.right - 7;
      const y = r.top + r.height / 2 - 5;
      const offsets = touch ? [[0, 0], [-16, 0], [16, 0], [0, -16]] : [[0, 0]];
      return offsets.every(([dx, dy]) => !document.elementFromPoint(x + dx, y + dy)?.closest('button, a, input, select, textarea, label, [role="button"], [tabindex="0"]'));
    }, touch);
  }
  expect(clear, '顔の近くに操作部品のない位置で静かにしている').toBe(true);
  const url = page.url();
  const actions = await watchActions(page);
  const point = await body(page);
  // 顔の上の方 (頭の高さ) を触る。足元の足場がボタン (タイル) のとき、足元に近い点を触ると、ブラウザーのタッチの
  // 位置の補正で下のボタンが押されることがある (ハリマルはクリックを受け取らない)。
  const faceY = point.y - 5;
  if (touch) await page.touchscreen.tap(point.faceX, faceY);
  else await page.mouse.click(point.faceX, faceY);
  let happy = false;
  for (let spent = 0; spent < 3_000 && !happy; spent += 100) {
    await page.clock.runFor(100);
    happy = (await actions()).includes('happy');
  }
  expect(happy, '喜ぶ').toBe(true);
  // 画面は変わらず、ダイアログも開かない。
  expect(page.url()).toBe(url);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(await overlaps(page)).toEqual([]);
});

test('長押し・ドラッグでは反応しない', async ({ page }, info) => {
  test.skip(info.project.name !== 'desktop', 'マウスで押す長さ・動きを正確に操作できる PC で確かめる (判定の境界値は単体テスト)');
  await openSampleHome(page);
  await waitStanding(page);
  const actions = await watchActions(page);
  const point = await body(page);
  await page.mouse.move(point.faceX, point.y);
  await page.mouse.down();
  await page.waitForTimeout(700);
  await page.mouse.up();
  await page.mouse.move(point.faceX, point.y);
  await page.mouse.down();
  await page.mouse.move(point.faceX + 40, point.y + 30, { steps: 5 });
  await page.mouse.up();
  await page.waitForTimeout(800);
  expect(await actions()).not.toContain('happy');
  expect(await actions()).not.toContain('turn');
});

test('どの画面でも、入力欄・固定バーに重ならず、立っている間は文字に重ならない (メンバー・フォーマット・履歴・設定・その他・観戦)', async ({ page }, info) => {
  test.setTimeout(180_000);
  await openSampleHome(page);
  const screens: [string, () => Promise<void>][] = [
    ['メンバー', () => tab(page, 'メンバー').click()],
    ['フォーマット', () => tab(page, 'フォーマット').click()],
    ['履歴', () => tab(page, '履歴').click()],
    ['設定', () => tab(page, '設定 / バックアップ').click()],
    ['その他', () => tab(page, 'その他').click()],
    ['観戦', () => tab(page, '観戦').click()],
    ['オーダー', () => tab(page, 'オーダー').click()],
  ];
  let shownSomewhere = 0;
  for (const [label, open] of screens) {
    await open();
    await page.evaluate(() => window.scrollTo(0, 0));
    let shown = 0;
    for (let i = 0; i < 8; i += 1) {
      await page.waitForTimeout(700);
      if ((await sprite(page).count()) === 0 || (await sprite(page).getAttribute('data-visible')) !== 'true') continue;
      shown += 1;
      expect(await overlaps(page), `${label} ${i}`).toEqual([]);
    }
    if (shown > 0) shownSomewhere += 1;
    // 画面に 1 体だけ。
    expect(await page.getByTestId('harimaru').count()).toBeLessThanOrEqual(1);
  }
  // スマホは観戦 (試合のないとき) 以外の画面に出る。PC (幅 1100) はメンバー・フォーマット・履歴・設定・その他の列が
  // 狭く (左右の空白 182px)、左右の端から入れるのはオーダー・観戦 (とホーム) だけ。
  expect(shownSomewhere, '足場のある画面のうち、いくつかには出る').toBeGreaterThanOrEqual(info.project.name === 'desktop' ? 2 : 3);
});

test('入力欄にフォーカスがある間は休み、離れると戻る', async ({ page }, info) => {
  // PC のメンバーの画面はコンテンツの列が狭く (幅 1100 で左右の空白 182px)、左右の端から入れない。
  test.skip(info.project.name === 'desktop', 'PC のメンバーの画面には左右の端から入れない (スマホで確かめる)');
  await openSampleHome(page);
  await tab(page, 'メンバー').click();
  await page.evaluate(() => window.scrollTo(0, 0));
  await expect(sprite(page)).toHaveAttribute('data-visible', 'true', { timeout: 20_000 });
  const field = page.locator('.page-view input:not([type="checkbox"]):not([type="radio"]):visible').first();
  await field.focus();
  await expect(sprite(page)).toHaveAttribute('data-visible', 'false');
  await field.blur();
  await page.evaluate(() => window.scrollTo(0, 0));
  await expect(sprite(page)).toHaveAttribute('data-visible', 'true', { timeout: 20_000 });
});

/**
 * page.clock を少しずつ進めて、ハリマルが見える位置で静かな行動 (待機・休む・周囲を見る。眠り・隠れ・跳ねの途中ではない)
 * をしているところまで待つ。眠り (最長 40 秒) の途中でも、時計を進めるので実時間の上限に当たらない。
 */
async function runUntilCalm(page: Page, maxMs = 90_000): Promise<void> {
  for (let spent = 0; spent <= maxMs; spent += 250) {
    const calm = await sprite(page).evaluate((el) => el.dataset.visible === 'true' && !el.style.clipPath && ['idle', 'look', 'rest'].includes(el.dataset.action ?? ''));
    if (calm) return;
    await page.clock.runFor(250);
  }
  throw new Error('ハリマルが静かな行動に戻らない');
}

/** カーソルの E2E の時計の起点 (固定)。 */
const CURSOR_CLOCK = Date.parse('2026-11-25T03:00:00Z');

test('PC: 近くで止まったカーソルに、気まぐれに近づくか顔を出す (カーソルは捕まえない)', async ({ page }, info) => {
  test.skip(info.project.name !== 'desktop', 'ホバーできる PC だけ');
  test.setTimeout(120_000);
  // 再現できる条件: 乱数の種・時計を固定し (登場の位置と気まぐれな抽選が毎回同じ)、眠っていない静かな行動から始める。
  // 時計は読み込みの前から決まった時刻で止めて、runFor でだけ進める (実時間で進むと、カーソルの動く速さや抽選の
  // 時刻・回数が実行ごとに変わる)。
  await seedRandom(page, 20261125);
  await page.clock.install({ time: CURSOR_CLOCK });
  await page.clock.pauseAt(CURSOR_CLOCK + 1_000);
  await openSampleHome(page);
  await runUntilCalm(page);
  const actions = await watchActions(page);
  // カーソルへの反応だけを数える: 近づく (approach) と、カーソルの近くで顔を出す (peek)。気まぐれに隠れてから顔を出す
  // ときは、直前の動作が隠れる (hide) なので数えない。
  const cursorReactions = async (): Promise<string[]> => {
    const seen = await actions();
    return seen.filter((action, i) => action === 'approach' || (action === 'peek' && seen[i - 1] !== 'hide' && seen[i - 1] !== 'peek'));
  };
  // カーソルを動かす前: 時計を進めても、カーソルへの反応 (近づく・顔を出す) は起きない。
  await page.clock.runFor(6_000);
  expect(await cursorReactions()).toEqual([]);
  let reacted = false;
  for (let attempt = 0; attempt < 6 && !reacted; attempt += 1) {
    await runUntilCalm(page);
    expect(await cursorReactions()).toEqual([]);
    const point = await body(page);
    // 体の横 90px あたりで止める (ボタンの上かどうかは問わない: カーソルの見た目・操作は変えない)。
    await page.mouse.move(point.x + (point.x > 300 ? -90 : 90), point.y - 10, { steps: 4 });
    // 止まってから反応を考えるまで (cursorStillMs 1.5 秒) と、その後の確かめ (cursorCheckMs 0.7 秒ごと) を時計で進める。
    for (let step = 0; step < 12 && !reacted; step += 1) {
      await page.clock.runFor(700);
      reacted = (await cursorReactions()).length > 0;
    }
  }
  expect(reacted).toBe(true);
  expect(await overlaps(page)).toEqual([]);
});

test('PC 1100×900: 歩く・駆ける間、足元はいつも 1 つの要素の辺の上 (横並びのカードの隙間・角丸の上を歩かない)', async ({ browser }, info) => {
  test.skip(info.project.name !== 'desktop', 'PC の横並びのカード (サンプルのホーム) で確かめる');
  test.setTimeout(300_000);
  let movingFrames = 0;
  const floating: string[] = [];
  const touching: string[] = [];
  /**
   * 同じカードの上を継ぎ目 (隣のタイルとの隙間が 20px 以下の端) の側へ進んで、その端から 16px 以内に着いた回数
   * (右端・左端)。data-action は歩き終えて次の行動を選ぶまで walk / run のままなので、止まったあとの標本は数えない
   * (前の標本から動いたときだけ数える)。
   */
  const seams = { right: 0, left: 0 };
  // 乱数の種: 幅 1100 で、1 は次の試合のカードとカード、4 はタイルの列、12 は一覧の行とカードの上を歩く (1〜40 を
  // 試して選んだ。幅 1100 では、タイルの継ぎ目の手前まで歩く種は見つからなかった。継ぎ目を渡る小ジャンプは
  // harimaruEntry.spec.ts の検証用の足場で確かめる)。
  // 種ごとに新しいページで、時計を読み込みの前から止めて進める (同じ種なら同じ歩き方になる)。
  for (const seed of [1, 4, 12]) {
    const context = await browser.newContext({ ...info.project.use, viewport: { width: 1100, height: 900 }, deviceScaleFactor: 1, serviceWorkers: 'block' });
    const page = await context.newPage();
    await seedRandom(page, seed);
    await page.clock.install({ time: CURSOR_CLOCK });
    await page.clock.pauseAt(CURSOR_CLOCK + 1_000);
    await openSampleHome(page);
    await runUntilCalm(page);
    /** 前の標本 (歩く・駆ける間だけ。ほかの行動を挟んだら捨てる)。 */
    let previous: { x: number; card: number } | null = null;
    for (let step = 0; step < 900; step += 1) {
      await page.clock.runFor(100);
      if (step % 50 === 0) await page.evaluate(() => window.scrollTo(0, 0));
      const sample = await sprite(page).evaluate((el) => {
        const action = el.dataset.action ?? '';
        const moving = (action === 'walk' || action === 'run') && el.dataset.visible === 'true' && !el.style.clipPath;
        if (!moving) return { moving: false, gap: 0, where: '', seam: null as 'right' | 'left' | null, x: 0, card: -1 };
        const r = el.getBoundingClientRect();
        // 足元の見える範囲 (表示枠の左右の透明な余白 2px を除く)。右向きは scaleX(-1)。
        const left = r.left + 2;
        const right = r.right - 2;
        // 足場になりうる要素: 背景・上の枠・影のある要素 (上辺) と、下の枠線だけの仕切り (下の線)。
        const visible = (c: string): boolean => !!c && c !== 'transparent' && !/rgba?\([^)]*,\s*0\)$/.test(c) && !/\/\s*0\)$/.test(c);
        const cards = Array.from(document.querySelectorAll('.app-main *')).flatMap((card) => {
          const st = getComputedStyle(card);
          const border = (side: 'top' | 'bottom'): boolean => parseFloat(st.getPropertyValue(`border-${side}-width`)) > 0 && st.getPropertyValue(`border-${side}-style`) !== 'none' && visible(st.getPropertyValue(`border-${side}-color`));
          const design = visible(st.backgroundColor) || st.backgroundImage !== 'none' || border('top') || st.boxShadow !== 'none';
          const q = card.getBoundingClientRect();
          if (q.width < 8) return [];
          if (design) return [{ q, radius: parseFloat(st.borderTopLeftRadius) || 0 }];
          if (border('bottom')) return [{ q: { left: q.left, right: q.right, top: q.bottom, bottom: q.bottom } as DOMRect, radius: 0 }];
          return [];
        });
        let gap = Infinity;
        let seam: 'right' | 'left' | null = null;
        let card = -1;
        for (const [index, { q, radius }] of cards.entries()) {
          if (Math.abs(q.top - r.bottom) > 3.5 || left < q.left - 0.5 || right > q.right + 0.5) continue;
          // 足元の両端で、カードの輪郭 (角丸で下がる分) と足元の高さの差を合わせた浮き。
          const drop = (d: number): number => (d < radius ? radius - Math.sqrt(Math.max(0, radius * radius - (radius - d) ** 2)) : 0);
          const vertical = r.bottom - q.top;
          const here = Math.max(Math.abs(drop(left - q.left) - vertical), Math.abs(drop(q.right - right) - vertical));
          if (here < gap) card = index;
          gap = Math.min(gap, here);
          const neighbor = (side: 'right' | 'left'): boolean =>
            cards.some(({ q: o }) => Math.abs(o.top - q.top) <= 3 && (side === 'right' ? o.left - q.right : q.left - o.right) >= 0 && (side === 'right' ? o.left - q.right : q.left - o.right) <= 20);
          // 足場の両端は角丸の半径 (サンプルのタイルは 16px) だけ除くので、継ぎ目の手前で止まる位置は端から 16px。
          // 継ぎ目 (隣の要素との隙間が 20px 以下の端) か、要素の端 (角丸の手前) まで。
          if (q.right - right <= 18 && (neighbor('right') || q.right - q.left > 60)) seam = 'right';
          if (left - q.left <= 18 && (neighbor('left') || q.right - q.left > 60)) seam = 'left';
        }
        return { moving: true, gap, where: `${action} x=${Math.round(r.left)} foot=${Math.round(r.bottom)}`, seam, x: r.left, card };
      });
      if (!sample.moving) {
        previous = null;
        continue;
      }
      movingFrames += 1;
      if (sample.gap > 1) floating.push(`種 ${seed}: ${sample.where} gap=${sample.gap}`);
      // 同じカードの上で、前の標本から継ぎ目の側へ進んで、継ぎ目の手前に着いたときだけ数える。
      if (sample.seam && previous && previous.card === sample.card && (sample.seam === 'right' ? sample.x > previous.x + 0.5 : sample.x < previous.x - 0.5)) seams[sample.seam] += 1;
      previous = { x: sample.x, card: sample.card };
      for (const hit of await overlaps(page)) touching.push(`種 ${seed}: ${sample.where} ${hit}`);
    }
    for (const hit of await overlaps(page)) touching.push(`種 ${seed}: 最後 ${hit}`);
    await context.close();
  }
  expect(movingFrames, '歩く・駆ける場面がある').toBeGreaterThan(20);
  expect(floating).toEqual([]);
  expect(touching).toEqual([]);
  // 継ぎ目・要素の端の手前まで歩いた回数は記録だけする。幅 1100 では休む・眠る時間が長く、種 1〜40 のどれも 90 秒の間に
  // 端まで歩かなかった。端の手前で止まる・継ぎ目をジャンプで渡ることは、controller.dom.test.ts (横並びのタイルの列) と
  // harimaruEntry.spec.ts の検証用の足場 (隙間 10px・36px) で決まった条件で確かめる。
  test.info().annotations.push({ type: '端の手前まで歩いた回数', description: String(seams.right + seams.left) });
});

test('速くスクロールしても位置が崩れず、止まったあとも重ならない', async ({ page }) => {
  await openSampleHome(page);
  await waitStanding(page);
  for (let i = 0; i < 6; i += 1) {
    await page.mouse.wheel(0, i % 2 ? -1_200 : 1_200);
    await page.waitForTimeout(60);
  }
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(1_500);
  if ((await sprite(page).getAttribute('data-visible')) === 'true') expect(await overlaps(page)).toEqual([]);
  await expect(sprite(page)).toHaveAttribute('data-visible', 'true', { timeout: 20_000 });
  expect(await overlaps(page)).toEqual([]);
});

/** 動作素材 v1.0 の画像 (リポジトリの中)。 */
const V10_DIR = fileURLToPath(new URL('../src/features/harimaru/assets/v10', import.meta.url));

/** 読み込んだ追加素材 v0.9 (14 動作) と動作素材 v1.0 (10 動作) のアトラスのファイル名。 */
const clipRequests = (page: Page): Promise<string[]> =>
  page.evaluate(() =>
    performance
      .getEntriesByType('resource')
      .map((e) => e.name.split('/').pop() ?? '')
      .filter((n) => /^(hang|slip|climb|cursorHang|tumble|sleepyFall|groom|stretch|lookUp|surprise|tilt|play|run|happy|lookDown|jumpPrep|jumpAir|jumpLand|dropAir|dropLand|peekTop|sideMount|sideClimb|sideLedge)@\dx/.test(n)),
  );

test('追加素材 v0.9・動作素材 v1.0 は描画レイヤーの準備のあとで画素密度に合う 1 組 (14 + 10 動作) だけを読み込み、表示 OFF・動きを減らす設定では読み込まない', async ({ page, browser }, info) => {
  await openSampleHome(page);
  await expect(sprite(page)).toHaveAttribute('data-visible', 'true', { timeout: 20_000 });
  const density = info.project.name === 'mobile' ? 3 : 1;
  // v0.9 は 14 枚を要求する。v1.0 の 10 枚は、ビルドが 4KB 未満の画像を埋め込む (データ URI) ので、4KB 以上の画像だけを要求する。
  const V09 = /^(hang|slip|climb|cursorHang|tumble|sleepyFall|groom|stretch|lookUp|surprise|tilt|play|run|happy)@/;
  const v10 = readdirSync(V10_DIR)
    .filter((name) => name.endsWith(`@${density}x.png`) && statSync(`${V10_DIR}/${name}`).size >= 4_096)
    .map((name) => name.split('@')[0])
    .sort();
  await expect.poll(async () => (await clipRequests(page)).filter((n) => V09.test(n)).length, { timeout: 10_000 }).toBe(14);
  await expect.poll(async () => (await clipRequests(page)).filter((n) => !V09.test(n)).map((n) => n.split('@')[0]).sort(), { timeout: 10_000 }).toEqual(v10);
  for (const name of await clipRequests(page)) expect(name).toMatch(new RegExp(`@${density}x`));

  // 動きを減らす設定: 描画しないので、追加素材も要求しない。
  const reduced = await browser.newContext({ ...info.project.use, reducedMotion: 'reduce' });
  const other = await reduced.newPage();
  await openSampleHome(other);
  await other.waitForTimeout(3_000);
  await expect(other.getByTestId('harimaru-layer')).toHaveCount(0);
  expect(await clipRequests(other)).toEqual([]);
  await reduced.close();

  // 表示 OFF のまま読み込み直しても要求しない。
  await tab(page, '設定 / バックアップ').click();
  await page.getByText('ハリマル', { exact: true }).click();
  await page.getByTestId('harimaru-toggle').uncheck();
  await page.reload();
  await expect(page.getByRole('heading', { name: 'サンプルチーム', level: 1 })).toBeVisible();
  await page.waitForTimeout(3_000);
  expect(await clipRequests(page)).toEqual([]);
});

test('画面を狭めても、隠れたままのハリマルが右端からはみ出して横スクロールを出さない', async ({ page }) => {
  // 2026-11-25 の本番デプロイで見つかった不具合: 画面幅を 393 → 320 px に狭めた直後、隠れた (不透明度 0) ハリマルが
  // 前の位置 (右端の外) に残り、スマホではレイアウト幅が広がって横スクロールが出た。時計を止めてその状態を固定する。
  await page.clock.install();
  await openSampleHome(page);
  await appear(page);
  await page.clock.pauseAt(Date.now() + 60_000);
  const width = page.viewportSize()!.width;
  // 隠れた状態 (不透明度 0) を作り、右端の手前に置く。
  await sprite(page).evaluate((el, x) => {
    const node = el as HTMLElement;
    node.dataset.visible = 'false';
    node.style.transform = `translate3d(${x}px, 200px, 0)`;
  }, width - 12);
  await page.setViewportSize({ width: Math.min(320, width - 40), height: 640 });
  // 縮めたあとの同じ瞬間に: 隠れたまま、右端の外に残っていて (resize で置き直されていない)、それでも横スクロールがない。
  const state = await sprite(page).evaluate((el) => {
    const doc = document.documentElement;
    return {
      opacity: getComputedStyle(el).opacity,
      outside: el.getBoundingClientRect().right > doc.clientWidth,
      sideways: doc.scrollWidth - doc.clientWidth,
    };
  });
  expect(state).toEqual({ opacity: '0', outside: true, sideways: 0 });
});
