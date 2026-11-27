import { describe, expect, it } from 'vitest';
import { DEFAULT_MOTION, DEFAULT_TERRAIN, SPRITE } from './params';
import { climbPlans, dropPlans, hopArcHeight, hopPlans, pickPlan, stepAt, stepsAreClear, type MovePlan, type Step } from './paths';
import { CLIPS } from './sprite';
import { computeSegments, type Rect } from './terrain';

/** 足場の間の移動 (横の小ジャンプ・飛び降り・側面のよじ登り) の経路 (純関数)。 */

const VIEW = { top: 0, bottom: 2_000, left: 0, right: 1_400 };

/** 箱だけの地形 (障害物は箱そのもの = 色の付いたカード)。 */
function world(boxes: Rect[], extra: Rect[] = []) {
  const segments = computeSegments({ platforms: boxes.map((b) => ({ left: b.left, right: b.right, top: b.top })), obstacles: [...boxes, ...extra], bounds: { left: 0, right: 1_400 } });
  return { boxes, segments, obstacles: [...boxes, ...extra] };
}

const frames = (steps: readonly Step[]): string[] =>
  steps.map((s) => (s.pose.sheet === 'base' ? `base:${s.pose.row}` : `${s.pose.sheet}:${s.pose.frame}`)).filter((f, i, all) => f !== all[i - 1]);

const at = (segments: ReturnType<typeof world>['segments'], top: number, left: number) => segments.find((s) => s.top === top && s.left <= left + 13 && s.left >= left)!;

function clear(plan: MovePlan, w: ReturnType<typeof world>, extra: { seeThrough?: Rect } = {}): boolean {
  const obstacles = extra.seeThrough ? w.obstacles.filter((o) => o !== extra.seeThrough) : w.obstacles;
  const selfBoxes = [plan.fromBox, plan.toBox].filter((i): i is number => i !== null).map((i) => w.boxes[i]);
  return stepsAreClear(plan.steps, obstacles, { view: VIEW, selfBoxes, decor: DEFAULT_MOTION.decorAllowance, overhang: 6 });
}

describe('横の小ジャンプ', () => {
  it('隣の縁を見て体を低くし、弧を描いて隣の上辺へ。前足 → 後ろ足の順に着地し、着地してから横に滑らない', () => {
    const w = world([{ left: 100, right: 300, top: 400, bottom: 520 }, { left: 310, right: 500, top: 400, bottom: 520 }]);
    const from = at(w.segments, 400, 100);
    const plans = hopPlans(from, w.segments, w.boxes);
    expect(plans.length).toBeGreaterThan(0);
    for (const plan of plans) {
      expect(frames(plan.steps)).toEqual(['base:0', 'jumpPrep:0', 'jumpAir:0', 'jumpLand:0', 'jumpLand:1', 'base:0']);
      const land = plan.steps.findIndex((s) => s.pose.sheet === 'jumpLand');
      expect(plan.steps.slice(land).every((s) => s.x === plan.end!.x)).toBe(true);
      expect(plan.end!.x).toBeGreaterThanOrEqual(plan.end!.segment.minX);
      expect(clear(plan, w)).toBe(true);
    }
  });

  it('狭い隙間は低い弧、広い隙間は高い弧 (高さは隙間に合わせて連続して変わる)', () => {
    const narrow = world([{ left: 100, right: 300, top: 400, bottom: 520 }, { left: 310, right: 500, top: 400, bottom: 520 }]);
    const wide = world([{ left: 100, right: 300, top: 400, bottom: 520 }, { left: 336, right: 536, top: 400, bottom: 520 }]);
    const arcOf = (w: ReturnType<typeof world>) => {
      const plan = hopPlans(at(w.segments, 400, 100), w.segments, w.boxes)[0];
      const air = plan.steps.find((s) => s.pose.sheet === 'jumpAir')!;
      return typeof air.tween === 'object' ? air.tween.arc : 0;
    };
    expect(arcOf(narrow)).toBeCloseTo(hopArcHeight(10), 6);
    expect(arcOf(wide)).toBeCloseTo(hopArcHeight(36), 6);
    expect(arcOf(wide)).toBeGreaterThan(arcOf(narrow) + 8);
    expect(hopArcHeight(0)).toBe(DEFAULT_MOTION.hopArc.min);
    expect(hopArcHeight(1_000)).toBe(DEFAULT_MOTION.hopArc.max);
  });

  it('要素どうしの実際の隙間が hopMaxGap を超える広い空白は跳び越えない', () => {
    const edge = world([{ left: 100, right: 300, top: 400, bottom: 520 }, { left: 300 + DEFAULT_MOTION.hopMaxGap, right: 560, top: 400, bottom: 520 }]);
    expect(hopPlans(at(edge.segments, 400, 100), edge.segments, edge.boxes).some((p) => p.end!.segment.left >= 300)).toBe(true);
    const over = world([{ left: 100, right: 300, top: 400, bottom: 520 }, { left: 300 + DEFAULT_MOTION.hopMaxGap + 1, right: 560, top: 400, bottom: 520 }]);
    expect(hopPlans(at(over.segments, 400, 100), over.segments, over.boxes)).toHaveLength(0);
  });

  it('届かない距離・高さの違う足場・文字で切れた端からは跳ばない。経路の上に文字があれば安全でない', () => {
    const far = world([{ left: 100, right: 300, top: 400, bottom: 520 }, { left: 300 + DEFAULT_TERRAIN.jumpMaxGap + 30, right: 700, top: 400, bottom: 520 }]);
    expect(hopPlans(at(far.segments, 400, 100), far.segments, far.boxes)).toHaveLength(0);
    const step = world([{ left: 100, right: 300, top: 400, bottom: 520 }, { left: 310, right: 500, top: 380, bottom: 520 }]);
    expect(hopPlans(at(step.segments, 400, 100), step.segments, step.boxes)).toHaveLength(0);
    // 文字が足場の右の端を切る (端が要素の角ではない)。
    const text = { left: 240, right: 300, top: 380, bottom: 396 };
    const cut = world([{ left: 100, right: 300, top: 400, bottom: 520 }, { left: 310, right: 500, top: 400, bottom: 520 }], [text]);
    expect(hopPlans(at(cut.segments, 400, 100), cut.segments, cut.boxes).filter((p) => p.end!.segment.left > 300)).toHaveLength(0);
    // 隙間の上に文字 (経路をふさぐ)。
    const above = { left: 296, right: 316, top: 366, bottom: 378 };
    const blocked = world([{ left: 100, right: 300, top: 400, bottom: 520 }, { left: 310, right: 500, top: 400, bottom: 520 }]);
    const plans = hopPlans(at(blocked.segments, 400, 100), blocked.segments, blocked.boxes);
    expect(plans.every((p) => !stepsAreClear(p.steps, [...blocked.obstacles, above], { view: VIEW, selfBoxes: [blocked.boxes[0], blocked.boxes[1]], decor: 3 }))).toBe(true);
  });
});

describe('飛び降り', () => {
  const w = world([{ left: 100, right: 300, top: 400, bottom: 460 }, { left: 280, right: 600, top: 500, bottom: 620 }]);

  it('縁から下をのぞき、前足を先に出して縁を離れ、落ちて四足で受け止める (横ジャンプの着地とは別のコマ)', () => {
    const plans = dropPlans(at(w.segments, 400, 100), w.segments, w.boxes);
    expect(plans.length).toBeGreaterThan(0);
    const safe = plans.filter((p) => clear(p, w));
    expect(safe.length).toBeGreaterThan(0);
    for (const plan of safe) {
      expect(frames(plan.steps)).toEqual(['base:0', 'lookDown:0', 'dropAir:0', 'dropLand:0', 'base:0']);
      expect(plan.steps.some((s) => s.pose.sheet === 'jumpLand')).toBe(false);
      // 落ちる前に、元のカードの横 (右の側面の外) へ出ている。
      const fall = plan.steps.findIndex((s) => s.tween === 'fall');
      expect(plan.steps[fall].x + 30 - 23).toBeGreaterThanOrEqual(300 - DEFAULT_MOTION.decorAllowance);
      expect(plan.end!.top).toBe(500);
      const land = plan.steps.find((s) => s.pose.sheet === 'dropLand')!;
      expect(land.y).toBe(500 - SPRITE.height);
      expect(land.x).toBe(plan.end!.x);
    }
  });

  it('高すぎる段・元のカードの下 (横へ出られない) には降りない', () => {
    const deep = world([{ left: 100, right: 300, top: 400, bottom: 460 }, { left: 280, right: 600, top: 400 + DEFAULT_MOTION.dropMax + 20, bottom: 700 }]);
    expect(dropPlans(at(deep.segments, 400, 100), deep.segments, deep.boxes)).toHaveLength(0);
    const under = world([{ left: 100, right: 300, top: 400, bottom: 460 }, { left: 120, right: 260, top: 500, bottom: 600 }]);
    expect(dropPlans(at(under.segments, 400, 100), under.segments, under.boxes)).toHaveLength(0);
  });
});

describe('側面のよじ登り (上向きのジャンプの代わり)', () => {
  // 高いカード (上辺 300) の右の側面のすぐ横に、低いカード (上辺 400) の足場がある。
  const high = { left: 100, right: 300, top: 300, bottom: 420 };
  const low = { left: 200, right: 600, top: 400, bottom: 520 };
  const w = world([high, low]);

  it('側面に前足をかけ、組ごとに同じ前足でつかんで押し上げ、上辺の角へ持ち替えて climb で上辺に乗る', () => {
    const from = w.segments.find((s) => s.top === 400)!;
    const plans = climbPlans(from, w.segments, w.boxes);
    expect(plans).toHaveLength(1);
    const plan = plans[0];
    const order = frames(plan.steps);
    expect(order.slice(0, 3)).toEqual(['base:0', 'base:1', 'sideMount:0']);
    const ledge = order.indexOf('sideLedge:0');
    expect(order.slice(3, ledge).every((f) => f.startsWith('sideClimb:'))).toBe(true);
    expect(order.slice(ledge + 1, ledge + 7)).toEqual(['climb:0', 'climb:1', 'climb:2', 'climb:3', 'climb:4', 'climb:5']);
    expect(order[order.length - 1]).toBe('base:0');
    const dir = plan.steps[0].dir;
    expect(dir).toBe(-1);
    // 前足は側面の線 (x = 300) の上。組の中で同じ高さ、組ごとに上がり、最後の組は上辺。
    const grips = plan.steps.filter((s) => s.pose.sheet === 'sideClimb').map((s) => {
      const a = CLIPS.sideClimb.anchors[(s.pose as { frame: number }).frame]!;
      expect(s.x + a[0]).toBeCloseTo(300, 6);
      return s.y + a[1];
    });
    for (let i = 0; i < grips.length; i += 2) expect(grips[i + 1]).toBe(grips[i]);
    expect(grips[grips.length - 1]).toBeCloseTo(300, 6);
    expect(Math.max(...grips.slice(0, -2).map((g, i) => g - grips[i + 2]))).toBeLessThanOrEqual(DEFAULT_MOTION.climbStep + 1);
    // 上辺に乗ったあとは、上辺の足場の立てる範囲に立つ。
    const top = w.segments.find((s) => s.top === 300)!;
    expect(plan.end!.top).toBe(300);
    expect(plan.end!.x).toBeLessThanOrEqual(top.maxX + 0.01);
    expect(clear(plan, w, { seeThrough: high })).toBe(true);
  });

  it('側面の横に文字があれば安全でない。低すぎる段差 (climbMinRise 未満) では登らない', () => {
    const from = w.segments.find((s) => s.top === 400)!;
    const plan = climbPlans(from, w.segments, w.boxes)[0];
    const label = { left: 304, right: 330, top: 340, bottom: 356 };
    expect(stepsAreClear(plan.steps, [label], { view: VIEW, overhang: 6 })).toBe(false);
    const flat = world([{ ...high, top: 390 }, low]);
    const f = flat.segments.find((s) => s.top === 400)!;
    expect(climbPlans(f, flat.segments, flat.boxes)).toHaveLength(0);
  });
});

describe('選び方', () => {
  it('余裕のある経路ほど選ばれやすく、直前に渡った組 (penalty) は選ばれにくい', () => {
    const plan = (distance: number): MovePlan => ({ kind: 'hop', startX: 0, steps: [], end: null, bounds: { left: 0, top: 0, right: 0, bottom: 0 }, fromBox: 0, toBox: 1, wallBox: null, distance });
    const counts = [0, 0];
    let seed = 1;
    const rng = () => {
      seed = (seed * 16807) % 2147483647;
      return seed / 2147483647;
    };
    for (let i = 0; i < 2_000; i += 1) {
      const options = [{ plan: plan(40), margin: 8, penalty: 1 }, { plan: plan(40), margin: 0, penalty: 1 }];
      counts[options.indexOf(pickPlan(rng, options)!)] += 1;
    }
    expect(counts[0]).toBeGreaterThan(counts[1] * 5);
    expect(pickPlan(rng, [{ plan: plan(10), margin: 0, penalty: 0 }])).toBeNull();
    expect(stepAt([{ pose: { sheet: 'base', row: 0, column: 0 }, x: 1, y: 2, dir: 1, ms: 10, tween: 'hold' }], 0, 0.5)).toEqual({ x: 1, y: 2 });
  });
});
