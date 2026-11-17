import { createContext, useContext, useEffect } from 'react';
import { screenWake } from '../screenWake';
import type { ScreenWake } from '../screenWake';

/**
 * 観戦ビューが画面に見えているか。試合のページを開いたとき、その下に隠して保持される一覧
 * (`watch-keep`) は `false` になり、その中のライブ観戦は画面のロックを持たない。
 */
export const WatchShownContext = createContext(true);

/** 隠して保持する部分。外側が隠れていれば内側も隠れている扱い。 */
export function WatchShown({ shown, children }: { shown: boolean; children: React.ReactNode }): React.JSX.Element {
  const outer = useContext(WatchShownContext);
  return <WatchShownContext.Provider value={outer && shown}>{children}</WatchShownContext.Provider>;
}

/**
 * `live` (対戦全体が進行中) で、この観戦ビューが見えている間、画面の自動スリープを防ぐ
 * (screenWake.ts)。ページが隠れたときの解除と、表示に戻ったときの取り直しは screenWake が行う。
 */
export function useScreenWake(live: boolean, wake: ScreenWake = screenWake): void {
  const shown = useContext(WatchShownContext);
  const on = live && shown;
  useEffect(() => (on ? wake.acquire() : undefined), [on, wake]);
}
