import { useCallback, useEffect, useState } from 'react';
import { NO_DECISIONS } from '../personLink';
import type { IdentityDecisions } from '../personLink';

/**
 * 本人照合の手動の判断（解除・確認）を、リーグごとにこの端末へ保存する。解除した行は、次に取得し直しても
 * 自動では結合し直さない（`personLink.ts`）。保存できない環境では、この画面を開いている間だけ有効。
 */
const keyOf = (leagueId: string): string => `league-order.analytics.identity.${leagueId}`;

function read(leagueId: string): IdentityDecisions {
  try {
    const raw = window.localStorage.getItem(keyOf(leagueId));
    if (!raw) return NO_DECISIONS;
    const value = JSON.parse(raw) as Partial<IdentityDecisions>;
    return {
      unlinks: Array.isArray(value.unlinks) ? value.unlinks.filter((x): x is string => typeof x === 'string') : [],
      confirms: value.confirms && typeof value.confirms === 'object' ? Object.fromEntries(Object.entries(value.confirms).filter(([, v]) => typeof v === 'string')) : {},
    };
  } catch {
    return NO_DECISIONS;
  }
}

export interface IdentityControls {
  decisions: IdentityDecisions;
  /** Undoes an automatic join of a row (it stays apart from now on). */
  unlink: (rowKey: string) => void;
  /** Joins a held row to the person a row of whom is `targetRowKey`. */
  confirm: (rowKey: string, targetRowKey: string) => void;
  /** Takes back an undo or a confirmation. */
  reset: (rowKey: string) => void;
}

export function useIdentityDecisions(leagueId: string | null): IdentityControls {
  const [state, setState] = useState<{ leagueId: string | null; decisions: IdentityDecisions }>(() => ({ leagueId, decisions: leagueId ? read(leagueId) : NO_DECISIONS }));
  useEffect(() => {
    if (state.leagueId !== leagueId) setState({ leagueId, decisions: leagueId ? read(leagueId) : NO_DECISIONS });
  }, [leagueId, state.leagueId]);
  const decisions = state.leagueId === leagueId ? state.decisions : leagueId ? read(leagueId) : NO_DECISIONS;
  const save = useCallback(
    (next: IdentityDecisions) => {
      setState({ leagueId, decisions: next });
      if (!leagueId) return;
      try {
        window.localStorage.setItem(keyOf(leagueId), JSON.stringify(next));
      } catch {
        // Not kept beyond this screen; the choice still applies now.
      }
    },
    [leagueId],
  );
  const unlink = useCallback((rowKey: string) => save({ unlinks: [...new Set([...decisions.unlinks, rowKey])], confirms: Object.fromEntries(Object.entries(decisions.confirms).filter(([k]) => k !== rowKey)) }), [decisions, save]);
  const confirm = useCallback((rowKey: string, targetRowKey: string) => save({ unlinks: decisions.unlinks.filter((k) => k !== rowKey), confirms: { ...decisions.confirms, [rowKey]: targetRowKey } }), [decisions, save]);
  const reset = useCallback((rowKey: string) => save({ unlinks: decisions.unlinks.filter((k) => k !== rowKey), confirms: Object.fromEntries(Object.entries(decisions.confirms).filter(([k]) => k !== rowKey)) }), [decisions, save]);
  return { decisions, unlink, confirm, reset };
}
