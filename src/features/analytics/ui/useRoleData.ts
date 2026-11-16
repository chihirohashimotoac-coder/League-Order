import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { seasonsNeedingGames } from '../projection';
import type { PlayerContributions } from '../reconstruct';
import type { GameScope } from '../roleGames';
import { currentContributions, currentResult, currentTeamContributions, detailCoverage, newDetailMemory, reconstructPerson, reconstructTeam } from '../service/detailService';
import type { TeamDetailResult } from '../service/detailService';
import type { TeamContributions } from '../roleGames';
import type { DetailMemory } from '../service/detailService';
import type { PlayerDetailResult } from '../service/detailService';
import { emptyGamesLoad, GamesSession } from '../service/gamesSession';
import type { GamesLoad } from '../service/gamesSession';
import type { GamesMemory } from '../service/gamesLoader';
import type { PeriodLoad } from '../service/periodService';
import { defaultSleep } from '../service/retry';
import type { Sleep } from '../service/retry';
import type { AnalyticsServices } from './usePeriodLoad';
import { AnalyticsApi } from '../api/readApi';
import { DETAIL_MAX_REQUESTS } from '../service/detailService';
import { describeN01Error } from '../../../integrations/n01/client';

/**
 * Game rows and leg reconstructions for the open period, fetched only when a view needs them
 * (a game-kind view, or "01全体" of a season with non-01 slots), shared by every view of the
 * period, cancelled when the period changes or the page closes, and never thrown into the app.
 */

export interface GamesState {
  /** `loading`: a season the view needs is still being read (the others are already shown). */
  status: 'idle' | 'loading' | 'done';
  load: GamesLoad | null;
  /** Seasons the current view needs game rows for. */
  needed: string[];
  /** Takes up again the seasons that failed, from where their reading stopped. */
  retry: () => void;
}

const isOnline = (): boolean => (typeof navigator === 'undefined' ? true : navigator.onLine !== false);

const roleApi = (services: AnalyticsServices, signal: AbortSignal, maxRequests: number): AnalyticsApi =>
  services.createRoleApi ? services.createRoleApi(signal, maxRequests) : new AnalyticsApi({ signal, maxRequests });

/** The time of the page's last 「再取得」 (0: none): data read before it is read again, once. */
function useReloadTime(reloadToken: number): number {
  return useMemo(() => (reloadToken > 0 ? Date.now() : 0), [reloadToken]);
}

export function useGamesLoad(services: AnalyticsServices, load: PeriodLoad | null, scope: GameScope, reloadToken: number): GamesState {
  const needed = useMemo(() => (load ? seasonsNeedingGames(load.seasons, scope) : []), [load, scope]);
  const neededKey = needed.join(',');
  const reloadAt = useReloadTime(reloadToken);
  const [snap, setSnap] = useState<{ period: PeriodLoad | null; load: GamesLoad; running: boolean }>({ period: null, load: emptyGamesLoad(), running: false });
  const session = useRef<{ period: PeriodLoad; session: GamesSession } | null>(null);
  // Lists read to the end while the page is open, whatever the period (the storage may refuse them).
  const listMemory = useRef<GamesMemory>(new Map());
  const neededRef = useRef(needed);
  neededRef.current = needed;

  const want = (s: GamesSession, period: PeriodLoad, ids: readonly string[]): void => {
    s.want(period.seasons.filter((x) => ids.includes(x.tournamentId)).map((x) => ({ tournamentId: x.tournamentId, status: x.status })));
  };

  // One session per period (and refresh): what it read serves every view, so switching views never
  // stops or repeats a read; only another period, a refresh or leaving the page ends it.
  useEffect(() => {
    if (!load) return;
    const s = new GamesSession(
      { createApi: (signal, max) => roleApi(services, signal, max), cache: services.cache, isOnline, now: () => Date.now(), freshAfter: reloadAt || undefined, sleep: services.sleep, memory: listMemory.current },
      (next, running) => setSnap({ period: load, load: next, running }),
    );
    session.current = { period: load, session: s };
    setSnap({ period: load, load: emptyGamesLoad(), running: false });
    want(s, load, neededRef.current);
    // Back online: the seasons that failed for want of a connection continue from their checkpoints.
    const online = (): void => s.resumeOnline();
    window.addEventListener('online', online);
    return () => {
      window.removeEventListener('online', online);
      s.dispose();
      if (session.current?.session === s) session.current = null;
    };
  }, [services, load, reloadAt]);

  useEffect(() => {
    const current = session.current;
    if (load && current && current.period === load) want(current.session, load, needed);
    // `needed` is represented by `neededKey`.
  }, [load, neededKey]);

  const retry = useCallback(() => session.current?.session.retry(), []);
  const mine = snap.period === load && load ? snap.load : null;
  const waiting = mine ? needed.some((id) => mine.pending.has(id) || (!mine.games.has(id) && !mine.failed.has(id))) : needed.length > 0;
  return { status: needed.length === 0 ? 'idle' : waiting ? 'loading' : 'done', load: mine, needed, retry };
}

export interface DetailState {
  running: string | null;
  results: Map<string, PlayerDetailResult>;
  contributions: PlayerContributions;
  /** Players whose result is an intermediate part: more of their legs are being, or will be, read. */
  partial: ReadonlySet<string>;
}

export interface DetailControls {
  /**
   * Runs (or runs again) a player's reconstruction. `fresh` reads the player's games again instead
   * of using the stored ones (default: when the player already has a result — 「再度復元する」);
   * `auto: true` marks a read a view owns (stopped when another player is shown).
   */
  run: (personKey: string, options?: { fresh?: boolean; auto?: boolean; recheck?: boolean }) => void;
  /**
   * The player on screen, and whether the view needs their leg details (`read`: the singles or the
   * doubles view, with a game of that kind). Reads them once per period and continues a read cut
   * off by its budget, part after part, without a button; a read of another player is stopped and
   * dropped. A view that does not need the details (`read: false`) lets a running part of the same
   * player finish but starts no new one. `null`: no player — the automatic read stops. Safe to
   * call on every render.
   */
  focus: (personKey: string | null, read: boolean) => void;
  /** `focus(personKey, true)`, or stops the automatic read for `null`. */
  ensure: (personKey: string | null) => void;
}

/**
 * The per-game figures shown: rebuilt from the **latest** result of each player, so a player's
 * figures are exactly what their last reconstruction accepted. Running a player again replaces
 * all of that player's figures — a season that no longer matches n01 (a corrected or deleted
 * leg) loses its old figures instead of keeping them under a description that says otherwise —
 * and nobody else's change. Each result only holds its own player's ids, so nothing collides.
 */
export function contributionsOf(results: ReadonlyMap<string, PlayerDetailResult>, games: GamesLoad | null = null): PlayerContributions {
  const contributions: PlayerContributions = new Map();
  for (const result of results.values()) {
    // Only figures checked against the game lists loaded now (a list read again with other
    // content gives none until the player is checked against it).
    for (const [gameId, players] of currentContributions(result, games?.games ?? null)) {
      const target = contributions.get(gameId) ?? new Map();
      for (const [oid, value] of players) target.set(oid, value);
      contributions.set(gameId, target);
    }
  }
  return contributions;
}

/** A reconstruction that ended in an error: no figures, and the reason (never the old figures). */
function failedResult(personKey: string, reason: string): PlayerDetailResult {
  return { personKey, checks: [], contributions: new Map(), bestLegs: new Map(), bestLegHeld: { all: false, starts: [], reasons: [] }, notAttempted: [], stale: [], failures: [reason], requestsSent: 0, starts: [] };
}

interface HeldState extends Omit<DetailState, 'partial'> {
  /** The period these results belong to: results of another period are never shown. */
  load: PeriodLoad | null;
  partial: Set<string>;
  /** Players whose read stopped between parts (another view took over): continued when wanted again. */
  paused: Set<string>;
}

const emptyFor = (load: PeriodLoad | null): HeldState => ({ load, running: null, results: new Map(), contributions: new Map(), partial: new Set(), paused: new Set() });

/** Parts (adapters of {@link DETAIL_MAX_REQUESTS} requests) one read may use; the pause between them. */
export const DETAIL_MAX_UNITS = 20;
export const DETAIL_UNIT_PAUSE_MS = 300;

/**
 * Leg reconstruction per selected player; verified figures accumulate for the open period.
 *
 * One reconstruction at a time: starting another (a different player shown) cancels the one
 * running, whose part in progress is dropped (the legs it read stay cached). Results are tagged
 * with their period, so a result that arrives after the period, league or team changed is never
 * shown. A read needing more than one budget continues in further parts by itself; each part's
 * result is shown as it arrives (seasons already checked first), marked partial until the last.
 */
export function usePlayerDetail(services: AnalyticsServices, load: PeriodLoad | null, games: GamesLoad | null, reloadToken = 0): DetailState & DetailControls {
  const [held, setHeld] = useState<HeldState>(() => emptyFor(load));
  const controller = useRef<{ abort: AbortController; load: PeriodLoad | null; personKey: string; auto: boolean } | null>(null);
  const reloadAt = useReloadTime(reloadToken);
  const [focusState, setFocusState] = useState<{ personKey: string; read: boolean } | null>(null);
  const focusRef = useRef(focusState);
  const gamesRef = useRef(games);
  gamesRef.current = games;
  const state: HeldState = held.load === load ? held : emptyFor(load);
  const sleep: Sleep = services.sleep ?? defaultSleep;
  // What the open screen's reads got (every player, part and period: a leg is the same game in any
  // period). Freshness still applies to each entry (its read time, the TTL, the page's refresh).
  const memory = useRef<{ memory: DetailMemory }>({ memory: newDetailMemory() });
  const contributions = useMemo(() => contributionsOf(state.results, games), [state.results, games]);
  // What may be shown: per season, only what was checked against the game list loaded now.
  const shownResults = useMemo(() => new Map([...state.results].map(([key, result]) => [key, currentResult(result, games?.games ?? null)])), [state.results, games]);

  useEffect(() => {
    // A run started for this very period (by a view that rendered first) is kept.
    if (controller.current && controller.current.load !== load) {
      controller.current.abort.abort();
      controller.current = null;
    }
    setHeld((s) => (s.load === load ? s : emptyFor(load)));
  }, [load]);
  useEffect(() => () => controller.current?.abort.abort(), []);

  const run = useCallback(
    (personKey: string, options: { fresh?: boolean; auto?: boolean; recheck?: boolean } = {}) => {
      if (!load || !gamesRef.current) return;
      controller.current?.abort.abort();
      const c = new AbortController();
      controller.current = { abort: c, load, personKey, auto: options.auto === true };
      // Read again what is stored when asked to (「再度復元する」), or what was read before the page's refresh.
      const freshAfter = (options.fresh ?? (state.results.has(personKey) && options.auto !== true)) ? Date.now() : reloadAt;
      setHeld((s) => {
        const base = s.load === load ? s : emptyFor(load);
        const paused = new Set(base.paused);
        paused.delete(personKey);
        return { ...base, running: personKey, paused };
      });
      const settle = (result: PlayerDetailResult, more: boolean, paused: boolean): void => {
        setHeld((s) => {
          if (s.load !== load) return s;
          const results = new Map([...s.results, [personKey, result]]);
          const partial = new Set(s.partial);
          if (more) partial.add(personKey);
          else partial.delete(personKey);
          const pausedSet = new Set(s.paused);
          if (paused) pausedSet.add(personKey);
          else pausedSet.delete(personKey);
          return { load, running: more && !paused ? personKey : null, results, contributions: s.contributions, partial, paused: pausedSet };
        });
      };
      const kept = memory.current.memory;
      // The list versions this player was last checked against: a season read again since is checked
      // with n01's totals and legs read after the change.
      const previousVersions = state.results.get(personKey)?.versions;
      // An automatic read goes on only while a view needs this player's legs.
      const wantedNow = (): boolean => !controller.current?.auto || (focusRef.current?.personKey === personKey && focusRef.current.read);
      void (async () => {
        let total = 0;
        try {
          for (let unit = 0; unit < DETAIL_MAX_UNITS; unit += 1) {
            const api = roleApi(services, c.signal, DETAIL_MAX_REQUESTS);
            const result = await reconstructPerson(
              { api, cache: services.cache, isOnline, now: () => Date.now(), freshAfter: freshAfter || undefined, signal: c.signal, sleep: services.sleep },
              { seasons: load.seasons, games: gamesRef.current?.games ?? new Map(), personKey, memory: kept, previousVersions, recheckOfficial: options.recheck === true && unit === 0 },
            );
            if (c.signal.aborted) return;
            total += result.requestsSent;
            result.requestsSent = total;
            // Cut off by its budget after reading something: the next part continues from the cache.
            const more = result.budgetStopped === true && (result.fetched ?? 0) > 0 && unit + 1 < DETAIL_MAX_UNITS;
            const wanted = wantedNow();
            settle(result, more, more && !wanted);
            if (!more || !wanted) break;
            await sleep(DETAIL_UNIT_PAUSE_MS, c.signal);
            if (c.signal.aborted) return;
            // Checked again right before the next part's first request: the view may have changed
            // during the pause (01全体, チーム). Paused then, and continued when the legs are needed again.
            if (!wantedNow()) {
              setHeld((s) => (s.load === load ? { ...s, running: s.running === personKey ? null : s.running, paused: new Set([...s.paused, personKey]) } : s));
              break;
            }
          }
        } catch (reason) {
          if (c.signal.aborted) return;
          settle(failedResult(personKey, `復元できませんでした（${describeN01Error(reason)}）。この選手の個人成績は表示していません。`), false, false);
        } finally {
          if (controller.current?.abort === c) controller.current = null;
        }
      })();
    },
    [services, load, reloadAt, state.results, sleep],
  );

  const focus = useCallback((personKey: string | null, read: boolean) => {
    const next = personKey === null ? null : { personKey, read };
    focusRef.current = next;
    setFocusState((prev) => (prev?.personKey === next?.personKey && prev?.read === next?.read ? prev : next));
    const inFlight = controller.current;
    if (inFlight && inFlight.auto && inFlight.personKey !== personKey && !inFlight.abort.signal.aborted) {
      // Another player (or none) is shown: stop reading, and drop what that part would have shown.
      inFlight.abort.abort();
      controller.current = null;
      // A read cut off after some of its parts were shown is continued (from the cache) when that
      // player is shown again; a read with no part shown yet simply starts again.
      setHeld((s) => {
        const paused = s.partial.has(inFlight.personKey) ? new Set([...s.paused, inFlight.personKey]) : s.paused;
        return s.running === inFlight.personKey || paused !== s.paused ? { ...s, running: s.running === inFlight.personKey ? null : s.running, paused } : s;
      });
    }
  }, []);

  const ensure = useCallback((personKey: string | null) => focus(personKey, personKey !== null), [focus]);

  // The automatic read: the shown player, when the view needs their legs and their result does not
  // cover the game lists loaded so far (none yet, more seasons arrived, or a part is paused).
  const coverage = focusState && load && games ? detailCoverage(load.seasons, games.games, focusState.personKey) : '';
  useEffect(() => {
    if (!focusState?.read || !load || !games || coverage === '') return;
    const current = controller.current;
    if (current && !current.abort.signal.aborted) return;
    const result = state.results.get(focusState.personKey);
    if (!result || state.paused.has(focusState.personKey) || (result.coverage !== undefined && result.coverage !== coverage && state.running === null)) {
      run(focusState.personKey, { auto: true });
    }
  }, [focusState, load, games, coverage, state.results, state.paused, state.running, run]);

  // Back online: a read that failed for want of a connection continues (from the cache).
  useEffect(() => {
    const online = (): void => {
      const f = focusRef.current;
      if (!f?.read) return;
      if (state.results.get(f.personKey)?.transient && !controller.current) run(f.personKey, { auto: true, fresh: false });
    };
    window.addEventListener('online', online);
    return () => window.removeEventListener('online', online);
  }, [state.results, run]);

  return { running: state.running, results: shownResults, contributions, partial: state.partial, run, focus, ensure };
}

/**
 * Where the team read stands: `waiting-games` — the game lists it needs are still being read;
 * `games-failed` — none of them could be read; `running`; `no-games` — the team has no game of the
 * kind; `failed` — legs were wanted but none could be read; `partial` — some games without legs;
 * `done`.
 */
export type TeamDetailPhase = 'idle' | 'waiting-games' | 'games-failed' | 'running' | 'no-games' | 'failed' | 'partial' | 'done';

export interface TeamDetailState {
  /** The team read for the current view (`null`: none needed — not the team view, or 01全体 / その他). */
  key: string | null;
  phase: TeamDetailPhase;
  running: boolean;
  /** More parts follow (the read crossed its budget). */
  partial: boolean;
  result: TeamDetailResult | null;
  /** Side figures fed to the projection: only those read against the game lists loaded now. */
  contributions: TeamContributions;
  retry: () => void;
}

/**
 * The shown team's side figures (First 9, Keep/Break) for the singles / doubles view: the legs of
 * that team's games of that kind only, read automatically part after part (each part
 * {@link DETAIL_MAX_REQUESTS} requests, sharing the per-game cache with the player reads). Another
 * team, kind, period or leaving the view stops the read; its result is never shown for another one.
 */
export function useTeamDetail(services: AnalyticsServices, load: PeriodLoad | null, games: GamesLoad | null, role: 'singles' | 'doubles' | null, teams: ReadonlyMap<string, string> | null, reloadToken = 0): TeamDetailState {
  const reloadAt = useReloadTime(reloadToken);
  const key = role && teams && teams.size > 0 ? `${role}|${[...teams].map(([t, team]) => `${t}:${team}`).join(',')}` : null;
  const [held, setHeld] = useState<{ load: PeriodLoad | null; key: string | null; running: boolean; partial: boolean; result: TeamDetailResult | null; coverage: string }>({ load: null, key: null, running: false, partial: false, result: null, coverage: '' });
  const [attempt, setAttempt] = useState(0);
  const memory = useRef<DetailMemory>(newDetailMemory());
  const gamesRef = useRef(games);
  gamesRef.current = games;
  // The seasons of the team whose list is complete now: a result made with fewer is read again.
  const coverage = key && load && games ? load.seasons.filter((s) => teams?.has(s.tournamentId) && games.games.get(s.tournamentId)?.complete).map((s) => s.tournamentId).join(',') : '';
  useEffect(() => {
    if (!key || !load || !teams || coverage === '' || !role) return;
    const c = new AbortController();
    setHeld((s) => (s.load === load && s.key === key ? { ...s, running: true } : { load, key, running: true, partial: false, result: null, coverage }));
    void (async () => {
      let total = 0;
      // Fixed once for the whole read: a later part must not count what an earlier part read as old.
      const freshAfter = (attempt > 0 ? Date.now() : reloadAt) || undefined;
      try {
        for (let unit = 0; unit < DETAIL_MAX_UNITS; unit += 1) {
          const api = roleApi(services, c.signal, DETAIL_MAX_REQUESTS);
          const result = await reconstructTeam(
            { api, cache: services.cache, isOnline, now: () => Date.now(), freshAfter, signal: c.signal, sleep: services.sleep },
            { seasons: load.seasons, games: gamesRef.current?.games ?? new Map(), teams, role, key, memory: memory.current },
          );
          if (c.signal.aborted) return;
          total += result.requestsSent;
          result.requestsSent = total;
          const more = result.budgetStopped === true && (result.fetched ?? 0) > 0 && unit + 1 < DETAIL_MAX_UNITS;
          setHeld({ load, key, running: more, partial: more, result, coverage });
          if (!more) break;
          await (services.sleep ?? defaultSleep)(DETAIL_UNIT_PAUSE_MS, c.signal);
          if (c.signal.aborted) return;
        }
      } catch (reason) {
        if (c.signal.aborted) return;
        setHeld({ load, key, running: false, partial: false, coverage, result: { key, contributions: new Map(), seasons: [], failures: [`Leg明細を取得できませんでした（${describeN01Error(reason)}）`], requestsSent: 0, versions: {} } });
      }
    })();
    return () => c.abort();
    // `teams` is represented by `key`.
  }, [services, load, key, coverage, reloadAt, attempt]);
  const mine = held.load === load && held.key === key ? held : null;
  const contributions = useMemo(() => (mine?.result && load ? currentTeamContributions(mine.result, games?.games ?? null, load.seasons) : new Map()), [mine?.result, games, load]);
  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  const phase = teamPhase(key, load, games, teams, coverage, mine);
  return { key, phase, running: phase === 'running', partial: mine?.partial ?? false, result: mine?.result ?? null, contributions, retry };
}

function teamPhase(
  key: string | null,
  load: PeriodLoad | null,
  games: GamesLoad | null,
  teams: ReadonlyMap<string, string> | null,
  coverage: string,
  mine: { running: boolean; result: TeamDetailResult | null } | null,
): TeamDetailPhase {
  if (!key || !load || !teams) return 'idle';
  if (coverage === '') {
    // No list of the team's seasons is complete yet: still being read, or none could be read.
    const ids = load.seasons.filter((s) => teams.has(s.tournamentId)).map((s) => s.tournamentId);
    const waiting = !games || ids.some((id) => games.pending.has(id) || (!games.games.has(id) && !games.failed.has(id)));
    return waiting ? 'waiting-games' : 'games-failed';
  }
  if (!mine || mine.running || !mine.result) return 'running';
  const seasons = mine.result.seasons.filter((x) => x.games > 0);
  const total = seasons.reduce((n, x) => n + x.games, 0);
  const rebuilt = seasons.reduce((n, x) => n + x.rebuilt, 0);
  if (total === 0) return mine.result.failures.length > 0 ? 'failed' : 'no-games';
  if (rebuilt === 0) return 'failed';
  return rebuilt < total ? 'partial' : 'done';
}
