import { N01Error, N01_ERROR_MESSAGES } from '../../integrations/n01/client';
import { N01_API_BASE_URL, isAllowedN01Url } from '../../integrations/n01/endpoints';
import { parseLeagueTournaments } from '../../integrations/n01/validation';
import type { N01LeagueTournaments } from '../../integrations/n01/types';
import { createAnalyticsFetchTransport } from '../analytics/api/readApi';
import type { AnalyticsOperation, AnalyticsTransport } from '../analytics/api/readApi';
import { parseStandings } from '../analytics/api/parse';
import type { OfficialStandingGroup } from '../analytics/types';
import type { CardOrder, Fixture, GameDetail, GameRow, LiveResponse, SeasonDocument, ThrowsResponse } from './parse';
import { MatchSchemaError, parseFixtures, parseGameDetail, parseGameRows, parseLive, parseOrders, parseSeasonDocument, parseThrows } from './parse';
import { parsePlayerStats } from '../analytics/api/parse';
import { parseRoster } from '../../integrations/n01/validation';
import type { N01RosterPlayer } from '../../integrations/n01/types';
import type { PlayerStatsRow } from '../analytics/types';
import type { RequestGovernor } from './governor';
import { sharedGovernor } from './governor';

/**
 * Read adapter of MATCH RESULTS and LIVE MATCH.
 *
 * It goes through the app's one audited transport (anonymous GET, no cookies, no HTTP cache,
 * n01 host allow-list) and issues read operations only. Season data is memoised for the life
 * of the instance (one screen visit); live reads are never memoised, but two identical live
 * reads in flight share one request. A request budget stops a runaway loop.
 *
 * n01's own limit is about 300 requests per minute per IP (manual §7, result -55 / HTTP 429);
 * polling one game every 1.5 s is 40 per minute.
 */

export const MATCHES_DEFAULT_MAX_REQUESTS = 120;
export const MATCHES_TIMEOUT_MS = 12_000;
/** Pages of `match/list` read per season (a league season is well under 1,000 games). */
export const MATCH_ROWS_PAGE = 100;
export const MATCH_ROWS_MAX_PAGES = 10;

export class MatchBudgetError extends Error {
  constructor(readonly limit: number) {
    super(`通信回数の上限 (${limit} 回) に達したため、取得を止めました。`);
    this.name = 'MatchBudgetError';
  }
}

export interface MatchesApiOptions {
  transport?: AnalyticsTransport;
  baseUrl?: string;
  maxRequests?: number;
  timeoutMs?: number;
  /** The request budget shared by every match screen (defaults to the app's one). */
  governor?: RequestGovernor;
}

/** Fields of a game row the match screens read (`fields` selects exactly these). */
const GAME_FIELDS = 'mid,tdid,tmid,schid,scid,match_type,title,startTime,endMatch,endSchedule,updateTime,statsData';

export class MatchesApi {
  private readonly memo = new Map<string, Promise<unknown>>();
  private readonly inflight = new Map<string, Promise<unknown>>();
  private readonly transport: AnalyticsTransport;
  private readonly maxRequests: number;
  private readonly timeoutMs: number;
  private readonly governor: RequestGovernor;
  requestCount = 0;

  constructor(options: MatchesApiOptions = {}) {
    const baseUrl = options.baseUrl ?? N01_API_BASE_URL;
    if (!isAllowedN01Url(baseUrl)) throw new N01Error('blocked', `${N01_ERROR_MESSAGES.blocked} (${baseUrl})`);
    this.transport = options.transport ?? createAnalyticsFetchTransport({ baseUrl });
    this.maxRequests = options.maxRequests ?? MATCHES_DEFAULT_MAX_REQUESTS;
    this.timeoutMs = options.timeoutMs ?? MATCHES_TIMEOUT_MS;
    this.governor = options.governor ?? sharedGovernor;
  }

  private key(operation: AnalyticsOperation, params: Record<string, string>): string {
    return `${operation}?${Object.keys(params).sort().map((name) => `${name}=${params[name]}`).join('&')}`;
  }

  private async send(operation: AnalyticsOperation, params: Record<string, string>, signal?: AbortSignal): Promise<unknown> {
    if (signal?.aborted) throw new N01Error('aborted', N01_ERROR_MESSAGES.aborted, operation);
    if (this.requestCount >= this.maxRequests) throw new MatchBudgetError(this.maxRequests);
    this.requestCount += 1;
    await this.governor.acquire(signal);
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.timeoutMs);
    const onAbort = (): void => controller.abort();
    signal?.addEventListener('abort', onAbort);
    try {
      return await this.transport.request(operation, params, controller.signal);
    } catch (error) {
      // n01 says "too many requests": every match screen waits, not only this one.
      if (error instanceof N01Error && error.kind === 'http' && error.status === 429) this.governor.pause(60);
      if (error instanceof N01Error) throw error;
      if (timedOut) throw new N01Error('timeout', N01_ERROR_MESSAGES.timeout, operation);
      if (signal?.aborted) throw new N01Error('aborted', N01_ERROR_MESSAGES.aborted, operation);
      throw new N01Error('network', N01_ERROR_MESSAGES.network, operation);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  }

  private memoised(operation: AnalyticsOperation, params: Record<string, string>): Promise<unknown> {
    const key = this.key(operation, params);
    const cached = this.memo.get(key);
    if (cached) return cached;
    const pending = this.send(operation, params);
    pending.catch(() => this.memo.delete(key));
    this.memo.set(key, pending);
    return pending;
  }

  /** Uncached, but one request at a time per key. */
  private fresh(operation: AnalyticsOperation, params: Record<string, string>, signal?: AbortSignal): Promise<unknown> {
    const key = this.key(operation, params);
    const running = this.inflight.get(key);
    if (running) return running;
    const pending = this.send(operation, params, signal).finally(() => this.inflight.delete(key));
    this.inflight.set(key, pending);
    return pending;
  }

  private async read<T>(operation: AnalyticsOperation, raw: Promise<unknown>, parse: (raw: unknown) => T): Promise<T> {
    const value = await raw;
    try {
      return parse(value);
    } catch (error) {
      if (error instanceof MatchSchemaError || (error instanceof Error && error.name.endsWith('SchemaError'))) {
        throw new N01Error('schema', `${N01_ERROR_MESSAGES.schema} ${error.message}`, operation);
      }
      throw error;
    }
  }

  seasons(leagueId: string): Promise<N01LeagueTournaments> {
    return this.read('league/tournament/list', this.memoised('league/tournament/list', { lgid: leagueId }), (raw) => parseLeagueTournaments(raw, leagueId));
  }

  season(tournamentId: string): Promise<SeasonDocument> {
    return this.read('tournament/get', this.memoised('tournament/get', { tdid: tournamentId }), (raw) => parseSeasonDocument(raw, tournamentId));
  }

  fixtures(tournamentId: string): Promise<Fixture[]> {
    return this.read('league/schedule/get', this.memoised('league/schedule/get', { tdid: tournamentId }), parseFixtures);
  }

  standings(tournamentId: string): Promise<OfficialStandingGroup[]> {
    return this.read('tournament/standings', this.memoised('tournament/standings', { tdid: tournamentId }), parseStandings);
  }

  /**
   * Every league game of a season (`tmid` containing `_lg_`), oldest first. Pages are read
   * until one comes back short; a page none of whose rows can be read stops the list and is
   * reported, never filled in.
   */
  async seasonGames(tournamentId: string, options: { live?: boolean } = {}): Promise<{ games: GameRow[]; unreadable: number; truncated: boolean }> {
    const games: GameRow[] = [];
    let unreadable = 0;
    for (let page = 0; page < MATCH_ROWS_MAX_PAGES; page += 1) {
      const params: Record<string, string> = {
        tdid: tournamentId,
        tmid__regex: '_lg_',
        sort: 'startTime',
        order: 'asc',
        count: String(MATCH_ROWS_PAGE),
        fields: GAME_FIELDS,
      };
      if (options.live) params.live = '1';
      if (page > 0) params.skip = String(page * MATCH_ROWS_PAGE);
      const request = options.live ? this.fresh('match/list', params) : this.memoised('match/list', params);
      const result = await this.read('match/list', request, parseGameRows);
      games.push(...result.games);
      unreadable += result.unreadable;
      if (result.rows < MATCH_ROWS_PAGE) return { games, unreadable, truncated: false };
    }
    return { games, unreadable, truncated: true };
  }

  /**
   * The league games started since `fromEpochSec` (one league night), finished and in progress:
   * the archive holds games in progress too, with the same `updateTime` as the live list
   * (checked 2026-11-06), so one request draws the whole board. Never memoised.
   */
  async todayGames(tournamentId: string, fromEpochSec: number, signal?: AbortSignal): Promise<GameRow[]> {
    const params: Record<string, string> = {
      tdid: tournamentId,
      tmid__regex: '_lg_',
      startTime__gte: String(Math.floor(fromEpochSec)),
      sort: 'startTime',
      order: 'asc',
      count: String(MATCH_ROWS_PAGE),
      fields: GAME_FIELDS,
    };
    return (await this.read('match/list', this.fresh('match/list', params, signal), parseGameRows)).games;
  }

  /** Every leg of a game, throw by throw; with `since`, only the legs changed after it. Finished games are memoised. */
  throws(mid: string, since: number | null, options: { finished?: boolean; signal?: AbortSignal } = {}): Promise<ThrowsResponse> {
    const params: Record<string, string> = { mid };
    if (since !== null) params.since = String(since);
    const request = options.finished && since === null ? this.memoised('match/throws', params) : this.fresh('match/throws', params, options.signal);
    return this.read('match/throws', request, parseThrows);
  }

  /** The orders of one card (who plays which game), as submitted so far. */
  cardOrders(tournamentId: string, tmid: string): Promise<CardOrder[]> {
    return this.read('team/order/list', this.fresh('team/order/list', { tdid: tournamentId, tmid }), parseOrders);
  }

  /** n01's own season figures per player (`player_stats_list`). */
  playerStats(tournamentId: string): Promise<PlayerStatsRow[]> {
    return this.read('tournament/stats', this.memoised('tournament/stats', { tdid: tournamentId, kind: 'player_stats_list' }), parsePlayerStats);
  }

  /** Every member of every team of a season (names for the stats rows). */
  roster(tournamentId: string): Promise<N01RosterPlayer[]> {
    return this.read('team/player/list', this.memoised('team/player/list', { tdid: tournamentId }), (raw) => parseRoster(raw, ''));
  }

  gameDetail(mid: string): Promise<GameDetail> {
    return this.read('match/get', this.memoised('match/get', { mid }), parseGameDetail);
  }

  /** `match/live` by card (`tmid`) or game (`mid`); `since` = the last `updateTime`. */
  live(target: { tmid: string } | { mid: string }, since: number | null, signal?: AbortSignal): Promise<LiveResponse> {
    const params: Record<string, string> = 'tmid' in target ? { tmid: target.tmid } : { mid: target.mid };
    if (since !== null) params.since = String(since);
    return this.read('match/live', this.fresh('match/live', params, signal), parseLive);
  }
}
