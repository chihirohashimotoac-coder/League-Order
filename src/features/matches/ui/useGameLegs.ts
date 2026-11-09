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
 * **A successful read is not a complete game.** What the legs held vouch for is checked against
 * the game's own data: every leg before the current one (the live poller's leg, or the reply's
 * `current_leg`, whichever is further on) must be held *and ended*. A reply asked for at leg 0
 * that arrives once leg 1 has started carries leg 0 unfinished — it vouches for nothing past
 * leg 0, so the ended leg is read again. Until every ended leg is held, `complete` is false and
 * the callers show no figure built from the whole game (averages, counts, finishing chances,
 * the estimate); the live leg itself (points left, its sheet) stays.
 *
 * Recovering missing legs (`sync`):
 * - `syncing`: a read is on its way (`since` the last reply; a full read after a reply that
 *   brought nothing new, so a `since` that went past a leg cannot hide it for good);
 * - `waiting`: the last read failed or brought nothing; the next one is scheduled (backoff);
 * - `stopped`: the automatic reads are used up. A tap (`retry`), coming back online, or the page
 *   becoming visible again reads at once. A new leg starting also starts afresh.
 * One read at a time per game, one timer at most; nothing is read while the page is hidden.
 */

export type LegsStatus = 'loading' | 'ready' | 'error';
export type LegsSync = 'idle' | 'syncing' | 'waiting' | 'stopped';

export interface GameLegs {
  legs: ThrowLeg[];
  status: LegsStatus;
  error: string | null;
  /**
   * Every leg the game has ended is held (and the read succeeded). Figures computed from the
   * whole game are only complete figures when this is true.
   */
  complete: boolean;
  /** Indexes (0-based) of legs that have ended but are not held yet (ended state). */
  missing: number[];
  sync: LegsSync;
  /** A leg ended but its final throws are not held yet (`status` ready, `complete` false). */
  stale: boolean;
  /** Reads again now: the whole game after a failed first read, the missing legs otherwise. */
  retry: () => void;
}

/** Waits before the automatic re-reads of a failed first read (then only by hand / on return). */
export const LEGS_RETRY_MS = [5_000, 15_000, 30_000] as const;
/** Waits before the automatic re-reads of missing legs (then `stopped`, until asked again). */
export const SYNC_RETRY_MS = [5_000, 10_000, 20_000, 40_000, 60_000] as const;

/**
 * The ended legs not held: every leg before `current` must be held and ended. `current` is the
 * leg in play (0-based); `null` when nothing says where the game is (nothing is claimed missing).
 */
export function missingLegs(legs: readonly ThrowLeg[], current: number | null): number[] {
  if (current === null || current <= 0) return [];
  const ended = new Set(legs.filter((leg) => leg.ended).map((leg) => leg.index));
  const missing: number[] = [];
  for (let index = 0; index < current; index += 1) if (!ended.has(index)) missing.push(index);
  return missing;
}

interface Held {
  mid: string;
  legs: ThrowLeg[];
  status: LegsStatus;
  error: string | null;
  /** The furthest `current_leg` a reply of this game named. */
  replyLeg: number | null;
}

const furthest = (a: number | null, b: number | null): number | null => (a === null ? b : b === null ? a : Math.max(a, b));
const hidden = (): boolean => typeof document !== 'undefined' && document.visibilityState === 'hidden';

export function useGameLegs(api: MatchesApi, mid: string, options: { finished: boolean; liveLegIndex: number | null }): GameLegs {
  const { finished, liveLegIndex } = options;
  const [held, setHeld] = useState<Held>({ mid, legs: [], status: 'loading', error: null, replyLeg: null });
  const [attempt, setAttempt] = useState(0);
  const [syncAttempt, setSyncAttempt] = useState(0);
  const [syncState, setSyncState] = useState<{ mid: string; sync: LegsSync }>({ mid, sync: 'idle' });
  const since = useRef<{ mid: string; value: number | null }>({ mid, value: null });
  const heldRef = useRef(held);
  heldRef.current = held;
  const liveLeg = useRef(liveLegIndex);
  liveLeg.current = liveLegIndex;
  const firstFailures = useRef(0);
  // Missing-leg reads: failures for the current target leg, and whether the next read is whole.
  const sync = useRef<{ mid: string; target: number | null; failures: number; whole: boolean }>({ mid, target: null, failures: 0, whole: false });
  // A scheduled read that fell due while the page was hidden: read once it is visible again.
  const dueWhileHidden = useRef(false);
  // A retry of a finished game reads n01 again instead of the remembered reply.
  const fresh = useRef(false);

  // The whole game, once per mid (and again on a retry).
  useEffect(() => {
    let alive = true;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | null = null;
    since.current = { mid, value: null };
    setHeld((current) => (current.mid === mid && current.status === 'ready' ? current : { mid, legs: [], status: 'loading', error: null, replyLeg: null }));
    const remembered = finished && !fresh.current;
    fresh.current = false;
    api
      .throws(mid, null, { finished: remembered, signal: controller.signal })
      .then((reply) => {
        if (!alive) return;
        if (reply.mid && reply.mid !== mid) throw new Error('別のゲームの記録が返されました。');
        since.current = { mid, value: reply.updateTime };
        firstFailures.current = 0;
        setHeld({ mid, legs: reply.legs, status: 'ready', error: null, replyLeg: reply.currentLeg });
      })
      .catch((reason) => {
        if (!alive) return;
        setHeld({ mid, legs: [], status: 'error', error: describeN01Error(reason), replyLeg: null });
        const wait = LEGS_RETRY_MS[firstFailures.current];
        firstFailures.current += 1;
        if (wait !== undefined) {
          timer = setTimeout(() => {
            if (hidden()) dueWhileHidden.current = true;
            else setAttempt((n) => n + 1);
          }, wait);
        }
      });
    return () => {
      alive = false;
      controller.abort();
      if (timer) clearTimeout(timer);
    };
    // `attempt` re-runs the read; `finished` switches to the memoised read once the game ends.
  }, [api, mid, finished, attempt]);

  const ready = held.mid === mid && held.status === 'ready';
  // Where the game is: the live leg, or as far as a reply of this game said it was.
  const current = ready ? furthest(finished ? null : liveLegIndex, held.replyLeg) : null;
  const missing = ready ? missingLegs(held.legs, current) : [];
  // Read the missing legs while the game is live; a finished game was read whole after it ended.
  const target = ready && !finished && missing.length > 0 ? current : null;

  useEffect(() => {
    if (target === null) {
      sync.current = { mid, target: null, failures: 0, whole: false };
      setSyncState((state) => (state.mid === mid && state.sync === 'idle' ? state : { mid, sync: 'idle' }));
      return;
    }
    // A new leg to catch up to (or another game) starts with a fresh set of automatic reads.
    if (sync.current.mid !== mid || sync.current.target !== target) sync.current = { mid, target, failures: 0, whole: false };
    let alive = true;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | null = null;
    const whole = sync.current.whole || since.current.mid !== mid || since.current.value === null;
    const before = missingLegs(heldRef.current.legs, target).length;
    setSyncState({ mid, sync: 'syncing' });

    const schedule = (wait: number): void => {
      timer = setTimeout(() => {
        if (hidden()) dueWhileHidden.current = true;
        else setSyncAttempt((n) => n + 1);
      }, wait);
    };
    // A failed read, or one that brought nothing new: wait (backoff), or stop when used up.
    const fail = (): void => {
      sync.current.failures += 1;
      sync.current.whole = true; // the next read is the whole game: a `since` cannot skip a leg twice
      if (sync.current.failures > SYNC_RETRY_MS.length) {
        setSyncState({ mid, sync: 'stopped' });
        return;
      }
      setSyncState({ mid, sync: 'waiting' });
      schedule(SYNC_RETRY_MS[sync.current.failures - 1]);
    };

    api
      .throws(mid, whole ? null : since.current.value, { signal: controller.signal })
      .then((reply) => {
        if (!alive) return;
        if (reply.mid && reply.mid !== mid) throw new Error('別のゲームの記録が返されました。');
        const base = heldRef.current;
        if (base.mid !== mid) return;
        const legs = !reply.changed ? base.legs : whole ? reply.legs : mergeLegs(base.legs, reply.legs);
        const replyLeg = furthest(base.replyLeg, reply.currentLeg);
        if (reply.updateTime) since.current = { mid, value: reply.updateTime };
        const next: Held = { ...base, legs, replyLeg };
        heldRef.current = next;
        setHeld(next);
        const left = missingLegs(legs, furthest(liveLeg.current, replyLeg)).length;
        if (left === 0) return; // complete: the effect re-runs with no target and goes idle
        if (left < before) {
          // Some legs came, not all (more ended meanwhile): the rest at once, whole.
          sync.current.whole = true;
          schedule(0);
        } else fail();
      })
      .catch(() => {
        if (alive) fail();
      });
    return () => {
      alive = false;
      controller.abort();
      if (timer) clearTimeout(timer);
    };
  }, [api, mid, target, syncAttempt]);

  const statusNow = held.mid === mid ? held.status : 'loading';
  // Between the render that finds legs missing and the read starting, it is already "reading".
  const syncNow = target !== null && (syncState.mid !== mid || syncState.sync === 'idle') ? 'syncing' : syncState.mid === mid ? syncState.sync : 'idle';

  // Reads now: the missing legs of a live game; otherwise the whole game again (a finished one
  // from n01, not the remembered reply). A tap starts the automatic reads afresh; coming back
  // online or to the page does not, so a flaky line still backs off and still stops.
  const resume = useCallback(
    (byHand: boolean) => {
      dueWhileHidden.current = false;
      if (!finished && heldRef.current.mid === mid && heldRef.current.status === 'ready') {
        sync.current = { ...sync.current, failures: byHand ? 0 : sync.current.failures, whole: true };
        setSyncAttempt((n) => n + 1);
      } else {
        if (byHand) firstFailures.current = 0;
        fresh.current = true;
        setAttempt((n) => n + 1);
      }
    },
    [mid, finished],
  );
  const retry = useCallback(() => resume(true), [resume]);

  // Back online: read what is waiting, stopped or failed now. Shown again: read what fell due
  // while hidden, or what had stopped — a read already scheduled keeps its backoff.
  const resumable = statusNow === 'error' || syncNow === 'waiting' || syncNow === 'stopped';
  const stoppedNow = syncNow === 'stopped' || (statusNow === 'error' && firstFailures.current > LEGS_RETRY_MS.length);
  useEffect(() => {
    if (!resumable || typeof window === 'undefined') return;
    const onOnline = (): void => {
      if (!hidden()) resume(false);
    };
    const onVisibility = (): void => {
      if (!hidden() && (dueWhileHidden.current || stoppedNow)) resume(false);
    };
    window.addEventListener('online', onOnline);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('online', onOnline);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [resumable, stoppedNow, resume]);

  if (held.mid !== mid) return { legs: [], status: 'loading', error: null, complete: false, missing: [], sync: 'idle', stale: false, retry };
  const complete = held.status === 'ready' && missing.length === 0;
  return { legs: held.legs, status: held.status, error: held.error, complete, missing, sync: syncNow, stale: held.status === 'ready' && !complete, retry };
}
