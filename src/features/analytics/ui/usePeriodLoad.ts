import { useEffect, useMemo, useState } from 'react';
import { newestFirst } from '../../../integrations/n01/seasonResolver';
import { AnalyticsApi } from '../api/readApi';
import { AnalyticsCache } from '../cache/analyticsCache';
import { emptyLoad, loadPeriod } from '../service/periodService';
import type { PeriodLoad } from '../service/periodService';
import { loadLeagueList } from '../service/seasonLoader';
import { classifySeason } from '../seasons';
import type { PeriodRequest } from '../seasons';
import type { Sleep } from '../service/retry';

/**
 * Loads a period for a screen. Lazy (nothing is requested until a screen mounts), cancelled
 * on unmount or when the request changes, and incapable of throwing into the app: every
 * failure ends up inside {@link PeriodLoad}.
 */

export interface SeasonOption {
  id: string;
  title: string;
  status: number | null;
}

export interface AnalyticsServices {
  createApi: (signal: AbortSignal) => AnalyticsApi;
  /** Adapter for the lazy game-row / leg-detail loads, each with its own request budget. */
  createRoleApi?: (signal: AbortSignal, maxRequests: number) => AnalyticsApi;
  cache: AnalyticsCache;
  /** Waits between retries and between parts of a long read (tests make it instant). */
  sleep?: Sleep;
}

let sharedCache: AnalyticsCache | null = null;

export function defaultServices(): AnalyticsServices {
  sharedCache ??= new AnalyticsCache();
  return {
    createApi: (signal) => new AnalyticsApi({ signal }),
    createRoleApi: (signal, maxRequests) => new AnalyticsApi({ signal, maxRequests }),
    cache: sharedCache,
  };
}

export interface PeriodState {
  status: 'loading' | 'done';
  load: PeriodLoad | null;
  seasonOptions: SeasonOption[];
  /**
   * The request (`mode|current|specified`) {@link load} belongs to. While another condition is being
   * read, `load` is the previous condition's: the screen must not show it as the new one.
   */
  loadKey: string;
  /** The request being read or shown now. */
  requestKey: string;
  /** When {@link load} was read (ms), for "前回の値（hh:mm 取得）". */
  loadedAt: number | null;
  /** Seasons read so far while loading (`null`: the season list is still being read). */
  progress: { done: number; total: number } | null;
}

const IDLE: PeriodState = { status: 'loading', load: null, seasonOptions: [], loadKey: '', requestKey: '', loadedAt: null, progress: null };

/** `request` and `reloadToken` identify one load; a changed token forces a refetch. */
export function usePeriodLoad(
  services: AnalyticsServices,
  leagueId: string | null,
  request: PeriodRequest | null,
  reloadToken: number,
): PeriodState {
  const [state, setState] = useState<PeriodState>(IDLE);
  const requestKey = request ? `${leagueId ?? ''}|${request.mode}|${request.currentTournamentId}|${request.specifiedTournamentId ?? ''}` : '';

  useEffect(() => {
    if (!leagueId || !request) return;
    const controller = new AbortController();
    let cancelled = false;
    setState((previous) => ({ ...previous, status: 'loading', requestKey, progress: null }));
    void (async () => {
      let next: PeriodState;
      try {
        const api = services.createApi(controller.signal);
        const forceRefresh = reloadToken > 0;
        const ctx = { api, cache: services.cache, isOnline: () => navigator.onLine !== false, now: () => Date.now(), forceRefresh };
        const listing = await loadLeagueList(ctx, leagueId);
        const seasonOptions: SeasonOption[] = listing.list
          ? newestFirst(listing.list.tournaments)
              .filter((summary) => classifySeason(summary).kind !== 'excluded')
              .map((summary) => ({ id: summary.tournamentId, title: summary.title, status: summary.status }))
          : [];
        const load = await loadPeriod({
          api,
          cache: services.cache,
          leagueId,
          request,
          forceRefresh,
          signal: controller.signal,
          onProgress: (progress) => {
            if (!cancelled) setState((previous) => (previous.requestKey === requestKey && previous.status === 'loading' ? { ...previous, progress } : previous));
          },
        });
        next = { status: 'done', load, seasonOptions, loadKey: requestKey, requestKey, loadedAt: Date.now(), progress: null };
      } catch (error) {
        // loadPeriod does not throw; this is the last line of defence for the order screens.
        const reason = error instanceof Error ? error.message : '分析データを取得できませんでした。';
        next = { status: 'done', seasonOptions: [], load: failedLoad(request, reason), loadKey: requestKey, requestKey, loadedAt: Date.now(), progress: null };
      }
      if (!cancelled) setState(next);
    })();
    return () => {
      cancelled = true;
      controller.abort();
    };
    // `request` is represented by `requestKey`.
  }, [services, leagueId, requestKey, reloadToken]);

  // The request of this render, not of the last effect: right after the period or season changes, the
  // load still held belongs to the previous request and must not be shown as this one (⑧/⑩).
  return useMemo(() => ({ ...state, requestKey }), [state, requestKey]);
}

function failedLoad(request: PeriodRequest, reason: string): PeriodLoad {
  return emptyLoad(request, { listError: { reason, kind: 'network' } });
}
