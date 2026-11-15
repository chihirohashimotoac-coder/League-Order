import type { AnalyticsApi } from '../api/readApi';
import type { AnalyticsCache } from '../cache/analyticsCache';
import type { SeasonGames } from '../roleGames';
import type { GamesSource } from '../projection';
import { GAMES_UNIT_REQUESTS, loadSeasonGames } from './gamesLoader';
import type { GamesFailureKind, GamesMemory, GamesProgress, GamesResult } from './gamesLoader';
import { defaultSleep } from './retry';
import type { Sleep } from './retry';

/**
 * The game lists of one open period, read season by season and published as each season is done.
 *
 * Work is split into **units**: one adapter with its own request budget
 * ({@link GAMES_UNIT_REQUESTS}). A reading whose unit runs out takes the next unit and goes on in
 * memory from the row it reached (`loadSeasonGames`), so a period needing hundreds of requests is
 * read to the end without the user doing anything — while no unit sends more than its budget, at
 * most `concurrency` seasons are read at once (each one page at a time), units follow each other
 * after a short pause, and a session uses at most {@link GAMES_MAX_UNITS} of them (a retry starts
 * a new allowance). Newest seasons first.
 *
 * Failures are reported per season; `retry()` takes them up again (the rows an earlier reading
 * got are read again and compared). Back online, `resumeOnline()` also reads again the seasons
 * shown from an expired saved list.
 */

export interface SessionSeason {
  tournamentId: string;
  status: number | null;
}

export interface GamesFailure {
  tournamentId: string;
  reason: string;
  kind: GamesFailureKind | 'held';
}

export interface GamesLoad extends GamesSource {
  failures: GamesFailure[];
  usedStaleCache: boolean;
  requestsSent: number;
  /** Seasons asked for that are not settled yet (queued, being read, or waiting for the next unit). */
  pending: ReadonlySet<string>;
  /** Rows read so far of the seasons still being read. */
  progress: ReadonlyMap<string, GamesProgress>;
  /** Units (adapters with their own budget) used so far. */
  units: number;
  /** Seasons shown from an expired saved list (not current; read again when back online). */
  stale?: ReadonlySet<string>;
  /** The browser's storage refused a write: what was read stays for this screen only. */
  saveFailed?: boolean;
}

export interface GamesSessionOptions {
  createApi: (signal: AbortSignal, maxRequests: number) => AnalyticsApi;
  cache: AnalyticsCache;
  isOnline: () => boolean;
  now: () => number;
  freshAfter?: number;
  sleep?: Sleep;
  concurrency?: number;
  unitRequests?: number;
  /** Safety limit on units of one session. */
  maxUnits?: number;
  /** Pause between units (ms), so a long load does not hammer n01. */
  pauseMs?: number;
  /** Lists read to the end during the open screen (shared by its sessions). */
  memory?: GamesMemory;
}

export const GAMES_MAX_UNITS = 60;
export const GAMES_UNIT_PAUSE_MS = 300;

export function emptyGamesLoad(): GamesLoad {
  return { games: new Map(), failed: new Set(), failures: [], usedStaleCache: false, requestsSent: 0, pending: new Set(), progress: new Map(), units: 0 };
}

export const GAMES_LIMIT_REASON = '通信の上限に達したため未取得（「再試行」で取得済みの範囲を照合してから続きを取得します）';
/** Times the browser coming back online takes a season up again by itself (then only the retry button). */
export const MAX_AUTO_RESUMES = 3;

export class GamesSession {
  private readonly controller = new AbortController();
  private readonly order = new Map<string, number>();
  private readonly status = new Map<string, number | null>();
  private queue: string[] = [];
  private readonly games = new Map<string, SeasonGames>();
  private readonly failures = new Map<string, GamesFailure>();
  private readonly progress = new Map<string, GamesProgress>();
  private readonly autoResumes = new Map<string, number>();
  private usedStale = new Set<string>();
  private saveFailed = false;
  private requests = 0;
  private units = 0;
  /** Units used since the last explicit retry: the safety limit counts from there. */
  private unitsAtRetry = 0;
  private running = false;
  private readonly live = new Set<AnalyticsApi>();

  constructor(
    private readonly options: GamesSessionOptions,
    private readonly onChange: (load: GamesLoad, running: boolean) => void,
  ) {}

  get busy(): boolean {
    return this.running;
  }

  snapshot(): GamesLoad {
    const pending = new Set(this.queue);
    // Being read (an older list may be shown meanwhile).
    for (const id of this.progress.keys()) if (!this.failures.has(id)) pending.add(id);
    let inFlight = 0;
    for (const api of this.live) inFlight += api.requestCount;
    return {
      games: new Map(this.games),
      failed: new Set(this.failures.keys()),
      failures: [...this.failures.values()],
      usedStaleCache: this.usedStale.size > 0,
      stale: new Set(this.usedStale),
      saveFailed: this.saveFailed,
      requestsSent: this.requests + inFlight,
      pending,
      progress: new Map(this.progress),
      units: this.units,
    };
  }

  /** Seasons the open view needs, newest first. Seasons already asked for are not asked again. */
  want(seasons: readonly SessionSeason[]): void {
    let added = false;
    for (const season of seasons) {
      if (this.order.has(season.tournamentId)) continue;
      this.order.set(season.tournamentId, this.order.size);
      this.status.set(season.tournamentId, season.status);
      this.enqueue(season.tournamentId);
      added = true;
    }
    if (added) void this.pump();
  }

  /**
   * Takes up again the seasons that failed (or only those listed). The rows an earlier reading got
   * are read again and compared, never reused (`gamesLoader`).
   */
  retry(ids?: readonly string[]): void {
    let added = false;
    for (const failure of [...this.failures.values()]) {
      if (ids && !ids.includes(failure.tournamentId)) continue;
      this.failures.delete(failure.tournamentId);
      this.enqueue(failure.tournamentId);
      added = true;
    }
    if (added) {
      // An explicit retry gets a fresh allowance of units.
      this.unitsAtRetry = this.units;
      this.emit();
      void this.pump();
    }
  }

  /**
   * The browser is back online: seasons that failed for want of a connection, and seasons shown
   * from an expired saved list, are read again — each a bounded number of times per session.
   */
  resumeOnline(): void {
    const take = (id: string): boolean => {
      const n = this.autoResumes.get(id) ?? 0;
      if (n >= MAX_AUTO_RESUMES) return false;
      this.autoResumes.set(id, n + 1);
      return true;
    };
    const failed = this.offlineFailures().filter(take);
    const stale = [...this.usedStale].filter((id) => !this.queue.includes(id) && !this.progress.has(id) && take(id));
    for (const id of stale) this.enqueue(id);
    if (failed.length > 0) this.retry(failed);
    else if (stale.length > 0) {
      this.emit();
      void this.pump();
    }
  }

  /** Seasons that failed for a reason the network may have caused (offline, connection). */
  offlineFailures(): string[] {
    return [...this.failures.values()].filter((f) => f.kind === 'offline' || f.kind === 'network').map((f) => f.tournamentId);
  }

  dispose(): void {
    this.controller.abort();
  }

  private enqueue(id: string): void {
    if (this.queue.includes(id)) return;
    this.queue.push(id);
    this.queue.sort((a, b) => (this.order.get(a) ?? 0) - (this.order.get(b) ?? 0));
  }

  private emit(): void {
    if (!this.controller.signal.aborted) this.onChange(this.snapshot(), this.running);
  }

  private settle(id: string, result: GamesResult): void {
    if (result.saveFailed) this.saveFailed = true;
    this.progress.delete(id);
    if (result.ok) {
      // A stale list is only replaced by a list read now; a failed refresh keeps showing it.
      this.games.set(id, result.games);
      this.failures.delete(id);
      if (result.source === 'stale-cache') this.usedStale.add(id);
      else this.usedStale.delete(id);
      if (!result.games.complete && result.games.heldReason) this.failures.set(id, { tournamentId: id, reason: result.games.heldReason, kind: 'held' });
      return;
    }
    // An older complete list may be shown while the season cannot be read (marked as stale).
    if (result.stale && !this.games.has(id)) {
      this.games.set(id, result.stale);
      this.usedStale.add(id);
    }
    if (result.kind === 'aborted') return;
    this.failures.set(id, { tournamentId: id, reason: result.kind === 'budget' ? GAMES_LIMIT_REASON : result.reason, kind: result.kind });
  }

  /** A fresh unit for a reading whose budget ran out, or `null` when the session's allowance is used. */
  private async unit(previous: AnalyticsApi | null): Promise<AnalyticsApi | null> {
    const o = this.options;
    const signal = this.controller.signal;
    if (previous) {
      this.live.delete(previous);
      this.requests += previous.requestCount;
    }
    if (signal.aborted || this.units - this.unitsAtRetry >= (o.maxUnits ?? GAMES_MAX_UNITS)) return null;
    if (this.units > 0) await (o.sleep ?? defaultSleep)(o.pauseMs ?? GAMES_UNIT_PAUSE_MS, signal);
    if (signal.aborted) return null;
    this.units += 1;
    const api = o.createApi(signal, o.unitRequests ?? GAMES_UNIT_REQUESTS);
    this.live.add(api);
    return api;
  }

  private async pump(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.emit();
    const signal = this.controller.signal;
    const o = this.options;
    try {
      // Each worker reads one season at a time with its own unit; a reading whose unit runs out
      // takes the next one and goes on in memory (see `loadSeasonGames`).
      const worker = async (): Promise<void> => {
        let api: AnalyticsApi | null = null;
        try {
          while (!signal.aborted) {
            const id = this.queue.shift();
            if (id === undefined) return;
            if (!api) api = await this.unit(null);
            if (!api) {
              this.failures.set(id, { tournamentId: id, reason: GAMES_LIMIT_REASON, kind: 'budget' });
              continue;
            }
            this.progress.set(id, { rows: 0, pages: 0 });
            this.emit();
            const ctx = {
              api,
              nextApi: async () => {
                api = await this.unit(api);
                return api;
              },
              cache: o.cache,
              isOnline: o.isOnline,
              now: o.now,
              freshAfter: o.freshAfter,
              signal,
              sleep: o.sleep,
              memory: o.memory,
            };
            const result = await loadSeasonGames(ctx, id, this.status.get(id) ?? null, (p) => {
              this.progress.set(id, p);
              this.emit();
            });
            this.settle(id, result);
            this.emit();
          }
        } finally {
          if (api) {
            this.live.delete(api);
            this.requests += api.requestCount;
          }
        }
      };
      await Promise.all(Array.from({ length: Math.max(1, o.concurrency ?? 2) }, () => worker()));
    } finally {
      this.running = false;
      this.emit();
    }
  }
}
