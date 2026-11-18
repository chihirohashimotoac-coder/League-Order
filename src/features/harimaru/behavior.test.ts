import { describe, expect, it } from 'vitest';
import { actionWeights, decideNext, pickWeighted, seededRng, walkRoom, type DecisionInput, type HarimaruAction } from './behavior';
import { DEFAULT_BEHAVIOR } from './params';

const base: DecisionInput = { now: 10_000, lastActivityAt: 9_000, history: [], x: 100, minX: 0, maxX: 300 };
const fixed = (...values: number[]) => {
  let i = 0;
  return () => values[Math.min(i++, values.length - 1)];
};

describe('pickWeighted', () => {
  it('重みに比例して選び、合計 0 なら null', () => {
    expect(pickWeighted(fixed(0), [['a', 1], ['b', 3]])).toBe('a');
    expect(pickWeighted(fixed(0.3), [['a', 1], ['b', 3]])).toBe('b');
    expect(pickWeighted(fixed(0.999999), [['a', 1], ['b', 0]])).toBe('a');
    expect(pickWeighted(fixed(0.5), [['a', 0], ['b', 0]])).toBeNull();
  });
});

describe('walkRoom', () => {
  it('最小距離を取れない方向には歩かない', () => {
    expect(walkRoom({ x: 5, minX: 0, maxX: 300 })).toEqual({ left: 0, right: DEFAULT_BEHAVIOR.walkDistance[1] });
    expect(walkRoom({ x: 0, minX: 0, maxX: 10 })).toEqual({ left: 0, right: 0 });
  });
});

describe('actionWeights', () => {
  it('狭い足場では歩かない', () => {
    expect(actionWeights({ ...base, x: 0, minX: 0, maxX: 10 }).walk).toBe(0);
  });
  it('直前と同じ行動は重みが下がり、2 回続くとさらに下がる', () => {
    const fresh = actionWeights(base);
    const once = actionWeights({ ...base, history: ['walk'] });
    const twice = actionWeights({ ...base, history: ['walk', 'walk'] });
    expect(once.walk).toBeCloseTo(fresh.walk * DEFAULT_BEHAVIOR.repeatPenalty);
    expect(twice.walk).toBeCloseTo(fresh.walk * DEFAULT_BEHAVIOR.repeatTwicePenalty);
  });
  it('無操作が続くと眠りやすくなる (境界値を含む)', () => {
    const awake = actionWeights({ ...base, lastActivityAt: base.now - DEFAULT_BEHAVIOR.inactiveSleepAfterMs + 1 });
    const inactive = actionWeights({ ...base, lastActivityAt: base.now - DEFAULT_BEHAVIOR.inactiveSleepAfterMs });
    expect(awake.sleep).toBe(DEFAULT_BEHAVIOR.weights.sleep);
    expect(inactive.sleep).toBe(DEFAULT_BEHAVIOR.sleepWhenInactive);
  });
  it('目覚めた直後は眠り直さない', () => {
    expect(actionWeights({ ...base, lastActivityAt: 0, history: ['sleep'] }).sleep).toBe(0);
  });
});

describe('decideNext', () => {
  it('同じ乱数列なら同じ結果 (再現できる)', () => {
    const a = decideNext(base, seededRng(42));
    const b = decideNext(base, seededRng(42));
    expect(a).toEqual(b);
  });
  it('歩く目的地は足場の範囲内で、時間は距離と速さから決まる', () => {
    for (let seed = 0; seed < 300; seed += 1) {
      const decision = decideNext({ ...base, x: 20, minX: 0, maxX: 60 }, seededRng(seed));
      if (decision.action !== 'walk') continue;
      expect(decision.targetX).toBeGreaterThanOrEqual(0);
      expect(decision.targetX).toBeLessThanOrEqual(60);
      expect(Math.abs(decision.targetX! - 20)).toBeGreaterThanOrEqual(DEFAULT_BEHAVIOR.walkDistance[0] - 1e-9);
      expect(decision.durationMs).toBeCloseTo((Math.abs(decision.targetX! - 20) / DEFAULT_BEHAVIOR.walkSpeed) * 1000);
    }
  });
  it('待機・睡眠の長さは設定の範囲内', () => {
    const idle = decideNext(base, fixed(0, 0.5));
    expect(idle.action).toBe('idle');
    expect(idle.durationMs).toBeGreaterThanOrEqual(DEFAULT_BEHAVIOR.idleMs[0]);
    expect(idle.durationMs).toBeLessThanOrEqual(DEFAULT_BEHAVIOR.idleMs[1]);
    const sleep = decideNext({ ...base, lastActivityAt: 0 }, fixed(0.99, 0.5));
    expect(sleep.action).toBe('sleep');
    expect(sleep.durationMs).toBeGreaterThanOrEqual(DEFAULT_BEHAVIOR.sleepMs[0]);
    expect(sleep.durationMs).toBeLessThanOrEqual(DEFAULT_BEHAVIOR.sleepMs[1]);
  });
  it('長く続けても同じ行動が機械的に続かず、何もしない時間もある', () => {
    const rng = seededRng(7);
    const history: HarimaruAction[] = [];
    let x = 150;
    let longestRun = 0;
    let run = 0;
    const counts: Record<HarimaruAction, number> = { idle: 0, walk: 0, sleep: 0 };
    for (let step = 0; step < 2_000; step += 1) {
      const decision = decideNext({ ...base, now: step * 5_000, lastActivityAt: step * 5_000 - (step % 20) * 5_000, history: history.slice(-6), x, minX: 0, maxX: 300 }, rng);
      if (decision.targetX !== undefined) x = decision.targetX;
      run = history[history.length - 1] === decision.action ? run + 1 : 1;
      longestRun = Math.max(longestRun, run);
      history.push(decision.action);
      counts[decision.action] += 1;
    }
    expect(counts.idle).toBeGreaterThan(400);
    expect(counts.walk).toBeGreaterThan(300);
    expect(counts.sleep).toBeGreaterThan(20);
    expect(longestRun).toBeLessThanOrEqual(5);
  });
});
