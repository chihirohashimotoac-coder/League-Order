import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { seededRng } from './behavior';
import { HarimaruController } from './controller';
import { DEFAULT_TIMING } from './params';
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
  it('少し待ってから、足場の上に 1 回だけ現れる (足元 = 上辺、全高 20px の枠)', () => {
    make().start();
    expect(sprite.dataset.visible).toBe('false');
    advance(DEFAULT_TIMING.enterDelayMs[1] + 50);
    const state = controller.snapshot();
    expect(sprite.dataset.visible).toBe('true');
    expect(state.placed).toBe(true);
    expect(state.top).toBe(300);
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
