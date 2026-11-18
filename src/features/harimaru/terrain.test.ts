import { describe, expect, it } from 'vitest';
import { DEFAULT_TERRAIN, SPRITE } from './params';
import { computeSegments, findSegment, mergePlatforms, subtractIntervals, visibleSegments } from './terrain';

const bounds = { left: 0, right: 2_000 };
const inset = DEFAULT_TERRAIN.cornerInset;

describe('mergePlatforms', () => {
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
