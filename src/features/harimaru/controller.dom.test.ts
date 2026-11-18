import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { seededRng } from './behavior';
import { HarimaruController } from './controller';
import { DEFAULT_TIMING } from './params';
import type { MeasuredTerrain } from './terrainDom';

const VIEW = { top: 0, bottom: 800 };
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
    dialog.remove();
    await Promise.resolve();
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

  it('destroy でタイマー・フレーム・リスナーを残さない', () => {
    make().start();
    advance(3_000);
    controller.destroy();
    expect(controller.snapshot().timers).toBe(0);
    expect(controller.snapshot().frame).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });
});
