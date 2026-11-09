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
import { parsePlayerStats, parseTeamStats } from '../analytics/api/parse';
import { parseRoster } from '../../integrations/n01/validation';
import type { N01RosterPlayer } from '../../integrations/n01/types';
import type { PlayerStatsRow, TeamStatsRow } from '../analytics/types';
import { RequestGovernor, sharedGovernor } from './governor';
import type { CompetitionDoc, CompetitionSummary, StandingGroup } from './competition';
import { parseAllStandings, parseCompetition, parseCompetitionList } from './competition';

/**
 * Read adapter of MATCH RESULTS and LIVE MATCH.
 *
 * It goes through the app's one audited transport (anonymous GET, no cookies, no HTTP cache,
 * n01 host allow-list) and issues read operations only. Season data is memoised for the life
 * of the instance (one screen visit); live reads are never memoised, but two identical live
 * reads in flight share one request.
 *
 * Two different limits, never mixed up:
 * - **budget** (`maxRequests`): a cumulative cap on the one-off reads of a visit (season
 *   documents, finished games' throws …). It stops a runaway loop and does not recover.
 * - **polling rate** (`pollPerMinute`): the reads a screen repeats while it stays open (today's
 *   board, the live list, `since` reads, orders). They are not counted in the budget — a
 *   spectator may keep the screen open all evening — but each instance may send at most
 *   `pollPerMinute` of them in any minute, waiting for a slot rather than failing.
 * Both also take a slot of the app-wide governor (150 / min, HTTP 429 pauses everything).
 *
 * n01's own limit is about 300 requests per minute per IP (manual §7, result -55 / HTTP 429);
 * polling one game every 1.5 s is 40 per minute.
 */

export const MATCHES_DEFAULT_MAX_REQUESTS = 120;
export const MATCHES_TIMEOUT_MS = 12_000;
/** Pages of `match/list` read per season (a league season is well under 1,000 games). */
export const MATCH_ROWS_PAGE = 100;
export const MATCH_ROWS_MAX_PAGES = 10;
/** Pages of today's board read at most (newest first): 500 games in 18 hours. */
export const TODAY_MAX_PAGES = 5;

/**
 * How many games each paged list reads at most, and in which order — what a capped list shows
 * (`truncated`). Derived from the page constants so the screens never repeat the numbers.
 */
export const LIST_LIMITS = {
  /** A competition's games, oldest first (`competitionGames`): the newest are the ones left out. */
  competition: { games: MATCH_ROWS_PAGE * MATCH_ROWS_MAX_PAGES, order: 'oldest' },
  /** A league season's games, oldest first (`seasonGames`). */
  season: { games: MATCH_ROWS_PAGE * MATCH_ROWS_MAX_PAGES, order: 'oldest' },
  /** Today's league games, newest first (`todayGames`): the earliest of the night are left out. */
  today: { games: MATCH_ROWS_PAGE * TODAY_MAX_PAGES, order: 'newest' },
} as const;
export type ListKind = keyof typeof LIST_LIMITS;
/** Polling reads one API instance may send per minute (one screen: board 12 + orders + since reads). */
export const MATCHES_POLL_PER_MINUTE = 60;
/** A full, all-finished page of a competition list is re-read after this long (corrections). */
export const COMPETITION_PAGE_TTL_MS = 3 * 60_000;

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
  /** Polling reads per minute of this instance (see the class comment). */
  pollPerMinute?: number;
  /** This instance's polling limiter (tests pass one with a fake clock). */
  pollGovernor?: RequestGovernor;
  now?: () => number;
}

/** One page of `match/list` as read. */
interface RowsPage {
  games: GameRow[];
  rows: number;
  unreadable: number;
}

/** A list read in pages: what was read, and whether it is known to be the whole list. */
export interface GameList {
  games: GameRow[];
  /** The page cap was reached: there may be more games than these. */
  truncated: boolean;
  /** Rows n01 sent that could not be read (left out, never filled in). */
  unreadable: number;
  /**
   * Two pages met on games with the same start time. n01 documents no order among equal start
   * times (nor a snapshot of the list), so a game may have fallen between the two page reads:
   * the list is not known to be whole. A later read usually settles it.
   */
  unsure: boolean;
}

/** True when a page continues the previous one on the same start time (order not guaranteed). */
function tiedAtBoundary(previous: readonly GameRow[], next: readonly GameRow[]): boolean {
  const last = previous[previous.length - 1]?.startTime ?? null;
  const first = next[0]?.startTime ?? null;
  return last !== null && first !== null && last === first;
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
  private readonly pollGovernor: RequestGovernor;
  private readonly now: () => number;
  /** Competition list pages as last read, for `competitionGames` (bounded: ≤ 10 per competition). */
  private readonly pages = new Map<string, { at: number; page: RowsPage }>();
  /** One-off reads sent (counted against `maxRequests`). */
  requestCount = 0;
  /** Polling reads sent (rate-limited, not counted against `maxRequests`). */
  pollCount = 0;

  constructor(options: MatchesApiOptions = {}) {
    const baseUrl = options.baseUrl ?? N01_API_BASE_URL;
    if (!isAllowedN01Url(baseUrl)) throw new N01Error('blocked', `${N01_ERROR_MESSAGES.blocked} (${baseUrl})`);
    this.transport = options.transport ?? createAnalyticsFetchTransport({ baseUrl });
    this.maxRequests = options.maxRequests ?? MATCHES_DEFAULT_MAX_REQUESTS;
    this.timeoutMs = options.timeoutMs ?? MATCHES_TIMEOUT_MS;
    this.governor = options.governor ?? sharedGovernor;
    this.now = options.now ?? (() => Date.now());
    this.pollGovernor = options.pollGovernor ?? new RequestGovernor(options.pollPerMinute ?? MATCHES_POLL_PER_MINUTE, this.now);
  }

  private key(operation: AnalyticsOperation, params: Record<string, string>): string {
    return `${operation}?${Object.keys(params).sort().map((name) => `${name}=${params[name]}`).join('&')}`;
  }

  private async send(operation: AnalyticsOperation, params: Record<string, string>, signal?: AbortSignal, kind: 'once' | 'poll' = 'once'): Promise<unknown> {
    if (signal?.aborted) throw new N01Error('aborted', N01_ERROR_MESSAGES.aborted, operation);
    if (kind === 'once') {
      if (this.requestCount >= this.maxRequests) throw new MatchBudgetError(this.maxRequests);
      this.requestCount += 1;
    } else {
      try {
        await this.pollGovernor.acquire(signal);
      } catch {
        throw new N01Error('aborted', N01_ERROR_MESSAGES.aborted, operation);
      }
      this.pollCount += 1;
    }
    try {
      await this.governor.acquire(signal);
    } catch {
      throw new N01Error('aborted', N01_ERROR_MESSAGES.aborted, operation);
    }
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
    const pending = this.send(operation, params, signal, 'poll').finally(() => this.inflight.delete(key));
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
  async seasonGames(tournamentId: string, options: { live?: boolean } = {}): Promise<GameList> {
    const games: GameRow[] = [];
    let unreadable = 0;
    let unsure = false;
    let previous: GameRow[] = [];
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
      if (page > 0 && tiedAtBoundary(previous, result.games)) unsure = true;
      previous = result.games;
      games.push(...result.games);
      unreadable += result.unreadable;
      if (result.rows < MATCH_ROWS_PAGE) return { games, unreadable, truncated: false, unsure };
    }
    return { games, unreadable, truncated: true, unsure };
  }

  /**
   * The league games started since `fromEpochSec` (one league night), finished and in progress:
   * the archive holds games in progress too, with the same `updateTime` as the live list
   * (checked 2026-11-06), so one request draws the whole board. Never memoised.
   *
   * Read **newest first** and paged: a night with more than 100 games must not lose the games
   * just started behind the 100 finished ones before them. Pages may overlap while games are
   * added (a game pushed to the next page is read twice) — rows are kept once per `mid`. The
   * result is oldest first; `truncated` says the page cap was reached.
   */
  async todayGames(tournamentId: string, fromEpochSec: number, signal?: AbortSignal): Promise<GameList> {
    const byMid = new Map<string, GameRow>();
    let unreadable = 0;
    let truncated = true;
    let unsure = false;
    let previous: GameRow[] = [];
    for (let page = 0; page < TODAY_MAX_PAGES; page += 1) {
      const params: Record<string, string> = {
        tdid: tournamentId,
        tmid__regex: '_lg_',
        startTime__gte: String(Math.floor(fromEpochSec)),
        sort: 'startTime',
        order: 'desc',
        count: String(MATCH_ROWS_PAGE),
        fields: GAME_FIELDS,
      };
      if (page > 0) params.skip = String(page * MATCH_ROWS_PAGE);
      const result = await this.read('match/list', this.fresh('match/list', params, signal), parseGameRows);
      if (page > 0 && tiedAtBoundary(previous, result.games)) unsure = true;
      previous = result.games;
      unreadable += result.unreadable;
      for (const game of result.games) if (!byMid.has(game.mid)) byMid.set(game.mid, game);
      if (result.rows < MATCH_ROWS_PAGE) {
        truncated = false;
        break;
      }
    }
    const games = [...byMid.values()].sort((a, b) => (a.startTime ?? 0) - (b.startTime ?? 0));
    return { games, truncated, unreadable, unsure };
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

  /** n01's own season figures per team member of a **team** event (`player_stats_list`). */
  playerStats(tournamentId: string): Promise<PlayerStatsRow[]> {
    return this.read('tournament/stats', this.memoised('tournament/stats', { tdid: tournamentId, kind: 'player_stats_list' }), parsePlayerStats);
  }

  /**
   * n01's own figures per entry (`stats_list`, manual: チーム/プレーヤー単位の集計). In an
   * individual event (`team_games` 0) an entry is a player (or a pair written as one entry),
   * and this is where its figures are — `player_stats_list` is for team events only.
   */
  entryStats(tournamentId: string): Promise<TeamStatsRow[]> {
    return this.read('tournament/stats', this.memoised('tournament/stats', { tdid: tournamentId, kind: 'stats_list' }), parseTeamStats);
  }

  /** Every member of every team of a season (names for the stats rows). */
  roster(tournamentId: string): Promise<N01RosterPlayer[]> {
    return this.read('team/player/list', this.memoised('team/player/list', { tdid: tournamentId }), (raw) => parseRoster(raw, ''));
  }

  /** Tournaments by title keyword (any status, newest first). */
  searchCompetitions(keyword: string): Promise<CompetitionSummary[]> {
    return this.read('tournament/list', this.fresh('tournament/list', { keyword, count: '40', fields: 'tdid,title,status,lgid,t_date' }), parseCompetitionList);
  }

  /** A competition's document (entries, titles, kind) — any tournament, league event or not. */
  competition(tdid: string): Promise<CompetitionDoc> {
    return this.read('tournament/get', this.memoised('tournament/get', { tdid }), (raw) => parseCompetition(raw, tdid));
  }

  /** The competition document read again (a polling read): its status may have moved on. */
  competitionNow(tdid: string, signal?: AbortSignal): Promise<CompetitionDoc> {
    return this.read('tournament/get', this.fresh('tournament/get', { tdid }, signal), (raw) => parseCompetition(raw, tdid));
  }

  /**
   * Every game of a competition (all kinds), oldest first; `live` = in progress only, never
   * memoised.
   *
   * Pages are kept per instance and re-read when they can have changed: a page holding a game
   * in progress, the last (short) page — new games are appended there — and any page older than
   * {@link COMPETITION_PAGE_TTL_MS} (a corrected or deleted game). A full, all-finished, recent
   * page is reused, so a 500-game event costs one or two requests per refresh, not five.
   */
  async competitionGames(tdid: string, options: { live?: boolean; signal?: AbortSignal } = {}): Promise<GameList> {
    const byMid = new Map<string, GameRow>();
    let unreadable = 0;
    let unsure = false;
    let previous: GameRow[] = [];
    for (let page = 0; page < MATCH_ROWS_MAX_PAGES; page += 1) {
      const params: Record<string, string> = { tdid, sort: 'startTime', order: 'asc', count: String(MATCH_ROWS_PAGE), fields: GAME_FIELDS };
      if (options.live) {
        params.live = '1';
        params.endMatch = '0';
      }
      if (page > 0) params.skip = String(page * MATCH_ROWS_PAGE);
      const key = this.key('match/list', params);
      const held = options.live ? undefined : this.pages.get(key);
      const reusable =
        held && held.page.rows === MATCH_ROWS_PAGE && held.page.unreadable === 0 && held.page.games.every((game) => game.finished) && this.now() - held.at < COMPETITION_PAGE_TTL_MS;
      let result: RowsPage;
      if (reusable) result = held.page;
      else {
        result = await this.read('match/list', this.fresh('match/list', params, options.signal), parseGameRows);
        if (!options.live) this.pages.set(key, { at: this.now(), page: result });
      }
      if (page > 0 && tiedAtBoundary(previous, result.games)) unsure = true;
      previous = result.games;
      unreadable += result.unreadable;
      for (const game of result.games) byMid.set(game.mid, game);
      if (result.rows < MATCH_ROWS_PAGE) return { games: [...byMid.values()], truncated: false, unreadable, unsure };
    }
    return { games: [...byMid.values()], truncated: true, unreadable, unsure };
  }

  /** Games in progress anywhere on n01 (competitions and n01 Online / Live), newest started first. */
  async nowLive(signal?: AbortSignal): Promise<GameRow[]> {
    // Sorting the whole of n01 by updateTime is refused as too slow (-54); the default order is start time, newest first.
    const params = { live: '1', endMatch: '0', count: String(MATCH_ROWS_PAGE), fields: GAME_FIELDS };
    return (await this.read('match/list', this.fresh('match/list', params, signal), parseGameRows)).games;
  }

  /** One game's row (names, legs) by its id. */
  async game(mid: string): Promise<GameRow | null> {
    const archived = await this.read('match/list', this.fresh('match/list', { mid, fields: GAME_FIELDS }), parseGameRows);
    if (archived.games[0]) return archived.games[0];
    // A game outside any competition reaches the archive only after it ends (checked 2026-11-06).
    const live = await this.read('match/list', this.fresh('match/list', { mid, live: '1', fields: GAME_FIELDS }), parseGameRows);
    return live.games[0] ?? null;
  }

  /** League divisions and round-robin groups (n01's own table); none for brackets. */
  allStandings(tdid: string): Promise<StandingGroup[]> {
    return this.read('tournament/standings', this.memoised('tournament/standings', { tdid }), parseAllStandings);
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
