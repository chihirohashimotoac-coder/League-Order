/**
 * 触れ合いの判定 (純関数)。DOM のイベントから取り出した数値だけを入力にする。
 *
 * - 短いタップ・クリックだけを採用する。長押し・スワイプ・複数の指・キャンセル・ボタンなどの
 *   操作部品の上・文字の選択・右クリックは採用しない (既存の操作はそのまま通る)。
 * - キャラクターはクリックを受け取らない (pointer-events: none)。押された位置が表示枠の上か近くか
 *   だけを、ページ全体の受動的なリスナーで見る。
 */
import { DEFAULT_INTERACTION, SPRITE, type InteractionParams } from './params';
import type { Rect } from './terrain';

export interface Gesture {
  /** 押してから離すまでの時間と、押した位置からの最大の移動 (CSS px)。 */
  durationMs: number;
  maxMove: number;
  /** 同時に触れていた指の数の最大。 */
  pointers: number;
  /** pointercancel で終わった。 */
  cancelled: boolean;
  /** マウスの左ボタン以外。 */
  secondaryButton: boolean;
  /** 押した要素が操作部品 (ボタン・リンク・入力など) の中。 */
  onControl: boolean;
  /** 離したときに文字が選択されている。 */
  selectedText: boolean;
}

export type GestureRejection = 'long' | 'moved' | 'multi' | 'cancelled' | 'button' | 'control' | 'selection';

/** 短いタップ・クリックとして採用できるか。できなければ理由。 */
export function classifyGesture(gesture: Gesture, params: InteractionParams = DEFAULT_INTERACTION): GestureRejection | null {
  if (gesture.cancelled) return 'cancelled';
  if (gesture.pointers > 1) return 'multi';
  if (gesture.secondaryButton) return 'button';
  if (gesture.onControl) return 'control';
  if (gesture.durationMs > params.tapMaxMs) return 'long';
  if (gesture.maxMove > params.tapMaxMove) return 'moved';
  if (gesture.selectedText) return 'selection';
  return null;
}

export type TouchZone = 'face' | 'back' | 'behind' | 'near' | null;

/**
 * 触れた場所が体のどこか。表示枠の見える部分 (左右の透明な余白を除く) を、向きに合わせて
 * 顔側 (前 40%) と背中・しっぽ側に分ける。しっぽ側の外 behindWidth までは「背後」、
 * 足元の段の上 approachRange までは「近く」。
 * @param x 表示枠の左端、top 足元の y、dir 向き (-1 = 左向き = 元の絵)
 */
export function touchZone(
  point: { x: number; y: number },
  sprite: { x: number; top: number; dir: -1 | 1 },
  params: InteractionParams = DEFAULT_INTERACTION,
): TouchZone {
  const left = sprite.x + SPRITE.sideInset;
  const right = sprite.x + SPRITE.width - SPRITE.sideInset;
  const top = sprite.top - SPRITE.height;
  const bottom = sprite.top;
  const slop = params.touchSlop;
  const insideY = point.y >= top - slop && point.y <= bottom + slop;
  if (insideY && point.x >= left - slop && point.x <= right + slop) {
    const width = right - left;
    // 左向きなら顔は左側。
    const faceEdge = sprite.dir < 0 ? left + width * 0.4 : right - width * 0.4;
    const onFace = sprite.dir < 0 ? point.x <= faceEdge : point.x >= faceEdge;
    return onFace ? 'face' : 'back';
  }
  if (insideY) {
    const behindLeft = sprite.dir < 0 ? right + slop : left - slop - params.behindWidth;
    const behindRight = sprite.dir < 0 ? right + slop + params.behindWidth : left - slop;
    if (point.x >= behindLeft && point.x <= behindRight) return 'behind';
  }
  const center = sprite.x + SPRITE.width / 2;
  if (Math.abs(point.x - center) <= params.approachRange && point.y >= top - 60 && point.y <= bottom + 40) return 'near';
  return null;
}

export type Reaction = 'happy' | 'turn' | 'surprise' | 'flee' | 'approach' | 'tilt' | null;

/**
 * 触れた場所と最近の接触から反応を決める。何度も触られたら (fleeTouches 回) 逃げる。
 * 近くの余白へのタップには、気まぐれに近づくか、首をかしげる (どちらもしないこともある)。
 * @param recentTouches この接触を含む、fleeWindowMs 以内に体に触れた時刻
 */
export function reactionFor(
  zone: TouchZone,
  recentTouches: number,
  rng: () => number,
  params: InteractionParams = DEFAULT_INTERACTION,
): Reaction {
  if (zone === null) return null;
  if (zone === 'near') {
    const roll = rng();
    if (roll < params.approachChance) return 'approach';
    return roll < params.approachChance + (1 - params.approachChance) * params.nearTiltChance ? 'tilt' : null;
  }
  if (recentTouches >= params.fleeTouches) return 'flee';
  if (zone === 'face') return 'happy';
  if (zone === 'back') return 'turn';
  return 'surprise';
}

/** 直近 windowMs 以内の時刻だけを残す。 */
export function recentTimes(times: readonly number[], now: number, windowMs: number): number[] {
  return times.filter((t) => now - t <= windowMs);
}

export type CursorReaction = 'approach' | 'peekNear' | 'lookUp' | 'tilt' | 'play' | 'cursorHang' | null;

/**
 * PC のカーソルへの反応。カーソルが足元の段の近くにあるときだけ、気まぐれに選ぶ。
 * - 速く動いている → じゃれる
 * - すぐ近くで止まっている → たまにぶら下がる (跳びつける位置で、経路と周りが安全なとき: canHang) /
 *   頭の上なら見上げる / 横なら首をかしげる
 * - 少し離れて止まっている → 近づく・近くから顔を出す・首をかしげる
 * 素材を読み込めていない反応は選ばない (available)。
 */
export function cursorReaction(
  input: {
    distance: number;
    stillMs: number;
    speed: number;
    /** カーソルがキャラクターの頭より上にあるか。 */
    above?: boolean;
    /** カーソルの先端に安全に跳びつけるか。 */
    canHang?: boolean;
    available: (id: 'lookUp' | 'tilt' | 'play' | 'cursorHang' | 'approach' | 'peekNear') => boolean;
  },
  rng: () => number,
  params: InteractionParams = DEFAULT_INTERACTION,
): CursorReaction {
  if (input.distance > params.cursorNear * 2) return null;
  if (input.speed >= params.fastCursor && input.distance <= params.cursorNear) {
    return input.available('play') && rng() < 0.5 ? 'play' : null;
  }
  if (input.stillMs < params.cursorStillMs) return null;
  if (input.distance <= 48) {
    if (input.canHang && input.available('cursorHang') && rng() < 0.15) return 'cursorHang';
    const roll = rng();
    if (input.above && input.available('lookUp') && roll < 0.4) return 'lookUp';
    if (input.available('tilt') && roll >= (input.above ? 0.4 : 0) && roll < (input.above ? 0.55 : 0.3)) return 'tilt';
    return null;
  }
  const roll = rng();
  if (roll < params.cursorApproachChance && input.available('approach')) return 'approach';
  if (roll < params.cursorApproachChance + params.cursorPeekChance && input.available('peekNear')) return 'peekNear';
  if (roll >= 0.92 && input.available('tilt')) return 'tilt';
  return null;
}

/** 2 つの矩形が重なるか (0.5px 未満の接触は除く)。 */
export function intersects(a: Rect, b: Rect): boolean {
  return a.right > b.left + 0.5 && a.left < b.right - 0.5 && a.bottom > b.top + 0.5 && a.top < b.bottom - 0.5;
}
