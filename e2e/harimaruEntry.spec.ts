import { expect, test, type Page } from '@playwright/test';
import { seedRandom } from './seededRandom';

/**
 * ハリマル: 画面の端からの登場と、カード・ボタンの上辺・側面を使う移動 (動作素材 v1.0)。本番のビルドで、乱数と時計を
 * 読み込みの前に固定し (#66 と同じ)、時計は runFor でだけ進める。描いている位置 (getBoundingClientRect) とコマ
 * (data-frame) を、ページの中の MutationObserver で 1 つも取りこぼさずに記録して確かめる。
 */

const START = Date.parse('2026-11-26T03:00:00Z');
const sprite = (page: Page) => page.getByTestId('harimaru');

interface Sample {
  frame: string;
  action: string;
  visible: boolean;
  left: number;
  top: number;
  right: number;
  bottom: number;
  sideways: number;
}

async function fixed(page: Page, seed: number): Promise<void> {
  await seedRandom(page, seed);
  await page.clock.install({ time: START });
  await page.clock.pauseAt(START + 1_000);
}

async function openSample(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByRole('button', { name: 'サンプルで試す' }).click();
  await expect(page.getByRole('heading', { name: 'サンプルチーム', level: 1 })).toBeVisible();
}

/** 描くコマ・位置が変わるたびに記録する (時計で進めても、間のフレームを取りこぼさない)。 */
async function record(page: Page): Promise<() => Promise<Sample[]>> {
  await page.evaluate(() => {
    const el = document.querySelector<HTMLElement>('[data-testid="harimaru"]')!;
    const w = window as unknown as { __trail: Sample[]; __trailObserver?: MutationObserver };
    w.__trail = [];
    w.__trailObserver?.disconnect();
    const take = (): void => {
      const r = el.getBoundingClientRect();
      const doc = document.documentElement;
      w.__trail.push({
        frame: el.dataset.frame ?? '',
        action: el.dataset.action ?? '',
        visible: el.dataset.visible === 'true',
        left: r.left,
        top: r.top,
        right: r.right,
        bottom: r.bottom,
        sideways: doc.scrollWidth - doc.clientWidth,
      });
    };
    w.__trailObserver = new MutationObserver(take);
    w.__trailObserver.observe(el, { attributes: true, attributeFilter: ['style', 'data-frame', 'data-visible'] });
  });
  return () => page.evaluate(() => (window as unknown as { __trail: Sample[] }).__trail);
}

/** 端からの登場が終わって立つまで、時計を進める。 */
async function untilStanding(page: Page, maxMs = 40_000): Promise<void> {
  for (let spent = 0; spent <= maxMs; spent += 200) {
    if (await sprite(page).evaluate((el) => el.dataset.visible === 'true' && el.dataset.action !== 'enter')) return;
    await page.clock.runFor(200);
  }
  throw new Error('端から現れない');
}

/** 見えている範囲 (固定ヘッダーの下〜下部ナビの上)。 */
const viewport = (page: Page) =>
  page.evaluate(() => ({
    top: document.querySelector('.app-header')!.getBoundingClientRect().bottom,
    bottom: document.querySelector('.tab-bar')!.getBoundingClientRect().top,
    width: document.documentElement.clientWidth,
  }));

/** 登場の記録: 最初に見えたコマは端に接し、そこから足場に立つまで 1 回に 12px を超えて跳ばない。 */
function checkEntry(trail: Sample[], view: { top: number; bottom: number; width: number }): { edge: string; first: Sample; last: Sample } {
  const entry = trail.filter((s) => s.visible && s.action === 'enter');
  expect(entry.length, '登場の途中のコマ').toBeGreaterThan(5);
  const first = entry[0];
  const edge = first.right <= 13 ? 'left' : first.left >= view.width - 13 ? 'right' : first.bottom <= view.top + 1 ? 'top' : first.top >= view.bottom - 1 ? 'bottom' : 'none';
  expect(edge, `最初に描いたコマは端の外 (${JSON.stringify(first)})`).not.toBe('none');
  for (let i = 1; i < entry.length; i += 1) {
    const jump = Math.hypot(entry[i].left - entry[i - 1].left, entry[i].top - entry[i - 1].top);
    expect(jump, `コマ ${i} (${entry[i - 1].frame} → ${entry[i].frame})`).toBeLessThan(edge === 'top' || edge === 'bottom' ? 24 : 12);
  }
  for (const s of trail) expect(s.sideways, '横スクロール').toBeLessThanOrEqual(0);
  return { edge, first, last: entry[entry.length - 1] };
}

/** 表示枠に重なる操作部品・文字・固定バー (0.5px 未満の接触は除く)。 */
async function overlaps(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const el = document.querySelector('[data-testid="harimaru"]')!;
    const r = el.getBoundingClientRect();
    const box = { left: r.left + 2.5, right: r.right - 2.5, top: r.top + 0.5, bottom: r.bottom - 0.5 };
    // 固定ヘッダー・下部ナビの裏 (画面の端から入る途中) の部分は描かれていないので数えない。
    box.top = Math.max(box.top, document.querySelector('.app-header')!.getBoundingClientRect().bottom);
    box.bottom = Math.min(box.bottom, document.querySelector('.tab-bar')!.getBoundingClientRect().top);
    if (box.bottom <= box.top) return [];
    const hit = (q: DOMRect): boolean => q.right > box.left && q.left < box.right && q.bottom > box.top && q.top < box.bottom;
    const found: string[] = [];
    for (const node of Array.from(document.querySelectorAll('.app *'))) {
      if (!hit(node.getBoundingClientRect())) continue;
      if (node.matches('input, select, textarea, label, .app-header, .tab-bar, .action-bar')) found.push(`${node.tagName}.${node.className}`);
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

test('実際のホーム: 画面の端から、見える画素が端から増えていくように入り、最初の足場に立つ (スマホは左右、PC は上端)', async ({ page }, info) => {
  await fixed(page, 20261126);
  await openSample(page);
  const mobile = info.project.name === 'mobile';
  // スマホ: 先頭 (右端・左端からタイルへ跳んで入る)。PC: 左右の端からカードまで遠いので、上端からタイルへ落ちる位置。
  await page.evaluate((m) => {
    if (m) window.scrollTo(0, 0);
    else {
      const card = document.querySelector('.next-match-card')!.getBoundingClientRect();
      window.scrollTo(0, Math.round(card.bottom + window.scrollY - document.querySelector('.app-header')!.getBoundingClientRect().bottom + 6));
    }
  }, mobile);
  await page.waitForTimeout(1_500);
  const trail = await record(page);
  await untilStanding(page);
  const view = await viewport(page);
  const { edge, last } = checkEntry(await trail(), view);
  if (mobile) expect(['left', 'right']).toContain(edge);
  else expect(edge).toBe('top');
  const frames = (await trail()).filter((s) => s.action === 'enter').map((s) => s.frame.split(':')[0]);
  if (edge === 'top') {
    expect(frames).toEqual(expect.arrayContaining(['peekTop', 'dropAir', 'dropLand']));
    expect(frames.indexOf('peekTop')).toBeLessThan(frames.indexOf('dropAir'));
  } else {
    expect(frames).toEqual(expect.arrayContaining(['jumpAir', 'jumpLand']));
  }
  // 立った位置は、足元の真下に足場 (タイル) の上辺がある。
  const foot = await sprite(page).evaluate((el) => {
    const r = el.getBoundingClientRect();
    const below = document.elementsFromPoint(r.left + r.width / 2, r.bottom + 2).find((e) => e.matches('.quick-tile, .card'));
    return below ? Math.abs(below.getBoundingClientRect().top - r.bottom) : null;
  });
  expect(foot).not.toBeNull();
  expect(foot!).toBeLessThanOrEqual(1);
  expect(Math.round(last.bottom)).toBe(Math.round((await sprite(page).boundingBox())!.y + 20));
  expect(await overlaps(page)).toEqual([]);
});

test('PC: サンプルのホームの初期位置 (端からの安全な経路がない) では画面の外で待ち、スクロールで経路ができると端から入る', async ({ page }, info) => {
  test.skip(info.project.name !== 'desktop', 'PC のホーム (左右の端からカードまで遠い)');
  await fixed(page, 20261126);
  await openSample(page);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(1_500);
  // 先頭: 左右の端からは遠く、上端からはカードにふさがれる。置き直さずに待つ。
  for (let i = 0; i < 20; i += 1) {
    await page.clock.runFor(1_000);
    expect(await sprite(page).getAttribute('data-visible'), `${i} 秒`).toBe('false');
  }
  const trail = await record(page);
  await page.evaluate(() => {
    const card = document.querySelector('.next-match-card')!.getBoundingClientRect();
    window.scrollTo(0, Math.round(card.bottom + window.scrollY - document.querySelector('.app-header')!.getBoundingClientRect().bottom + 6));
  });
  await untilStanding(page);
  const { edge } = checkEntry(await trail(), await viewport(page));
  expect(edge).toBe('top');
});

test('PC: 体が上へ完全に抜けるまでスクロールすると、元の位置で待つ。逆にスクロールすれば、元の位置がそのまま見えてくる', async ({ page }, info) => {
  test.skip(info.project.name !== 'desktop', 'PC のホーム (上端から入れる位置がある)');
  await fixed(page, 20261126);
  await openSample(page);
  const entryY = await page.evaluate(() => {
    const card = document.querySelector('.next-match-card')!.getBoundingClientRect();
    const y = Math.round(card.bottom + window.scrollY - document.querySelector('.app-header')!.getBoundingClientRect().bottom + 6);
    window.scrollTo(0, y);
    return y;
  });
  await page.waitForTimeout(1_500);
  await untilStanding(page);
  const before = await sprite(page).evaluate((el) => ({ x: el.getBoundingClientRect().left, y: el.getBoundingClientRect().top + window.scrollY }));
  // 一番下までスクロール (足場のタイルは見えている上端より上へ抜ける)。
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  await page.clock.runFor(4_000);
  const away = await sprite(page).evaluate((el) => ({ bottom: el.getBoundingClientRect().bottom, header: document.querySelector('.app-header')!.getBoundingClientRect().bottom, action: el.dataset.action }));
  expect(away.bottom).toBeLessThanOrEqual(away.header);
  expect(away.action).not.toBe('enter');
  // 戻す: 同じ場所に (置き直さずに) いる。
  await page.evaluate((y) => window.scrollTo(0, y), entryY);
  await page.clock.runFor(1_500);
  const after = await sprite(page).evaluate((el) => ({ x: el.getBoundingClientRect().left, y: el.getBoundingClientRect().top + window.scrollY, visible: el.dataset.visible }));
  expect(after.visible).toBe('true');
  expect(after.x).toBeCloseTo(before.x, 0);
  expect(after.y).toBeCloseTo(before.y, 0);
});

test('スマホ: 端から入っている途中に幅を 393 → 320 px に縮めても横スクロールが出ず、中断して端から入り直す', async ({ page }, info) => {
  test.skip(info.project.name !== 'mobile', 'スマホの幅の縮小 (#64)');
  await fixed(page, 20261126);
  await openSample(page);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(1_500);
  // 登場が始まるまで進め、途中で幅を縮める。
  for (let i = 0; i < 200 && (await sprite(page).getAttribute('data-action')) !== 'enter'; i += 1) await page.clock.runFor(50);
  await page.clock.runFor(150);
  expect(await sprite(page).getAttribute('data-action')).toBe('enter');
  await page.setViewportSize({ width: 320, height: 640 });
  const sideways = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(sideways).toBeLessThanOrEqual(0);
  const trail = await record(page);
  await page.clock.runFor(200);
  expect(await sprite(page).getAttribute('data-visible')).toBe('false');
  await page.evaluate(() => window.scrollTo(0, 0));
  await untilStanding(page);
  for (const s of await trail()) expect(s.sideways).toBeLessThanOrEqual(0);
  expect(await overlaps(page)).toEqual([]);
});

/** 検証用の足場 (実アプリの .card と同じ見た目・判定) をホームの先頭に差し込み、ほかの中身を隠す。 */
async function lab(page: Page, cards: [number, number, number, number][], height: number): Promise<void> {
  await page.evaluate(
    ({ cards, height }) => {
      document.querySelector<HTMLElement>('.home-grid')!.style.display = 'none';
      document.querySelector<HTMLElement>('.demo-banner')!.style.display = 'none';
      const wrap = document.createElement('div');
      wrap.id = 'harimaru-lab';
      wrap.style.cssText = `position:relative;height:${height}px`;
      for (const [left, top, width, h] of cards) {
        const card = document.createElement('div');
        card.className = 'card';
        card.style.cssText = `position:absolute;left:${left}px;top:${top}px;width:${width}px;height:${h}px;margin:0;box-sizing:border-box`;
        wrap.append(card);
      }
      document.querySelector('.page-view')!.prepend(wrap);
      window.scrollTo(0, 0);
    },
    { cards, height },
  );
}

test('検証用の足場: 下端から入るときは、画面の下へ続くカードの側面をよじ登り (前足は側面の線の上)、上辺に乗る', async ({ page }, info) => {
  test.skip(info.project.name !== 'desktop', 'PC 1280×720 の配置で確かめる (左右・上端からは届かない位置のカード)');
  await fixed(page, 7);
  await openSample(page);
  // 左右の端から 120px より遠く、上端から 240px より低く、画面の下 (720) へ続くカード。上辺 = 77 + 460 = 537。
  await lab(page, [[300, 460, 260, 800]], 1_400);
  const trail = await record(page);
  await untilStanding(page);
  const all = await trail();
  const view = await viewport(page);
  const { edge } = checkEntry(all, view);
  expect(edge).toBe('bottom');
  const order = all.filter((s) => s.action === 'enter').map((s) => s.frame.split(':')[0]).filter((f, i, list) => f !== list[i - 1]);
  expect(order.slice(order.indexOf('sideMount'))).toEqual(['sideMount', 'sideClimb', 'sideLedge', 'climb', 'base']);
  // 前足 (基準点) は側面の線の上 (画素への丸めの範囲)。
  const card = await page.evaluate(() => {
    const r = document.querySelectorAll('#harimaru-lab > .card')[0].getBoundingClientRect();
    return { left: r.left, right: r.right, top: r.top };
  });
  for (const s of all.filter((x) => x.frame.startsWith('sideClimb'))) {
    const mirrored = Math.abs(s.left + 30 - 7.67 - card.left) <= 0.6;
    const plain = Math.abs(s.left + 7.67 - card.right) <= 0.6;
    expect(mirrored || plain, `sideClimb at ${s.left}`).toBe(true);
  }
  const stand = (await sprite(page).boundingBox())!;
  expect(stand.y + 20).toBeCloseTo(card.top, 0);
});

/** 時計を進めながら、条件を満たす記録が得られるまで待つ (無操作で眠りやすくなるので、ときどきキーを押す)。 */
async function watchUntil<T>(page: Page, trail: () => Promise<Sample[]>, found: (all: Sample[]) => T | null, rounds = 150): Promise<T | null> {
  for (let round = 0; round < rounds; round += 1) {
    await page.keyboard.press('Shift');
    await page.clock.runFor(4_000);
    await page.evaluate(() => window.scrollTo(0, 0));
    const result = found(await trail());
    if (result) return result;
  }
  return null;
}

/** 記録の中の横の小ジャンプ (構え → 空中 → 着地)。着地 0 → 1 の間に横へ動いた回数も数える。 */
function hopsIn(all: Sample[]): { arc: number; distance: number; slid: boolean }[] {
  const hops: { arc: number; distance: number; slid: boolean }[] = [];
  for (let i = 0; i < all.length; i += 1) {
    if (!all[i].frame.startsWith('jumpPrep')) continue;
    let j = i + 1;
    const air: Sample[] = [];
    for (; j < all.length && all[j].frame.startsWith('jumpAir'); j += 1) air.push(all[j]);
    if (air.length < 3 || !all[j]?.frame.startsWith('jumpLand')) continue;
    const land: Sample[] = [];
    for (let k = j; k < all.length && all[k].frame.startsWith('jumpLand'); k += 1) land.push(all[k]);
    hops.push({ arc: all[i].top - Math.min(...air.map((s) => s.top)), distance: Math.abs(all[j].left - all[i].left), slid: new Set(land.map((s) => Math.round(s.left))).size > 1 });
  }
  return hops;
}

test('検証用の足場: 狭い隙間と広い隙間の小ジャンプは弧の高さが違い、前足 → 後ろ足で着地して横に滑らない', async ({ page }, info) => {
  test.skip(info.project.name !== 'desktop', 'PC 1280×720 の配置');
  test.setTimeout(300_000);
  await fixed(page, 11);
  await openSample(page);
  // 左端まで続くカード (歩いて入る) → 隙間 10px → 隙間 60px。
  await lab(page, [[-80, 300, 380, 120], [310, 300, 200, 120], [570, 300, 200, 120]], 600);
  const trail = await record(page);
  await untilStanding(page);
  const hops = await watchUntil(page, trail, (all) => {
    const list = hopsIn(all);
    return list.some((h) => h.distance < 100) && list.some((h) => h.distance > 105) ? list : null;
  });
  expect(hops, '狭い隙間・広い隙間の両方の小ジャンプ').not.toBeNull();
  const narrow = hops!.filter((h) => h.distance < 100);
  const wide = hops!.filter((h) => h.distance > 105);
  expect(Math.max(...wide.map((h) => h.arc))).toBeGreaterThan(Math.max(...narrow.map((h) => h.arc)) + 4);
  expect(hops!.filter((h) => h.slid)).toEqual([]);
});

test('検証用の足場: 低いカードへは下をのぞいて飛び降り (四足で着地)、高いカードへは側面をよじ登る', async ({ page }, info) => {
  test.skip(info.project.name !== 'desktop', 'PC 1280×720 の配置');
  test.setTimeout(300_000);
  await fixed(page, 11);
  await openSample(page);
  // 左端まで続く高いカードと、その右の側面の下から続く低いカード (110px 下)。低いカードの上辺は高いカードの側面で切れる。
  await lab(page, [[-80, 410, 900, 120], [-80, 300, 420, 160]], 600);
  const trail = await record(page);
  await untilStanding(page);
  const seen = await watchUntil(page, trail, (all) => {
    const order = all.map((s) => s.frame.split(':')[0]).filter((f, i, list) => f !== list[i - 1]);
    const drop = order.findIndex((f, i) => f === 'lookDown' && order[i + 1] === 'dropAir' && order[i + 2] === 'dropLand');
    const climb = order.findIndex((f, i) => f === 'sideMount' && order[i + 1] === 'sideClimb' && order[i + 2] === 'sideLedge' && order[i + 3] === 'climb');
    return drop >= 0 && climb >= 0 ? { all, order } : null;
  }, 200);
  expect(seen, '飛び降りと、側面のよじ登りの両方').not.toBeNull();
  // 飛び降りの着地は四足のコマ (横の小ジャンプの着地とは別)。
  const landing = seen!.all.filter((s) => s.frame.startsWith('dropLand'));
  expect(landing.length).toBeGreaterThan(0);
  expect(seen!.order.filter((f, i, o) => f === 'dropAir' && o[i + 1] === 'jumpLand')).toEqual([]);
  // よじ登る間、前足 (基準点) は高いカードの右の側面の線の上。
  const face = await page.evaluate(() => document.querySelectorAll('#harimaru-lab > .card')[1].getBoundingClientRect().right);
  for (const s of seen!.all.filter((x) => x.frame.startsWith('sideClimb'))) expect(Math.abs(s.left + 7.67 - face), `sideClimb at ${s.left}`).toBeLessThanOrEqual(0.6);
});
