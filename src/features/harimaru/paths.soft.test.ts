import { describe, expect, it } from 'vitest';
import { DEFAULT_MOTION } from './params';
import { stepsAreClear, type Step } from './paths';
import type { Rect } from './terrain';

const VIEW = { left: 0, right: 1_000, top: 0, bottom: 800 };
const pose = { sheet: 'base' as const, row: 0 as const, column: 0 };

/** 種類の印 (collectObstacles と同じく列挙しない) を付けた障害物。 */
const soft = (rect: Rect): Rect => Object.defineProperty({ ...rect }, 'kind', { value: 'soft', enumerable: false });
const text = (left: number, right: number): Rect => ({ left, right, top: 385, bottom: 395 });

/** x 100 → 300 を 20px ずつ (1 段 100ms) 歩き、x 300 で止まる。hold を渡すと、その位置で止まる段を入れる。 */
function walk(hold?: { x: number; ms: number }): Step[] {
  const steps: Step[] = [];
  for (let x = 100; x <= 300; x += 20) {
    if (hold && x === hold.x) steps.push({ pose, x, y: 380, dir: 1, ms: hold.ms, tween: 'hold' });
    steps.push({ pose, x, y: 380, dir: 1, ms: x === 300 ? 0 : 100, tween: x === 300 ? 'hold' : 'linear' });
  }
  return steps;
}

const options = { view: VIEW, softPassMs: DEFAULT_MOTION.softPassMs, softHoldMs: DEFAULT_MOTION.softHoldMs };

describe('stepsAreClear の文字・アイコン (soft) の扱い', () => {
  it('動いている途中に短くかぶるだけなら通ってよい', () => {
    expect(stepsAreClear(walk(), [soft(text(200, 204))], options)).toBe(true);
  });

  it('かぶる時間の合計が softPassMs を超えると通らない', () => {
    expect(stepsAreClear(walk(), [soft(text(140, 260))], options)).toBe(false);
  });

  it('止まる位置 (最後の段) で文字にかぶる経路は通らない', () => {
    expect(stepsAreClear(walk(), [soft(text(300, 304))], options)).toBe(false);
  });

  it('文字の上で softHoldMs より長く立ち止まる経路は通らない (短い間なら通ってよい)', () => {
    expect(stepsAreClear(walk({ x: 200, ms: DEFAULT_MOTION.softHoldMs + 100 }), [soft(text(200, 204))], options)).toBe(false);
    expect(stepsAreClear(walk({ x: 200, ms: DEFAULT_MOTION.softHoldMs - 50 }), [soft(text(200, 204))], options)).toBe(true);
  });

  it('入力欄・重要な表示 (hard・種類の印のない矩形) には、通過中でもかぶらない', () => {
    expect(stepsAreClear(walk(), [text(200, 204)], options)).toBe(false);
  });

  it('softPassMs を渡さなければ、soft も hard と同じく通さない (立っている場所の確認など)', () => {
    expect(stepsAreClear(walk(), [soft(text(200, 204))], { view: VIEW })).toBe(false);
  });
});
