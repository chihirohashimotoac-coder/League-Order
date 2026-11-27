import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { seededRng } from './behavior';
import { HarimaruController } from './controller';
import { DEFAULT_BEHAVIOR, DEFAULT_MOTION, SPRITE } from './params';
import type { Rect } from './terrain';
import type { MeasuredTerrain } from './terrainDom';

/**
 * 文字には体が重なってよい (立つ・待つ位置でも) が、同じ文字を長く (5 秒以上) 隠し続けない。ボタン・カードなどの
 * UI には重なり続けてよい。jsdom の画面は 1024×768。
 */

let now = 0;
let root: HTMLElement;
let app: HTMLElement;
let sprite: HTMLElement;
let controller: HarimaruController;
let found: Rect[];

const CARD = { left: 60, right: 600, top: 300, bottom: 420 };
const terrain = (): MeasuredTerrain => ({
  platforms: [{ left: CARD.left, right: CARD.right, top: CARD.top }],
  boxes: [CARD],
  obstacles: [],
  bounds: { left: 4, right: 1_020 },
  view: { top: 0, bottom: 768, left: 0, right: 1_024 },
  docBottom: 3_000,
});

/** 文字の行の矩形 (collectObstacles と同じ、列挙しない印)。 */
const text = (rect: Rect): Rect => Object.defineProperties({ ...rect }, { kind: { value: 'soft', enumerable: false }, text: { value: true, enumerable: false } });

const still: typeof DEFAULT_BEHAVIOR = {
  ...DEFAULT_BEHAVIOR,
  weights: { idle: 1, rest: 0, look: 0, walk: 0, run: 0, hop: 0, jump: 0, hide: 0, sleep: 0, groom: 0, stretch: 0 },
  sleepWhenInactive: 0,
  idleMs: [3_000, 3_000],
};

function advance(ms: number): void {
  for (let t = 0; t < ms; t += 16) {
    now += 16;
    vi.advanceTimersByTime(16);
  }
}

beforeEach(() => {
  vi.useFakeTimers();
  now = 0;
  found = [];
  app = document.createElement('div');
  root = document.createElement('main');
  app.append(root);
  document.body.append(app);
  sprite = document.createElement('div');
  document.body.append(sprite);
  controller = new HarimaruController({
    sprite,
    root,
    watch: app,
    platformSelector: '.x',
    rng: seededRng(1),
    now: () => now,
    measure: () => terrain(),
    obstaclesIn: () => found,
    behavior: still,
    finePointer: false,
    motion: { ...DEFAULT_MOTION, entryMaxGap: 120, entryRetreatChance: 0 },
  });
  controller.setSheet('base', 'base.png');
});

afterEach(() => {
  controller?.destroy();
  document.body.innerHTML = '';
  vi.useRealTimers();
});

function standing(): { x: number; top: number } {
  controller.start();
  for (let t = 0; t < 20_000 && !(controller.snapshot().placed && controller.snapshot().action === 'idle'); t += 16) advance(16);
  expect(controller.snapshot().placed).toBe(true);
  return controller.snapshot();
}

describe('同じ文字を長く隠し続けない', () => {
  it('待機しかしない設定でも、文字の上では textHoldMs (5 秒未満) のうちに、文字を隠さない位置へ歩いて離れる', () => {
    const { x, top } = standing();
    // いまの位置の体にかかる文字の行 (足場の左側だけ)。右へ寄れば隠さない。
    const line = text({ left: x - 40, right: x + 40, top: top - 14, bottom: top - 4 });
    found = [line];
    const t0 = now;
    let left: number | null = null;
    for (let t = 0; t < 8_000 && left === null; t += 16) {
      advance(16);
      const s = controller.snapshot();
      const body = { left: s.x + SPRITE.sideInset, right: s.x + SPRITE.width - SPRITE.sideInset };
      if (s.placed && (body.right <= line.left || body.left >= line.right)) left = now - t0;
    }
    expect(left).not.toBeNull();
    expect(left!).toBeLessThan(5_000);
    expect(controller.snapshot().events).toContain('text:leave:walk');
  });

  it('ボタン・カードなどの UI (文字でない矩形) には、重なったまま待っていてよい', () => {
    const { x, top } = standing();
    found = [Object.defineProperty({ left: x - 40, right: x + 40, top: top - 14, bottom: top - 4 }, 'kind', { value: 'soft', enumerable: false })];
    advance(8_000);
    expect(controller.snapshot().x).toBe(x);
    expect(controller.snapshot().events.filter((e) => e.startsWith('text:leave'))).toEqual([]);
  });

  it('足場のどこでも文字を隠すなら、隠れて端から出直す', () => {
    const { top } = standing();
    found = [text({ left: 0, right: 1_024, top: top - 14, bottom: top - 4 })];
    advance(6_000);
    expect(controller.snapshot().events).toContain('text:leave:hide');
  });

  it('眠っている間に画面が変わって文字が体の下に来たら、5 秒未満のうちに起きて、文字を隠さない位置へ離れる', async () => {
    controller.destroy();
    controller = new HarimaruController({
      sprite, root, watch: app, platformSelector: '.x', rng: seededRng(1), now: () => now, measure: () => terrain(), obstaclesIn: () => found,
      behavior: { ...still, weights: { ...still.weights, idle: 0.0001, sleep: 1 }, inactiveSleepAfterMs: 0, sleepWhenInactive: 1, sleepMs: [30_000, 30_000], sleepyFallChance: 0 },
      finePointer: false,
      motion: { ...DEFAULT_MOTION, entryMaxGap: 120, entryRetreatChance: 0 },
    });
    controller.setSheet('base', 'base.png');
    controller.start();
    for (let t = 0; t < 30_000 && controller.snapshot().action !== 'sleep'; t += 16) advance(16);
    expect(controller.snapshot().action).toBe('sleep');
    const { x, top } = controller.snapshot();
    found = [text({ left: x - 40, right: x + 40, top: top - 14, bottom: top - 4 })];
    root.append(document.createElement('p'));
    await Promise.resolve();
    const t0 = now;
    let left: number | null = null;
    for (let t = 0; t < 10_000 && left === null; t += 16) {
      advance(16);
      const s = controller.snapshot();
      if (s.placed && (s.x + SPRITE.width - SPRITE.sideInset <= x - 40 || s.x + SPRITE.sideInset >= x + 40)) left = now - t0;
    }
    expect(controller.snapshot().events).toContain('text:recheck');
    expect(left).not.toBeNull();
    expect(left!).toBeLessThan(5_000);
  });
});

