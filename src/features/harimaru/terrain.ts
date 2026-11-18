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

/** 同じ高さ (±1px) で隙間が joinGap 以下の足場をつなぐ。角丸の内側余白はつなぐ前に外側の端にだけ適用する。 */
export function mergePlatforms(platforms: readonly Platform[], params: TerrainParams = DEFAULT_TERRAIN): Platform[] {
  const byTop = [...platforms]
    .filter((p) => Number.isFinite(p.left) && Number.isFinite(p.right) && Number.isFinite(p.top) && p.right > p.left)
    .sort((a, b) => a.top - b.top);
  // 高さの差が 1px 以内の足場を 1 つの段にまとめ、段の中で左から順につなぐ。
  const rows: Platform[][] = [];
  for (const platform of byTop) {
    const row = rows[rows.length - 1];
    if (row && platform.top - row[0].top <= 1) row.push(platform);
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

/** 縦方向の表示範囲 [top, bottom] (ページ座標) に、立っている姿がすべて収まる足場。 */
export function visibleSegments(segments: readonly Segment[], view: { top: number; bottom: number }): Segment[] {
  return segments.filter((s) => s.top - SPRITE.height >= view.top && s.top <= view.bottom);
}
