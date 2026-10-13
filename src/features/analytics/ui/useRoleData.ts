import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { seasonsNeedingGames } from '../projection';
import type { PlayerContributions } from '../reconstruct';
import type { GameScope } from '../roleGames';
import { reconstructPerson } from '../service/detailService';
import type { PlayerDetailResult } from '../service/detailService';
import { GAMES_MAX_REQUESTS, loadGames } from '../service/gamesLoader';
import type { GamesLoad } from '../service/gamesLoader';
import type { PeriodLoad } from '../service/periodService';
import type { AnalyticsServices } from './usePeriodLoad';
import { AnalyticsApi } from '../api/readApi';
import { DETAIL_MAX_REQUESTS } from '../service/detailService';

/**
 * Game rows and leg reconstructions for the open period, fetched only when a view needs them
 * (a game-kind view, or "01全体" of a season with non-01 slots), cancelled when the period or
 * the view changes, and never thrown into the app.
 */

export interface GamesState {
  status: 'idle' | 'loading' | 'done';
  load: GamesLoad | null;
  /** Seasons the current view needs game rows for. */
  needed: string[];
}

const EMPTY_GAMES: GamesLoad = { games: new Map(), failed: new Set(), failures: [], usedStaleCache: false, requestsSent: 0 };

export function useGamesLoad(services: AnalyticsServices, load: PeriodLoad | null, scope: GameScope, reloadToken: number): GamesState {
  const needed = useMemo(() => (load ? seasonsNeedingGames(load.seasons, scope) : []), [load, scope]);
  const neededKey = needed.join(',');
  const [state, setState] = useState<GamesState>({ status: 'idle', load: null, needed: [] });
  // What has already been loaded for this period, so switching views does not refetch.
  const accumulated = useRef<{ period: PeriodLoad | null; load: GamesLoad }>({ period: null, load: EMPTY_GAMES });

  useEffect(() => {
    if (!load) return;
    if (accumulated.current.period !== load) accumulated.current = { period: load, load: { ...EMPTY_GAMES, games: new Map(), failed: new Set(), failures: [] } };
    const have = accumulated.current.load;
    const missing = load.seasons.filter((s) => needed.includes(s.tournamentId) && !have.games.has(s.tournamentId));
    if (missing.length === 0) {
      setState({ status: needed.length > 0 ? 'done' : 'idle', load: have, needed });
      return;
    }
    const controller = new AbortController();
    let cancelled = false;
    setState({ status: 'loading', load: have, needed });
    void (async () => {
      try {
        const api: AnalyticsApi = services.createRoleApi ? services.createRoleApi(controller.signal, GAMES_MAX_REQUESTS) : new AnalyticsApi({ signal: controller.signal, maxRequests: GAMES_MAX_REQUESTS });
        const result = await loadGames(
          { api, cache: services.cache, isOnline: () => navigator.onLine !== false, now: () => Date.now(), forceRefresh: reloadToken > 0, signal: controller.signal },
          missing.map((s) => ({ tournamentId: s.tournamentId, status: s.status })),
        );
        if (cancelled) return;
        const merged: GamesLoad = {
          games: new Map([...have.games, ...result.games]),
          failed: new Set([...[...have.failed].filter((id) => !result.games.has(id)), ...result.failed]),
          failures: [...have.failures.filter((f) => !result.games.has(f.tournamentId)), ...result.failures],
          usedStaleCache: have.usedStaleCache || result.usedStaleCache,
          requestsSent: have.requestsSent + result.requestsSent,
        };
        accumulated.current = { period: load, load: merged };
        setState({ status: 'done', load: merged, needed });
      } catch {
        if (!cancelled) setState({ status: 'done', load: have, needed });
      }
    })();
    return () => {
      cancelled = true;
      controller.abort();
    };
    // `needed` is represented by `neededKey`.
  }, [services, load, neededKey, reloadToken]);

  return state;
}

export interface DetailState {
  running: string | null;
  results: Map<string, PlayerDetailResult>;
  contributions: PlayerContributions;
}

/** Leg reconstruction per selected player; verified figures accumulate for the open period. */
export function usePlayerDetail(services: AnalyticsServices, load: PeriodLoad | null, games: GamesLoad | null): DetailState & { run: (personKey: string) => void } {
  const [state, setState] = useState<DetailState>({ running: null, results: new Map(), contributions: new Map() });
  const controller = useRef<AbortController | null>(null);

  useEffect(() => {
    controller.current?.abort();
    setState({ running: null, results: new Map(), contributions: new Map() });
  }, [load]);
  useEffect(() => () => controller.current?.abort(), []);

  const run = useCallback(
    (personKey: string) => {
      if (!load || !games) return;
      controller.current?.abort();
      const c = new AbortController();
      controller.current = c;
      setState((s) => ({ ...s, running: personKey }));
      void (async () => {
        try {
          const api = services.createRoleApi ? services.createRoleApi(c.signal, DETAIL_MAX_REQUESTS) : new AnalyticsApi({ signal: c.signal, maxRequests: DETAIL_MAX_REQUESTS });
          const result = await reconstructPerson(
            { api, cache: services.cache, isOnline: () => navigator.onLine !== false, now: () => Date.now(), signal: c.signal },
            { seasons: load.seasons, games: games.games, personKey },
          );
          if (c.signal.aborted) return;
          setState((s) => {
            const contributions: PlayerContributions = new Map([...s.contributions].map(([k, v]) => [k, new Map(v)]));
            for (const [gameId, players] of result.contributions) {
              const target = contributions.get(gameId) ?? new Map();
              for (const [oid, value] of players) target.set(oid, value);
              contributions.set(gameId, target);
            }
            return { running: null, results: new Map([...s.results, [personKey, result]]), contributions };
          });
        } catch {
          if (!c.signal.aborted) setState((s) => ({ ...s, running: null }));
        }
      })();
    },
    [services, load, games],
  );
  return { ...state, run };
}
