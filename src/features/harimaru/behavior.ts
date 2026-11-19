/**
 * ハリマルの行動選択 (純関数)。DOM・React・時計に依存せず、乱数を差し替えて全分岐をテストできる。
 *
 * 固定の巡回ではなく、直前の行動・直近の履歴・無操作の時間・足場の広さ・周りの空き (跳ねる余地、
 * 安全なジャンプ先、隠れて移れる別の足場) から重み付き抽選で選ぶ。「何もしない (待機・休む)」も
 * 候補に含め、同じ行動や動きっぱなしが続かないよう重みを下げる。
 * 素材のない動作 (clips.ts で available: false) は選ばない。
 */
import { isAvailable, type MotionId } from './clips';
import { DEFAULT_BEHAVIOR, type BehaviorParams } from './params';

/** 自分から選ぶ行動。 */
export type HarimaruAction = 'idle' | 'rest' | 'look' | 'walk' | 'run' | 'hop' | 'jump' | 'hide' | 'sleep' | 'groom' | 'stretch';

export const ACTIONS: readonly HarimaruAction[] = ['idle', 'rest', 'look', 'walk', 'run', 'hop', 'jump', 'hide', 'sleep', 'groom', 'stretch'];

/** 体が動く行動 (続けて選ばれにくくする。画面の中で動きっぱなしにしない)。 */
export const MOVING: ReadonlySet<HarimaruAction> = new Set(['walk', 'run', 'hop', 'jump']);
/** 静かな行動。 */
export const CALM: ReadonlySet<HarimaruAction> = new Set(['idle', 'rest', 'look', 'sleep', 'groom', 'stretch']);

/** 0 以上 1 未満の乱数を返す関数。テストでは固定列やシード付きの関数に差し替える。 */
export type Rng = () => number;

export interface DecisionInput {
  /** いまの時刻と、最後にユーザーが操作した時刻 (ms)。 */
  now: number;
  lastActivityAt: number;
  /** 直近の行動 (古い順。末尾が直前)。 */
  history: readonly HarimaruAction[];
  /** キャラクターの左端 x と、いまの足場で取れる左端 x の範囲 (CSS px)。 */
  x: number;
  minX: number;
  maxX: number;
  /** 上に跳ねる空きがあるか。 */
  canHop?: boolean;
  /** 安全なジャンプ先があるか。 */
  canJump?: boolean;
  /** 隠れて移れる別の足場 (または同じ足場の別の位置) があるか。 */
  canRelocate?: boolean;
  /** 素材のある動作か (既定: clips.ts の表)。 */
  available?: (id: MotionId) => boolean;
}

export interface Decision {
  action: HarimaruAction;
  /** 待機・休む・眠る・隠れている長さ (ms)。歩行・駆け足は距離と速さから決まる時間。 */
  durationMs: number;
  /** 歩行・駆け足の目的地 (左端 x)。 */
  targetX?: number;
  /** 隠れる前に足場の端まで歩くか (画面の外へ消えるように見せる)。 */
  walkToEdge?: boolean;
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
export function walkRoom(
  input: Pick<DecisionInput, 'x' | 'minX' | 'maxX'>,
  params: BehaviorParams = DEFAULT_BEHAVIOR,
  distance: readonly [number, number] = params.walkDistance,
): { left: number; right: number } {
  const [minDistance, maxDistance] = distance;
  const left = Math.min(maxDistance, Math.max(0, input.x - input.minX));
  const right = Math.min(maxDistance, Math.max(0, input.maxX - input.x));
  return { left: left >= minDistance ? left : 0, right: right >= minDistance ? right : 0 };
}

/** 各行動の重み。テストと調整のために公開する。 */
export function actionWeights(input: DecisionInput, params: BehaviorParams = DEFAULT_BEHAVIOR): Record<HarimaruAction, number> {
  const available = input.available ?? ((id: MotionId) => isAvailable(id));
  const room = walkRoom(input, params);
  const runRoom = walkRoom(input, params, params.runDistance);
  const inactive = input.now - input.lastActivityAt >= params.inactiveSleepAfterMs;
  const w = params.weights;
  const weights: Record<HarimaruAction, number> = {
    idle: w.idle,
    rest: inactive ? w.rest * 2 : w.rest,
    look: w.look,
    walk: room.left > 0 || room.right > 0 ? w.walk : 0,
    run: runRoom.left > 0 || runRoom.right > 0 ? w.run : 0,
    hop: input.canHop ? w.hop : 0,
    jump: input.canJump ? w.jump : 0,
    hide: input.canRelocate ? w.hide : 0,
    sleep: inactive ? params.sleepWhenInactive : w.sleep,
    groom: w.groom,
    stretch: w.stretch,
  };
  const last = input.history[input.history.length - 1];
  const beforeLast = input.history[input.history.length - 2];
  if (last) weights[last] *= last === beforeLast ? params.repeatTwicePenalty : params.repeatPenalty;
  // 動いたあとは静かな行動を選びやすく (動きっぱなしにしない)。
  if (last && MOVING.has(last)) for (const action of MOVING) weights[action] *= params.afterMovingPenalty;
  if (last && beforeLast && MOVING.has(last) && MOVING.has(beforeLast)) for (const action of MOVING) weights[action] = 0;
  // 休んだあとは眠りやすく、眠り・休みのあとは伸びをしやすい。目覚めた直後にすぐ眠り直さない。
  if (last === 'rest') weights.sleep *= 2;
  if (last === 'sleep' || last === 'rest') weights.stretch *= 3;
  if (last === 'sleep') weights.sleep = 0;
  // 素材のない動作は選ばない。
  for (const action of ACTIONS) if (!available(action)) weights[action] = 0;
  return weights;
}

/** 次の行動を決める。 */
export function decideNext(input: DecisionInput, rng: Rng, params: BehaviorParams = DEFAULT_BEHAVIOR): Decision {
  const weights = actionWeights(input, params);
  const action = pickWeighted<HarimaruAction>(rng, ACTIONS.map((a) => [a, weights[a]] as const)) ?? 'idle';

  if (action === 'walk' || action === 'run') {
    const distanceRange = action === 'run' ? params.runDistance : params.walkDistance;
    const speed = action === 'run' ? params.runSpeed : params.walkSpeed;
    const room = walkRoom(input, params, distanceRange);
    const direction = room.left > 0 && room.right > 0 ? (rng() < 0.5 ? -1 : 1) : room.left > 0 ? -1 : 1;
    const limit = direction < 0 ? room.left : room.right;
    const distance = Math.min(limit, between(rng, [distanceRange[0], Math.max(distanceRange[0], limit)]));
    const targetX = clamp(input.x + direction * distance, input.minX, input.maxX);
    const durationMs = (Math.abs(targetX - input.x) / speed) * 1000;
    return { action, durationMs, targetX };
  }
  if (action === 'sleep') return { action, durationMs: between(rng, params.sleepMs) };
  if (action === 'rest') return { action, durationMs: between(rng, params.restMs) };
  if (action === 'look') return { action, durationMs: between(rng, params.lookMs) };
  if (action === 'hide') return { action, durationMs: between(rng, params.hiddenMs), walkToEdge: rng() < params.walkToEdgeChance };
  if (action === 'hop' || action === 'jump') return { action, durationMs: 0 };
  if (action === 'groom' || action === 'stretch') return { action, durationMs: between(rng, params.idleMs) };
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
