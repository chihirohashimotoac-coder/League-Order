import type { AnalyticsApi } from '../api/readApi';
import type { AnalyticsCache } from '../cache/analyticsCache';
import type { SeasonGames } from '../roleGames';
import type { GamesSource } from '../projection';
import { GAMES_UNIT_REQUESTS, loadSeasonGames } from './gamesLoader';
import type { GamesFailureKind, GamesProgress, GamesResult } from './gamesLoader';
import { defaultSleep } from './retry';
import type { Sleep } from './retry';

/**
 * The game lists of one open period, read season by season and published as each season is done.
 *
 * Work is split into **units**: one adapter with its own request budget
 * ({@link GAMES_UNIT_REQUESTS}). A season the budget cuts off keeps its checkpoint and is taken up
 * again by the next unit, so a period needing hundreds of requests is read to the end without the
 * user doing anything — while one unit still never sends more than its budget, and at most
 * `concurrency` seasons are read at once (each one page at a time). Newest seasons first.
 *
 * A unit that reads nothing ends the load (nothing would change by trying again at once). Failures
 * other than the budget are reported per season; `retry()` takes them up again from their
 * checkpoints (also used when the browser comes back online).
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
}

export const GAMES_MAX_UNITS = 60;
export const GAMES_UNIT_PAUSE_MS = 300;

export function emptyGamesLoad(): GamesLoad {
  return { games: new Map(), failed: new Set(), failures: [], usedStaleCache: false, requestsSent: 0, pending: new Set(), progress: new Map(), units: 0 };
}

export class GamesSession {
  private readonly controller = new AbortController();
  private readonly order = new Map<string, number>();
  private readonly status = new Map<string, number | null>();
  private queue: string[] = [];
  private readonly games = new Map<string, SeasonGames>();
  private readonly failures = new Map<string, GamesFailure>();
  private readonly progress = new Map<string, GamesProgress>();
  private usedStale = new Set<string>();
  private requests = 0;
  private units = 0;
  /** Units used since the last explicit retry: the safety limit counts from there. */
  private unitsAtRetry = 0;
  private running = false;
  private current: AnalyticsApi | null = null;

  constructor(
    private readonly options: GamesSessionOptions,
    private readonly onChange: (load: GamesLoad, running: boolean) => void,
  ) {}

  get busy(): boolean {
    return this.running;
  }

  snapshot(): GamesLoad {
    const pending = new Set(this.queue);
    // Being read, or cut off and waiting for the next unit (an older list may be shown meanwhile).
    for (const id of this.progress.keys()) if (!this.failures.has(id)) pending.add(id);
    return {
      games: new Map(this.games),
      failed: new Set(this.failures.keys()),
      failures: [...this.failures.values()],
      usedStaleCache: this.usedStale.size > 0,
      requestsSent: this.requests + (this.current?.requestCount ?? 0),
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

  /** Takes up again the seasons that failed (or only those listed), from their checkpoints. */
  retry(ids?: readonly string[]): void {
    let added = false;
    for (const failure of [...this.failures.values()]) {
      if (ids && !ids.includes(failure.tournamentId)) continue;
      this.failures.delete(failure.tournamentId);
      this.enqueue(failure.tournamentId);
      added = true;
    }
    if (added) {
      // An explicit retry gets a fresh allowance of units (the checkpoints keep what was read).
      this.unitsAtRetry = this.units;
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

  private settle(id: string, result: GamesResult): 'budget' | 'aborted' | 'settled' {
    if (result.ok) {
      this.games.set(id, result.games);
      this.failures.delete(id);
      this.progress.delete(id);
      if (result.source === 'stale-cache') this.usedStale.add(id);
      else this.usedStale.delete(id);
      if (!result.games.complete && result.games.heldReason) this.failures.set(id, { tournamentId: id, reason: result.games.heldReason, kind: 'held' });
      return 'settled';
    }
    if (result.progress) this.progress.set(id, result.progress);
    // An older complete list may be shown while the new one is being read (marked as stale).
    if (result.stale && !this.games.has(id)) {
      this.games.set(id, result.stale);
      this.usedStale.add(id);
    }
    if (result.kind === 'budget') {
      this.enqueue(id);
      return 'budget';
    }
    if (result.kind === 'aborted') return 'aborted';
    this.failures.set(id, { tournamentId: id, reason: result.reason, kind: result.kind });
    return 'settled';
  }

  private async pump(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.emit();
    const signal = this.controller.signal;
    const o = this.options;
    try {
      while (this.queue.length > 0 && !signal.aborted) {
        if (this.units - this.unitsAtRetry >= (o.maxUnits ?? GAMES_MAX_UNITS)) {
          for (const id of this.queue) this.failures.set(id, { tournamentId: id, reason: '通信の上限に達したため未取得（「再試行」で続きから取得します）', kind: 'budget' });
          this.queue = [];
          break;
        }
        if (this.units > 0) await (o.sleep ?? defaultSleep)(o.pauseMs ?? GAMES_UNIT_PAUSE_MS, signal);
        if (signal.aborted) break;
        this.units += 1;
        const api = o.createApi(signal, o.unitRequests ?? GAMES_UNIT_REQUESTS);
        this.current = api;
        const ctx = { api, cache: o.cache, isOnline: o.isOnline, now: o.now, freshAfter: o.freshAfter, signal, sleep: o.sleep };
        let budgetHit = false;
        let pages = 0;
        const worker = async (): Promise<void> => {
          while (!budgetHit && !signal.aborted) {
            const id = this.queue.shift();
            if (id === undefined) return;
            this.progress.set(id, this.progress.get(id) ?? { rows: 0, pages: 0 });
            this.emit();
            const result = await loadSeasonGames(ctx, id, this.status.get(id) ?? null, (p) => {
              this.progress.set(id, p);
              this.emit();
            });
            pages += result.pages;
            const outcome = this.settle(id, result);
            if (outcome === 'budget') budgetHit = true;
            this.emit();
          }
        };
        await Promise.all(Array.from({ length: Math.max(1, o.concurrency ?? 2) }, () => worker()));
        this.requests += api.requestCount;
        this.current = null;
        if (budgetHit && pages === 0) {
          // Nothing could be read with a whole budget: stop rather than spin.
          for (const id of this.queue) this.failures.set(id, { tournamentId: id, reason: '通信の上限に達したため未取得（「再試行」で続きから取得します）', kind: 'budget' });
          this.queue = [];
        }
      }
    } finally {
      this.running = false;
      this.emit();
    }
  }
}
