/**
 * 観戦中の画面の自動スリープ防止 (Screen Wake Lock API, `navigator.wakeLock.request('screen')`)。
 *
 * 表示中のライブ観戦ビュー (いま進行中の試合・リーグのライブ・日程・結果の進行中の対戦) が
 * `acquire()` で「保持者」になり、返された関数で抜ける。保持者が 1 人以上いて、ページが表示中
 * (`visibilityState === 'visible'`) の間だけ、画面のロックを 1 つ持つ。
 *
 * - 要求は同時に 1 件まで。複数の対戦を同時に表示しても、React Strict Mode で effect が
 *   付け直されても、ロックの要求は重ならない (保持者を数えるだけ)。
 * - 要求の途中で不要になった (保持者がいなくなった・ページが隠れた) ときは、遅れて届いたロックを
 *   すぐ解除する。要求の途中で再び必要になったときは、届いたロックをそのまま使う。
 * - ページが隠れたら解除し、表示に戻ったら取り直す。OS がロックを解除した (省電力など) ときは、
 *   次にページが表示に戻るまで取り直さない (繰り返しの要求をしない)。
 * - API が無い・要求が拒否された・例外が出たときは何もしない (観戦はそのまま続く)。拒否のあとは、
 *   次にページが表示に戻るか、保持者が新たに現れるまで要求しない。
 * - `visibilitychange` のリスナーは、保持者がいる間だけ 1 つ付ける。
 */

export interface WakeSentinel {
  release(): Promise<void>;
  addEventListener(type: 'release', listener: () => void): void;
  removeEventListener(type: 'release', listener: () => void): void;
}

export interface WakeEnvironment {
  /** `navigator.wakeLock` (無ければ `undefined`)。 */
  wakeLock(): { request(type: 'screen'): Promise<WakeSentinel> } | undefined;
  visible(): boolean;
  onVisibility(listener: () => void): () => void;
}

export interface ScreenWake {
  /** 保持者になる。返された関数で抜ける (2 回目以降の呼び出しは何もしない)。 */
  acquire(): () => void;
  /** テスト・確認用: 保持者の数、ロックを持っているか、要求中か。 */
  readonly snapshot: { holders: number; held: boolean; pending: boolean };
}

const ignore = (): void => undefined;

export function browserWakeEnvironment(): WakeEnvironment {
  return {
    wakeLock: () => {
      if (typeof navigator === 'undefined') return undefined;
      const api = (navigator as Navigator & { wakeLock?: { request(type: 'screen'): Promise<WakeSentinel> } }).wakeLock;
      return api && typeof api.request === 'function' ? api : undefined;
    },
    visible: () => typeof document !== 'undefined' && document.visibilityState === 'visible',
    onVisibility: (listener) => {
      if (typeof document === 'undefined') return ignore;
      document.addEventListener('visibilitychange', listener);
      return () => document.removeEventListener('visibilitychange', listener);
    },
  };
}

export function createScreenWake(environment: WakeEnvironment = browserWakeEnvironment()): ScreenWake {
  let holders = 0;
  let sentinel: WakeSentinel | null = null;
  let pending = false;
  /** 要求し直してよい機会 (表示に戻った・保持者が新たに現れた) のたびに増える。 */
  let chance = 0;
  /** 最後に要求した (または拒否された) ときの `chance`。同じ機会には二度要求しない。 */
  let triedAt = -1;
  let unlisten: (() => void) | null = null;

  const wanted = (): boolean => holders > 0 && environment.visible();

  const drop = (held: WakeSentinel): void => {
    held.removeEventListener('release', onReleased);
    try {
      void held.release().catch(ignore);
    } catch {
      // 解除できなくても、OS がいずれ解除する。
    }
  };

  // OS (またはブラウザ) が解除した: 次に表示に戻るまで取り直さない。
  function onReleased(): void {
    if (sentinel) sentinel.removeEventListener('release', onReleased);
    sentinel = null;
  }

  const request = (): void => {
    const api = environment.wakeLock();
    if (!api) return;
    triedAt = chance;
    let asked: Promise<WakeSentinel>;
    try {
      asked = api.request('screen');
    } catch {
      return;
    }
    pending = true;
    asked.then(
      (got) => {
        pending = false;
        if (wanted() && !sentinel) {
          sentinel = got;
          got.addEventListener('release', onReleased);
        } else drop(got);
      },
      () => {
        pending = false;
        // 要求中に新しい機会があった (隠れて表示に戻った等) ときだけ、もう一度。
        sync();
      },
    );
  };

  function sync(): void {
    if (wanted()) {
      if (!sentinel && !pending && triedAt !== chance) request();
    } else if (sentinel) {
      const held = sentinel;
      sentinel = null;
      drop(held);
    }
  }

  const onVisibility = (): void => {
    if (environment.visible()) chance += 1;
    sync();
  };

  return {
    acquire() {
      holders += 1;
      if (holders === 1) {
        unlisten = environment.onVisibility(onVisibility);
        // 要求中に抜けてすぐ戻った (Strict Mode の付け直し・画面の切り替え) ときは、同じ要求の続き。
        if (!pending) chance += 1;
      }
      sync();
      let left = false;
      return () => {
        if (left) return;
        left = true;
        holders -= 1;
        if (holders === 0) {
          unlisten?.();
          unlisten = null;
        }
        sync();
      };
    },
    get snapshot() {
      return { holders, held: sentinel !== null, pending };
    },
  };
}

/** アプリ全体で 1 つ。 */
export const screenWake: ScreenWake = createScreenWake();
