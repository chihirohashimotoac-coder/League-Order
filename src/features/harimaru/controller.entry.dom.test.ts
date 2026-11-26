import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { seededRng } from './behavior';
import { HarimaruController } from './controller';
import { DEFAULT_BEHAVIOR, DEFAULT_MOTION, SPRITE, type MotionParams } from './params';
import { CLIP_IDS, CLIPS } from './sprite';
import type { Rect } from './terrain';
import type { MeasuredTerrain } from './terrainDom';

/**
 * 画面端からの登場 (上・下・左右)。描いている位置 (transform) が端の向こうから足場まで連続して動くこと、経路がなければ
 * 画面の外で待って条件の変化で確かめ直すこと、中断・引っ込み・逆スクロール・画面遷移の扱い。
 * jsdom の画面は 1024×768 (固定バーなし)。window.scrollY を差し替えてスクロールを表す。
 */

let now = 0;
let scrollY = 0;
let root: HTMLElement;
let app: HTMLElement;
let sprite: HTMLElement;
let controller: HarimaruController;
/** 足場の要素の箱 (ページ座標)。 */
let boxes: Rect[];

const view = () => ({ top: scrollY, bottom: scrollY + 768, left: 0, right: 1_024 });
const terrain = (): MeasuredTerrain => ({
  platforms: boxes.map((b) => ({ left: b.left, right: b.right, top: b.top })),
  boxes,
  obstacles: [],
  bounds: { left: 4, right: 1_020 },
  view: view(),
  docBottom: 3_000,
});

const calm: typeof DEFAULT_BEHAVIOR = {
  ...DEFAULT_BEHAVIOR,
  weights: { idle: 1, rest: 0, look: 0, walk: 0, run: 0, hop: 0, jump: 0, hide: 0, sleep: 0, groom: 0, stretch: 0 },
  sleepWhenInactive: 0,
};

function make(options: { seed?: number; motion?: Partial<MotionParams>; entryFrom?: 'left' | 'right' | null; sheets?: boolean } = {}): HarimaruController {
  controller = new HarimaruController({
    sprite,
    root,
    watch: app,
    platformSelector: '.x',
    rng: seededRng(options.seed ?? 1),
    now: () => now,
    measure: () => terrain(),
    obstaclesIn: () => [],
    behavior: calm,
    finePointer: false,
    motion: { ...DEFAULT_MOTION, entryRetreatChance: 0, ...options.motion },
    entryFrom: options.entryFrom ?? null,
  });
  controller.setSheet('base', 'base.png');
  if (options.sheets !== false) for (const id of CLIP_IDS) controller.setSheet(id, `${id}.png`);
  return controller;
}

function advance(ms: number): void {
  for (let t = 0; t < ms; t += 16) {
    now += 16;
    vi.advanceTimersByTime(16);
  }
}

/** 描いている表示枠の左上と、そのときのコマ・表示。 */
function drawn(): { left: number; top: number; frame: string; visible: boolean } {
  const m = /translate3d\(([-\d.]+)px, ([-\d.]+)px/.exec(sprite.style.transform);
  return { left: m ? Number(m[1]) : NaN, top: m ? Number(m[2]) : NaN, frame: sprite.dataset.frame ?? '', visible: sprite.dataset.visible === 'true' };
}

/** 立つまで、1 フレームごとに描いた位置を記録する。 */
function recordUntilPlaced(maxMs = 20_000): ReturnType<typeof drawn>[] {
  const out: ReturnType<typeof drawn>[] = [];
  for (let t = 0; t < maxMs && !controller.snapshot().placed; t += 16) {
    advance(16);
    if (sprite.dataset.visible === 'true') out.push(drawn());
  }
  return out;
}

function scrollTo(y: number): void {
  scrollY = y;
  window.dispatchEvent(new Event('scroll'));
}

const entries = () => controller.snapshot().events.filter((e) => e.startsWith('enter:'));

beforeEach(() => {
  vi.useFakeTimers();
  now = 0;
  scrollY = 0;
  vi.spyOn(window, 'scrollY', 'get').mockImplementation(() => scrollY);
  app = document.createElement('div');
  root = document.createElement('main');
  app.append(root);
  document.body.append(app);
  sprite = document.createElement('div');
  document.body.append(sprite);
  // 左端から 60 px のカード (左右の端から入れる距離)。
  boxes = [{ left: 60, right: 400, top: 300, bottom: 420 }];
});

afterEach(() => {
  controller?.destroy();
  document.body.innerHTML = '';
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('左右の端からの登場', () => {
  it('記録がなければ安全な経路のある左右どちらかから入る: 描いた位置は端の外から足場まで連続し、最後は足場に立つ', () => {
    make().start();
    const trail = recordUntilPlaced();
    const state = controller.snapshot();
    expect(state.placed).toBe(true);
    expect(entries()[0]).toMatch(/^enter:left:/);
    // 最初に描いたコマは左端の外 (セルの右端が 0 以下)、そこから 1 フレームに 12 px 以上は跳ばない。
    expect(trail[0].left + SPRITE.width).toBeLessThanOrEqual(0.01);
    for (let i = 1; i < trail.length; i += 1) expect(Math.abs(trail[i].left - trail[i - 1].left), `frame ${i}`).toBeLessThan(12);
    // 見えている画素が端から増えていく (立つ位置まで)。
    expect(Math.max(...trail.map((f) => f.left))).toBeCloseTo(state.x, 0);
    expect(state.top).toBe(300);
    expect(sprite.dataset.instant).toBe('true');
  });

  it('前の画面から引き継いだ側 (右) に経路がなければ、もう一方の側 (左) から入る', () => {
    make({ entryFrom: 'right' }).start();
    recordUntilPlaced();
    expect(entries()[0]).toMatch(/^enter:left:/);
  });

  it('引き継いだ側 (右) に経路があれば、その側から入る。初回は記録なしで、左右とも使える', () => {
    boxes = [{ left: 60, right: 400, top: 300, bottom: 420 }, { left: 640, right: 980, top: 300, bottom: 420 }];
    make({ entryFrom: 'right' }).start();
    recordUntilPlaced();
    expect(entries()[0]).toMatch(/^enter:right:/);
    expect(controller.snapshot().dir).toBe(-1);
    // いた位置に近い側を、次の画面へ引き継ぐ。
    expect(controller.exitSide()).toBe('right');
    controller.destroy();
    const sides = new Set<string>();
    for (let seed = 1; seed < 20 && sides.size < 2; seed += 1) {
      make({ seed }).start();
      recordUntilPlaced();
      sides.add(entries()[0].split(':')[1]);
      controller.destroy();
    }
    expect([...sides].sort()).toEqual(['left', 'right']);
  });

  it('のぞいて入る・立ち止まらず入る・のぞいて引っ込むがあり、引っ込んだ直後は空けてから、引っ込まずに入る', () => {
    const seen = new Set<string>();
    for (let seed = 1; seed < 40 && seen.size < 2; seed += 1) {
      make({ seed, motion: { entryRetreatChance: 0 } }).start();
      recordUntilPlaced();
      seen.add(entries()[0].split(':')[2]);
      controller.destroy();
    }
    expect([...seen].sort()).toEqual(['direct', 'peek']);

    make({ motion: { entryPeekChance: 1, entryRetreatChance: 1 } }).start();
    let retreatedAt: number | null = null;
    for (let t = 0; t < 30_000 && !controller.snapshot().placed; t += 16) {
      advance(16);
      if (retreatedAt === null && entries().some((e) => e.endsWith(':retreat')) && !controller.snapshot().entering) retreatedAt = now;
    }
    const list = entries();
    expect(list[0]).toMatch(/:retreat$/);
    expect(list[1]).toMatch(/:peek$/);
    // 引っ込んでいる間は見えない。次の登場は retreatCooldownMs の最小より後。
    expect(retreatedAt).not.toBeNull();
    const second = controller.snapshot();
    expect(second.placed).toBe(true);
    expect(now - retreatedAt!).toBeGreaterThanOrEqual(DEFAULT_MOTION.retreatCooldownMs[0]);
    // 引っ込んだ方向の意図を消さない (同じ左の端から入り直す)。
    expect(list[0].split(':')[1]).toBe(list[1].split(':')[1]);
  });
});

describe('経路がない・中断', () => {
  it('安全な経路がなければ画面の外で待ち (置き直さない)、DOM の変化で経路ができたら端から入る', async () => {
    // 端から遠いカード (左右の隙間・上からの落下が長すぎる)。
    boxes = [{ left: 400, right: 620, top: 600, bottom: 700 }];
    make().start();
    advance(6_000);
    expect(controller.snapshot().placed).toBe(false);
    expect(sprite.dataset.visible).toBe('false');
    expect(controller.snapshot().events.some((e) => e.startsWith('enter:none:'))).toBe(true);
    boxes = [{ left: 60, right: 400, top: 300, bottom: 420 }];
    root.append(document.createElement('section'));
    await Promise.resolve();
    recordUntilPlaced();
    expect(controller.snapshot().placed).toBe(true);
    expect(entries().filter((e) => !e.startsWith('enter:none'))).toHaveLength(1);
  });

  it('登場の途中のスクロールでは即座に隠れ、止まってから同じ意図で端から入り直す (二重に登場しない)', () => {
    make().start();
    for (let t = 0; t < 10_000 && !controller.snapshot().entering; t += 16) advance(16);
    advance(200);
    expect(controller.snapshot().entering).not.toBeNull();
    scrollTo(0);
    expect(sprite.dataset.visible).toBe('false');
    expect(controller.snapshot().entering).toBeNull();
    expect(controller.snapshot().airborne).toBe(false);
    // 止まったあと、新しい登場は 1 つだけ。登場の途中でないのに見えているフレームはない。
    let concurrent = 0;
    for (let t = 0; t < 15_000 && !controller.snapshot().placed; t += 16) {
      advance(16);
      const s = controller.snapshot();
      if (sprite.dataset.visible === 'true' && !s.entering && !s.placed) concurrent += 1;
    }
    expect(concurrent).toBe(0);
    expect(controller.snapshot().placed).toBe(true);
    expect(entries().filter((e) => !e.startsWith('enter:none'))).toHaveLength(2);
  });

  it('登場の途中でモーダルが開いたら隠れて空中の状態を残さず、閉じると端から入り直す', async () => {
    make().start();
    for (let t = 0; t < 10_000 && !controller.snapshot().entering; t += 16) advance(16);
    const modal = document.createElement('div');
    modal.setAttribute('aria-modal', 'true');
    app.append(modal);
    await Promise.resolve();
    let s = controller.snapshot();
    expect(sprite.dataset.visible).toBe('false');
    expect(s.paused).toContain('modal');
    expect(s.entering).toBeNull();
    expect(s.airborne).toBe(false);
    expect(s.timers).toBe(0);
    modal.remove();
    await Promise.resolve();
    recordUntilPlaced();
    s = controller.snapshot();
    expect(s.placed).toBe(true);
    expect(entries().filter((e) => !e.startsWith('enter:none'))).toHaveLength(2);
  });

  it('登場の途中で着地する足場が動いたら、その場で隠れて出直す。destroy でタイマーを残さない', () => {
    const el = document.createElement('div');
    let rect = { left: 60, right: 400, top: 300, bottom: 420 };
    el.getBoundingClientRect = () => ({ ...rect, width: rect.right - rect.left, height: rect.bottom - rect.top, x: rect.left, y: rect.top, toJSON: () => ({}) }) as DOMRect;
    root.append(el);
    controller = make();
    const measure = (): MeasuredTerrain => ({ ...terrain(), elements: [el] });
    (controller as unknown as { measureFn: () => MeasuredTerrain }).measureFn = measure;
    controller.start();
    for (let t = 0; t < 10_000 && !controller.snapshot().entering; t += 16) advance(16);
    advance(100);
    rect = { ...rect, top: 330 };
    advance(32);
    expect(controller.snapshot().events).toContain('hold:lost');
    expect(sprite.dataset.visible).toBe('false');
    controller.destroy();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('監査の指摘の回帰', () => {
  it('まだ入れていない間に続けてスクロールしても、止まるまでは登場を始めない (予約の時刻をまたいでも)', () => {
    make().start();
    // 登場の予約 (最長 2.6 秒) をまたいで、200ms ごとにスクロールし続ける。
    for (let t = 0; t < 4_000; t += 200) {
      scrollTo(0);
      advance(200);
      expect(controller.snapshot().entering, `t=${t}`).toBeNull();
      expect(sprite.dataset.visible).toBe('false');
    }
    recordUntilPlaced();
    expect(controller.snapshot().placed).toBe(true);
  });

  it('のぞいて引っ込んだ端から入り直す (左右とも安全で、乱数が反対の側を引いても)', () => {
    boxes = [{ left: 60, right: 400, top: 300, bottom: 420 }, { left: 640, right: 980, top: 300, bottom: 420 }];
    for (let seed = 1; seed < 8; seed += 1) {
      make({ seed, motion: { entryPeekChance: 1, entryRetreatChance: 1 } }).start();
      recordUntilPlaced(40_000);
      const list = entries().filter((e) => !e.startsWith('enter:none'));
      expect(list[0]).toMatch(/:retreat$/);
      expect(list[1].split(':')[1], `seed ${seed}`).toBe(list[0].split(':')[1]);
      controller.destroy();
    }
  });

  it('登場の途中に、近くで位置の変わるトランジションが始まる・フォーカスが移ると中断する', () => {
    for (const disturb of ['transition', 'focus'] as const) {
      make().start();
      for (let t = 0; t < 10_000 && !controller.snapshot().entering; t += 16) advance(16);
      advance(100);
      expect(controller.snapshot().entering).not.toBeNull();
      if (disturb === 'transition') {
        const el = document.createElement('div');
        root.append(el);
        const event = new Event('transitionrun', { bubbles: true });
        Object.defineProperty(event, 'propertyName', { value: 'transform' });
        el.dispatchEvent(event);
      } else {
        const button = document.createElement('button');
        root.append(button);
        button.focus();
      }
      expect(controller.snapshot().entering, disturb).toBeNull();
      expect(sprite.dataset.visible).toBe('false');
      expect(controller.snapshot().events).toContain('jump:aborted');
      controller.destroy();
    }
  });

  it('カード裏に沈んで一部が切り取られた姿は、見えている部分 (頭) が下端を抜けたときに抜けたとみなす', () => {
    scrollY = 600;
    boxes = [{ left: 60, right: 400, top: 1_000, bottom: 1_100 }];
    make().start();
    recordUntilPlaced();
    // 足元 1000 の姿を 14px 沈める (見えている頭 = 994。沈んでいなければ 980)。
    (controller as unknown as { sink: number }).sink = 14;
    // 見えている下端 = 990: 沈んでいない姿なら頭が見えているが、沈んだ姿は見えている部分がすべて下へ抜けている。
    scrollTo(222);
    advance(400);
    expect(controller.snapshot().intent).toBe('bottom');
  });
});

describe('スクロールで画面の外へ出たとき', () => {
  it('体が上へ完全に抜けたら上の端の意図を記録し、経路がなければ元の位置で待つ。逆にスクロールすると、元の位置がそのまま見えてくる', () => {
    make().start();
    recordUntilPlaced();
    const before = controller.snapshot();
    // 上へ抜ける (足元 300 ≤ 見えている上端 400)。
    scrollTo(400);
    advance(2_500);
    let s = controller.snapshot();
    expect(s.intent).toBe('top');
    expect(s.placed).toBe(true);
    expect(s.paused).toContain('offscreen');
    expect(s.events).toContain('enter:none:top');
    // 下の端からも左右からも入り直さない (別の端に置き直さない)。
    expect(entries().filter((e) => !e.startsWith('enter:none'))).toHaveLength(1);
    scrollTo(0);
    advance(600);
    s = controller.snapshot();
    expect(s.paused).toEqual([]);
    expect(s.x).toBe(before.x);
    expect(s.top).toBe(before.top);
    expect(s.intent).toBeNull();
    expect(entries().filter((e) => !e.startsWith('enter:none'))).toHaveLength(1);
  });

  it('上へ抜けたあと、上の端から足場へ経路があれば、上端から頭を見せて落ち、四足で着地する', () => {
    boxes = [{ left: 60, right: 400, top: 300, bottom: 420 }, { left: 500, right: 800, top: 560, bottom: 700 }];
    make().start();
    recordUntilPlaced();
    scrollTo(400);
    const trail = recordUntilPlaced(0);
    for (let t = 0; t < 10_000 && !controller.snapshot().entering; t += 16) advance(16);
    const frames: ReturnType<typeof drawn>[] = [...trail];
    for (let t = 0; t < 10_000 && controller.snapshot().entering; t += 16) {
      advance(16);
      frames.push(drawn());
    }
    expect(entries().pop()).toMatch(/^enter:top:/);
    const order = frames.map((f) => f.frame.split(':')[0]).filter((f, i, all) => f !== all[i - 1]);
    expect(order).toEqual(expect.arrayContaining(['peekTop', 'dropAir', 'dropLand']));
    expect(order.indexOf('peekTop')).toBeLessThan(order.indexOf('dropAir'));
    expect(order.indexOf('dropAir')).toBeLessThan(order.indexOf('dropLand'));
    // 最初のコマは見えている上端の上 (固定バーの裏・画面の外) から。
    const firstPeek = frames.find((f) => f.frame.startsWith('peekTop'))!;
    expect(firstPeek.top + SPRITE.height).toBeLessThanOrEqual(400 + 0.01);
    const s = controller.snapshot();
    expect(s.placed).toBe(true);
    expect(s.top).toBe(560);
    expect(s.intent).toBeNull();
  });

  it('下へ抜けたあと、画面の下へ続く要素の側面をよじ登って上辺に乗る (前足は側面の線の上)', () => {
    scrollY = 600;
    boxes = [{ left: 60, right: 400, top: 1_000, bottom: 1_100 }, { left: 520, right: 760, top: 560, bottom: 1_400 }];
    make().start();
    recordUntilPlaced();
    expect(controller.snapshot().top).toBe(1_000);
    // 体が下へ完全に抜ける (頭 980 ≥ 見えている下端 768)。
    scrollTo(0);
    for (let t = 0; t < 10_000 && !controller.snapshot().entering; t += 16) advance(16);
    expect(controller.snapshot().entering).toMatch(/^bottom:/);
    const frames: ReturnType<typeof drawn>[] = [];
    for (let t = 0; t < 15_000 && controller.snapshot().entering; t += 16) {
      advance(16);
      frames.push(drawn());
    }
    const order = frames.map((f) => f.frame.split(':')[0]).filter((f, i, all) => f !== all[i - 1]);
    expect(order.slice(order.indexOf('sideMount'))).toEqual(['sideMount', 'sideClimb', 'sideLedge', 'climb', 'base']);
    const s = controller.snapshot();
    const face = s.dir < 0 ? 760 : 520;
    for (const f of frames.filter((f) => f.frame.startsWith('sideClimb'))) {
      const a = CLIPS.sideClimb.anchors[Number(f.frame.split(':')[1])]!;
      // 画素への丸め (DPR 1) の範囲で、前足は側面の線の上。
      expect(Math.abs(f.left + (s.dir < 0 ? a[0] : SPRITE.width - a[0]) - face)).toBeLessThanOrEqual(0.5);
    }
    expect(frames[0].top).toBeGreaterThanOrEqual(768);
    expect(s.placed).toBe(true);
    expect(s.top).toBe(560);
  });
});
