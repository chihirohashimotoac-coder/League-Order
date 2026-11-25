/**
 * 観戦画面 → ハリマルへの、ライブの状態の受け渡し (小さな購読)。
 *
 * - 観戦画面は、既存のライブのポーラーが画面に渡した状態を、そのまま `publishLive` で流すだけ (新しい取得はしない)。
 * - 同時に流せるのは 1 つの観戦画面だけ: 最後に `claimLive` した画面 (主たる観戦対象)。ほかの画面の状態は捨てる。
 * - 聞き手 (ハリマルの描画レイヤー) がいなければ何もしない (表示 OFF・動きを減らす設定・観戦以外の画面)。
 */
import type { LiveState } from '../matches/parse';

export type LiveFeedMessage =
  | { kind: 'state'; source: string; state: LiveState; allyId: string | null }
  /**
   * 次の状態を基準にし直す (通信の失敗・取得上限・非表示のあと: その間の出来事には反応しない)。
   * `base` 付き (過去の Leg の表示をすべて解除したとき): 表示中に受け取った、同じ観戦対象の最新の状態。聞き手はこれを
   * 演出せずに基準にする (解除のあとに `changed: 0` が続いても、次の新しい出来事を基準として捨てない)。
   */
  | { kind: 'rebase'; source: string; base?: { state: LiveState; allyId: string | null } }
  /** 観戦対象 source の画面が過去の Leg を表示し始めた: その source の演出中・待っている出来事を取り消す (表示中は流さない)。 */
  | { kind: 'hold'; source: string }
  | { kind: 'release'; source: string };

type Listener = (message: LiveFeedMessage) => void;

const listeners = new Set<Listener>();
/** 流す権利を持つ観戦画面 (後から来たものが優先)。 */
const claims: string[] = [];
/**
 * 観戦対象 (source) ごとの、流す権利を持っている間に受け取った最新の状態 (停止中・聞き手がいない間に受け取ったものを
 * 含む: 表示 OFF の間に進んだ状態も基準に含める)。停止をすべて解除したときの基準に使う。
 * 信頼できない記録は捨てる: 権利のない間に状態が届いた (取りこぼしがある)・権利が移った・権利を手放した・
 * 基準のやり直し (通信の失敗など)・タブの表示の切り替え (forgetLiveStates)。
 */
const latest = new Map<string, { state: LiveState; allyId: string | null }>();

export function subscribeLive(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** 観戦画面が、状態を流す権利を取る。返り値で手放す。 */
export function claimLive(source: string): () => void {
  // 権利が移る: それまでの記録 (前の画面のもの、または取り直す画面の古いもの) は基準に使わない。
  latest.clear();
  claims.push(source);
  return () => {
    const index = claims.lastIndexOf(source);
    if (index >= 0) claims.splice(index, 1);
    if (!claims.includes(source)) latest.delete(source);
    for (const listener of [...listeners]) listener({ kind: 'release', source });
  };
}

/** いま流す権利を持っている観戦画面。 */
export function activeLiveSource(): string | null {
  return claims[claims.length - 1] ?? null;
}

/** 観戦対象 (source) ごとの、過去の Leg を表示している画面の数。1 つ以上ある source の状態は流さない。 */
const holds = new Map<string, number>();

/**
 * 観戦対象 `source` の画面が過去の Leg を表示している間、その source の状態を流さない (見ていない進行中の Leg に
 * 反応しない)。ほかの source (2 カード表示の左・開いた試合のページなど) は止めない。返り値で解除する (2 回目以降の
 * 解除は何もしない)。その source の停止がすべて解けたら、表示中に受け取った最新の状態を演出せずに基準にする
 * (表示中に起きた出来事に反応せず、解除のあとの新しい出来事には反応する)。受け取った状態がなければ、次の状態を
 * 基準にし直す (従来どおり)。
 */
export function holdLive(source: string): () => void {
  holds.set(source, (holds.get(source) ?? 0) + 1);
  for (const listener of [...listeners]) listener({ kind: 'hold', source });
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const left = (holds.get(source) ?? 1) - 1;
    if (left > 0) {
      holds.set(source, left);
      return;
    }
    holds.delete(source);
    const base = latest.get(source);
    if (listeners.size === 0 || activeLiveSource() !== source) return;
    for (const listener of [...listeners]) listener(base ? { kind: 'rebase', source, base } : { kind: 'rebase', source });
  };
}

export function publishLive(source: string, state: LiveState, allyId: string | null): void {
  if (activeLiveSource() !== source) {
    latest.delete(source);
    return;
  }
  latest.set(source, { state, allyId });
  if (listeners.size === 0 || holds.has(source)) return;
  for (const listener of [...listeners]) listener({ kind: 'state', source, state, allyId });
}

/**
 * 記録した状態をすべて捨てる (タブが非表示になった・表示に戻ったとき。その前に受け取った状態は、停止の解除の
 * 基準に使わない。戻ったあとに受け取った状態からまた記録する)。
 */
export function forgetLiveStates(): void {
  latest.clear();
}

export function rebaseLive(source: string): void {
  // それまでに受け取った状態は、停止の解除の基準に使わない (その後に受け取る状態から記録し直す)。
  latest.delete(source);
  if (listeners.size === 0 || activeLiveSource() !== source) return;
  for (const listener of [...listeners]) listener({ kind: 'rebase', source });
}
