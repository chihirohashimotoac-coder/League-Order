import type { N01Operation, N01Request } from './endpoints';
import { N01_API_BASE_URL, buildUrl, isAllowedN01Url } from './endpoints';
import type {
  N01Fixture,
  N01LeagueSummary,
  N01LeagueTournaments,
  N01OrderEntry,
  N01PlayerStats,
  N01RosterPlayer,
  N01Tournament,
} from './types';
import {
  N01SchemaError,
  parseLeagueSearch,
  parseLeagueTournaments,
  parseOrders,
  parseRoster,
  parseSchedule,
  parseStats,
  parseTournament,
} from './validation';

/**
 * n01 read client (docs/N01_MASTER_DESIGN.md §4).
 *
 * - The transport is injected: the app uses `fetch`, tests and the E2E fixture server
 *   use canned responses, and nothing else changes.
 * - Every response is validated into the normalised types before it is returned.
 * - Failures are classified (`N01Error.kind`) so the UI can say *why* a sync failed and
 *   offer the right next step (retry, or continue with the previous data).
 * - One client is created per sync and memoises its requests, so a sync never asks n01
 *   for the same thing twice, and a later sync never sees an earlier sync's answers.
 */

export type N01ErrorKind = 'network' | 'timeout' | 'http' | 'notFound' | 'schema' | 'aborted' | 'blocked';

export class N01Error extends Error {
  constructor(
    readonly kind: N01ErrorKind,
    message: string,
    readonly operation?: N01Operation | string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'N01Error';
  }
}

export const N01_ERROR_MESSAGES: Record<N01ErrorKind, string> = {
  network: 'n01 に接続できませんでした (オフライン、または n01 側が応答していません)。',
  timeout: 'n01 の応答がありませんでした (タイムアウト)。',
  http: 'n01 がエラーを返しました。',
  notFound: 'n01 にデータが見つかりませんでした。',
  schema: 'n01 のデータ形式が想定と異なります。',
  aborted: '同期を中止しました。',
  blocked: '許可されていない接続先です。',
};

export interface N01Transport {
  request(request: N01Request, signal: AbortSignal): Promise<unknown>;
}

export interface FetchTransportOptions {
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

/** Browser transport: anonymous, uncached GETs to the n01 public read API. */
export function createFetchTransport(options: FetchTransportOptions = {}): N01Transport {
  const baseUrl = options.baseUrl ?? N01_API_BASE_URL;
  if (!isAllowedN01Url(baseUrl)) {
    throw new N01Error('blocked', `${N01_ERROR_MESSAGES.blocked} (${baseUrl})`);
  }
  return {
    async request(request, signal) {
      const fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
      const url = buildUrl(baseUrl, request);
      let response: Response;
      try {
        response = await fetchImpl(url, {
          method: 'GET',
          credentials: 'omit',
          cache: 'no-store',
          referrerPolicy: 'no-referrer',
          headers: { Accept: 'application/json' },
          signal,
        });
      } catch (error) {
        if (signal.aborted) throw error;
        throw new N01Error('network', N01_ERROR_MESSAGES.network, request.operation);
      }
      if (response.status === 404) {
        throw new N01Error('notFound', N01_ERROR_MESSAGES.notFound, request.operation, 404);
      }
      if (!response.ok) {
        throw new N01Error('http', `${N01_ERROR_MESSAGES.http} (HTTP ${response.status})`, request.operation, response.status);
      }
      const body = await response.text();
      try {
        return JSON.parse(body) as unknown;
      } catch {
        throw new N01Error('schema', `${N01_ERROR_MESSAGES.schema} (JSON ではありません)`, request.operation);
      }
    },
  };
}

export interface N01ClientOptions {
  /** Per-request timeout. */
  timeoutMs?: number;
  /** Aborts every pending and future request (e.g. the captain cancels the sync). */
  signal?: AbortSignal;
  /** Clock, injected so date parsing is deterministic in tests. */
  now?: () => number;
}

export const N01_DEFAULT_TIMEOUT_MS = 12_000;

export class N01Client {
  private readonly cache = new Map<string, Promise<unknown>>();
  private readonly timeoutMs: number;
  private readonly now: () => number;
  /** Number of requests actually sent (for the "no excessive requests" check). */
  requestCount = 0;

  constructor(
    private readonly transport: N01Transport,
    private readonly options: N01ClientOptions = {},
  ) {
    this.timeoutMs = options.timeoutMs ?? N01_DEFAULT_TIMEOUT_MS;
    this.now = options.now ?? (() => Date.now());
  }

  private raw(operation: N01Operation, params: Record<string, string>): Promise<unknown> {
    const key = `${operation}?${Object.keys(params)
      .sort()
      .map((name) => `${name}=${params[name]}`)
      .join('&')}`;
    const cached = this.cache.get(key);
    if (cached) return cached;
    const pending = this.send({ operation, params });
    // A failed request is not memoised: a retry must actually retry.
    pending.catch(() => this.cache.delete(key));
    this.cache.set(key, pending);
    return pending;
  }

  private async send(request: N01Request): Promise<unknown> {
    const outer = this.options.signal;
    if (outer?.aborted) throw new N01Error('aborted', N01_ERROR_MESSAGES.aborted, request.operation);
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.timeoutMs);
    const onAbort = (): void => controller.abort();
    outer?.addEventListener('abort', onAbort);
    this.requestCount += 1;
    try {
      return await this.transport.request(request, controller.signal);
    } catch (error) {
      if (error instanceof N01Error) throw error;
      if (timedOut) throw new N01Error('timeout', N01_ERROR_MESSAGES.timeout, request.operation);
      if (outer?.aborted) throw new N01Error('aborted', N01_ERROR_MESSAGES.aborted, request.operation);
      throw new N01Error('network', N01_ERROR_MESSAGES.network, request.operation);
    } finally {
      clearTimeout(timer);
      outer?.removeEventListener('abort', onAbort);
    }
  }

  private async parsed<T>(operation: N01Operation, params: Record<string, string>, parse: (raw: unknown) => T): Promise<T> {
    const raw = await this.raw(operation, params);
    try {
      return parse(raw);
    } catch (error) {
      if (error instanceof N01SchemaError) {
        throw new N01Error('schema', `${N01_ERROR_MESSAGES.schema} ${error.message}`, operation);
      }
      throw error;
    }
  }

  searchLeagues(query: string): Promise<N01LeagueSummary[]> {
    return this.parsed('league/list', { keyword: query }, parseLeagueSearch);
  }

  leagueTournaments(leagueId: string): Promise<N01LeagueTournaments> {
    return this.parsed('league/tournament/list', { lgid: leagueId }, (raw) => parseLeagueTournaments(raw, leagueId));
  }

  tournament(tournamentId: string): Promise<N01Tournament> {
    return this.parsed('tournament/get', { tdid: tournamentId }, (raw) => parseTournament(raw, tournamentId));
  }

  stats(tournamentId: string): Promise<N01PlayerStats[]> {
    // Team events return individual members' rows only for this kind.
    return this.parsed('tournament/stats', { tdid: tournamentId, kind: 'player_stats_list' }, parseStats);
  }

  roster(tournamentId: string, teamId: string): Promise<N01RosterPlayer[]> {
    return this.parsed('team/player/list', { tdid: tournamentId, tpid: teamId }, (raw) => parseRoster(raw, teamId));
  }

  /**
   * Every team's members of a tournament in one request (`team/player/list` without a
   * `tpid`). It is the evidence for whether an `opid` names one person in that season.
   */
  fullRoster(tournamentId: string): Promise<N01RosterPlayer[]> {
    return this.parsed('team/player/list', { tdid: tournamentId }, (raw) => parseRoster(raw, ''));
  }

  schedule(tournamentId: string): Promise<N01Fixture[]> {
    return this.parsed('league/schedule/get', { tdid: tournamentId }, (raw) => parseSchedule(raw, this.now()));
  }

  orders(tournamentId: string, teamId: string): Promise<N01OrderEntry[]> {
    return this.parsed('team/order/list', { tdid: tournamentId, tpid: teamId }, parseOrders);
  }
}

/** Human-readable message for any error a sync can raise. */
export function describeN01Error(error: unknown): string {
  if (error instanceof N01Error) return error.message;
  return N01_ERROR_MESSAGES.network;
}
