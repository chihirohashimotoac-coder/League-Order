import { describe, expect, it } from 'vitest';
import { ACTIONS, MOVING, actionWeights, decideNext, pickWeighted, seededRng, walkRoom, type DecisionInput, type HarimaruAction } from './behavior';
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
    const once = actionWeights({ ...base, history: ['look'] });
    const twice = actionWeights({ ...base, history: ['look', 'look'] });
    expect(once.look).toBeCloseTo(fresh.look * DEFAULT_BEHAVIOR.repeatPenalty);
    expect(twice.look).toBeCloseTo(fresh.look * DEFAULT_BEHAVIOR.repeatTwicePenalty);
  });
  it('動いたあとは動く行動が選ばれにくく、2 回続いたら 3 回目は選ばない (動きっぱなしにしない)', () => {
    const all = { ...base, canHop: true, canJump: true };
    const fresh = actionWeights(all);
    const once = actionWeights({ ...all, history: ['idle', 'walk'] });
    expect(once.run).toBeCloseTo(fresh.run * DEFAULT_BEHAVIOR.afterMovingPenalty);
    expect(once.jump).toBeCloseTo(fresh.jump * DEFAULT_BEHAVIOR.afterMovingPenalty);
    const twice = actionWeights({ ...all, history: ['walk', 'hop'] });
    for (const action of ['walk', 'run', 'hop', 'jump'] as const) expect(twice[action]).toBe(0);
    expect(twice.idle).toBeGreaterThan(0);
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
    // 抽選の最後の候補を眠りにする (毛づくろい・伸びを除く)。
    const sleep = decideNext({ ...base, lastActivityAt: 0, available: (id) => id !== 'groom' && id !== 'stretch' }, fixed(0.99, 0.5));
    expect(sleep.action).toBe('sleep');
    expect(sleep.durationMs).toBeGreaterThanOrEqual(DEFAULT_BEHAVIOR.sleepMs[0]);
    expect(sleep.durationMs).toBeLessThanOrEqual(DEFAULT_BEHAVIOR.sleepMs[1]);
  });
  it('長く続けても同じ行動が機械的に続かず、静かな時間の方が長い (動きっぱなしにしない)', () => {
    const rng = seededRng(7);
    const history: HarimaruAction[] = [];
    let x = 150;
    let longestRun = 0;
    let run = 0;
    let movingStreak = 0;
    let longestMoving = 0;
    const counts = Object.fromEntries(ACTIONS.map((a) => [a, 0])) as Record<HarimaruAction, number>;
    let calmMs = 0;
    let movingMs = 0;
    for (let step = 0; step < 3_000; step += 1) {
      const decision = decideNext(
        { ...base, now: step * 5_000, lastActivityAt: step * 5_000 - (step % 20) * 5_000, history: history.slice(-6), x, minX: 0, maxX: 300, canHop: true, canJump: step % 3 === 0, canRelocate: true },
        rng,
      );
      if (decision.targetX !== undefined) x = decision.targetX;
      run = history[history.length - 1] === decision.action ? run + 1 : 1;
      longestRun = Math.max(longestRun, run);
      movingStreak = MOVING.has(decision.action) ? movingStreak + 1 : 0;
      longestMoving = Math.max(longestMoving, movingStreak);
      history.push(decision.action);
      counts[decision.action] += 1;
      // ジャンプ・跳ねるは 1 秒弱、隠れている時間は静か。
      const ms = decision.action === 'jump' || decision.action === 'hop' ? 800 : decision.durationMs;
      if (MOVING.has(decision.action)) movingMs += ms;
      else calmMs += ms;
    }
    // 素材のある行動はすべて現れる (v0.9 で毛づくろい・伸びも届いた)。どれも全体の 3 割を超えない。
    for (const action of ACTIONS) {
      expect(counts[action], action).toBeGreaterThan(20);
      expect(counts[action], action).toBeLessThan(900);
    }
    expect(longestRun).toBeLessThanOrEqual(5);
    expect(longestMoving).toBeLessThanOrEqual(2);
    expect(calmMs / (calmMs + movingMs)).toBeGreaterThan(0.75);
  });

  it('素材のない (読み込めていない) 動作は選ばない', () => {
    const rng = seededRng(5);
    for (let i = 0; i < 400; i += 1) {
      const action = decideNext({ ...base, history: i % 2 ? ['rest'] : [], available: (id) => id !== 'groom' && id !== 'stretch' }, rng).action;
      expect(['groom', 'stretch']).not.toContain(action);
    }
  });

  it('素材が届いた動作 (毛づくろい・伸び) は、表を変えるだけで選ばれるようになる', () => {
    const rng = seededRng(3);
    const seen = new Set<HarimaruAction>();
    for (let i = 0; i < 400; i += 1) {
      seen.add(decideNext({ ...base, history: i % 2 ? ['rest'] : [], available: () => true }, rng).action);
    }
    expect(seen.has('groom')).toBe(true);
    expect(seen.has('stretch')).toBe(true);
  });

  it('跳ねる空き・ジャンプ先・移れる場所がなければ、その行動は選ばない', () => {
    const weights = actionWeights({ ...base, canHop: false, canJump: false, canRelocate: false });
    expect(weights.hop).toBe(0);
    expect(weights.jump).toBe(0);
    expect(weights.hide).toBe(0);
  });

  it('駆け足は歩くより速く、足場の中で止まる', () => {
    for (let seed = 0; seed < 400; seed += 1) {
      const decision = decideNext({ ...base, x: 100, minX: 0, maxX: 400 }, seededRng(seed));
      if (decision.action !== 'run') continue;
      expect(decision.targetX).toBeGreaterThanOrEqual(0);
      expect(decision.targetX).toBeLessThanOrEqual(400);
      expect(decision.durationMs).toBeCloseTo((Math.abs(decision.targetX! - 100) / DEFAULT_BEHAVIOR.runSpeed) * 1000);
      return;
    }
    throw new Error('run was never chosen');
  });
});
