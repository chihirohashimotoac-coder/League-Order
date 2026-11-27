import { useCallback, useEffect, useRef, useState } from 'react';
import type { MatchesApi } from '../api';
import type { CardOrder } from '../parse';
import { describeN01Error } from '../../../integrations/n01/client';

/**
 * The orders of one league card (`team/order/list` by `tmid`), shared by every 観戦 view of a card
 * (ライブ・日程・結果・PC の 2 カード表示): one request for the whole card, never one per game.
 *
 * - Read when the view opens (or, opened while the page is hidden, when it is shown); with `poll`,
 *   again every {@link ORDER_POLL_MS} (30 s) while the page is visible. A hidden page sends nothing;
 *   coming back reads at once when the last read is older than the interval.
 * - One read at a time per view (and `MatchesApi.cardOrders` shares one request between views
 *   asking for the same card). `refresh()` reads now (the manual 再取得), unless a read is on.
 * - A failure keeps the last good orders and says so (`error`, `failedAt`); the next try waits
 *   30 s, 60 s, then 120 s (no fast retries).
 * - A reply for another card (the view moved on) or after the view closed is dropped.
 * - Polling stops when `poll` turns false (the card is over) and on unmount.
 */
export const ORDER_POLL_MS = 30_000;
export const ORDER_MAX_BACKOFF_MS = 120_000;

export interface CardOrdersState {
  /** The card these orders are of. */
  tmid: string | null;
  /** The last orders read without error; `null` before the first one. */
  rows: CardOrder[] | null;
  /** A read is on. */
  loading: boolean;
  /** The last read failed (the rows, if any, are of an earlier read). */
  error: string | null;
  fetchedAt: number | null;
  failedAt: number | null;
}

export interface CardOrders extends CardOrdersState {
  refresh: () => void;
}

const EMPTY = (tmid: string | null): CardOrdersState => ({ tmid, rows: null, loading: tmid !== null, error: null, fetchedAt: null, failedAt: null });

export function useCardOrders(api: MatchesApi, tournamentId: string, tmid: string | null, options: { poll: boolean }): CardOrders {
  const [state, setState] = useState<CardOrdersState>(() => EMPTY(tmid));
  const refreshRef = useRef<() => void>(() => undefined);
  const { poll } = options;

  useEffect(() => {
    setState((held) => (held.tmid === tmid ? held : EMPTY(tmid)));
    if (!tmid) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let controller: AbortController | null = null;
    let failures = 0;
    let lastTry = 0;
    const hidden = (): boolean => typeof document !== 'undefined' && document.visibilityState === 'hidden';
    const clear = (): void => {
      if (timer !== null) clearTimeout(timer);
      timer = null;
    };
    const schedule = (): void => {
      clear();
      if (!alive || !poll || hidden()) return;
      const wait = failures === 0 ? ORDER_POLL_MS : Math.min(ORDER_MAX_BACKOFF_MS, ORDER_POLL_MS * 2 ** (failures - 1));
      timer = setTimeout(() => {
        timer = null;
        load();
      }, wait);
    };
    const load = (): void => {
      if (!alive || controller) return;
      clear();
      lastTry = Date.now();
      const mine = new AbortController();
      controller = mine;
      setState((held) => (held.tmid === tmid ? { ...held, loading: true } : held));
      api
        .cardOrders(tournamentId, tmid, mine.signal)
        .then((rows) => {
          if (!alive || controller !== mine) return;
          failures = 0;
          setState({ tmid, rows, loading: false, error: null, fetchedAt: Date.now(), failedAt: null });
        })
        .catch((error: unknown) => {
          if (!alive || controller !== mine) return;
          failures += 1;
          setState((held) => (held.tmid === tmid ? { ...held, loading: false, error: describeN01Error(error), failedAt: Date.now() } : held));
        })
        .finally(() => {
          if (controller === mine) controller = null;
          if (alive) schedule();
        });
    };
    const onVisibility = (): void => {
      if (hidden()) {
        clear();
        return;
      }
      if (controller) return;
      // Never read yet (opened while hidden): now, polled or not.
      if (lastTry === 0) {
        load();
        return;
      }
      if (!poll) return;
      const waited = Date.now() - lastTry;
      if (waited >= ORDER_POLL_MS) load();
      else if (timer === null) schedule();
    };
    refreshRef.current = load;
    document.addEventListener('visibilitychange', onVisibility);
    if (!hidden()) load();
    return () => {
      alive = false;
      clear();
      controller?.abort();
      controller = null;
      document.removeEventListener('visibilitychange', onVisibility);
      refreshRef.current = () => undefined;
    };
  }, [api, tournamentId, tmid, poll]);

  const refresh = useCallback(() => refreshRef.current(), []);
  // A state of another card (the first render after `tmid` changed) is never shown.
  const shown = state.tmid === tmid ? state : EMPTY(tmid);
  return { ...shown, refresh };
}

/**
 * Whether a card not started when the view opened has started since: `match/live` by `tmid` every
 * 30 s while visible (n01 answers "match not found" until its first game starts). Used where no
 * other list of today's games is read (日程・結果) and for a card the live tab shows before its first
 * game; it stops for good once a game is seen. Errors wait longer (up to 120 s) and are not shown.
 */
export function useCardStart(api: MatchesApi, tmid: string | null, enabled: boolean): boolean {
  const [started, setStarted] = useState<string | null>(null);
  useEffect(() => {
    if (!tmid || !enabled || started === tmid) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let controller: AbortController | null = null;
    let failures = 0;
    let lastTry = 0;
    const hidden = (): boolean => document.visibilityState === 'hidden';
    const schedule = (): void => {
      if (timer !== null) clearTimeout(timer);
      timer = null;
      if (!alive || hidden()) return;
      timer = setTimeout(check, failures === 0 ? ORDER_POLL_MS : Math.min(ORDER_MAX_BACKOFF_MS, ORDER_POLL_MS * 2 ** (failures - 1)));
    };
    const check = (): void => {
      timer = null;
      if (!alive || controller) return;
      lastTry = Date.now();
      const mine = new AbortController();
      controller = mine;
      api
        .live({ tmid }, null, mine.signal)
        .then((reply) => {
          if (!alive || controller !== mine) return;
          if (!('changed' in reply && reply.changed === false) && 'tmid' in reply && reply.mid && reply.tmid === tmid) {
            setStarted(tmid);
            alive = false;
            return;
          }
          failures = 0;
        })
        .catch((error: unknown) => {
          if (!alive || controller !== mine) return;
          // "match not found" (HTTP 404 / result -1) is the answer before the first game: not a failure.
          const notYet = typeof error === 'object' && error !== null && 'kind' in error && ((error as { kind: string }).kind === 'notFound' || (error as { kind: string }).kind === 'schema');
          failures = notYet ? 0 : failures + 1;
        })
        .finally(() => {
          if (controller === mine) controller = null;
          if (alive) schedule();
        });
    };
    const onVisibility = (): void => {
      if (hidden()) {
        if (timer !== null) clearTimeout(timer);
        timer = null;
      } else if (!controller && timer === null) {
        if (Date.now() - lastTry >= ORDER_POLL_MS) check();
        else schedule();
      }
    };
    document.addEventListener('visibilitychange', onVisibility);
    // Opened while hidden: the first check waits for the page to be shown.
    if (!hidden()) check();
    return () => {
      alive = false;
      if (timer !== null) clearTimeout(timer);
      controller?.abort();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [api, tmid, enabled, started]);
  return started !== null && started === tmid;
}
