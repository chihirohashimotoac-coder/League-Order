import { describeN01Error, N01Error } from '../../../integrations/n01/client';
import { N01_STATUS } from '../../../integrations/n01/types';
import type { RawGame } from '../api/parse';
import type { AnalyticsApi } from '../api/readApi';
import { GAME_LIST_PAGE, RequestBudgetError } from '../api/readApi';
import type { AnalyticsCache } from '../cache/analyticsCache';
import { TTL } from '../cache/analyticsCache';
import { isLeagueGame } from '../roleGames';
import type { SeasonGames } from '../roleGames';
import type { DataSource } from './seasonLoader';
import { withRetry } from './retry';
import type { Sleep } from './retry';

/**
 * Played games of one season (`match/list`), read page after page and **resumable**.
 *
 * A season's list can be longer than one adapter's request budget (TDO 2026/3rd: 1,665 games, 17
 * requests), and a load can be cut off (budget, network, the screen left). So every page read is
 * kept as a checkpoint (`games-wip:<tdid>`), and the next load continues from it instead of
 * starting again; the finished list replaces the season's entry (`games:<tdid>`) only once it was
 * read to the end. An incomplete list is never passed off as the season.
 *
 * Page boundaries: each request after the first starts at the **last row already read** (one row
 * of overlap). That row must come back first; otherwise the list moved under us (a game deleted
 * or inserted before the boundary, or rows with the same start time reordered), and old and new
 * rows are not mixed: the season is read again from its first row once, and if it moves again it
 * is set aside with the reason. A row seen twice is treated the same way. Ids are deduplicated.
 * The last page is the first one shorter than {@link GAME_LIST_PAGE} rows, so a list of exactly
 * 100·n rows is confirmed by one more request.
 */

export interface GamesContext {
  api: AnalyticsApi;
  cache: AnalyticsCache;
  isOnline: () => boolean;
  now: () => number;
  /** Ignore every cached list and checkpoint (one-off loads and tests). */
  forceRefresh?: boolean;
  /**
   * Only lists and checkpoints read at or after this time count (the page's refresh): a load split
   * over several adapters keeps what the earlier parts of the same refresh read.
   */
  freshAfter?: number;
  signal?: AbortSignal;
  sleep?: Sleep;
  /** Safety limit override (tests); never above {@link MAX_SEASON_ROWS}. */
  maxRows?: number;
}

export const gamesKey = (tournamentId: string): string => `games:${tournamentId}`;
export const gamesProgressKey = (tournamentId: string): string => `games-wip:${tournamentId}`;

/** Requests of one work unit of game lists. A load needing more continues in further units. */
export const GAMES_UNIT_REQUESTS = 100;
/** Safety limit of one season's list (500 requests), far above any league seen: beyond it the season is set aside. */
export const MAX_SEASON_ROWS = 50_000;
/** Times a season is read again from its first row after its page boundary moved, before it is set aside. */
export const MAX_BOUNDARY_RESTARTS = 1;

export const BOUNDARY_REASON = 'ゲーム一覧の取得中にページの境界で並びが変わりました（試合の更新・削除、または同時刻の並び替え）。古い続きと新しい一覧を混ぜないよう、この季は保留しています（「再試行」で最初から取り直します）';
const RUNAWAY_REASON = `ゲーム一覧が安全上の上限（${MAX_SEASON_ROWS.toLocaleString('ja-JP')}件）を超えたため、この季は保留しています`;

export interface GamesProgress {
  /** Rows of the list read so far (finished or not). */
  rows: number;
  /** Requests answered for this season so far (all parts of the load). */
  pages: number;
}

export type GamesFailureKind = 'offline' | 'budget' | 'network' | 'schema' | 'aborted';

export type GamesResult =
  | { ok: true; games: SeasonGames; source: DataSource; fetchedAt: number; pages: number }
  | {
      ok: false;
      tournamentId: string;
      reason: string;
      kind: GamesFailureKind;
      /** The checkpoint survives: a later load continues from it. */
      progress: GamesProgress | null;
      /** An older complete list (expired) that may be shown meanwhile. */
      stale: SeasonGames | null;
      pages: number;
    };

interface Checkpoint {
  v: 3;
  tournamentId: string;
  /** When the first row was read: a refresh asked after this invalidates the checkpoint. */
  startedAt: number;
  /** Ids of the rows read so far, in list order (`null`: a row without an id). */
  ids: (string | null)[];
  games: RawGame[];
  dropped: SeasonGames['dropped'];
  pages: number;
  restarts: number;
}

/** Drops what the cache does not need (names come from the season's stats rows). */
function compact(game: RawGame): RawGame {
  return {
    ...game,
    startTime: null,
    sides: game.sides.map((side) => ({ ...side, players: side.players.map((p) => ({ oid: p.oid, opid: p.opid, name: null })) })) as RawGame['sides'],
  };
}

function failureKind(error: unknown): GamesFailureKind {
  if (error instanceof RequestBudgetError) return 'budget';
  if (error instanceof N01Error && (error.kind === 'aborted' || error.kind === 'schema')) return error.kind;
  return 'network';
}

function fresh(tournamentId: string, startedAt: number, restarts: number): Checkpoint {
  return { v: 3, tournamentId, startedAt, ids: [], games: [], dropped: { unfinished: 0, unreadable: 0, nonLeague: 0 }, pages: 0, restarts };
}

const ttlOf = (status: number | null): number => (status === N01_STATUS.FINISHED ? TTL.finishedSeason : TTL.runningSeason);

export async function loadSeasonGames(ctx: GamesContext, tournamentId: string, status: number | null, onProgress?: (progress: GamesProgress) => void): Promise<GamesResult> {
  const key = gamesKey(tournamentId);
  const wipKey = gamesProgressKey(tournamentId);
  const freshAfter = ctx.forceRefresh ? Number.POSITIVE_INFINITY : (ctx.freshAfter ?? 0);
  const cached = await ctx.cache.get<SeasonGames>(key);
  if (cached && ctx.cache.isFresh(cached) && cached.fetchedAt >= freshAfter) return { ok: true, games: cached.value, source: 'cache', fetchedAt: cached.fetchedAt, pages: 0 };
  // Only a list read to the end can stand in for the season while it is being read again.
  const stale = cached?.value.complete ? cached.value : null;
  const stored = await ctx.cache.get<Checkpoint>(wipKey);
  const resumable = stored && stored.value?.v === 3 && stored.value.tournamentId === tournamentId && ctx.cache.isFresh(stored) && stored.value.startedAt >= freshAfter ? stored.value : null;
  if (!ctx.isOnline()) {
    if (stale) return { ok: true, games: stale, source: 'stale-cache', fetchedAt: cached!.fetchedAt, pages: 0 };
    return { ok: false, tournamentId, kind: 'offline', reason: 'オフラインで、保存済みのゲーム別データもありません。', progress: resumable ? { rows: resumable.ids.length, pages: resumable.pages } : null, stale: null, pages: 0 };
  }
  const ttl = ttlOf(status);
  let state: Checkpoint = resumable ? { ...resumable, ids: [...resumable.ids], games: [...resumable.games], dropped: { ...resumable.dropped } } : fresh(tournamentId, ctx.now(), 0);
  let pages = 0;
  let seen = new Set(state.ids.filter((id): id is string => id !== null));
  const save = async (): Promise<void> => {
    if (state.ids.length > 0) await ctx.cache.put(wipKey, state, ttl);
  };
  const progress = (): GamesProgress => ({ rows: state.ids.length, pages: state.pages });

  for (;;) {
    if (state.ids.length >= Math.min(MAX_SEASON_ROWS, ctx.maxRows ?? MAX_SEASON_ROWS)) {
      await ctx.cache.delete(wipKey);
      return { ok: true, games: { tournamentId, games: state.games, dropped: state.dropped, complete: false, heldReason: RUNAWAY_REASON }, source: 'network', fetchedAt: ctx.now(), pages };
    }
    if (ctx.signal?.aborted) {
      await save();
      return { ok: false, tournamentId, kind: 'aborted', reason: '中断しました。', progress: progress(), stale, pages };
    }
    const consumed = state.ids.length;
    let page: Awaited<ReturnType<AnalyticsApi['gamesAt']>>;
    try {
      page = await withRetry(ctx, () => ctx.api.gamesAt(tournamentId, consumed === 0 ? 0 : consumed - 1, state.restarts > 0));
    } catch (error) {
      await save();
      const kind = failureKind(error);
      if (kind !== 'budget' && kind !== 'aborted' && stale) {
        // A list read to the end earlier is better than none; the checkpoint is kept for the next load.
        return { ok: true, games: stale, source: 'stale-cache', fetchedAt: cached!.fetchedAt, pages };
      }
      return { ok: false, tournamentId, kind, reason: error instanceof RequestBudgetError ? error.message : describeN01Error(error), progress: progress(), stale, pages };
    }
    pages += 1;
    state.pages += 1;

    // The overlap row must be the last row already read, and no row may come back twice.
    const overlap = consumed > 0;
    const added = overlap ? page.ids.slice(1) : page.ids;
    const moved =
      (overlap && (page.rows === 0 || page.ids[0] !== state.ids[consumed - 1])) ||
      added.some((id, i) => id !== null && (seen.has(id) || added.indexOf(id) !== i));
    if (moved) {
      await ctx.cache.delete(wipKey);
      if (state.restarts < MAX_BOUNDARY_RESTARTS) {
        state = fresh(tournamentId, ctx.now(), state.restarts + 1);
        seen = new Set();
        continue;
      }
      return { ok: true, games: { tournamentId, games: [], dropped: { unfinished: 0, unreadable: 0, nonLeague: 0 }, complete: false, heldReason: BOUNDARY_REASON }, source: 'network', fetchedAt: ctx.now(), pages };
    }

    const overlapId = overlap ? page.ids[0] : undefined;
    const overlapUnreadable = overlap && !page.games.some((g) => g.gameId === overlapId);
    state.ids.push(...added);
    for (const id of added) if (id !== null) seen.add(id);
    state.dropped.unreadable += page.unreadable - (overlapUnreadable ? 1 : 0);
    for (const game of page.games) {
      if (overlap && game.gameId === overlapId) continue;
      if (!isLeagueGame(game.matchId)) state.dropped.nonLeague += 1;
      else if (!game.finished) state.dropped.unfinished += 1;
      else state.games.push(compact(game));
    }
    onProgress?.(progress());

    if (page.rows < GAME_LIST_PAGE) {
      // The last page was reached. A row n01 sent that could not be read is a game we cannot
      // account for: the list is then not the whole season, however short the last page was.
      const complete = state.dropped.unreadable === 0;
      const games: SeasonGames = { tournamentId, games: state.games, dropped: state.dropped, complete };
      // An incomplete list keeps the rows that were read (nothing correct is thrown away), but only
      // briefly, so the next visit retries it; projection never uses it as the season.
      await ctx.cache.put(key, games, complete ? ttl : Math.min(ttl, 10 * 60 * 1000));
      await ctx.cache.delete(wipKey);
      return { ok: true, games, source: 'network', fetchedAt: ctx.now(), pages };
    }
    await save();
  }
}
