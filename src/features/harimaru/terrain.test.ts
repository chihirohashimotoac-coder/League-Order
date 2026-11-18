import { describe, expect, it } from 'vitest';
import { DEFAULT_TERRAIN, SPRITE } from './params';
import { arcAt, arcBounds, arcIsClear, boxIsClear, computeSegments, findSegment, jumpCandidates, mergePlatforms, spriteBox, subtractIntervals, visibleSegments } from './terrain';

const bounds = { left: 0, right: 2_000 };
const inset = DEFAULT_TERRAIN.cornerInset;

describe('mergePlatforms', () => {
  it('ホバーで 2px 浮いたタイルも同じ列としてつなぐ (段の高さは最も高い上辺)', () => {
    const merged = mergePlatforms([
      { left: 0, right: 100, top: 50 },
      { left: 110, right: 200, top: 48 },
      { left: 210, right: 300, top: 54 },
    ]);
    expect(merged).toEqual([
      { left: inset, right: 200 - inset, top: 48 },
      { left: 210 + inset, right: 300 - inset, top: 54 },
    ]);
  });

  it('同じ高さで隙間の小さいタイルをつなぎ、外側の角だけ避ける', () => {
    const merged = mergePlatforms([
      { left: 0, right: 100, top: 50 },
      { left: 110, right: 200, top: 50.5 },
      { left: 300, right: 400, top: 50 },
    ]);
    expect(merged).toEqual([
      { left: inset, right: 200 - inset, top: 50 },
      { left: 300 + inset, right: 400 - inset, top: 50 },
    ]);
  });
});

describe('subtractIntervals', () => {
  it('ふさがれた区間を除く', () => {
    expect(subtractIntervals(0, 100, [[10, 20], [15, 30], [90, 120]])).toEqual([[0, 10], [30, 90]]);
    expect(subtractIntervals(0, 100, [[-10, 200]])).toEqual([]);
  });
});

describe('computeSegments', () => {
  const platform = { left: 0, right: 400, top: 200 };

  it('上に何もない足場は、角を除いた全幅を使える', () => {
    const [segment] = computeSegments({ platforms: [platform], obstacles: [], bounds });
    expect(segment.top).toBe(200);
    expect(segment.left).toBe(inset);
    expect(segment.right).toBe(400 - inset);
    expect(segment.minX).toBe(inset - SPRITE.sideInset);
    expect(segment.maxX).toBe(400 - inset - SPRITE.width + SPRITE.sideInset);
  });

  it('見出しの文字の横だけを使い、文字の上には立たない', () => {
    const heading = { left: 0, right: 80, top: 172, bottom: 190 };
    const segments = computeSegments({ platforms: [platform], obstacles: [heading], bounds });
    expect(segments).toHaveLength(1);
    expect(segments[0].left).toBe(80 + DEFAULT_TERRAIN.clearanceSide);
    // 立っている姿 (可視部分) は文字の矩形と重ならない。
    expect(segments[0].minX + SPRITE.sideInset).toBeGreaterThanOrEqual(heading.right);
  });

  it('足場そのもの・帯より上の要素は障害物にしない', () => {
    const self = { left: 0, right: 400, top: 200, bottom: 260 };
    const farAbove = { left: 0, right: 400, top: 100, bottom: 200 - SPRITE.height - DEFAULT_TERRAIN.clearanceTop };
    expect(computeSegments({ platforms: [platform], obstacles: [self, farAbove], bounds })).toHaveLength(1);
  });

  it('帯に少しでも重なるカードがあれば、その範囲は使わない', () => {
    const cardAbove = { left: 0, right: 400, top: 100, bottom: 200 - SPRITE.height - DEFAULT_TERRAIN.clearanceTop + 1 };
    expect(computeSegments({ platforms: [platform], obstacles: [cardAbove], bounds })).toEqual([]);
  });

  it('狭い隙間・画面外は使わない', () => {
    const left = { left: 0, right: 180, top: 180, bottom: 199 };
    const right = { left: 180 + 30, right: 400, top: 180, bottom: 199 };
    expect(computeSegments({ platforms: [platform], obstacles: [left, right], bounds })).toEqual([]);
    expect(computeSegments({ platforms: [platform], obstacles: [], bounds: { left: 0, right: 30 } })).toEqual([]);
  });
});

describe('findSegment / visibleSegments', () => {
  const segments = computeSegments({ platforms: [{ left: 0, right: 400, top: 200 }], obstacles: [], bounds });
  it('同じ高さ・範囲内の足場だけを見つける', () => {
    expect(findSegment(segments, 200.5, 100)).toBe(segments[0]);
    expect(findSegment(segments, 210, 100)).toBeNull();
    expect(findSegment(segments, 200, 1_000)).toBeNull();
    // ホバーで 2px 浮いた足場は、許容を広げたときだけ同じ足場とみなす。
    expect(findSegment(segments, 202, 100)).toBeNull();
    expect(findSegment(segments, 202, 100, 3)).toBe(segments[0]);
    expect(findSegment(segments, 204, 100, 3)).toBeNull();
  });
  it('立っている姿が見えている足場だけを登場の候補にする', () => {
    expect(visibleSegments(segments, { top: 0, bottom: 800 })).toHaveLength(1);
    expect(visibleSegments(segments, { top: 190, bottom: 800 })).toHaveLength(0);
    expect(visibleSegments(segments, { top: 0, bottom: 199 })).toHaveLength(0);
  });
  it('ピンチズーム中は、横方向にも見えている範囲だけを使う', () => {
    const [clipped] = visibleSegments(segments, { top: 0, bottom: 800, left: 200, right: 300 });
    expect(clipped.minX + SPRITE.sideInset).toBeGreaterThanOrEqual(200);
    expect(clipped.maxX + SPRITE.width - SPRITE.sideInset).toBeLessThanOrEqual(300);
    expect(visibleSegments(segments, { top: 0, bottom: 800, left: 380, right: 600 })).toHaveLength(0);
  });
});

describe('ジャンプの経路', () => {
  const plan = { from: { x: 100, top: 300 }, to: { x: 200, top: 280 }, height: 14 };
  it('放物線の両端は踏切・着地の足元、頂点は高い方の上辺からさらに上', () => {
    expect(arcAt(plan, 0)).toEqual({ x: 100, foot: 300 });
    expect(arcAt(plan, 1)).toEqual({ x: 200, foot: 280 });
    expect(arcAt(plan, 0.5).foot).toBeCloseTo(280 - 14);
    const bounds = arcBounds(plan);
    expect(bounds.top).toBeLessThanOrEqual(280 - 14 - SPRITE.height);
    expect(bounds.right).toBe(200 + SPRITE.width);
  });
  it('経路のどこかで障害物・表示範囲の外に触れたら安全でない', () => {
    const view = { top: 0, bottom: 1_000 };
    expect(arcIsClear(plan, [], view)).toBe(true);
    // 経路の真ん中あたりの上に文字がある。
    expect(arcIsClear(plan, [{ left: 140, right: 170, top: 240, bottom: 262 }], view)).toBe(false);
    // 経路の外 (はるか上) の文字は関係ない。
    expect(arcIsClear(plan, [{ left: 140, right: 170, top: 100, bottom: 120 }], view)).toBe(true);
    // 頂点が固定ヘッダーの下に隠れる位置は使わない。
    expect(arcIsClear(plan, [], { top: 250, bottom: 1_000 })).toBe(false);
  });
  it('spriteBox / boxIsClear は見える部分だけを使う', () => {
    expect(spriteBox(100, 200)).toEqual({ left: 102, right: 128, top: 180, bottom: 200 });
    expect(boxIsClear(spriteBox(100, 200), [{ left: 128, right: 140, top: 180, bottom: 200 }], { top: 0, bottom: 999 })).toBe(true);
    expect(boxIsClear(spriteBox(100, 200), [{ left: 120, right: 140, top: 180, bottom: 200 }], { top: 0, bottom: 999 })).toBe(false);
  });
  it('候補は横に並ぶ足場だけ。隙間・上り・下りの上限を超えるものは除く', () => {
    const segment = (left: number, right: number, top: number) => ({ top, left, right, minX: left, maxX: right - SPRITE.width });
    const current = segment(0, 200, 300);
    const near = segment(230, 400, 290);
    const farGap = segment(200 + DEFAULT_TERRAIN.jumpMaxGap + 40, 700, 300);
    const tooHigh = segment(240, 400, 300 - DEFAULT_TERRAIN.jumpMaxRise - 1);
    const tooLow = segment(240, 400, 300 + DEFAULT_TERRAIN.jumpMaxDrop + 1);
    const stacked = segment(0, 200, 380);
    const plans = jumpCandidates(current, [current, near, farGap, tooHigh, tooLow, stacked], 14);
    expect(plans.map((p) => p.target)).toEqual([near]);
    expect(plans[0].from.x).toBe(current.maxX);
    expect(plans[0].to.x).toBeGreaterThan(near.minX);
    const back = jumpCandidates(near, [current], 14);
    expect(back[0].from.x).toBe(near.minX);
    expect(back[0].to.x).toBeLessThan(current.maxX);
  });
});
