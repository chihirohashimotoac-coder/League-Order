import { N01_ERROR_MESSAGES, N01Error } from '../../../integrations/n01/client';
import { N01_API_BASE_URL, isAllowedN01Url } from '../../../integrations/n01/endpoints';
import { parseLeagueTournaments, parseRoster, parseTournament } from '../../../integrations/n01/validation';
import { N01SchemaError } from '../../../integrations/n01/validation';
import type { N01LeagueTournaments, N01RosterPlayer, N01Tournament } from '../../../integrations/n01/types';
import type { OfficialStandingGroup, PlayerStatsRow, TeamStatsRow } from '../types';
import { AnalyticsSchemaError, parsePlayerStats, parseStandings, parseTeamStats } from './parse';

/**
 * Analytics read adapter. It is its own client — the sync's `N01Client`, its operation list
 * and its request counts are untouched — and it can only issue anonymous GETs to the
 * allow-listed n01 hosts. The same request is never sent twice by one adapter, and a hard
 * request budget stops a runaway "all periods" fetch.
 */

export const ANALYTICS_OPERATIONS = [
  'league/tournament/list',
  'tournament/get',
  'tournament/stats',
  'tournament/standings',
  'team/player/list',
] as const;

export type AnalyticsOperation = (typeof ANALYTICS_OPERATIONS)[number];

export interface AnalyticsTransport {
  get(url: string, signal: AbortSignal): Promise<unknown>;
}

export function createAnalyticsFetchTransport(fetchImpl?: typeof fetch): AnalyticsTransport {
  return {
    async get(url, signal) {
      const run = fetchImpl ?? globalThis.fetch.bind(globalThis);
      let response: Response;
      try {
        response = await run(url, {
          method: 'GET',
          credentials: 'omit',
          cache: 'no-store',
          referrerPolicy: 'no-referrer',
          headers: { Accept: 'application/json' },
          signal,
        });
      } catch (error) {
        if (signal.aborted) throw error;
        throw new N01Error('network', N01_ERROR_MESSAGES.network);
      }
      if (response.status === 404) throw new N01Error('notFound', N01_ERROR_MESSAGES.notFound, undefined, 404);
      if (response.status === 429) throw new N01Error('http', `${N01_ERROR_MESSAGES.http} (HTTP 429: リクエスト過多)`, undefined, 429);
      if (!response.ok) throw new N01Error('http', `${N01_ERROR_MESSAGES.http} (HTTP ${response.status})`, undefined, response.status);
      const body = await response.text();
      try {
        return JSON.parse(body) as unknown;
      } catch {
        throw new N01Error('schema', `${N01_ERROR_MESSAGES.schema} (JSON ではありません)`);
      }
    },
  };
}

export interface AnalyticsApiOptions {
  transport?: AnalyticsTransport;
  baseUrl?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Most requests this adapter may send. Beyond it a request fails with `RequestBudgetError`. */
  maxRequests?: number;
}

export class RequestBudgetError extends Error {
  constructor(readonly limit: number) {
    super(`分析用の通信回数の上限 (${limit} 回) に達しました。`);
    this.name = 'RequestBudgetError';
  }
}

export const ANALYTICS_DEFAULT_TIMEOUT_MS = 15_000;
export const ANALYTICS_DEFAULT_MAX_REQUESTS = 60;

export class AnalyticsApi {
  private readonly memo = new Map<string, Promise<unknown>>();
  private readonly transport: AnalyticsTransport;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly maxRequests: number;
  requestCount = 0;

  constructor(private readonly options: AnalyticsApiOptions = {}) {
    this.baseUrl = options.baseUrl ?? N01_API_BASE_URL;
    if (!isAllowedN01Url(this.baseUrl)) throw new N01Error('blocked', `${N01_ERROR_MESSAGES.blocked} (${this.baseUrl})`);
    this.transport = options.transport ?? createAnalyticsFetchTransport();
    this.timeoutMs = options.timeoutMs ?? ANALYTICS_DEFAULT_TIMEOUT_MS;
    this.maxRequests = options.maxRequests ?? ANALYTICS_DEFAULT_MAX_REQUESTS;
  }

  private url(operation: AnalyticsOperation, params: Record<string, string>): string {
    const url = new URL(`${this.baseUrl.replace(/\/+$/u, '')}/${operation}`);
    for (const key of Object.keys(params).sort()) url.searchParams.set(key, params[key]);
    return url.toString();
  }

  private raw(operation: AnalyticsOperation, params: Record<string, string>): Promise<unknown> {
    const url = this.url(operation, params);
    const cached = this.memo.get(url);
    if (cached) return cached;
    const pending = this.send(url, operation);
    pending.catch(() => this.memo.delete(url));
    this.memo.set(url, pending);
    return pending;
  }

  private async send(url: string, operation: AnalyticsOperation): Promise<unknown> {
    const outer = this.options.signal;
    if (outer?.aborted) throw new N01Error('aborted', N01_ERROR_MESSAGES.aborted, operation);
    if (this.requestCount >= this.maxRequests) throw new RequestBudgetError(this.maxRequests);
    this.requestCount += 1;
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.timeoutMs);
    const onAbort = (): void => controller.abort();
    outer?.addEventListener('abort', onAbort);
    try {
      return await this.transport.get(url, controller.signal);
    } catch (error) {
      if (error instanceof N01Error) throw error;
      if (timedOut) throw new N01Error('timeout', N01_ERROR_MESSAGES.timeout, operation);
      if (outer?.aborted) throw new N01Error('aborted', N01_ERROR_MESSAGES.aborted, operation);
      throw new N01Error('network', N01_ERROR_MESSAGES.network, operation);
    } finally {
      clearTimeout(timer);
      outer?.removeEventListener('abort', onAbort);
    }
  }

  private async parsed<T>(operation: AnalyticsOperation, params: Record<string, string>, parse: (raw: unknown) => T): Promise<T> {
    const raw = await this.raw(operation, params);
    try {
      return parse(raw);
    } catch (error) {
      if (error instanceof AnalyticsSchemaError || error instanceof N01SchemaError) {
        throw new N01Error('schema', `${N01_ERROR_MESSAGES.schema} ${error.message}`, operation);
      }
      throw error;
    }
  }

  leagueTournaments(leagueId: string): Promise<N01LeagueTournaments> {
    return this.parsed('league/tournament/list', { lgid: leagueId }, (raw) => parseLeagueTournaments(raw, leagueId));
  }

  tournament(tournamentId: string): Promise<N01Tournament> {
    return this.parsed('tournament/get', { tdid: tournamentId }, (raw) => parseTournament(raw, tournamentId));
  }

  teamStats(tournamentId: string): Promise<TeamStatsRow[]> {
    return this.parsed('tournament/stats', { tdid: tournamentId, kind: 'stats_list' }, parseTeamStats);
  }

  playerStats(tournamentId: string): Promise<PlayerStatsRow[]> {
    return this.parsed('tournament/stats', { tdid: tournamentId, kind: 'player_stats_list' }, parsePlayerStats);
  }

  standings(tournamentId: string): Promise<OfficialStandingGroup[]> {
    return this.parsed('tournament/standings', { tdid: tournamentId }, parseStandings);
  }

  /** Every team's roster of one season in a single request (the evidence for opid uniqueness). */
  fullRoster(tournamentId: string): Promise<N01RosterPlayer[]> {
    return this.parsed('team/player/list', { tdid: tournamentId }, (raw) => parseRoster(raw, ''));
  }
}
