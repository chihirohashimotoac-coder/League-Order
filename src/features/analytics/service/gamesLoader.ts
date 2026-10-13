import { describeN01Error, N01Error } from '../../../integrations/n01/client';
import { N01_STATUS } from '../../../integrations/n01/types';
import type { RawGame } from '../api/parse';
import type { AnalyticsApi } from '../api/readApi';
import { GAME_LIST_PAGE, RequestBudgetError } from '../api/readApi';
import type { AnalyticsCache } from '../cache/analyticsCache';
import { TTL } from '../cache/analyticsCache';
import { isLeagueGame } from '../roleGames';
import type { SeasonGames } from '../roleGames';
import type { GamesSource } from '../projection';
import type { DataSource } from './seasonLoader';

/**
 * Played games of the seasons a view needs (`match/list`, paged), loaded only when a view
 * asks for them: "01全体" of an all-01 season never needs them, a game-kind view does.
 *
 * Same contract as the season loader: fresh cache → network → stale cache → failure, never
 * throws, a request budget of its own, cancellable, and a list that could not be read to the
 * end is marked incomplete rather than passed off as the whole season.
 */

export interface GamesContext {
  api: AnalyticsApi;
  cache: AnalyticsCache;
  isOnline: () => boolean;
  now: () => number;
  forceRefresh?: boolean;
  signal?: AbortSignal;
}

export const gamesKey = (tournamentId: string): string => `games:${tournamentId}`;

/** Pages read per season at most (1,500 games): a runaway list stops here and says so. */
export const MAX_GAME_PAGES = 15;
/** Budget of one games load: 12 seasons × ~6 pages in a real league, with headroom. */
export const GAMES_MAX_REQUESTS = 100;

export type GamesResult =
  | { ok: true; games: SeasonGames; source: DataSource; fetchedAt: number }
  | { ok: false; tournamentId: string; reason: string; kind: 'offline' | 'budget' | 'network' | 'schema' | 'aborted' };

/** Drops what the cache does not need (names come from the season's stats rows). */
function compact(game: RawGame): RawGame {
  return {
    ...game,
    startTime: null,
    sides: game.sides.map((side) => ({ ...side, players: side.players.map((p) => ({ oid: p.oid, opid: p.opid, name: null })) })) as RawGame['sides'],
  };
}

function failureKind(error: unknown): 'budget' | 'network' | 'schema' | 'aborted' {
  if (error instanceof RequestBudgetError) return 'budget';
  if (error instanceof N01Error && (error.kind === 'aborted' || error.kind === 'schema')) return error.kind;
  return 'network';
}

export async function loadSeasonGames(ctx: GamesContext, tournamentId: string, status: number | null): Promise<GamesResult> {
  const key = gamesKey(tournamentId);
  const cached = await ctx.cache.get<SeasonGames>(key);
  if (cached && ctx.cache.isFresh(cached) && !ctx.forceRefresh) return { ok: true, games: cached.value, source: 'cache', fetchedAt: cached.fetchedAt };
  if (!ctx.isOnline()) {
    if (cached) return { ok: true, games: cached.value, source: 'stale-cache', fetchedAt: cached.fetchedAt };
    return { ok: false, tournamentId, kind: 'offline', reason: 'オフラインで、保存済みのゲーム別データもありません。' };
  }
  const seen = new Map<string, RawGame>();
  const dropped = { unfinished: 0, unreadable: 0, nonLeague: 0 };
  let complete = false;
  try {
    for (let page = 0; page < MAX_GAME_PAGES; page += 1) {
      if (ctx.signal?.aborted) throw new N01Error('aborted', '中断しました。', 'match/list');
      const result = await ctx.api.gamesPage(tournamentId, page);
      dropped.unreadable += result.unreadable;
      for (const game of result.games) {
        if (!isLeagueGame(game.matchId)) dropped.nonLeague += 1;
        else if (!game.finished) dropped.unfinished += 1;
        else seen.set(game.gameId, compact(game));
      }
      if (result.rows < GAME_LIST_PAGE) {
        // The last page was reached. A row n01 sent that could not be read is a game we cannot
        // account for: the list is then not the whole season, however short the last page was.
        complete = dropped.unreadable === 0;
        break;
      }
    }
  } catch (error) {
    if (cached) return { ok: true, games: cached.value, source: 'stale-cache', fetchedAt: cached.fetchedAt };
    return { ok: false, tournamentId, kind: failureKind(error), reason: error instanceof RequestBudgetError ? error.message : describeN01Error(error) };
  }
  const games: SeasonGames = { tournamentId, games: [...seen.values()], dropped, complete };
  const ttl = status === N01_STATUS.FINISHED ? TTL.finishedSeason : TTL.runningSeason;
  // An incomplete list keeps the rows that were read (nothing correct is thrown away), but only
  // briefly, so the next visit retries it; projection never uses it as the season.
  await ctx.cache.put(key, games, complete ? ttl : Math.min(ttl, 10 * 60 * 1000));
  return { ok: true, games, source: 'network', fetchedAt: ctx.now() };
}

export interface GamesLoad extends GamesSource {
  failures: { tournamentId: string; reason: string; kind: string }[];
  usedStaleCache: boolean;
  requestsSent: number;
}

/** Loads the listed seasons' games, two seasons at a time (each is a sequence of pages). */
export async function loadGames(ctx: GamesContext, seasons: readonly { tournamentId: string; status: number | null }[], concurrency = 2): Promise<GamesLoad> {
  const games = new Map<string, SeasonGames>();
  const failed = new Set<string>();
  const failures: GamesLoad['failures'] = [];
  let usedStaleCache = false;
  let stop = false;
  for (let i = 0; i < seasons.length && !stop; i += concurrency) {
    const batch = seasons.slice(i, i + concurrency);
    const results = await Promise.all(batch.map((s) => loadSeasonGames(ctx, s.tournamentId, s.status)));
    for (const result of results) {
      if (result.ok) {
        games.set(result.games.tournamentId, result.games);
        if (result.source === 'stale-cache') usedStaleCache = true;
      } else {
        failed.add(result.tournamentId);
        failures.push({ tournamentId: result.tournamentId, reason: result.reason, kind: result.kind });
        if (result.kind === 'budget' || result.kind === 'aborted') stop = true;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  // Seasons never attempted because the load stopped are failures too: their figures are missing.
  for (const s of seasons) {
    if (!games.has(s.tournamentId) && !failed.has(s.tournamentId)) {
      failed.add(s.tournamentId);
      failures.push({ tournamentId: s.tournamentId, reason: '通信の上限または中断のため未取得', kind: 'budget' });
    }
  }
  return { games, failed, failures, usedStaleCache, requestsSent: ctx.api.requestCount };
}
