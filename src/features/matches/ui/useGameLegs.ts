import { useCallback, useEffect, useRef, useState } from 'react';
import { describeN01Error } from '../../../integrations/n01/client';
import type { MatchesApi } from '../api';
import type { ThrowLeg } from '../parse';
import { mergeLegs } from '../parse';

/**
 * The legs of **one** game (`mid`), as `match/throws` gives them, for the live sheet and the
 * game view.
 *
 * The game id is the boundary: everything held — legs, `since`, the status — belongs to the
 * `mid` it was read for. When `mid` changes, nothing of the previous game is returned, even for
 * the render before the new read starts, and a reply for another game (a late answer, or n01
 * moving a `tmid` / `scid` to the next game) is dropped. A failed read is a visible state
 * (`error`), retried on its own a few times and on request — never filled in with other legs.
 *
 * While the game is live, each time its current leg moves on, the legs changed since the last
 * read are re-read (`since`): a returned leg replaces the one held whole (a corrected visit
 * included). If that read fails the legs are `stale` until a retry succeeds.
 */

export type LegsStatus = 'loading' | 'ready' | 'error';

export interface GameLegs {
  legs: ThrowLeg[];
  status: LegsStatus;
  error: string | null;
  /** A leg ended but its final throws could not be re-read yet. */
  stale: boolean;
  retry: () => void;
}

/** Waits before the automatic re-reads of a failed first read (then only by hand). */
export const LEGS_RETRY_MS = [5_000, 15_000, 30_000] as const;
/** Waits before the automatic re-reads of a failed `since` read (then it stays `stale`). */
export const SYNC_RETRY_MS = [5_000, 10_000, 20_000, 40_000, 60_000] as const;

interface Held {
  mid: string;
  legs: ThrowLeg[];
  status: LegsStatus;
  error: string | null;
  stale: boolean;
}

export function useGameLegs(api: MatchesApi, mid: string, options: { finished: boolean; liveLegIndex: number | null }): GameLegs {
  const { finished, liveLegIndex } = options;
  const [held, setHeld] = useState<Held>({ mid, legs: [], status: 'loading', error: null, stale: false });
  const [attempt, setAttempt] = useState(0);
  const [syncAttempt, setSyncAttempt] = useState(0);
  const since = useRef<{ mid: string; value: number | null }>({ mid, value: null });
  // The live leg the held legs are up to date with: a `since` read only when it moves on.
  const synced = useRef<{ mid: string; leg: number | null }>({ mid, leg: null });
  const syncFailures = useRef(0);
  const liveLeg = useRef(liveLegIndex);
  liveLeg.current = liveLegIndex;

  // The whole game, once per mid (and again on a retry).
  useEffect(() => {
    let alive = true;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | null = null;
    since.current = { mid, value: null };
    setHeld((current) => (current.mid === mid && current.status === 'ready' ? current : { mid, legs: [], status: 'loading', error: null, stale: false }));
    api
      .throws(mid, null, { finished, signal: controller.signal })
      .then((reply) => {
        if (!alive) return;
        if (reply.mid && reply.mid !== mid) throw new Error('別のゲームの記録が返されました。');
        since.current = { mid, value: reply.updateTime };
        synced.current = { mid, leg: liveLeg.current };
        syncFailures.current = 0;
        setHeld({ mid, legs: reply.legs, status: 'ready', error: null, stale: false });
      })
      .catch((reason) => {
        if (!alive) return;
        setHeld({ mid, legs: [], status: 'error', error: describeN01Error(reason), stale: false });
        const wait = LEGS_RETRY_MS[attempt];
        if (wait !== undefined) timer = setTimeout(() => setAttempt((n) => n + 1), wait);
      });
    return () => {
      alive = false;
      controller.abort();
      if (timer) clearTimeout(timer);
    };
    // `attempt` re-runs the read; `finished` switches to the memoised read once the game ends.
  }, [api, mid, finished, attempt]);

  const ready = held.mid === mid && held.status === 'ready';

  // A live leg moved on: the legs changed since the last read.
  useEffect(() => {
    if (finished || !ready || liveLegIndex === null || since.current.mid !== mid || since.current.value === null) return;
    if (synced.current.mid === mid && synced.current.leg === liveLegIndex) return;
    let alive = true;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | null = null;
    api
      .throws(mid, since.current.value, { signal: controller.signal })
      .then((reply) => {
        if (!alive || (reply.mid && reply.mid !== mid)) return;
        if (reply.updateTime) since.current = { mid, value: reply.updateTime };
        synced.current = { mid, leg: liveLegIndex };
        syncFailures.current = 0;
        setHeld((current) => (current.mid !== mid ? current : { ...current, legs: reply.changed ? mergeLegs(current.legs, reply.legs) : current.legs, stale: false }));
      })
      .catch(() => {
        if (!alive) return;
        setHeld((current) => (current.mid !== mid ? current : { ...current, stale: true }));
        const wait = SYNC_RETRY_MS[syncFailures.current];
        syncFailures.current += 1;
        if (wait !== undefined) timer = setTimeout(() => setSyncAttempt((n) => n + 1), wait);
      });
    return () => {
      alive = false;
      controller.abort();
      if (timer) clearTimeout(timer);
    };
  }, [api, mid, finished, ready, liveLegIndex, syncAttempt]);

  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  if (held.mid !== mid) return { legs: [], status: 'loading', error: null, stale: false, retry };
  return { legs: held.legs, status: held.status, error: held.error, stale: held.stale, retry };
}
