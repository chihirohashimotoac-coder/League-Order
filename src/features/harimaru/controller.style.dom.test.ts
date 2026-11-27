import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { seededRng } from './behavior';
import { HarimaruController } from './controller';
import { DEFAULT_BEHAVIOR, DEFAULT_MOTION } from './params';
import { invalidateStyleCache, measureTerrain } from './terrainDom';

/**
 * 計算したスタイルの控え (terrainDom の styleCache) と、DOM の変化を起こさない CSS の変化 (画面の入場のフェードなど)。
 * 実際の measureTerrain で計測する (要素の箱は getBoundingClientRect を差し替える)。
 */

let now = 0;
let controller: HarimaruController | null = null;
let style: HTMLStyleElement;

beforeEach(() => {
  vi.useFakeTimers();
  now = 0;
  invalidateStyleCache();
  style = document.createElement('style');
  document.head.append(style);
  // jsdom は配置を計算しない: 文書の高さを与える (経路が文書の下端より下に出ないかの確かめに使う)。
  Object.defineProperty(document.documentElement, 'scrollHeight', { value: 3_000, configurable: true });
});

afterEach(() => {
  controller?.destroy();
  controller = null;
  document.body.innerHTML = '';
  style.remove();
  delete (document.documentElement as unknown as Record<string, unknown>).scrollHeight;
  vi.useRealTimers();
});

function advance(ms: number): void {
  for (let t = 0; t < ms; t += 16) {
    now += 16;
    vi.advanceTimersByTime(16);
  }
}

describe('スタイルの控えと CSS のアニメーション', () => {
  it('入場のフェードの途中 (ほぼ透明) で控えたスタイルは、アニメーションが終わったら捨てて、端から入り直す', () => {
    const app = document.createElement('div');
    const root = document.createElement('main');
    const page = document.createElement('section');
    page.className = 'fading';
    const card = document.createElement('div');
    card.style.backgroundColor = 'rgb(255, 255, 255)';
    // 左端から 12px のカード (左右の端から入れる)。
    card.getBoundingClientRect = () => ({ left: 12, right: 400, top: 300, bottom: 420, width: 388, height: 120, x: 12, y: 300, toJSON: () => ({}) }) as DOMRect;
    page.append(card);
    root.append(page);
    app.append(root);
    document.body.append(app);
    const sprite = document.createElement('div');
    document.body.append(sprite);
    // フェードの途中: 入れ物がほぼ透明 (DOM の変化を起こさない、スタイルシートの規則)。
    style.textContent = '.fading { opacity: 0.01; }';
    controller = new HarimaruController({
      sprite,
      root,
      watch: app,
      platformSelector: '',
      rng: seededRng(1),
      now: () => now,
      measure: measureTerrain,
      obstaclesIn: () => [],
      behavior: { ...DEFAULT_BEHAVIOR, weights: { idle: 1, rest: 0, look: 0, walk: 0, run: 0, hop: 0, jump: 0, hide: 0, sleep: 0, groom: 0, stretch: 0 } },
      finePointer: false,
      motion: { ...DEFAULT_MOTION, entryRetreatChance: 0 },
    });
    controller.setSheet('base', 'base.png');
    controller.start();
    advance(6_000);
    expect(controller.snapshot().placed).toBe(false);
    // フェードが終わる (DOM は変わらない)。控えを捨てないと、入れ物を見えないままとみなし続ける。
    style.textContent = '';
    advance(6_000);
    expect(controller.snapshot().placed).toBe(false);
    page.dispatchEvent(new Event('animationend', { bubbles: true }));
    advance(10_000);
    expect(controller.snapshot().placed).toBe(true);
    expect(controller.snapshot().top).toBe(300);
  });
});
