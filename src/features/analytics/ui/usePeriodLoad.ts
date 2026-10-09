import { useEffect, useMemo, useState } from 'react';
import { newestFirst } from '../../../integrations/n01/seasonResolver';
import { AnalyticsApi } from '../api/readApi';
import { AnalyticsCache } from '../cache/analyticsCache';
import { loadPeriod } from '../service/periodService';
import type { PeriodLoad } from '../service/periodService';
import { loadLeagueList } from '../service/seasonLoader';
import { classifySeason } from '../seasons';
import type { PeriodRequest } from '../seasons';

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
  cache: AnalyticsCache;
}

let sharedCache: AnalyticsCache | null = null;

export function defaultServices(): AnalyticsServices {
  sharedCache ??= new AnalyticsCache();
  return { createApi: (signal) => new AnalyticsApi({ signal }), cache: sharedCache };
}

export interface PeriodState {
  status: 'loading' | 'done';
  load: PeriodLoad | null;
  seasonOptions: SeasonOption[];
}

const IDLE: PeriodState = { status: 'loading', load: null, seasonOptions: [] };

/** `request` and `reloadToken` identify one load; a changed token forces a refetch. */
export function usePeriodLoad(
  services: AnalyticsServices,
  leagueId: string | null,
  request: PeriodRequest | null,
  reloadToken: number,
): PeriodState {
  const [state, setState] = useState<PeriodState>(IDLE);
  const requestKey = request ? `${request.mode}|${request.currentTournamentId}|${request.specifiedTournamentId ?? ''}` : '';

  useEffect(() => {
    if (!leagueId || !request) return;
    const controller = new AbortController();
    let cancelled = false;
    setState((previous) => ({ ...previous, status: 'loading' }));
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
        const load = await loadPeriod({ api, cache: services.cache, leagueId, request, forceRefresh });
        next = { status: 'done', load, seasonOptions };
      } catch (error) {
        // loadPeriod does not throw; this is the last line of defence for the order screens.
        const reason = error instanceof Error ? error.message : '分析データを取得できませんでした。';
        next = { status: 'done', seasonOptions: [], load: failedLoad(request, reason) };
      }
      if (!cancelled) setState(next);
    })();
    return () => {
      cancelled = true;
      controller.abort();
    };
    // `request` is represented by `requestKey`.
  }, [services, leagueId, requestKey, reloadToken]);

  return useMemo(() => state, [state]);
}

function failedLoad(request: PeriodRequest, reason: string): PeriodLoad {
  return {
    request,
    seasons: [],
    meta: [],
    failures: [],
    skipped: [],
    formatExcluded: [],
    complete: false,
    listError: { reason, kind: 'network' },
    offline: false,
    usedStaleCache: false,
    fetchedAt: null,
    requestsSent: 0,
  };
}
