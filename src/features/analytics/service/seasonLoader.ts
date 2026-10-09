import { describeN01Error, N01Error } from '../../../integrations/n01/client';
import type { N01LeagueTournaments, N01RosterPlayer, N01Tournament } from '../../../integrations/n01/types';
import { N01_STATUS } from '../../../integrations/n01/types';
import type { AnalyticsApi } from '../api/readApi';
import { RequestBudgetError } from '../api/readApi';
import type { AnalyticsCache, CacheEntry } from '../cache/analyticsCache';
import { TTL } from '../cache/analyticsCache';
import type { SeasonInput } from '../seasonData';
import type { OfficialStandingGroup, PlayerStatsRow, TeamStatsRow } from '../types';

/**
 * One season's raw data, fetched or read from the analytics cache (design §6).
 *
 * Required parts (tournament, team stats, player stats) decide success. Optional parts
 * (official standings, the whole roster) may fail: the season is then *partial* and says
 * which part is missing, so the UI can withhold official ranks or season-to-season linking
 * instead of pretending.
 */

/** JSON-safe form of a season's raw data (the tournament's `lg_result` map is not needed here). */
export interface CachedSeason {
  tournament: Omit<N01Tournament, 'results'>;
  teamStats: TeamStatsRow[];
  playerStats: PlayerStatsRow[];
  standings: OfficialStandingGroup[] | null;
  roster: N01RosterPlayer[] | null;
}

export type DataSource = 'network' | 'cache' | 'stale-cache';

export interface SeasonLoaded {
  ok: true;
  tournamentId: string;
  input: SeasonInput;
  source: DataSource;
  fetchedAt: number;
  /** Optional parts that could not be read. */
  missing: ('standings' | 'roster')[];
  /** Set when stale cache was used because the network failed or the device is offline. */
  error?: string;
}

export interface SeasonFailed {
  ok: false;
  tournamentId: string;
  reason: string;
  kind: 'offline' | 'budget' | 'network' | 'schema' | 'aborted';
}

export type SeasonResult = SeasonLoaded | SeasonFailed;

export interface LoaderContext {
  api: AnalyticsApi;
  cache: AnalyticsCache;
  isOnline: () => boolean;
  now: () => number;
  forceRefresh?: boolean;
}

export const seasonKey = (tournamentId: string): string => `season:${tournamentId}`;
export const leagueKey = (leagueId: string): string => `league:${leagueId}`;

export function toCached(input: SeasonInput, missing: readonly string[]): CachedSeason {
  const { results: _results, ...tournament } = input.tournament;
  void _results;
  return {
    tournament,
    teamStats: [...input.teamStats],
    playerStats: [...input.playerStats],
    standings: missing.includes('standings') ? null : [...input.standings],
    roster: input.roster ? [...input.roster] : null,
  };
}

export function fromCached(cached: CachedSeason): { input: SeasonInput; missing: ('standings' | 'roster')[] } {
  const missing: ('standings' | 'roster')[] = [];
  if (cached.standings === null) missing.push('standings');
  if (cached.roster === null) missing.push('roster');
  return {
    input: {
      tournament: { ...cached.tournament, results: new Map() },
      teamStats: cached.teamStats,
      playerStats: cached.playerStats,
      standings: cached.standings ?? [],
      roster: cached.roster,
    },
    missing,
  };
}

function classifyError(error: unknown): SeasonFailed['kind'] {
  if (error instanceof RequestBudgetError) return 'budget';
  if (error instanceof N01Error) {
    if (error.kind === 'aborted') return 'aborted';
    if (error.kind === 'schema') return 'schema';
  }
  return 'network';
}

function describeError(error: unknown): string {
  return error instanceof RequestBudgetError ? error.message : describeN01Error(error);
}

function fromEntry(tournamentId: string, entry: CacheEntry<CachedSeason>, source: DataSource, error?: string): SeasonLoaded {
  const { input, missing } = fromCached(entry.value);
  return { ok: true, tournamentId, input, source, fetchedAt: entry.fetchedAt, missing, ...(error ? { error } : {}) };
}

/** Loads one season: fresh cache → network → stale cache → failure. Never throws. */
export async function loadSeason(ctx: LoaderContext, tournamentId: string): Promise<SeasonResult> {
  const key = seasonKey(tournamentId);
  const cached = await ctx.cache.get<CachedSeason>(key);
  if (cached && ctx.cache.isFresh(cached) && !ctx.forceRefresh) return fromEntry(tournamentId, cached, 'cache');

  if (!ctx.isOnline()) {
    if (cached) return fromEntry(tournamentId, cached, 'stale-cache', 'オフラインのため保存済みのデータを表示しています。');
    return { ok: false, tournamentId, kind: 'offline', reason: 'オフラインで、保存済みの分析データもありません。' };
  }

  try {
    const tournament = await ctx.api.tournament(tournamentId);
    const [teamStats, playerStats] = await Promise.all([ctx.api.teamStats(tournamentId), ctx.api.playerStats(tournamentId)]);
    const missing: ('standings' | 'roster')[] = [];
    let standings: OfficialStandingGroup[] = [];
    let roster: N01RosterPlayer[] | null = null;
    try {
      standings = await ctx.api.standings(tournamentId);
    } catch (error) {
      if (error instanceof N01Error && error.kind === 'aborted') throw error;
      missing.push('standings');
    }
    try {
      roster = await ctx.api.fullRoster(tournamentId);
    } catch (error) {
      if (error instanceof N01Error && error.kind === 'aborted') throw error;
      missing.push('roster');
    }
    const input: SeasonInput = { tournament, teamStats, playerStats, standings, roster };
    const ttl = tournament.status === N01_STATUS.FINISHED ? TTL.finishedSeason : TTL.runningSeason;
    // A partial season is kept briefly only: the missing part should be retried soon.
    await ctx.cache.put(key, toCached(input, missing), missing.length > 0 ? Math.min(ttl, 10 * 60 * 1000) : ttl);
    return { ok: true, tournamentId, input, source: 'network', fetchedAt: ctx.now(), missing };
  } catch (error) {
    if (cached) return fromEntry(tournamentId, cached, 'stale-cache', `${describeError(error)} 保存済みのデータを表示しています。`);
    return { ok: false, tournamentId, kind: classifyError(error), reason: describeError(error) };
  }
}

export interface LeagueListResult {
  ok: boolean;
  list: N01LeagueTournaments | null;
  source: DataSource | null;
  fetchedAt: number | null;
  reason?: string;
  kind?: SeasonFailed['kind'];
}

/** The league's tournament list, with the same cache → network → stale fallback. */
export async function loadLeagueList(ctx: LoaderContext, leagueId: string): Promise<LeagueListResult> {
  const key = leagueKey(leagueId);
  const cached = await ctx.cache.get<N01LeagueTournaments>(key);
  if (cached && ctx.cache.isFresh(cached) && !ctx.forceRefresh) {
    return { ok: true, list: cached.value, source: 'cache', fetchedAt: cached.fetchedAt };
  }
  if (!ctx.isOnline()) {
    if (cached) return { ok: true, list: cached.value, source: 'stale-cache', fetchedAt: cached.fetchedAt };
    return { ok: false, list: null, source: null, fetchedAt: null, kind: 'offline', reason: 'オフラインで、保存済みのシーズン一覧もありません。' };
  }
  try {
    const list = await ctx.api.leagueTournaments(leagueId);
    await ctx.cache.put(key, list, TTL.leagueList);
    return { ok: true, list, source: 'network', fetchedAt: ctx.now() };
  } catch (error) {
    if (cached) return { ok: true, list: cached.value, source: 'stale-cache', fetchedAt: cached.fetchedAt, reason: describeError(error) };
    return { ok: false, list: null, source: null, fetchedAt: null, kind: classifyError(error), reason: describeError(error) };
  }
}
