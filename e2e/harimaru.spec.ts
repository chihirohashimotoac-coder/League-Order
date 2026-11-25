import { expect, test, type Page } from '@playwright/test';
import { tab } from './nav';
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
    // カードの裏に沈んで切り取られている部分 (clip-path の下側) は描かれていないので数えない。
    const clip = /inset\(0(?:px)? 0(?:px)? ([\d.]+)px/.exec((el as HTMLElement).style.clipPath || '');
    const clipped = clip ? parseFloat(clip[1]) : 0;
    const box = { left: r.left + 2.5, right: r.right - 2.5, top: r.top + 0.5, bottom: r.bottom - 0.5 - clipped };
    if (box.bottom <= box.top) return [];
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

test('既存のボタンはハリマルの有無で同じように動く (日程・結果への移動と、ホームへの戻り)', async ({ page }) => {
  await page.clock.install();
  await openSampleHome(page);
  await page.clock.runFor(4_000);
  await expect(sprite(page)).toHaveAttribute('data-visible', 'true');
  await page.getByTestId('home-results').click();
  // ボタンの操作はそのまま届き、画面が移る (ハリマルは移った先で足場を探し直す)。
  await expect(page.locator('.app-header h1')).not.toHaveText('サンプルチーム');
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
  await expect(sprite(page)).toHaveAttribute('data-visible', 'true', { timeout: 10_000 });
  // 隠れている・跳ねている間は待つ。
  await expect.poll(async () => sprite(page).evaluate((el) => !el.style.clipPath && ['idle', 'look', 'rest'].includes(el.dataset.action ?? '')), { timeout: 20_000 }).toBe(true);
}

test('顔をタップ・クリックすると喜び、下の画面の操作には何も起きない', async ({ page }) => {
  await openSampleHome(page);
  await waitStanding(page);
  const url = page.url();
  const actions = await watchActions(page);
  const point = await body(page);
  if (page.viewportSize()!.width < 600) await page.touchscreen.tap(point.faceX, point.y);
  else await page.mouse.click(point.faceX, point.y);
  await expect.poll(actions, { timeout: 3_000 }).toContain('happy');
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

test('どの画面でも、出るときは文字・操作部品・固定バーに重ならない (メンバー・フォーマット・履歴・設定・その他・観戦)', async ({ page }) => {
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
  expect(shownSomewhere, '足場のある画面のうち、いくつかには出る').toBeGreaterThan(2);
});

test('入力欄にフォーカスがある間は休み、離れると戻る', async ({ page }) => {
  await openSampleHome(page);
  await tab(page, 'メンバー').click();
  await page.evaluate(() => window.scrollTo(0, 0));
  await expect(sprite(page)).toHaveAttribute('data-visible', 'true', { timeout: 10_000 });
  const field = page.locator('.page-view input:not([type="checkbox"]):not([type="radio"]):visible').first();
  await field.focus();
  await expect(sprite(page)).toHaveAttribute('data-visible', 'false');
  await field.blur();
  await page.evaluate(() => window.scrollTo(0, 0));
  await expect(sprite(page)).toHaveAttribute('data-visible', 'true', { timeout: 10_000 });
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

test('PC: 近くで止まったカーソルに、気まぐれに近づくか顔を出す (カーソルは捕まえない)', async ({ page }, info) => {
  test.skip(info.project.name !== 'desktop', 'ホバーできる PC だけ');
  test.setTimeout(120_000);
  // 再現できる条件: 乱数の種・時計を固定し (登場の位置と気まぐれな抽選が毎回同じ)、眠っていない静かな行動から始める。
  // 時計は止めて、runFor でだけ進める (実時間で進むと、カーソルの動く速さや抽選の時刻が実行ごとに変わる)。
  await seedRandom(page, 20261125);
  await page.clock.install();
  await openSampleHome(page);
  await page.clock.pauseAt((await page.evaluate(() => Date.now())) + 1_000);
  await runUntilCalm(page);
  const actions = await watchActions(page);
  const cursorReactions = async (): Promise<string[]> => (await actions()).filter((action) => action === 'approach' || action === 'peek');
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
  await expect(sprite(page)).toHaveAttribute('data-visible', 'true', { timeout: 10_000 });
  expect(await overlaps(page)).toEqual([]);
});

/** 読み込んだ追加素材 v0.9 (動作ごとのアトラス) のファイル名。 */
const clipRequests = (page: Page): Promise<string[]> =>
  page.evaluate(() =>
    performance
      .getEntriesByType('resource')
      .map((e) => e.name.split('/').pop() ?? '')
      .filter((n) => /^(hang|slip|climb|cursorHang|tumble|sleepyFall|groom|stretch|lookUp|surprise|tilt|play|run|happy)@\dx/.test(n)),
  );

test('追加素材 v0.9 は登場のあとで画素密度に合う 1 組 (14 動作) だけを読み込み、表示 OFF・動きを減らす設定では読み込まない', async ({ page, browser }, info) => {
  await openSampleHome(page);
  await expect(sprite(page)).toHaveAttribute('data-visible', 'true', { timeout: 10_000 });
  await expect.poll(async () => (await clipRequests(page)).length, { timeout: 10_000 }).toBe(14);
  const density = info.project.name === 'mobile' ? 3 : 1;
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
