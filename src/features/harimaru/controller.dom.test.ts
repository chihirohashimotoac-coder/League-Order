import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { seededRng } from './behavior';
import { HarimaruController } from './controller';
import { DEFAULT_ANIMATION, DEFAULT_BEHAVIOR, DEFAULT_INTERACTION, DEFAULT_MOTION, DEFAULT_TIMING } from './params';
import type { MeasuredTerrain } from './terrainDom';

const VIEW = { top: 0, bottom: 800, left: 0, right: 1_000 };
const terrain = (platforms: MeasuredTerrain['platforms'], view = VIEW): MeasuredTerrain => ({
  platforms,
  obstacles: [],
  bounds: { left: 0, right: 1_000 },
  view,
});

let now = 0;
let current: MeasuredTerrain;
let root: HTMLElement;
let app: HTMLElement;
let sprite: HTMLElement;
let controller: HarimaruController;

function make(seed = 1): HarimaruController {
  controller = new HarimaruController({
    sprite,
    root,
    watch: app,
    platformSelector: '.x',
    rng: seededRng(seed),
    now: () => now,
    measure: () => current,
  });
  return controller;
}

function advance(ms: number): void {
  // requestAnimationFrame もフェイクタイマーで進む。
  for (let t = 0; t < ms; t += 16) {
    now += 16;
    vi.advanceTimersByTime(16);
  }
}

beforeEach(() => {
  vi.useFakeTimers();
  now = 0;
  app = document.createElement('div');
  root = document.createElement('main');
  app.append(root);
  document.body.append(app);
  sprite = document.createElement('div');
  document.body.append(sprite);
  current = terrain([{ left: 100, right: 500, top: 300 }]);
});

afterEach(() => {
  controller?.destroy();
  document.body.innerHTML = '';
  vi.useRealTimers();
});

describe('HarimaruController', () => {
  it('少し待ってから、画面の端の向こうから入り、足場の上に 1 回だけ立つ (足元 = 上辺、全高 20px の枠)', () => {
    make().start();
    expect(sprite.dataset.visible).toBe('false');
    let entered = false;
    let firstX: number | null = null;
    for (let i = 0; i < 400 && !controller.snapshot().placed; i += 1) {
      advance(16);
      const state = controller.snapshot();
      if (state.entering && state.abs && firstX === null) firstX = state.abs.x;
      if (state.entering) entered = true;
    }
    const state = controller.snapshot();
    expect(entered).toBe(true);
    // 最初のコマは端の向こう (左端の外、または右端の外) に描かれる。
    expect(firstX! + 30 <= VIEW.left + 0.01 || firstX! >= VIEW.right - 0.01).toBe(true);
    expect(sprite.dataset.visible).toBe('true');
    expect(state.placed).toBe(true);
    expect(state.top).toBe(300);
    expect(state.events.filter((e) => e.startsWith('enter:') && !e.includes('retreat'))).toHaveLength(1);
    expect(sprite.style.transform).toMatch(/translate3d\([\d.]+px, 280px, 0(px)?\)/);
  });

  it('安全な足場がなければ表示しない', () => {
    current = terrain([]);
    make().start();
    advance(5_000);
    expect(controller.snapshot().placed).toBe(false);
    expect(sprite.dataset.visible).toBe('false');
  });

  it('歩くと実際に位置が変わり、足場の外に出ない', () => {
    make(3).start();
    const xs = new Set<number>();
    for (let i = 0; i < 600; i += 1) {
      advance(100);
      const { x, placed } = controller.snapshot();
      if (!placed) continue;
      xs.add(Math.round(x));
      expect(x).toBeGreaterThanOrEqual(100 + 12 - 2 - 0.01);
      expect(x).toBeLessThanOrEqual(500 - 12 - 30 + 2 + 0.01);
    }
    expect(xs.size).toBeGreaterThan(5);
  });

  it('無操作が続くと眠る', () => {
    make(5).start();
    const seen = new Set<string>();
    for (let i = 0; i < 1_500; i += 1) {
      advance(100);
      seen.add(controller.snapshot().action ?? '');
    }
    expect(seen.has('sleep')).toBe(true);
    expect(seen.has('walk')).toBe(true);
    expect(seen.has('idle')).toBe(true);
  });

  it('モーダルが開くと隠れてタイマーを止め、閉じると戻る', async () => {
    make().start();
    advance(3_000);
    expect(controller.snapshot().placed).toBe(true);
    const dialog = document.createElement('div');
    dialog.setAttribute('aria-modal', 'true');
    app.append(dialog);
    await Promise.resolve();
    expect(sprite.dataset.visible).toBe('false');
    expect(controller.snapshot().paused).toContain('modal');
    expect(controller.snapshot().timers).toBe(0);
    expect(controller.snapshot().frame).toBe(false);
    // 休止中はスクロール・DOM の変化があっても計測の予約を残さない。
    window.dispatchEvent(new Event('scroll'));
    window.dispatchEvent(new Event('resize'));
    expect(controller.snapshot().auxTimers).toBe(0);
    dialog.remove();
    await Promise.resolve();
    expect(sprite.dataset.visible).toBe('true');
  });

  it('足場の近くで位置の変わるトランジションが始まると即座に隠れ、終わると足元を合わせて戻る', () => {
    make().start();
    advance(3_000);
    const { x, top } = controller.snapshot();
    const tile = document.createElement('button');
    root.append(tile);
    tile.getBoundingClientRect = () => ({ left: x, right: x + 100, top, bottom: top + 80, width: 100, height: 80, x, y: top, toJSON: () => ({}) }) as DOMRect;
    const run = (type: string, propertyName: string): void => {
      const event = new Event(type, { bubbles: true });
      Object.defineProperty(event, 'propertyName', { value: propertyName });
      tile.dispatchEvent(event);
    };
    // 色・影だけのトランジションでは隠れない。
    run('transitionrun', 'box-shadow');
    expect(sprite.dataset.visible).toBe('true');
    run('transitionrun', 'transform');
    expect(sprite.dataset.visible).toBe('false');
    expect(controller.snapshot().paused).toContain('shift');
    // ホバーで 2px 浮いた足場に合わせ直す。
    current = terrain([{ left: 100, right: 500, top: 298 }]);
    run('transitionend', 'transform');
    expect(sprite.dataset.visible).toBe('true');
    expect(controller.snapshot().top).toBe(298);
  });

  it('位置の変わるアニメーションの終了が届かなくても、一定時間で戻る', () => {
    make().start();
    advance(3_000);
    const { x, top } = controller.snapshot();
    const card = document.createElement('div');
    root.append(card);
    card.getBoundingClientRect = () => ({ left: x - 50, right: x + 50, top: top - 10, bottom: top + 60, width: 100, height: 70, x: x - 50, y: top - 10, toJSON: () => ({}) }) as DOMRect;
    card.dispatchEvent(new Event('animationstart', { bubbles: true }));
    expect(sprite.dataset.visible).toBe('false');
    advance(2_100);
    expect(sprite.dataset.visible).toBe('true');
  });

  it('タブが非表示の間は止まる', () => {
    make().start();
    advance(3_000);
    const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
    document.dispatchEvent(new Event('visibilitychange'));
    expect(controller.snapshot().timers).toBe(0);
    expect(sprite.dataset.visible).toBe('false');
    hidden.mockReturnValue(false);
    document.dispatchEvent(new Event('visibilitychange'));
    expect(sprite.dataset.visible).toBe('true');
    hidden.mockRestore();
  });

  it('足場が動いたら姿を消し、新しい安全な場所から出直す', () => {
    make().start();
    advance(3_000);
    current = terrain([{ left: 100, right: 500, top: 420 }]);
    window.dispatchEvent(new Event('resize'));
    advance(DEFAULT_TIMING.remeasureDebounceMs + 20);
    expect(sprite.dataset.visible).toBe('false');
    advance(4_000);
    expect(controller.snapshot().top).toBe(420);
    expect(sprite.dataset.visible).toBe('true');
  });

  it('乗っている足場がホバーで浮いても消えず、上辺に合わせて一緒に動く', () => {
    const tile = document.createElement('button');
    root.append(tile);
    let tileTop = 300;
    tile.getBoundingClientRect = () => ({ left: 100, right: 500, top: tileTop, bottom: tileTop + 80, width: 400, height: 80, x: 100, y: tileTop, toJSON: () => ({}) }) as DOMRect;
    current = { ...terrain([{ left: 100, right: 500, top: 300 }]), elements: [tile] };
    make().start();
    advance(3_000);
    expect(sprite.dataset.visible).toBe('true');
    const run = (type: string): void => {
      const event = new Event(type, { bubbles: true });
      Object.defineProperty(event, 'propertyName', { value: 'transform' });
      tile.dispatchEvent(event);
    };
    run('transitionrun');
    expect(sprite.dataset.visible).toBe('true');
    expect(controller.snapshot().paused).toEqual([]);
    tileTop = 298;
    advance(50);
    expect(controller.snapshot().top).toBe(298);
    expect(sprite.style.transform).toMatch(/, 278px, 0(px)?\)/);
    run('transitionend');
    tileTop = 300;
    run('transitionrun');
    advance(50);
    expect(controller.snapshot().top).toBe(300);
    run('transitionend');
    expect(sprite.dataset.visible).toBe('true');
    expect(controller.snapshot().auxTimers).toBeLessThanOrEqual(1);
  });

  it('歩いて浮いたタイルに乗り移るときも、足元をそのタイルの上辺に合わせる', () => {
    const low = document.createElement('div');
    const high = document.createElement('div');
    root.append(low, high);
    // 同じ段で重なり合う 2 つの足場 (角丸の内側どうしが重なるので 1 本につながる。隙間のあるタイルは別の足場)。
    low.getBoundingClientRect = () => ({ left: 100, right: 330, top: 300, bottom: 380, width: 230, height: 80, x: 100, y: 300, toJSON: () => ({}) }) as DOMRect;
    high.getBoundingClientRect = () => ({ left: 290, right: 500, top: 298, bottom: 380, width: 210, height: 80, x: 290, y: 298, toJSON: () => ({}) }) as DOMRect;
    current = { ...terrain([{ left: 100, right: 330, top: 300 }, { left: 290, right: 500, top: 298 }]), elements: [low, high] };
    make(3).start();
    let sawHigh = false;
    // 端から入ったあと、気まぐれに歩いて浮いたタイルの上へ来るまで (乱数は固定)。
    for (let i = 0; i < 2_400 && !sawHigh; i += 1) {
      advance(100);
      const { placed, x, top } = controller.snapshot();
      if (!placed) continue;
      const overHigh = x + 30 - 2 > 290;
      // 浮いたタイルの上に体がかかっていれば、その上辺 (298) に立つ。
      if (overHigh) {
        sawHigh = true;
        expect(top).toBe(298);
      }
    }
    expect(sawHigh).toBe(true);
  });

  it('歩いて向かう先 (同じ足場の遠い端) のタイルが動き始めても隠れる', () => {
    make().start();
    advance(3_000);
    const { top } = controller.snapshot();
    const farTile = document.createElement('button');
    root.append(farTile);
    // 足場は x 100〜500。キャラクターから離れた右端のタイル。
    farTile.getBoundingClientRect = () => ({ left: 440, right: 500, top, bottom: top + 80, width: 60, height: 80, x: 440, y: top, toJSON: () => ({}) }) as DOMRect;
    const event = new Event('transitionrun', { bubbles: true });
    Object.defineProperty(event, 'propertyName', { value: 'transform' });
    farTile.dispatchEvent(event);
    expect(sprite.dataset.visible).toBe('false');
  });

  it('同じ要素の別のプロパティ・別のアニメーションが終わっても、位置の動きが終わるまで隠れたまま', () => {
    make().start();
    advance(3_000);
    const { x, top } = controller.snapshot();
    const tile = document.createElement('button');
    root.append(tile);
    tile.getBoundingClientRect = () => ({ left: x, right: x + 100, top, bottom: top + 80, width: 100, height: 80, x, y: top, toJSON: () => ({}) }) as DOMRect;
    const fire = (type: string, props: Record<string, string>): void => {
      const event = new Event(type, { bubbles: true });
      for (const [key, value] of Object.entries(props)) Object.defineProperty(event, key, { value });
      tile.dispatchEvent(event);
    };
    fire('transitionrun', { propertyName: 'transform' });
    fire('animationstart', { animationName: 'lift' });
    fire('transitionend', { propertyName: 'border-color' });
    expect(sprite.dataset.visible).toBe('false');
    fire('transitionend', { propertyName: 'transform' });
    expect(sprite.dataset.visible).toBe('false');
    fire('animationend', { animationName: 'lift' });
    expect(sprite.dataset.visible).toBe('true');
  });

  it('保険の確認でまだ動いていれば隠れたまま、長く続けば姿を消して出直す', () => {
    make().start();
    advance(3_000);
    const { x, top } = controller.snapshot();
    const tile = document.createElement('div');
    root.append(tile);
    tile.getBoundingClientRect = () => ({ left: x, right: x + 100, top, bottom: top + 80, width: 100, height: 80, x, y: top, toJSON: () => ({}) }) as DOMRect;
    let running = true;
    (tile as unknown as { getAnimations: () => unknown[] }).getAnimations = () =>
      running ? [{ playState: 'running', effect: { getTiming: () => ({ iterations: 1 }) } }] : [];
    tile.dispatchEvent(new Event('animationstart', { bubbles: true }));
    advance(2_100);
    expect(sprite.dataset.visible).toBe('false');
    advance(2_000 * 5);
    expect(controller.snapshot().placed).toBe(false);
    running = false;
    advance(4_000);
    expect(controller.snapshot().placed).toBe(true);
    expect(sprite.dataset.visible).toBe('true');
  });

  it('休止中 (モーダル) は位置の動きを見張らず、タイマーも予約しない', async () => {
    make().start();
    advance(3_000);
    const dialog = document.createElement('div');
    dialog.setAttribute('aria-modal', 'true');
    app.append(dialog);
    await Promise.resolve();
    const { x, top } = controller.snapshot();
    const tile = document.createElement('div');
    root.append(tile);
    await Promise.resolve();
    advance(300);
    tile.getBoundingClientRect = () => ({ left: x, right: x + 100, top, bottom: top + 80, width: 100, height: 80, x, y: top, toJSON: () => ({}) }) as DOMRect;
    tile.dispatchEvent(new Event('animationstart', { bubbles: true }));
    expect(controller.snapshot().paused).not.toContain('shift');
    expect(controller.snapshot().auxTimers).toBe(0);
    expect(controller.snapshot().timers).toBe(0);
  });

  it('タブが非表示のまま始まったら、登場を予約しない', () => {
    const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
    make().start();
    expect(controller.snapshot().timers).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    hidden.mockReturnValue(false);
    document.dispatchEvent(new Event('visibilitychange'));
    advance(3_000);
    expect(sprite.dataset.visible).toBe('true');
    hidden.mockRestore();
  });

  it('DOM の変化で足場が消えたら、再計測のまとめ待ちをせずに (描画の前に) 消える', async () => {
    make().start();
    advance(3_000);
    expect(sprite.dataset.visible).toBe('true');
    // 旧座標にボタンが入った: 足場はもう使えない。
    current = { ...terrain([{ left: 100, right: 500, top: 300 }]), obstacles: [{ left: 0, right: 1_000, top: 285, bottom: 299 }] };
    root.append(document.createElement('button'));
    await Promise.resolve();
    // 確認は次の描画の直前 (requestAnimationFrame) に 1 回: 変化が描画される前に消えている。
    vi.advanceTimersByTime(17);
    expect(sprite.dataset.visible).toBe('false');
    expect(controller.snapshot().placed).toBe(false);
  });

  it('ピンチズームで横方向の見える範囲が狭まったら、その中だけを歩く', () => {
    make(11).start();
    advance(3_000);
    const { x } = controller.snapshot();
    const view = { ...VIEW, left: Math.max(100, x - 40), right: Math.min(500, x + 70) };
    current = { ...terrain([{ left: 100, right: 500, top: 300 }]), view };
    for (let i = 0; i < 400; i += 1) {
      advance(100);
      const state = controller.snapshot();
      if (!state.placed || state.paused.length > 0) continue;
      expect(state.x + 2).toBeGreaterThanOrEqual(view.left - 0.01);
      expect(state.x + 30 - 2).toBeLessThanOrEqual(view.right + 0.01);
    }
  });

  it('位置の動きで隠れたあとにモーダルが開いても、見張りのタイマーを残さない', async () => {
    make().start();
    advance(3_000);
    const { x, top } = controller.snapshot();
    const tile = document.createElement('div');
    root.append(tile);
    await Promise.resolve();
    tile.getBoundingClientRect = () => ({ left: x, right: x + 100, top, bottom: top + 80, width: 100, height: 80, x, y: top, toJSON: () => ({}) }) as DOMRect;
    tile.dispatchEvent(new Event('animationstart', { bubbles: true }));
    expect(controller.snapshot().paused).toContain('shift');
    const dialog = document.createElement('div');
    dialog.setAttribute('aria-modal', 'true');
    app.append(dialog);
    await Promise.resolve();
    expect(controller.snapshot().paused).toEqual(['modal']);
    expect(controller.snapshot().auxTimers).toBe(0);
    expect(controller.snapshot().timers).toBe(0);
    dialog.remove();
    await Promise.resolve();
    expect(sprite.dataset.visible).toBe('true');
  });

  it('離れた場所のアニメーションでは隠れない', () => {
    make().start();
    advance(3_000);
    const far = document.createElement('div');
    root.append(far);
    // 足場 (x 100〜500, 上辺 300) から縦に離れた要素。
    far.getBoundingClientRect = () => ({ left: 0, right: 600, top: 0, bottom: 50, width: 600, height: 50, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
    far.dispatchEvent(new Event('animationstart', { bubbles: true }));
    expect(sprite.dataset.visible).toBe('true');
  });

  it('destroy でタイマー・フレーム・リスナーを残さない', () => {
    make().start();
    advance(3_000);
    controller.destroy();
    expect(controller.snapshot().timers).toBe(0);
    expect(controller.snapshot().auxTimers).toBe(0);
    expect(controller.snapshot().frame).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });
});

// ---------------------------------------------------------------- PR2: 行動・アスレチック・触れ合い

const only = (weights: Partial<typeof DEFAULT_BEHAVIOR.weights>): typeof DEFAULT_BEHAVIOR => ({
  ...DEFAULT_BEHAVIOR,
  weights: { idle: 0, rest: 0, look: 0, walk: 0, run: 0, hop: 0, jump: 0, hide: 0, sleep: 0, groom: 0, stretch: 0, ...weights },
  sleepWhenInactive: 0,
  repeatPenalty: 1,
  repeatTwicePenalty: 1,
  afterMovingPenalty: 1,
});

function make2(options: { seed?: number; behavior?: typeof DEFAULT_BEHAVIOR; finePointer?: boolean; interaction?: Partial<typeof DEFAULT_INTERACTION>; motion?: Partial<typeof DEFAULT_MOTION> } = {}): HarimaruController {
  controller = new HarimaruController({
    sprite,
    root,
    watch: app,
    platformSelector: '.x',
    rng: seededRng(options.seed ?? 1),
    now: () => now,
    measure: () => current,
    obstaclesIn: () => [],
    behavior: options.behavior,
    finePointer: options.finePointer ?? false,
    interaction: { ...DEFAULT_INTERACTION, ...options.interaction },
    motion: { ...DEFAULT_MOTION, ...options.motion },
  });
  return controller;
}

/** 画面の端から入り終えて、足場に立つまで進める。 */
function entered(): void {
  for (let i = 0; i < 2_000 && !controller.snapshot().placed; i += 1) advance(16);
  expect(controller.snapshot().placed).toBe(true);
}

function pointer(type: string, x: number, y: number, extra: Record<string, unknown> = {}, target: EventTarget = window): void {
  const event = new MouseEvent(type, { bubbles: true, clientX: x, clientY: y, button: 0 });
  for (const [key, value] of Object.entries({ pointerId: 1, pointerType: 'touch', ...extra })) Object.defineProperty(event, key, { value });
  target.dispatchEvent(event);
}

function tapAt(x: number, y: number, holdMs = 80, extra: Record<string, unknown> = {}, target: EventTarget = window): void {
  pointer('pointerdown', x, y, extra, target);
  advance(holdMs);
  pointer('pointerup', x, y, extra, target);
}

describe('HarimaruController (PR2)', () => {
  it('隣の足場 (同じ高さ) へ安全な経路があれば小ジャンプし、空中では足元から浮き、着地すると隣の足場に立つ', () => {
    current = terrain([{ left: 100, right: 300, top: 300 }, { left: 340, right: 600, top: 296 }]);
    make2({ behavior: only({ jump: 1, idle: 0.0001 }), motion: { reconsiderChance: 0 } }).start();
    entered();
    const startX = controller.snapshot().x;
    let sawAirborne = false;
    let maxRise = 0;
    for (let i = 0; i < 2_000 && !(sawAirborne && !controller.snapshot().airborne); i += 1) {
      advance(16);
      const state = controller.snapshot();
      if (state.airborne && state.action === 'hopJump' && state.abs) {
        sawAirborne = true;
        // 足元 (セルの下端) が、低い方の上辺からどれだけ上にあるか。
        maxRise = Math.max(maxRise, 300 - (state.abs.y + 20));
      }
    }
    expect(sawAirborne).toBe(true);
    // 隙間 40px の弧の高さ (16px) まで浮く。
    expect(maxRise).toBeGreaterThan(10);
    const landed = controller.snapshot();
    expect([300, 296]).toContain(landed.top);
    if (landed.top === 296) expect(landed.x).toBeGreaterThan(340);
    else expect(landed.x).toBeLessThan(300);
    // 跳んだ足場とは別の足場に着地している。
    expect(startX < 300 ? landed.top : 300).toBe(startX < 300 ? 296 : 300);
    expect(landed.abs).toBeNull();
    expect(landed.airborne).toBe(false);
  });

  it('横並びのタイル (隙間 10px・角丸) の列: 歩く・駆ける間は 1 枚のタイルの角丸の内側だけを踏み、継ぎ目は左右どちらの向きにもジャンプで渡る', () => {
    // サンプルのホーム (PC 1280 px) の 3 枚のタイルと同じ並び。
    const tiles = [
      { left: 70, right: 275, top: 398 },
      { left: 285, right: 490, top: 398 },
      { left: 500, right: 705, top: 398 },
    ];
    current = terrain(tiles);
    make2({ seed: 5, behavior: only({ walk: 1, run: 0.5, jump: 1, idle: 0.3 }) }).start();
    const tileOf = (x: number): number => tiles.findIndex((t) => x + 2 >= t.left + 12 - 0.01 && x + 30 - 2 <= t.right - 12 + 0.01);
    const crossed = { right: 0, left: 0 };
    let lastTile = -1;
    /** 前の地上の標本のあと、ジャンプの空中 (airborne・正の lift) を通ったか。 */
    let flew = false;
    let groundFrames = 0;
    for (let i = 0; i < 6_000; i += 1) {
      advance(16);
      const state = controller.snapshot();
      if (!state.placed) {
        // 見えない間に別の場所へ移ったら (隠れて出直すなど)、横断として数えない。
        lastTile = -1;
        flew = false;
        continue;
      }
      if (state.airborne || state.lift > 0) {
        if (state.action === 'hopJump' && state.airborne && state.abs) flew = true;
        continue;
      }
      if (state.sink !== 0) continue;
      groundFrames += 1;
      // 地上では、足元の見える範囲が必ず 1 枚のタイルの角丸の内側に収まる (隙間・角丸の上にいない)。
      const tile = tileOf(state.x);
      expect(tile, `x=${state.x}`).toBeGreaterThanOrEqual(0);
      expect(state.top).toBe(398);
      if (lastTile >= 0 && tile !== lastTile) {
        // タイルが変わるのは、ジャンプで隣のタイルへ渡ったときだけ (歩いて・瞬間的に移らない)。
        expect(flew, `${lastTile} → ${tile}`).toBe(true);
        expect(Math.abs(tile - lastTile)).toBe(1);
        crossed[tile > lastTile ? 'right' : 'left'] += 1;
      }
      lastTile = tile;
      flew = false;
    }
    expect(groundFrames).toBeGreaterThan(1_000);
    // 継ぎ目は、右向き・左向きのどちらにもジャンプで渡った (歩いては渡らない: 地上の標本はすべて 1 枚の上)。
    expect(crossed.right).toBeGreaterThan(0);
    expect(crossed.left).toBeGreaterThan(0);
  });

  it('ジャンプの途中でスクロール・DOM の変化があったら、古い経路のまま飛ばずに即座に隠れて出直す', async () => {
    for (const disturb of ['scroll', 'dom'] as const) {
      current = terrain([{ left: 100, right: 300, top: 300 }, { left: 340, right: 600, top: 296 }]);
      make2({ behavior: only({ jump: 1, idle: 0.0001 }), motion: { reconsiderChance: 0 } }).start();
      entered();
      for (let i = 0; i < 2_000 && controller.snapshot().action !== 'hopJump'; i += 1) advance(16);
      advance(400);
      expect(controller.snapshot().airborne).toBe(true);
      if (disturb === 'scroll') window.dispatchEvent(new Event('scroll'));
      else {
        root.append(document.createElement('p'));
        await Promise.resolve();
      }
      const state = controller.snapshot();
      expect(state.events, disturb).toContain('jump:aborted');
      expect(state.airborne).toBe(false);
      expect(state.placed).toBe(false);
      expect(sprite.dataset.visible).toBe('false');
      entered();
      controller.destroy();
    }
  });

  it('ジャンプの途中で足場がホバーなどで動き始めたら、着地の高さが合わないので中断して出直す', () => {
    const tile = document.createElement('div');
    root.append(tile);
    tile.getBoundingClientRect = () => ({ left: 340, right: 600, top: 290, bottom: 380, width: 260, height: 90, x: 340, y: 290, toJSON: () => ({}) }) as DOMRect;
    current = { ...terrain([{ left: 100, right: 300, top: 300 }, { left: 340, right: 600, top: 296 }]), elements: [] };
    make2({ behavior: only({ jump: 1, idle: 0.0001 }), motion: { reconsiderChance: 0 } }).start();
    entered();
    for (let i = 0; i < 2_000 && controller.snapshot().action !== 'hopJump'; i += 1) advance(16);
    expect(controller.snapshot().airborne).toBe(true);
    const event = new Event('transitionrun', { bubbles: true });
    Object.defineProperty(event, 'propertyName', { value: 'transform' });
    tile.dispatchEvent(event);
    expect(controller.snapshot().events).toContain('jump:aborted');
    expect(controller.snapshot().airborne).toBe(false);
    expect(sprite.dataset.visible).toBe('false');
  });

  it('踏切の前から足場が動いている途中なら跳ばない (動いたあとの高さが分からない)', () => {
    const target = document.createElement('div');
    const start = document.createElement('div');
    root.append(target, start);
    target.getBoundingClientRect = () => ({ left: 340, right: 600, top: 296, bottom: 380, width: 260, height: 84, x: 340, y: 296, toJSON: () => ({}) }) as DOMRect;
    start.getBoundingClientRect = () => ({ left: 100, right: 300, top: 300, bottom: 380, width: 200, height: 80, x: 100, y: 300, toJSON: () => ({}) }) as DOMRect;
    current = { ...terrain([{ left: 100, right: 300, top: 300 }, { left: 340, right: 600, top: 296 }]), elements: [start, target] };
    make2({ behavior: only({ jump: 1, idle: 0.0001 }) }).start();
    entered();
    // 「ジャンプ」を選んで踏切へ歩き始めたところで、着地先の足場がホバーで浮き始める (終わらない)。
    for (let i = 0; i < 4_000 && !controller.snapshot().events.includes('action:jump'); i += 1) advance(16);
    expect(controller.snapshot().events).toContain('action:jump');
    const event = new Event('transitionrun', { bubbles: true });
    Object.defineProperty(event, 'propertyName', { value: 'transform' });
    target.dispatchEvent(event);
    // 浮く途中のトランジションが動いている。
    (target as unknown as { getAnimations: () => unknown[] }).getAnimations = () => [{ playState: 'running', effect: { getTiming: () => ({ iterations: 1 }) } }];
    for (let i = 0; i < 1_500 && !controller.snapshot().events.includes('jump:skipped:moving'); i += 1) {
      advance(16);
      expect(controller.snapshot().airborne).toBe(false);
    }
    expect(controller.snapshot().events).toContain('jump:skipped:moving');
  });

  it('その場で跳ねている途中に画面が変わったら、足場に降りて確かめ直す。跳ねている間のタップには反応しない', async () => {
    make2({ behavior: only({ hop: 1, idle: 0.0001 }), finePointer: false }).start();
    controller = controller as HarimaruController;
    // 跳ねる余地あり (障害物なし) なので、そのうち跳ねる。
    for (let i = 0; i < 4_000 && !(controller.snapshot().lift > 0); i += 1) advance(8);
    expect(controller.snapshot().lift).toBeGreaterThan(0);
    const { x, top } = controller.snapshot();
    pointer('pointerdown', x + 15, top - 10);
    pointer('pointerup', x + 15, top - 10);
    expect(controller.snapshot().events.some((e) => e.startsWith('react:'))).toBe(false);
    root.append(document.createElement('p'));
    await Promise.resolve();
    const state = controller.snapshot();
    expect(state.events).toContain('hop:aborted');
    expect(state.lift).toBe(0);
  });

  it('経路に障害物があればジャンプしない', () => {
    current = terrain([{ left: 100, right: 300, top: 300 }, { left: 340, right: 600, top: 290 }]);
    controller = new HarimaruController({
      sprite, root, watch: app, platformSelector: '.x', rng: seededRng(1), now: () => now, measure: () => current,
      // 2 つの足場の間の上に文字がある。
      obstaclesIn: () => [{ left: 270, right: 340, top: 200, bottom: 300 }],
      behavior: only({ jump: 1, idle: 0.0001 }), finePointer: false,
    });
    controller.start();
    entered();
    for (let i = 0; i < 200; i += 1) {
      advance(50);
      expect(controller.snapshot().airborne).toBe(false);
    }
    expect(controller.snapshot().events.some((e) => e === 'action:jump')).toBe(false);
  });

  it('ジャンプの途中でモーダルが開いたら即座に隠れて空中の状態を残さず、閉じると安全な足場から出直す', async () => {
    current = terrain([{ left: 100, right: 300, top: 300 }, { left: 340, right: 600, top: 290 }]);
    make2({ behavior: only({ jump: 1, idle: 0.0001 }) }).start();
    for (let i = 0; i < 2_000 && !controller.snapshot().airborne; i += 1) advance(16);
    expect(controller.snapshot().airborne).toBe(true);
    const dialog = document.createElement('div');
    dialog.setAttribute('aria-modal', 'true');
    app.append(dialog);
    await Promise.resolve();
    const paused = controller.snapshot();
    expect(sprite.dataset.visible).toBe('false');
    expect(paused.airborne).toBe(false);
    expect(paused.lift).toBe(0);
    expect(paused.frame).toBe(false);
    expect(paused.timers).toBe(0);
    dialog.remove();
    await Promise.resolve();
    advance(4_000);
    const after = controller.snapshot();
    expect(after.placed).toBe(true);
    expect([300, 290]).toContain(after.top);
  });

  it('カード裏に隠れる: 上辺より下へ沈んで見えなくなり、別の場所で耳と目だけ出してから出てくる', () => {
    current = terrain([{ left: 100, right: 300, top: 300 }, { left: 400, right: 700, top: 250 }]);
    make2({ behavior: only({ hide: 1, idle: 0.0001 }) }).start();
    const states: { sink: number; top: number; x: number; clip: string; sunk: string | undefined }[] = [];
    for (let i = 0; i < 2_000; i += 1) {
      advance(16);
      const s = controller.snapshot();
      states.push({ sink: s.sink, top: s.top, x: s.x, clip: sprite.style.clipPath, sunk: sprite.dataset.sunk });
      if (s.events.includes('action:peek') && s.sink === 0 && s.action === 'idle') break;
    }
    const hidden = states.filter((s) => s.sunk === 'true');
    expect(hidden.length).toBeGreaterThan(0);
    // 沈んだ分は切り取って描かない (カードの裏に入る)。
    expect(states.some((s) => s.clip.startsWith('inset(0px 0px') || s.clip.startsWith('inset(0 0'))).toBe(true);
    // 耳と目だけを出す深さで止まる時間がある。
    expect(states.some((s) => Math.abs(s.sink - (20 - DEFAULT_ANIMATION.peekVisible)) < 0.01)).toBe(true);
    const end = states[states.length - 1];
    expect(end.sink).toBe(0);
    expect(end.clip).toBe('');
  });

  it('顔に触れると喜び、背中に触れると振り向く。背後から触れると (驚くの画像がなければ) 振り向く', () => {
    make2({ behavior: only({ idle: 1 }) }).start();
    advance(3_000);
    // 向きに合わせて、顔側 (前) と背中側 (後ろ) の位置を決める。何度も触ると逃げるので、触れるたびに間をあける。
    const at = (part: 'face' | 'back') => {
      const { x, top, dir } = controller.snapshot();
      const front = dir < 0 ? 0.1 : 0.9;
      const fraction = part === 'face' ? front : 1 - front;
      return { x: x + 2 + 26 * fraction, y: top - 10 };
    };
    let p = at('face');
    tapAt(p.x, p.y);
    expect(controller.snapshot().events.at(-1)).toBe('react:happy');
    advance(DEFAULT_INTERACTION.fleeWindowMs + 100);
    p = at('back');
    const before = controller.snapshot().dir;
    tapAt(p.x, p.y);
    expect(controller.snapshot().events.at(-1)).toBe('react:turn');
    expect(controller.snapshot().dir).toBe(before > 0 ? -1 : 1);
    advance(DEFAULT_INTERACTION.fleeWindowMs + 100);
    const { x, top, dir } = controller.snapshot();
    const behindX = dir < 0 ? x + 30 + 8 : x - 8;
    tapAt(behindX, top - 10);
    const events = controller.snapshot().events;
    expect(events.slice(-2)).toEqual(['react:surprise:pending-asset', 'react:turn']);
  });

  it('何度も触られると逃げる (駆けて離れ、隠れて別の場所へ)', () => {
    current = terrain([{ left: 100, right: 700, top: 300 }]);
    make2({ behavior: only({ idle: 1 }) }).start();
    advance(3_000);
    for (let i = 0; i < 3; i += 1) {
      const { x, top } = controller.snapshot();
      tapAt(x + 15, top - 10);
      advance(1_000);
    }
    expect(controller.snapshot().events).toContain('react:flee');
  });

  it('長押し・スワイプ・2 本指・キャンセル・ボタンの上は反応しない', () => {
    make2({ behavior: only({ idle: 1 }) }).start();
    advance(3_000);
    const { x, top } = controller.snapshot();
    tapAt(x + 15, top - 10, 600);
    pointer('pointerdown', x + 15, top - 10);
    pointer('pointermove', x + 45, top - 10);
    pointer('pointerup', x + 45, top - 10);
    pointer('pointerdown', x + 15, top - 10);
    pointer('pointerdown', x + 20, top - 10, { pointerId: 2 });
    pointer('pointerup', x + 20, top - 10, { pointerId: 2 });
    pointer('pointerup', x + 15, top - 10);
    pointer('pointerdown', x + 15, top - 10);
    pointer('pointercancel', x + 15, top - 10);
    pointer('pointerup', x + 15, top - 10);
    const button = document.createElement('button');
    root.append(button);
    tapAt(x + 15, top - 10, 80, {}, button);
    const events = controller.snapshot().events;
    expect(events).toEqual(expect.arrayContaining(['tap:ignored:long', 'tap:ignored:moved', 'tap:ignored:multi', 'tap:ignored:control']));
    expect(events.some((e) => e.startsWith('react:'))).toBe(false);
  });

  it('近くの余白をタップすると、気まぐれに近づいてそちらを向く', () => {
    current = terrain([{ left: 100, right: 700, top: 300 }]);
    make2({ interaction: { approachChance: 1 } }).start();
    advance(3_000);
    const { x, top } = controller.snapshot();
    const target = x < 400 ? x + 120 : x - 120;
    tapAt(target, top - 5);
    expect(controller.snapshot().events).toContain('react:approach');
    advance(10_000);
    const after = controller.snapshot();
    expect(Math.abs(after.x + 15 - target)).toBeLessThan(Math.abs(x + 15 - target));
  });

  it('本文の文字・操作部品の上をタップしても近づかない (余白のタップだけ)', () => {
    current = terrain([{ left: 100, right: 700, top: 300 }]);
    let obstacles: { left: number; right: number; top: number; bottom: number }[] = [];
    controller = new HarimaruController({
      sprite, root, watch: app, platformSelector: '.x', rng: seededRng(1), now: () => now, measure: () => current,
      obstaclesIn: () => obstacles, behavior: only({ idle: 1 }), finePointer: false,
      interaction: { ...DEFAULT_INTERACTION, approachChance: 1 },
    });
    controller.start();
    advance(3_000);
    const { x, top } = controller.snapshot();
    const target = { x: x < 400 ? x + 120 : x - 120, y: top - 5 };
    obstacles = [{ left: target.x - 20, right: target.x + 20, top: target.y - 8, bottom: target.y + 8 }];
    tapAt(target.x, target.y);
    expect(controller.snapshot().events).toContain('tap:ignored:content');
    expect(controller.snapshot().events).not.toContain('react:approach');
    obstacles = [];
    advance(DEFAULT_INTERACTION.reactionCooldownMs + 100);
    tapAt(target.x, target.y);
    expect(controller.snapshot().events).toContain('react:approach');
  });

  it('足元のすぐ下 (カードの面) をタップしても、体に触れたことにしない', () => {
    current = terrain([{ left: 100, right: 700, top: 300 }]);
    let obstacles: { left: number; right: number; top: number; bottom: number }[] = [];
    controller = new HarimaruController({
      sprite, root, watch: app, platformSelector: '.x', rng: seededRng(1), now: () => now, measure: () => current,
      obstaclesIn: () => obstacles, behavior: only({ idle: 1 }), finePointer: false,
    });
    controller.start();
    advance(3_000);
    const { x, top } = controller.snapshot();
    // 足場のカード (上辺 300 から下) の面。
    obstacles = [{ left: 100, right: 700, top, bottom: top + 80 }];
    tapAt(x + 15, top + 3);
    expect(controller.snapshot().events).toContain('tap:ignored:content');
    expect(controller.snapshot().events.some((e) => e.startsWith('react:'))).toBe(false);
    // 体そのもの (見えている枠の中) へのタップは反応する。
    advance(DEFAULT_INTERACTION.reactionCooldownMs + 100);
    tapAt(x + 15, top - 10);
    expect(controller.snapshot().events.some((e) => e === 'react:happy' || e === 'react:turn')).toBe(true);
  });

  it('PC: 止まったカーソルに近づき、速いカーソルへの「じゃれる」は画像がなければ見送る', () => {
    current = terrain([{ left: 100, right: 700, top: 300 }]);
    make2({ finePointer: true, interaction: { cursorApproachChance: 1, cursorStillMs: 500 } }).start();
    advance(3_000);
    const { x, top } = controller.snapshot();
    const cx = x < 400 ? x + 130 : x - 100;
    pointer('pointermove', cx, top - 30, { pointerType: 'mouse' });
    advance(2_500);
    expect(controller.snapshot().events).toContain('react:approach');
    advance(15_000);
    // 速く動くカーソル
    for (let i = 0; i < 12; i += 1) {
      const s = controller.snapshot();
      pointer('pointermove', s.x + 15 + (i % 2 ? 60 : -60), s.top - 20, { pointerType: 'mouse' });
      advance(16);
    }
    advance(1_500);
    expect(controller.snapshot().events.some((e) => e === 'react:play:pending-asset' || e === 'react:approach')).toBe(true);
  });

  it('タッチの端末ではカーソルの反応を見張らない', () => {
    make2({ finePointer: false }).start();
    advance(3_000);
    pointer('pointermove', 200, 200, { pointerType: 'mouse' });
    expect(controller.snapshot().auxTimers).toBe(0);
  });

  it('速いスクロールのあと「転ぶ」は画像がなければ見送る (遅いスクロールでは何もしない)', () => {
    make2().start();
    advance(3_000);
    let y = 0;
    const scrollY = vi.spyOn(window, 'scrollY', 'get').mockImplementation(() => y);
    for (let i = 0; i < 5; i += 1) {
      y += 2;
      window.dispatchEvent(new Event('scroll'));
      advance(16);
    }
    advance(400);
    expect(controller.snapshot().events.some((e) => e.startsWith('react:tumble'))).toBe(false);
    for (let i = 0; i < 5; i += 1) {
      y += 120;
      window.dispatchEvent(new Event('scroll'));
      advance(16);
    }
    y = 0;
    advance(400);
    scrollY.mockRestore();
    expect(controller.snapshot().events).toContain('react:tumble:pending-asset');
  });

  it('入力欄にフォーカスがある間は隠れて休み、離れると戻る', () => {
    make2().start();
    advance(3_000);
    const input = document.createElement('input');
    root.append(input);
    input.focus();
    expect(controller.snapshot().paused).toContain('input');
    expect(sprite.dataset.visible).toBe('false');
    expect(controller.snapshot().timers).toBe(0);
    input.blur();
    advance(50);
    expect(sprite.dataset.visible).toBe('true');
  });

  it('v0.9 の画像を読み込めていなければ、その動作は始めない (寝ぼける・着地の失敗は見送り、記録だけ残す)', () => {
    current = terrain([{ left: 100, right: 166, top: 300 }]);
    make2({ behavior: { ...only({ sleep: 1, idle: 0.2 }), sleepWhenInactive: 1, sleepMs: [5_000, 6_000] } }).start();
    const seen = new Set<string>();
    for (let i = 0; i < 1_500; i += 1) {
      advance(50);
      for (const e of controller.snapshot().events) seen.add(e);
    }
    expect(seen.has('action:sleep')).toBe(true);
    expect(seen.has('action:sleepyFall')).toBe(false);
    expect(controller.trigger('slip')).toBe(false);
    controller.destroy();

    current = terrain([{ left: 100, right: 300, top: 300 }, { left: 340, right: 600, top: 296 }]);
    make2({ seed: 4, behavior: only({ jump: 1, idle: 0.3 }) }).start();
    seen.clear();
    for (let i = 0; i < 12_000 && !seen.has('react:tumble:pending-asset'); i += 1) {
      advance(16);
      for (const e of controller.snapshot().events) seen.add(e);
    }
    expect(seen.has('react:tumble:pending-asset')).toBe(true);
    // 描けない動作は描かない (姿勢は待機のまま、v0.2 の画像のまま)。
    expect(controller.snapshot().lift).toBe(0);
    expect(controller.snapshot().sheet).toBe('base');
  });

  it('いろいろな行動を続けても、タイマー・フレームは destroy で残らない', () => {
    current = terrain([{ left: 100, right: 300, top: 300 }, { left: 340, right: 600, top: 290 }]);
    make2({ seed: 9, behavior: { ...DEFAULT_BEHAVIOR, inactiveSleepAfterMs: 20_000 } }).start();
    const seen = new Set<string>();
    for (let i = 0; i < 3_000; i += 1) {
      advance(50);
      const a = controller.snapshot().action;
      if (a) seen.add(a);
    }
    for (const action of ['idle', 'walk', 'look', 'rest', 'sleep']) expect(seen.has(action), action).toBe(true);
    controller.destroy();
    expect(vi.getTimerCount()).toBe(0);
  });
});
