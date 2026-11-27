import { expect, test, type Page } from '@playwright/test';
import { blocking, harimaruOverlaps } from './harimaruOverlap';
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

/**
 * 登場の記録: 見えない間 (のぞいて引っ込んだあとなど) で区切った登場ごとに、最初に見えたコマは端に接し、そこから
 * 1 回に 12px (上下の端からは落ちる・登る速さのぶん 24px) を超えて跳ばない。最後の登場の端と、最初・最後のコマを返す。
 */
function checkEntry(trail: Sample[], view: { top: number; bottom: number; width: number }): { edge: string; first: Sample; last: Sample } {
  const runs: Sample[][] = [];
  let run: Sample[] = [];
  for (const s of trail) {
    if (s.visible && s.action === 'enter') run.push(s);
    else if (run.length > 0 && (!s.visible || s.action !== 'enter')) {
      runs.push(run);
      run = [];
    }
  }
  if (run.length > 0) runs.push(run);
  expect(runs.length, '登場').toBeGreaterThan(0);
  let edge = 'none';
  for (const entry of runs) {
    expect(entry.length, '登場の途中のコマ').toBeGreaterThan(5);
    const first = entry[0];
    edge = first.right <= 13 ? 'left' : first.left >= view.width - 13 ? 'right' : first.bottom <= view.top + 1 ? 'top' : first.top >= view.bottom - 1 ? 'bottom' : 'none';
    expect(edge, `最初に描いたコマは端の外 (${JSON.stringify(first)})`).not.toBe('none');
    for (let i = 1; i < entry.length; i += 1) {
      const jump = Math.hypot(entry[i].left - entry[i - 1].left, entry[i].top - entry[i - 1].top);
      expect(jump, `コマ ${i} (${entry[i - 1].frame} → ${entry[i].frame})`).toBeLessThan(edge === 'top' || edge === 'bottom' ? 24 : 12);
    }
  }
  for (const s of trail) expect(s.sideways, '横スクロール').toBeLessThanOrEqual(0);
  const last = runs[runs.length - 1];
  return { edge, first: last[0], last: last[last.length - 1] };
}

/** 表示枠が重なってはいけないもの (harimaruOverlap.ts の規則。移動中の文字の短いかぶりは除く)。 */
async function overlaps(page: Page): Promise<string[]> {
  return blocking(await page.evaluate(harimaruOverlaps));
}

/** PC の配置のまま、左右の端から 20px にカードがある幅 (1189 以上は列の外の空白が 24px を超え、左右から入れない)。 */
const PC_ENTRY = { width: 1100, height: 720 };

test('実際のホーム: 画面の左右の端から、見える画素が端から増えていくように入り、最初の足場に立つ (スマホ・PC 1100)', async ({ page }, info) => {
  const mobile = info.project.name === 'mobile';
  if (!mobile) await page.setViewportSize(PC_ENTRY);
  await fixed(page, 20261126);
  await openSample(page);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(1_500);
  const trail = await record(page);
  await untilStanding(page);
  const view = await viewport(page);
  const { edge, last } = checkEntry(await trail(), view);
  expect(['left', 'right']).toContain(edge);
  const frames = (await trail()).filter((s) => s.action === 'enter').map((s) => s.frame.split(':')[0]);
  expect(frames).toEqual(expect.arrayContaining(['jumpAir', 'jumpLand']));
  // 立った位置は、足元の真下に見えているデザイン (カード・タイル・ボタンなど) の上辺がある。
  const foot = await sprite(page).evaluate((el) => {
    const r = el.getBoundingClientRect();
    const tops = document.elementsFromPoint(r.left + r.width / 2, r.bottom + 2).filter((e) => e.closest('.app-main')).map((e) => Math.abs(e.getBoundingClientRect().top - r.bottom));
    return tops.length > 0 ? Math.min(...tops) : null;
  });
  expect(foot).not.toBeNull();
  expect(foot!).toBeLessThanOrEqual(1);
  expect(Math.round(last.bottom)).toBe(Math.round((await sprite(page).boundingBox())!.y + 20));
  expect(await overlaps(page)).toEqual([]);
});

test('PC 1280・1920: 左右の端の空白が広いホームでは、上下の端からも入らず画面の外で待つ。幅を 1100 に狭めると左右の端から入る', async ({ page }, info) => {
  test.skip(info.project.name !== 'desktop', 'PC のホーム (コンテンツの列の外の空白が広い)');
  test.setTimeout(120_000);
  await fixed(page, 20261126);
  await openSample(page);
  for (const size of [{ width: 1280, height: 720 }, { width: 1920, height: 1080 }]) {
    await page.setViewportSize(size);
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(1_500);
    const gutter = await page.evaluate(() => {
      const card = document.querySelector('.next-match-card')!.getBoundingClientRect();
      return { left: card.left, right: document.documentElement.clientWidth - card.right };
    });
    expect(Math.min(gutter.left, gutter.right), `${size.width}: 端からカードまでの空白`).toBeGreaterThan(24);
    // 先頭・次の試合のカードの下端が上端のすぐ下に来る位置 (以前は上端から落ちて入れた位置) のどちらでも待つ。
    for (const at of ['top', 'card'] as const) {
      await page.evaluate((where) => {
        if (where === 'top') window.scrollTo(0, 0);
        else {
          const card = document.querySelector('.next-match-card')!.getBoundingClientRect();
          window.scrollTo(0, Math.round(card.bottom + window.scrollY - document.querySelector('.app-header')!.getBoundingClientRect().bottom + 6));
        }
      }, at);
      for (let i = 0; i < 12; i += 1) {
        await page.clock.runFor(1_000);
        expect(await sprite(page).getAttribute('data-visible'), `${size.width} ${at} ${i} 秒`).toBe('false');
      }
    }
  }
  await page.evaluate(() => window.scrollTo(0, 0));
  const trail = await record(page);
  await page.setViewportSize(PC_ENTRY);
  await untilStanding(page);
  const { edge } = checkEntry(await trail(), await viewport(page));
  expect(['left', 'right']).toContain(edge);
});

test('PC 1100: 体が上へ完全に抜けるまでスクロールすると、元の位置で待つ。逆にスクロールすれば、元の位置がそのまま見えてくる', async ({ page }, info) => {
  test.skip(info.project.name !== 'desktop', 'PC のホーム');
  await page.setViewportSize(PC_ENTRY);
  await fixed(page, 20261126);
  await openSample(page);
  await page.evaluate(() => window.scrollTo(0, 0));
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
  await page.evaluate(() => window.scrollTo(0, 0));
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

test('検証用の足場: 下へ抜けたあと下端から戻るときは、画面の下へ続くカードの側面をよじ登り (前足は側面の線の上)、上辺に乗る', async ({ page }, info) => {
  test.skip(info.project.name !== 'desktop', 'PC 1280×720 の配置で確かめる (左右の端から届かない位置の高いカード)');
  await fixed(page, 7);
  await openSample(page);
  // A: 左端まで続く低い位置のカード (左から歩いて入る)。B: 左右の端から遠い、画面の下へ続く高いカード (上辺 460)。
  await lab(page, [[-80, 1_100, 380, 120], [500, 460, 260, 1_200]], 2_000);
  // 初めは先頭 (A は画面の下の外、B は端から遠い): 左右から入れないので待つ (上下の端からは入らない)。
  for (let i = 0; i < 6; i += 1) {
    await page.clock.runFor(1_000);
    expect(await sprite(page).getAttribute('data-visible'), `先頭 ${i} 秒`).toBe('false');
  }
  // A が画面の下の方に見える位置へ: 左の端から A に入る。
  const down = await page.evaluate(() => {
    const a = document.querySelectorAll('#harimaru-lab > .card')[0].getBoundingClientRect();
    const y = Math.round(a.top + window.scrollY - 600);
    window.scrollTo(0, y);
    return y;
  });
  expect(down).toBeGreaterThan(0);
  await untilStanding(page);
  // 先頭へ戻す: A (と体) は画面の下へ抜ける。下端から、画面の下へ続く B の側面をよじ登って戻る。
  const trail = await record(page);
  await page.evaluate(() => window.scrollTo(0, 0));
  // 抜けて見えなくなるまで (スクロールの処理を待つ)。
  await expect.poll(async () => {
    await page.clock.runFor(100);
    return sprite(page).getAttribute('data-visible');
  }).toBe('false');
  await untilStanding(page);
  const all = await trail();
  const view = await viewport(page);
  const { edge } = checkEntry(all, view);
  expect(edge).toBe('bottom');
  const order = all.filter((s) => s.action === 'enter').map((s) => s.frame.split(':')[0]).filter((f, i, list) => f !== list[i - 1]);
  expect(order.slice(order.indexOf('sideMount'))).toEqual(['sideMount', 'sideClimb', 'sideLedge', 'climb', 'base']);
  // 前足 (基準点) は側面の線の上 (画素への丸めの範囲)。
  const card = await page.evaluate(() => {
    const r = document.querySelectorAll('#harimaru-lab > .card')[1].getBoundingClientRect();
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
function hopsIn(all: Sample[]): { arc: number; distance: number; slid: boolean; from: number; to: number }[] {
  const hops: { arc: number; distance: number; slid: boolean; from: number; to: number }[] = [];
  for (let i = 0; i < all.length; i += 1) {
    if (!all[i].frame.startsWith('jumpPrep')) continue;
    let j = i + 1;
    const air: Sample[] = [];
    for (; j < all.length && all[j].frame.startsWith('jumpAir'); j += 1) air.push(all[j]);
    if (air.length < 3 || !all[j]?.frame.startsWith('jumpLand')) continue;
    const land: Sample[] = [];
    for (let k = j; k < all.length && all[k].frame.startsWith('jumpLand'); k += 1) land.push(all[k]);
    // 体の中心 (表示枠の中央) の、構えと着地の x。
    hops.push({ arc: all[i].top - Math.min(...air.map((s) => s.top)), distance: Math.abs(all[j].left - all[i].left), slid: new Set(land.map((s) => Math.round(s.left))).size > 1, from: all[i].left + 15, to: all[j].left + 15 });
  }
  return hops;
}

test('検証用の足場: 狭い隙間と広い隙間の小ジャンプは弧の高さが違い、前足 → 後ろ足で着地して横に滑らない', async ({ page }, info) => {
  test.skip(info.project.name !== 'desktop', 'PC 1280×720 の配置');
  test.setTimeout(300_000);
  await fixed(page, 11);
  await openSample(page);
  // 左端まで続くカード (歩いて入る) → 隙間 10px → 隙間 36px (跳び越える空白の上限 hopMaxGap 40px の内側)。
  await lab(page, [[-80, 300, 380, 120], [310, 300, 200, 120], [546, 300, 200, 120]], 600);
  // 2 つの隙間の中央 (画面の x)。小ジャンプは、どちらの隙間をまたいだかで分ける。
  const mids = await page.evaluate(() => {
    const q = Array.from(document.querySelectorAll('#harimaru-lab > .card')).map((c) => c.getBoundingClientRect());
    return [(q[0].right + q[1].left) / 2, (q[1].right + q[2].left) / 2];
  });
  const trail = await record(page);
  await untilStanding(page);
  const across = (h: { from: number; to: number }, mid: number): boolean => Math.min(h.from, h.to) < mid && Math.max(h.from, h.to) > mid;
  const hops = await watchUntil(page, trail, (all) => {
    const list = hopsIn(all);
    return list.some((h) => across(h, mids[0])) && list.some((h) => across(h, mids[1])) ? list : null;
  });
  expect(hops, '狭い隙間・広い隙間の両方の小ジャンプ').not.toBeNull();
  const narrow = hops!.filter((h) => across(h, mids[0]));
  const wide = hops!.filter((h) => across(h, mids[1]));
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
