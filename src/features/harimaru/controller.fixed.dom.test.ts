import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { seededRng } from './behavior';
import { HarimaruController } from './controller';
import { DEFAULT_BEHAVIOR, DEFAULT_MOTION, DEFAULT_TIMING, SPRITE } from './params';
import type { Rect } from './terrain';
import type { MeasuredTerrain } from './terrainDom';

/**
 * 画面に固定された下部ナビの上辺を足場にする。座標は計測したときのスクロール位置でのページ座標。ナビの上に立っている
 * 間にスクロールしたら、体を画面に対して止め (描画は position: fixed)、ページ座標の足元をナビの上辺に合わせる。
 * jsdom の画面は 1024×768。下部ナビは画面の 700〜768 (画面の座標)。
 */

let now = 0;
let scrollY = 0;
let navTop = 700;
let navShown = true;
let root: HTMLElement;
let app: HTMLElement;
let sprite: HTMLElement;
let nav: HTMLElement;
let controller: HarimaruController;

const terrain = (): MeasuredTerrain => {
  const top = navTop + scrollY;
  const platforms = navShown ? [{ left: 0, right: 1_024, top, inset: 0, fixed: true }] : [];
  return {
    platforms,
    boxes: navShown ? [{ left: 0, right: 1_024, top, bottom: top + 68, fixed: true } as Rect] : [],
    elements: navShown ? [nav] : [],
    obstacles: [],
    bounds: { left: 4, right: 1_020 },
    view: { top: scrollY, bottom: scrollY + navTop, left: 0, right: 1_024 },
    docBottom: 5_000,
  };
};

const calm: typeof DEFAULT_BEHAVIOR = {
  ...DEFAULT_BEHAVIOR,
  weights: { idle: 1, rest: 0, look: 0, walk: 0, run: 0, hop: 0, jump: 0, hide: 0, sleep: 0, groom: 0, stretch: 0 },
  sleepWhenInactive: 0,
};

function advance(ms: number): void {
  for (let t = 0; t < ms; t += 16) {
    now += 16;
    vi.advanceTimersByTime(16);
  }
}

function untilPlaced(maxMs = 20_000): void {
  for (let t = 0; t < maxMs && !(controller.snapshot().placed && controller.snapshot().action !== 'enter'); t += 16) advance(16);
}

function scrollTo(y: number): void {
  scrollY = y;
  window.dispatchEvent(new Event('scroll'));
}

const drawnY = (): number => Number(/translate3d\([-\d.]+px, ([-\d.]+)px/.exec(sprite.style.transform)?.[1] ?? NaN);

beforeEach(() => {
  vi.useFakeTimers();
  now = 0;
  scrollY = 0;
  navTop = 700;
  navShown = true;
  vi.spyOn(window, 'scrollY', 'get').mockImplementation(() => scrollY);
  app = document.createElement('div');
  root = document.createElement('main');
  app.append(root);
  nav = document.createElement('nav');
  nav.className = 'tab-bar';
  nav.getBoundingClientRect = () =>
    (navShown ? { left: 0, right: 1_024, top: navTop, bottom: 768, width: 1_024, height: 768 - navTop, x: 0, y: navTop, toJSON: () => ({}) } : { left: 0, right: 0, top: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
  document.body.append(app, nav);
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
    obstaclesIn: () => [],
    behavior: calm,
    finePointer: false,
    motion: { ...DEFAULT_MOTION, entryRetreatChance: 0 },
  });
  controller.setSheet('base', 'base.png');
});

afterEach(() => {
  controller?.destroy();
  document.body.innerHTML = '';
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('下部ナビの上辺の足場', () => {
  it('ナビの上辺しか足場がなくても、左右の端から歩いて入り、ナビの上辺に立つ', () => {
    controller.start();
    untilPlaced();
    const state = controller.snapshot();
    expect(state.placed).toBe(true);
    expect(state.top).toBe(700);
    expect(controller.snapshot().events.find((e) => e.startsWith('enter:') && !e.startsWith('enter:none'))).toMatch(/^enter:(left|right):/);
  });

  it('ナビの上に立ったままスクロールすると、画面に対して止まったまま (描画は画面に固定)、止まったらページ座標に戻す', () => {
    controller.start();
    untilPlaced();
    expect(drawnY()).toBe(700 - SPRITE.height);
    scrollTo(120);
    expect(sprite.style.position).toBe('fixed');
    // 画面の座標で同じ高さ。ページ座標の足元はナビの上辺 (700 + 120)。
    expect(drawnY()).toBe(700 - SPRITE.height);
    expect(controller.snapshot().top).toBe(820);
    expect(sprite.dataset.visible).toBe('true');
    scrollTo(300);
    expect(controller.snapshot().top).toBe(1_000);
    advance(DEFAULT_TIMING.scrollIdleMs + 50);
    expect(sprite.style.position).toBe('');
    expect(drawnY()).toBe(1_000 - SPRITE.height);
    expect(sprite.dataset.visible).toBe('true');
    expect(controller.snapshot().placed).toBe(true);
  });

  it('画面の高さが変わってナビが動いたら足元を合わせ、ナビが見えなくなったら隠れて出直す', () => {
    controller.start();
    untilPlaced();
    navTop = 650;
    scrollTo(10);
    expect(controller.snapshot().top).toBe(660);
    navShown = false;
    scrollTo(20);
    expect(sprite.dataset.visible).toBe('false');
    expect(controller.snapshot().placed).toBe(false);
  });
});
