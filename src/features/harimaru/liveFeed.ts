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
  /** 次の状態を基準にし直す (通信の失敗・取得上限・非表示のあと: その間の出来事には反応しない)。 */
  | { kind: 'rebase'; source: string }
  /** 観戦画面が過去の Leg を表示し始めた: 演出中・待っている出来事を取り消す (表示中は状態を流さない)。 */
  | { kind: 'hold' }
  | { kind: 'release'; source: string };

type Listener = (message: LiveFeedMessage) => void;

const listeners = new Set<Listener>();
/** 流す権利を持つ観戦画面 (後から来たものが優先)。 */
const claims: string[] = [];

export function subscribeLive(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** 観戦画面が、状態を流す権利を取る。返り値で手放す。 */
export function claimLive(source: string): () => void {
  claims.push(source);
  return () => {
    const index = claims.lastIndexOf(source);
    if (index >= 0) claims.splice(index, 1);
    for (const listener of [...listeners]) listener({ kind: 'release', source });
  };
}

/** いま流す権利を持っている観戦画面。 */
export function activeLiveSource(): string | null {
  return claims[claims.length - 1] ?? null;
}

/** 過去の Leg を表示している観戦画面の数。1 つ以上あれば状態を流さない。 */
let holds = 0;

/**
 * 観戦画面が過去の Leg を表示している間、状態を流さない (見ていない進行中の Leg に反応しない)。返り値で解除する。
 * 解除したら、いま流す権利を持つ画面の次の状態を基準にし直す (表示中に起きた出来事にまとめて反応しない)。
 */
export function holdLive(): () => void {
  holds += 1;
  for (const listener of [...listeners]) listener({ kind: 'hold' });
  let released = false;
  return () => {
    if (released) return;
    released = true;
    holds = Math.max(0, holds - 1);
    const source = activeLiveSource();
    if (holds === 0 && source) rebaseLive(source);
  };
}

export function publishLive(source: string, state: LiveState, allyId: string | null): void {
  if (listeners.size === 0 || holds > 0 || activeLiveSource() !== source) return;
  for (const listener of [...listeners]) listener({ kind: 'state', source, state, allyId });
}

export function rebaseLive(source: string): void {
  if (listeners.size === 0 || activeLiveSource() !== source) return;
  for (const listener of [...listeners]) listener({ kind: 'rebase', source });
}
