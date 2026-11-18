/**
 * ハリマルの行動選択 (純関数)。DOM・React・時計に依存せず、乱数を差し替えて全分岐をテストできる。
 *
 * 固定の巡回ではなく、直前の行動・直近の履歴・無操作の時間・足場の広さから重み付き抽選で選ぶ。
 * 「何もしない (待機)」も候補に含め、同じ行動が機械的に続かないよう重みを下げる。
 * PR1 は待機・歩行・睡眠の 3 動作。PR2 以降で行動を追加しても、この関数の形は変えない。
 */
import { DEFAULT_BEHAVIOR, type BehaviorParams } from './params';

export type HarimaruAction = 'idle' | 'walk' | 'sleep';

/** 0 以上 1 未満の乱数を返す関数。テストでは固定列やシード付きの関数に差し替える。 */
export type Rng = () => number;

export interface DecisionInput {
  /** いまの時刻と、最後にユーザーが操作した時刻 (ms)。 */
  now: number;
  lastActivityAt: number;
  /** 直近の行動 (新しい順ではなく古い順。末尾が直前)。 */
  history: readonly HarimaruAction[];
  /** キャラクターの左端 x と、いまの足場で取れる左端 x の範囲 (CSS px)。 */
  x: number;
  minX: number;
  maxX: number;
}

export interface Decision {
  action: HarimaruAction;
  /** 待機・睡眠の長さ (ms)。歩行は距離と速さから決まる時間。 */
  durationMs: number;
  /** 歩行の目的地 (左端 x)。 */
  targetX?: number;
}

/** 範囲 [min, max] の一様な値。 */
export function between(rng: Rng, [min, max]: readonly [number, number]): number {
  return min + (max - min) * rng();
}

/** 重み付き抽選。重みの合計が 0 のときは null。 */
export function pickWeighted<T>(rng: Rng, entries: readonly (readonly [T, number])[]): T | null {
  const total = entries.reduce((sum, [, weight]) => sum + Math.max(0, weight), 0);
  if (!(total > 0)) return null;
  let roll = rng() * total;
  for (const [value, weight] of entries) {
    const w = Math.max(0, weight);
    if (roll < w) return value;
    roll -= w;
  }
  // 浮動小数点の端数: 最後の正の重みを返す。
  for (let i = entries.length - 1; i >= 0; i -= 1) if (entries[i][1] > 0) return entries[i][0];
  return null;
}

/** 歩ける方向と最大距離。最小距離を取れない方向は 0。 */
export function walkRoom(input: Pick<DecisionInput, 'x' | 'minX' | 'maxX'>, params: BehaviorParams = DEFAULT_BEHAVIOR): { left: number; right: number } {
  const [minDistance, maxDistance] = params.walkDistance;
  const left = Math.min(maxDistance, Math.max(0, input.x - input.minX));
  const right = Math.min(maxDistance, Math.max(0, input.maxX - input.x));
  return { left: left >= minDistance ? left : 0, right: right >= minDistance ? right : 0 };
}

/** 各行動の重み。テストと調整のために公開する。 */
export function actionWeights(input: DecisionInput, params: BehaviorParams = DEFAULT_BEHAVIOR): Record<HarimaruAction, number> {
  const room = walkRoom(input, params);
  const inactive = input.now - input.lastActivityAt >= params.inactiveSleepAfterMs;
  const weights: Record<HarimaruAction, number> = {
    idle: params.weights.idle,
    walk: room.left > 0 || room.right > 0 ? params.weights.walk : 0,
    sleep: inactive ? params.sleepWhenInactive : params.weights.sleep,
  };
  const last = input.history[input.history.length - 1];
  const beforeLast = input.history[input.history.length - 2];
  if (last) weights[last] *= last === beforeLast ? params.repeatTwicePenalty : params.repeatPenalty;
  // 目覚めた直後にすぐ眠り直さない。
  if (last === 'sleep') weights.sleep = 0;
  return weights;
}

/** 次の行動を決める。 */
export function decideNext(input: DecisionInput, rng: Rng, params: BehaviorParams = DEFAULT_BEHAVIOR): Decision {
  const weights = actionWeights(input, params);
  const action = pickWeighted<HarimaruAction>(rng, [
    ['idle', weights.idle],
    ['walk', weights.walk],
    ['sleep', weights.sleep],
  ]) ?? 'idle';

  if (action === 'walk') {
    const room = walkRoom(input, params);
    const direction = room.left > 0 && room.right > 0 ? (rng() < 0.5 ? -1 : 1) : room.left > 0 ? -1 : 1;
    const limit = direction < 0 ? room.left : room.right;
    const distance = Math.min(limit, between(rng, [params.walkDistance[0], Math.max(params.walkDistance[0], limit)]));
    const targetX = clamp(input.x + direction * distance, input.minX, input.maxX);
    const durationMs = (Math.abs(targetX - input.x) / params.walkSpeed) * 1000;
    return { action, durationMs, targetX };
  }
  if (action === 'sleep') return { action, durationMs: between(rng, params.sleepMs) };
  return { action: 'idle', durationMs: between(rng, params.idleMs) };
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** シード付きの乱数 (mulberry32)。テスト・プレビューの再現用。 */
export function seededRng(seed: number): Rng {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
