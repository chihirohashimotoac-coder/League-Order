/**
 * 足場の判定 (純関数)。実 DOM から集めた矩形 (ページ座標, CSS px) だけを入力にする。
 *
 * - 足場 = カード・タイルの上辺。角丸を避けて内側だけを使い、同じ高さで隙間の小さい足場は 1 本につなぐ。
 * - キャラクターが立つ帯 (上辺から全高 + 余白ぶん上) に、文字・操作部品・色の付いた要素などの
 *   障害物が 1 つでも重なる x 範囲は使わない。障害物の判定は保守的に行い、迷う場所には立たない。
 * - 結果は「キャラクターの左端 x が取りうる範囲」で返す。範囲が狭い足場は捨てる (安全な場所がなければ非表示)。
 */
import { DEFAULT_TERRAIN, SPRITE, type TerrainParams } from './params';

export interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface Platform {
  left: number;
  right: number;
  /** 上辺の y (ページ座標)。 */
  top: number;
}

export interface Segment {
  /** 足元の y (= 足場の上辺)。 */
  top: number;
  /** 立てる帯の左右 (障害物と角を除いた範囲)。 */
  left: number;
  right: number;
  /** 表示枠 (幅 SPRITE.width) の左端 x が取りうる範囲。 */
  minX: number;
  maxX: number;
}

export interface TerrainInput {
  platforms: readonly Platform[];
  obstacles: readonly Rect[];
  /** 横方向に使ってよい範囲 (ページ座標)。画面の左右端・横スクロールを避ける。 */
  bounds: { left: number; right: number };
}

/** ほぼ同じ高さ (rowTolerance 以内) で隙間が joinGap 以下の足場をつなぐ。角丸の内側余白はつなぐ前に外側の端にだけ適用する。 */
export function mergePlatforms(platforms: readonly Platform[], params: TerrainParams = DEFAULT_TERRAIN): Platform[] {
  const byTop = [...platforms]
    .filter((p) => Number.isFinite(p.left) && Number.isFinite(p.right) && Number.isFinite(p.top) && p.right > p.left)
    .sort((a, b) => a.top - b.top);
  // 高さの差が rowTolerance 以内の足場を 1 つの段にまとめ、段の中で左から順につなぐ (段の高さは最も高い上辺)。
  const rows: Platform[][] = [];
  for (const platform of byTop) {
    const row = rows[rows.length - 1];
    if (row && platform.top - row[0].top <= params.rowTolerance) row.push(platform);
    else rows.push([platform]);
  }
  const merged: Platform[] = [];
  for (const row of rows) {
    const runs: Platform[] = [];
    for (const platform of [...row].sort((a, b) => a.left - b.left)) {
      const last = runs[runs.length - 1];
      if (last && platform.left - last.right <= params.joinGap) {
        last.right = Math.max(last.right, platform.right);
        last.top = Math.min(last.top, platform.top);
      } else {
        runs.push({ ...platform });
      }
    }
    merged.push(...runs);
  }
  return merged.map((p) => ({ ...p, left: p.left + params.cornerInset, right: p.right - params.cornerInset }));
}

/** 区間 [left, right] から、ふさがれた区間を取り除いた残り。 */
export function subtractIntervals(
  left: number,
  right: number,
  blocked: readonly (readonly [number, number])[],
): [number, number][] {
  const sorted = blocked.filter(([a, b]) => b > left && a < right).sort((a, b) => a[0] - b[0]);
  const free: [number, number][] = [];
  let cursor = left;
  for (const [a, b] of sorted) {
    if (a > cursor) free.push([cursor, Math.min(a, right)]);
    cursor = Math.max(cursor, b);
    if (cursor >= right) break;
  }
  if (cursor < right) free.push([cursor, right]);
  return free;
}

/** キャラクターが安全に立てる足場の一覧。 */
export function computeSegments(input: TerrainInput, params: TerrainParams = DEFAULT_TERRAIN): Segment[] {
  const segments: Segment[] = [];
  for (const platform of mergePlatforms(input.platforms, params)) {
    const left = Math.max(platform.left, input.bounds.left);
    const right = Math.min(platform.right, input.bounds.right);
    if (right - left < params.minSegmentWidth) continue;
    const bandTop = platform.top - SPRITE.height - params.clearanceTop;
    // 足場の上辺より 0.5px 以上上に始まり、帯の中まで届く要素は障害物。足場そのもの (上辺が同じ) は含めない。
    const blocked = input.obstacles
      .filter((o) => o.bottom > bandTop && o.top < platform.top - 0.5 && o.right > o.left && o.bottom > o.top)
      .map((o) => [o.left - params.clearanceSide, o.right + params.clearanceSide] as const);
    for (const [freeLeft, freeRight] of subtractIntervals(left, right, blocked)) {
      if (freeRight - freeLeft < params.minSegmentWidth) continue;
      // 表示枠の透明な左右余白は障害物に重なってもよい (見える部分だけを帯に収める)。
      const minX = freeLeft - SPRITE.sideInset;
      const maxX = freeRight - SPRITE.width + SPRITE.sideInset;
      if (maxX < minX) continue;
      segments.push({ top: platform.top, left: freeLeft, right: freeRight, minX, maxX });
    }
  }
  return segments;
}

/** いまの位置 (足元の y と左端 x) を含む足場。高さのずれが tolerance を超えた・消えたときは null。 */
export function findSegment(segments: readonly Segment[], top: number, x: number, tolerance = 1): Segment | null {
  const near = segments.filter((s) => Math.abs(s.top - top) <= tolerance && x >= s.minX - 1 && x <= s.maxX + 1);
  // 候補が複数あれば、高さの最も近い足場。
  return near.sort((a, b) => Math.abs(a.top - top) - Math.abs(b.top - top))[0] ?? null;
}

/**
 * 表示範囲 (ページ座標) に立っている姿がすべて収まる足場。横方向はピンチズーム中の見えている範囲に
 * 合わせて、左端 x の範囲を狭めた写しを返す (left / right を省くと横方向は制限しない)。
 */
export function visibleSegments(
  segments: readonly Segment[],
  view: { top: number; bottom: number; left?: number; right?: number },
): Segment[] {
  const viewLeft = view.left ?? -Infinity;
  const viewRight = view.right ?? Infinity;
  const visible: Segment[] = [];
  for (const s of segments) {
    if (s.top - SPRITE.height < view.top || s.top > view.bottom) continue;
    const minX = Math.max(s.minX, viewLeft - SPRITE.sideInset);
    const maxX = Math.min(s.maxX, viewRight - SPRITE.width + SPRITE.sideInset);
    if (maxX < minX) continue;
    visible.push({ ...s, minX, maxX });
  }
  return visible;
}

// ------------------------------------------------------------------ 経路 (ジャンプ・跳ねる)

/** 表示枠の見える部分 (左右の透明な余白を除く)。足元 foot から全高ぶん上。 */
export function spriteBox(x: number, foot: number): Rect {
  return { left: x + SPRITE.sideInset, right: x + SPRITE.width - SPRITE.sideInset, top: foot - SPRITE.height, bottom: foot };
}

function overlaps(a: Rect, b: Rect): boolean {
  return a.right > b.left + 0.5 && a.left < b.right - 0.5 && a.bottom > b.top + 0.5 && a.top < b.bottom - 0.5;
}

/** 矩形が障害物に重ならず、表示範囲の中に収まっているか。 */
export function boxIsClear(box: Rect, obstacles: readonly Rect[], view: { top: number; bottom: number; left?: number; right?: number }): boolean {
  if (box.top < view.top || box.bottom > view.bottom) return false;
  if (view.left !== undefined && box.left < view.left) return false;
  if (view.right !== undefined && box.right > view.right) return false;
  return !obstacles.some((o) => overlaps(box, o));
}

export interface JumpPlan {
  from: { x: number; top: number };
  to: { x: number; top: number };
  /** 頂点の高さ (踏切・着地の高い方の上辺からさらに上へ)。 */
  height: number;
  target: Segment;
}

/** 放物線の途中の位置 (t = 0〜1)。頂点は高い方の端から height だけ上。 */
export function arcAt(plan: Pick<JumpPlan, 'from' | 'to' | 'height'>, t: number): { x: number; foot: number } {
  const lift = plan.height + Math.abs(plan.from.top - plan.to.top) / 2;
  return {
    x: plan.from.x + (plan.to.x - plan.from.x) * t,
    foot: plan.from.top + (plan.to.top - plan.from.top) * t - 4 * lift * t * (1 - t),
  };
}

/**
 * 放物線の最も高い足元 (y が最小)。両端の高さが違うと頂点は t = 0.5 からずれるので、
 * 微分が 0 になる t を求めて [0, 1] に収める。
 */
export function arcPeakFoot(plan: Pick<JumpPlan, 'from' | 'to' | 'height'>): number {
  const lift = plan.height + Math.abs(plan.from.top - plan.to.top) / 2;
  const dy = plan.to.top - plan.from.top;
  const t = lift > 0 ? Math.min(1, Math.max(0, 0.5 - dy / (8 * lift))) : 0;
  return Math.min(arcAt(plan, t).foot, plan.from.top, plan.to.top);
}

/** 経路の全体が通る範囲 (障害物を集める範囲)。頂点で頭が届く高さまで含める。 */
export function arcBounds(plan: Pick<JumpPlan, 'from' | 'to' | 'height'>): Rect {
  return {
    left: Math.min(plan.from.x, plan.to.x),
    right: Math.max(plan.from.x, plan.to.x) + SPRITE.width,
    top: arcPeakFoot(plan) - SPRITE.height - 1,
    bottom: Math.max(plan.from.top, plan.to.top),
  };
}

function union(a: Rect, b: Rect): Rect {
  return { left: Math.min(a.left, b.left), right: Math.max(a.right, b.right), top: Math.min(a.top, b.top), bottom: Math.max(a.bottom, b.bottom) };
}

/**
 * 経路の全体で、見える部分が障害物に重ならず、表示範囲の中に収まるか。steps 等分した隣り合う 2 点の
 * 間を通る範囲 (2 つの矩形を包む矩形) で調べるので、点と点の間にある薄い線も見逃さない (保守的)。
 */
export function arcIsClear(
  plan: Pick<JumpPlan, 'from' | 'to' | 'height'>,
  obstacles: readonly Rect[],
  view: { top: number; bottom: number; left?: number; right?: number },
  steps = 24,
): boolean {
  // 両端は足場の上に立っている姿そのもの。間の区間は、足場の上辺 (着地・踏切の線) をまたがない。
  let previous = spriteBox(plan.from.x, plan.from.top);
  if (!boxIsClear(previous, obstacles, view)) return false;
  for (let i = 1; i <= steps; i += 1) {
    const { x, foot } = arcAt(plan, i / steps);
    const box = spriteBox(x, foot);
    const swept = union(previous, box);
    // 掃いた範囲の下端は、両端の足場の上辺より下へ出ない (足場そのものとは重ならない)。
    swept.bottom = Math.min(swept.bottom, Math.max(plan.from.top, plan.to.top));
    if (!boxIsClear(swept, obstacles, view)) return false;
    previous = box;
  }
  return true;
}

/**
 * いまの足場から、横に並ぶ別の足場へのジャンプの候補 (経路の安全はまだ確かめない)。
 * 横の隙間が jumpMaxGap 以下、上りは jumpMaxRise 以下、下りは jumpMaxDrop 以下のものだけ。
 */
export function jumpCandidates(
  current: Segment,
  segments: readonly Segment[],
  height: number,
  params: TerrainParams = DEFAULT_TERRAIN,
): JumpPlan[] {
  const plans: JumpPlan[] = [];
  for (const target of segments) {
    if (target.top === current.top && target.minX === current.minX && target.maxX === current.maxX) continue;
    const rise = current.top - target.top;
    if (rise > params.jumpMaxRise || -rise > params.jumpMaxDrop) continue;
    const inset = Math.min(16, (target.maxX - target.minX) / 2);
    if (target.minX > current.maxX) {
      const gap = target.minX - current.maxX;
      if (gap > params.jumpMaxGap || gap < 4) continue;
      plans.push({ from: { x: current.maxX, top: current.top }, to: { x: target.minX + inset, top: target.top }, height, target });
    } else if (target.maxX < current.minX) {
      const gap = current.minX - target.maxX;
      if (gap > params.jumpMaxGap || gap < 4) continue;
      plans.push({ from: { x: current.minX, top: current.top }, to: { x: target.maxX - inset, top: target.top }, height, target });
    }
  }
  return plans;
}
