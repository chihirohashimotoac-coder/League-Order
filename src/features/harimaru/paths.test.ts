import { describe, expect, it } from 'vitest';
import { DEFAULT_MOTION, SPRITE } from './params';
import { allowSelf, entryPlans, retreatOf, stepAt, stepsAreClear, sweptBoxes, type Step, type View } from './paths';
import { CLIPS } from './sprite';
import type { Rect, Segment } from './terrain';

/** 経路の純関数 (画面端からの登場)。座標はページ座標 (CSS px)。 */

const VIEW: View = { top: 60, bottom: 780, left: 0, right: 390 };

/** 要素の箱から、角丸 12px を除いた上辺の足場。 */
function segmentOf(box: Rect): Segment {
  const left = box.left + 12;
  const right = box.right - 12;
  return { top: box.top, left, right, minX: left - SPRITE.sideInset, maxX: right - SPRITE.width + SPRITE.sideInset };
}

const frames = (steps: readonly Step[]): string[] =>
  steps.map((s) => (s.pose.sheet === 'base' ? `base:${s.pose.row}` : `${s.pose.sheet}:${s.pose.frame}`)).filter((f, i, all) => f !== all[i - 1]);

const peek = { mode: 'peek' as const, holdMs: 500 };

describe('左右の端からの登場', () => {
  const box = { left: 263, right: 378, top: 448, bottom: 579 };
  const target = segmentOf(box);

  it('右端: 端の向こうから耳と目をのぞかせ、隙間を小さく跳んで足場に着地する (前足 → 後ろ足)', () => {
    const plans = entryPlans('right', [target], [box], VIEW, peek);
    expect(plans.length).toBeGreaterThan(0);
    const { steps, end } = plans[0];
    // 最初のコマは右端の外 (見えない)、のぞく位置で見えるのは端から 6・12 px だけ。
    expect(steps[0].x).toBeGreaterThanOrEqual(VIEW.right);
    expect(VIEW.right - steps[1].x).toBe(6);
    expect(VIEW.right - steps[2].x).toBe(12);
    expect(steps[2].tween).toBe('hold');
    expect(steps[2].ms).toBe(500);
    expect(steps.every((s) => s.dir === -1)).toBe(true);
    expect(frames(steps)).toEqual(['base:0', 'jumpPrep:0', 'jumpAir:0', 'jumpLand:0', 'jumpLand:1', 'base:0']);
    // 着地してからは横に動かない (前足の接地のあとに滑らない)。
    const land = steps.findIndex((s) => s.pose.sheet === 'jumpLand');
    expect(steps.slice(land).every((s) => s.x === steps[land].x && s.y === box.top - SPRITE.height)).toBe(true);
    expect(end!.x).toBeGreaterThanOrEqual(target.minX);
    expect(end!.x).toBeLessThanOrEqual(target.maxX);
    expect(end!.top).toBe(box.top);
  });

  it('左端: 向きは右、端の外から入る。立ち止まらずに入るときは、のぞいて止まる段がない', () => {
    const box2 = { left: 12, right: 190, top: 300, bottom: 400 };
    const plans = entryPlans('left', [segmentOf(box2)], [box2], VIEW, { mode: 'direct', holdMs: 500 });
    const { steps } = plans[0];
    expect(steps[0].x + SPRITE.width).toBeLessThanOrEqual(VIEW.left);
    expect(steps.every((s) => s.dir === 1)).toBe(true);
    expect(steps.some((s) => s.ms === 500)).toBe(false);
    expect(frames(steps)).toEqual(['base:0', 'jumpAir:0', 'jumpLand:0', 'jumpLand:1', 'base:0']);
  });

  it('足場が端まで続いていれば歩いて入る。端から遠すぎる足場には入らない', () => {
    const edgeBox = { left: -20, right: 200, top: 300, bottom: 400 };
    const walk = entryPlans('left', [{ top: 300, left: 0, right: 188, minX: -2, maxX: 160 }], [edgeBox], VIEW, peek)[0];
    expect(frames(walk.steps)).toEqual(['base:0', 'base:1', 'base:0']);
    const far = { left: 200, right: 380, top: 300, bottom: 400 };
    expect(entryPlans('left', [segmentOf(far)], [far], VIEW, peek)).toHaveLength(0);
  });

  it('画面の端と要素の間の実際の空白が entryMaxGap (24px) までなら入り、それより広い空白は跳び越えない', () => {
    const at = (left: number) => ({ left, right: left + 180, top: 300, bottom: 400 });
    const edge = at(VIEW.left + DEFAULT_MOTION.entryMaxGap);
    expect(entryPlans('left', [segmentOf(edge)], [edge], VIEW, peek).length).toBeGreaterThan(0);
    const over = at(VIEW.left + DEFAULT_MOTION.entryMaxGap + 1);
    expect(entryPlans('left', [segmentOf(over)], [over], VIEW, peek)).toHaveLength(0);
    // 右端も同じ (要素の右の角から画面の右端まで)。
    const right = { left: 150, right: VIEW.right - DEFAULT_MOTION.entryMaxGap - 1, top: 300, bottom: 400 };
    expect(entryPlans('right', [segmentOf(right)], [right], VIEW, peek)).toHaveLength(0);
  });

  it('足場が複数の要素にまたがるときは、入る側の端の要素と画面の端の空白で決める', () => {
    const near = { left: 12, right: 200, top: 300, bottom: 400 };
    const far = { left: 180, right: 360, top: 300, bottom: 400 };
    const merged: Segment = { top: 300, left: 24, right: 348, minX: 24 - SPRITE.sideInset, maxX: 348 - SPRITE.width + SPRITE.sideInset };
    expect(entryPlans('left', [merged], [near, far], VIEW, peek).length).toBeGreaterThan(0);
    // 右端の空白は 390 - 360 = 30 px (> 24): 右からは入らない。
    expect(entryPlans('right', [merged], [near, far], VIEW, peek)).toHaveLength(0);
  });

  it('のぞいて引っ込む経路: のぞく位置まで同じで、同じ端の外へ戻る。着いた先は持たない', () => {
    const plan = entryPlans('right', [target], [box], VIEW, peek)[0];
    const back = retreatOf(plan);
    expect(back.mode).toBe('retreat');
    expect(back.end).toBeNull();
    expect(back.steps[2]).toEqual(plan.steps[2]);
    expect(back.steps[back.steps.length - 1].x).toBe(plan.steps[0].x);
    expect(back.steps.every((s) => s.pose.sheet === 'base')).toBe(true);
    // 経路のどこでも、見えるのは端から 12 px まで。
    for (const b of sweptBoxes(back.steps)) expect(b.left).toBeGreaterThanOrEqual(VIEW.right - 12);
  });
});

describe('上端からの登場', () => {
  const box = { left: 100, right: 300, top: 180, bottom: 260 };

  it('頭から見せ (peekTop)、落ちて (dropAir)、四足で受け止める (dropLand)。最初のコマは端の上 (見えない)', () => {
    const plans = entryPlans('top', [segmentOf(box)], [box], VIEW, { ...peek, dir: 1 });
    expect(plans.length).toBeGreaterThan(0);
    const { steps } = plans[0];
    expect(steps[0].y + SPRITE.height).toBeLessThanOrEqual(VIEW.top);
    expect(frames(steps)).toEqual(['peekTop:0', 'dropAir:0', 'dropLand:0', 'base:0']);
    // 落ちる間は横に動かず、着地のコマは足元 = 上辺。
    const land = steps.find((s) => s.pose.sheet === 'dropLand')!;
    expect(land.y).toBe(box.top - SPRITE.height);
    expect(new Set(steps.map((s) => s.x)).size).toBe(1);
    // 落下は加速する (前半より後半で多く進む)。
    const fall = steps.findIndex((s) => s.tween === 'fall');
    const a = stepAt(steps, fall, 0.5).y - steps[fall].y;
    const b = stepAt(steps, fall, 1).y - stepAt(steps, fall, 0.5).y;
    expect(b).toBeGreaterThan(a);
  });

  it('端から遠すぎる (entryMaxDrop を超える) 足場には落ちない', () => {
    const low = { left: 100, right: 300, top: VIEW.top + DEFAULT_MOTION.entryMaxDrop + 10, bottom: 700 };
    expect(entryPlans('top', [segmentOf(low)], [low], VIEW, peek)).toHaveLength(0);
  });

  it('引っ込むときは peekTop の位置を同じ端の外へ戻す', () => {
    const back = retreatOf(entryPlans('top', [segmentOf(box)], [box], VIEW, peek)[0]);
    expect(back.steps.every((s) => s.pose.sheet === 'peekTop')).toBe(true);
    expect(back.steps[back.steps.length - 1].y + SPRITE.height).toBeLessThanOrEqual(VIEW.top);
  });
});

describe('下端からの登場 (側面をよじ登る)', () => {
  // 画面の下へ続く要素 (下端 900 > 見えている下端 780)。上辺の足場は右の角まで届く。
  const box = { left: 100, right: 300, top: 640, bottom: 900 };

  it('側面の横で耳と目から見せ、sideMount → sideClimb (組ごとに同じ前足) → sideLedge → climb → 待機', () => {
    const plans = entryPlans('bottom', [segmentOf(box)], [box], VIEW, peek);
    const right = plans.find((p) => p.steps[0].dir === -1)!;
    const left = plans.find((p) => p.steps[0].dir === 1)!;
    expect(right && left).toBeTruthy();
    for (const plan of [right, left]) {
      const { steps } = plan;
      const dir = steps[0].dir;
      const face = dir < 0 ? box.right : box.left;
      expect(steps[0].y).toBeGreaterThan(VIEW.bottom);
      const order = frames(steps);
      expect(order[0]).toBe('base:0');
      expect(order[1]).toBe('sideMount:0');
      const ledge = order.indexOf('sideLedge:0');
      expect(order.slice(2, ledge).every((f) => f.startsWith('sideClimb:'))).toBe(true);
      expect(order.slice(ledge + 1, ledge + 7)).toEqual(['climb:0', 'climb:1', 'climb:2', 'climb:3', 'climb:4', 'climb:5']);
      expect(order[order.length - 1]).toBe('base:0');
      // 前足 (基準点) の世界座標: 側面の線の上。組 (つかむ・押し上げる) の中では同じ高さ、組ごとに上がる。
      const grips: number[] = [];
      for (const s of steps) {
        if (s.pose.sheet !== 'sideClimb') continue;
        const a = CLIPS.sideClimb.anchors[s.pose.frame]!;
        const ax = dir < 0 ? a[0] : SPRITE.width - a[0];
        expect(s.x + ax).toBeCloseTo(face, 6);
        grips.push(s.y + a[1]);
      }
      for (let i = 0; i < grips.length; i += 2) expect(grips[i + 1]).toBeCloseTo(grips[i], 6);
      for (let i = 2; i < grips.length; i += 2) expect(grips[i]).toBeLessThan(grips[i - 2]);
      // 最後の組は上辺の高さ。上辺の角への持ち替えも同じ角。
      expect(grips[grips.length - 1]).toBeCloseTo(box.top, 6);
      // 最後の climb のコマと待機は同じ描画原点。立ち姿は上辺の足場に立つ。
      const last = steps[steps.length - 1];
      const lastClimb = [...steps].reverse().find((s) => s.pose.sheet === 'climb')!;
      expect(last.y).toBe(box.top - SPRITE.height);
      expect(lastClimb.y).toBeCloseTo(last.y, 6);
      expect(plan.end!.top).toBe(box.top);
      expect(plan.end!.x).toBeGreaterThanOrEqual(segmentOf(box).minX - 0.01);
      expect(plan.end!.x).toBeLessThanOrEqual(segmentOf(box).maxX + 0.01);
    }
  });

  it('要素が画面の下まで続いていなければ、下端からは入らない', () => {
    const short = { left: 100, right: 300, top: 640, bottom: 760 };
    expect(entryPlans('bottom', [segmentOf(short)], [short], VIEW, peek)).toHaveLength(0);
  });

  it('文書の下端より下にセルを置く経路は安全とみなさない (スクロールの範囲を広げない)', () => {
    const plan = entryPlans('bottom', [segmentOf(box)], [box], VIEW, peek)[0];
    expect(stepsAreClear(plan.steps, [], { view: VIEW, beyond: 'bottom', overhang: 6 })).toBe(true);
    expect(stepsAreClear(plan.steps, [], { view: VIEW, beyond: 'bottom', overhang: 6, docBottom: VIEW.bottom })).toBe(false);
  });
});

describe('経路の安全判定', () => {
  const box = { left: 263, right: 378, top: 448, bottom: 579 };
  const plan = entryPlans('right', [segmentOf(box)], [box], VIEW, peek)[0];

  it('端の向こうの部分は数えないが、見えている範囲の障害物 (のぞく位置の文字など) には重ならない', () => {
    expect(stepsAreClear(plan.steps, [], { view: VIEW, beyond: 'right' })).toBe(true);
    // 端の向こうに見張りの経路を数えないとき (beyond なし) は、画面の外に出るので安全でない。
    expect(stepsAreClear(plan.steps, [], { view: VIEW })).toBe(false);
    // のぞく位置 (右端から 12 px) に文字がある。
    expect(stepsAreClear(plan.steps, [{ left: 380, right: 390, top: 430, bottom: 440 }], { view: VIEW, beyond: 'right' })).toBe(false);
    // 端の向こう (画面の外) の要素は数えない。
    expect(stepsAreClear(plan.steps, [{ left: 395, right: 420, top: 430, bottom: 440 }], { view: VIEW, beyond: 'right' })).toBe(true);
  });

  it('候補の要素自身の箱は decorAllowance だけ内側へ縮めて数える (上辺はそのまま)。ほかの障害物はそのまま', () => {
    const self = { left: 100, right: 200, top: 300, bottom: 400 };
    const other = { left: 0, right: 10, top: 0, bottom: 10 };
    expect(allowSelf([self, other], [{ ...self, left: 100.4 }], 3)).toEqual([{ left: 103, right: 197, top: 300, bottom: 397 }, other]);
    expect(allowSelf([self], [], 3)).toEqual([self]);
  });
});
