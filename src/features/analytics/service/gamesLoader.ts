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
 * Played games of one season (`match/list`), read to the end across request budgets.
 *
 * **One reading, in memory.** A season's list can be longer than one adapter's budget (TDO
 * 2026/3rd: 1,665 games, 17 requests). When the budget runs out the reading asks for another unit
 * (`nextApi`) and goes on from the row it reached, in memory: nothing it read is dropped, and a
 * failed write to the browser's storage cannot make it start again. The finished list replaces
 * the season's entry (`games:<tdid>`) only once it was read to the end; an incomplete list is
 * never passed off as the season.
 *
 * **Resuming a reading that stopped** (the budget of the screen ran out, a failure, the screen
 * left, the page closed). The rows read before the stop may have changed since: a score
 * corrected under the same id, a game deleted and another added (the page boundary unchanged),
 * a game finished. n01 offers no way to prove they did not — `match/list` filters on neither
 * `updateTime` nor deletions (n01 API manual: `updateTime` is a sort/return field only, deleted
 * matches are not returned). So those rows are **read again and compared** (`games-wip:<tdid>`
 * keeps their ids and a fingerprint of the counted content), never reused: what is published was
 * all read in the reading that published it, and what changed is reported (`recollated`).
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
  /**
   * Another unit (a fresh adapter and budget) when this one's budget runs out; `null`: none left —
   * the reading stops (resumable: its ids are kept for the comparison of the next one).
   */
  nextApi?: () => Promise<AnalyticsApi | null>;
  cache: AnalyticsCache;
  isOnline: () => boolean;
  now: () => number;
  /** Ignore every cached list and checkpoint (one-off loads and tests). */
  forceRefresh?: boolean;
  /** Only lists and checkpoints read at or after this time count (the page's refresh). */
  freshAfter?: number;
  signal?: AbortSignal;
  sleep?: Sleep;
  /** Safety limit override (tests); never above {@link MAX_SEASON_ROWS}. */
  maxRows?: number;
  /**
   * Lists read to the end during the open screen, kept in memory: consulted before the browser's
   * storage, so a list the storage refused is not read again when another period shows its season.
   */
  memory?: GamesMemory;
}

export type GamesMemory = Map<string, { value: SeasonGames; at: number }>;

export const gamesKey = (tournamentId: string): string => `games:${tournamentId}`;
export const gamesProgressKey = (tournamentId: string): string => `games-wip:${tournamentId}`;

/** Requests of one work unit of game lists. A reading needing more continues in further units. */
export const GAMES_UNIT_REQUESTS = 100;
/** Safety limit of one season's list (500 requests), far above any league seen: beyond it the season is set aside. */
export const MAX_SEASON_ROWS = 50_000;
/** Times a season is read again from its first row after its page boundary moved, before it is set aside. */
export const MAX_BOUNDARY_RESTARTS = 1;
/**
 * How long the record of a stopped reading of a running season is kept for the comparison
 * (a finished season: as long as its list). Older records are dropped: the season is simply read.
 */
export const RUNNING_CHECKPOINT_MS = 30 * 60 * 1000;

export const BOUNDARY_REASON = 'ゲーム一覧の取得中にページの境界で並びが変わりました（試合の更新・削除、または同時刻の並び替え）。古い続きと新しい一覧を混ぜないよう、この季は保留しています（「再試行」で最初から取り直します）';
const RUNAWAY_REASON = `ゲーム一覧が安全上の上限（${MAX_SEASON_ROWS.toLocaleString('ja-JP')}件）を超えたため、この季は保留しています`;

export interface GamesProgress {
  /** Rows of the list read so far in this reading (finished or not). */
  rows: number;
  /** Requests answered for this season so far. */
  pages: number;
}

export type GamesFailureKind = 'offline' | 'budget' | 'network' | 'schema' | 'aborted';

export type GamesResult =
  | { ok: true; games: SeasonGames; source: DataSource; fetchedAt: number; pages: number; saveFailed?: boolean }
  | {
      ok: false;
      tournamentId: string;
      reason: string;
      kind: GamesFailureKind;
      /** How far this reading got (its rows are compared, not reused, by the next one). */
      progress: GamesProgress | null;
      /** An older complete list (expired) that may be shown meanwhile. */
      stale: SeasonGames | null;
      pages: number;
      saveFailed?: boolean;
    };

/** The record of a stopped reading: what it saw, for the comparison of the next reading. */
interface Checkpoint {
  v: 5;
  tournamentId: string;
  /** When the first row was read: a refresh asked after this drops the record. */
  startedAt: number;
  /** Ids of the rows read, in list order (`null`: a row without an id). */
  ids: (string | null)[];
  /** {@link fingerprint} of each row (`null`: unreadable). */
  prints: (string | null)[];
  pages: number;
}

/** Drops what the cache does not need (names come from the season's stats rows). */
function compact(game: RawGame): RawGame {
  return {
    ...game,
    startTime: null,
    sides: game.sides.map((side) => ({ ...side, players: side.players.map((p) => ({ oid: p.oid, opid: p.opid, name: null })) })) as RawGame['sides'],
  };
}

/** FNV-1a (32 bit) of a string, as 8 hex digits. */
function fnv(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/**
 * A row's counted content: its slot and kind, whether it is finished, its start time, and per
 * side the team, the throwing order, legs, score and darts. A correction to any of them changes it.
 */
export function fingerprint(game: RawGame): string {
  return fnv(
    JSON.stringify([
      game.gameId,
      game.matchId,
      game.schid,
      game.matchType,
      game.finished,
      game.startTime,
      game.sides.map((s) => [s.teamId, s.players.map((p) => [p.oid, p.opid]), s.legsWon, s.score, s.darts]),
    ]),
  );
}

const versions = new WeakMap<SeasonGames, string>();

/**
 * Identifies a season's list **content** (the same season id read again after a correction gets
 * another version), so figures checked against one list are never shown with another.
 */
export function gamesVersion(raw: SeasonGames): string {
  if (raw.version) return raw.version;
  let v = versions.get(raw);
  if (!v) {
    v = fnv(JSON.stringify([raw.games.map((g) => fingerprint(g)), raw.dropped, raw.complete]));
    versions.set(raw, v);
  }
  return v;
}

function failureKind(error: unknown): GamesFailureKind {
  if (error instanceof RequestBudgetError) return 'budget';
  if (error instanceof N01Error && (error.kind === 'aborted' || error.kind === 'schema')) return error.kind;
  return 'network';
}

const ttlOf = (status: number | null): number => (status === N01_STATUS.FINISHED ? TTL.finishedSeason : TTL.runningSeason);

/** What the earlier, stopped reading saw that this one did not see the same way. */
function compare(prior: Checkpoint, ids: readonly (string | null)[], prints: readonly (string | null)[]): NonNullable<SeasonGames['recollated']> {
  const now = new Map<string, { at: number; print: string | null }>();
  ids.forEach((id, at) => id !== null && now.set(id, { at, print: prints[at] }));
  let corrected = 0;
  let removed = 0;
  let reach = -1;
  prior.ids.forEach((id, i) => {
    if (id === null) return;
    const hit = now.get(id);
    if (!hit) {
      removed += 1;
      return;
    }
    reach = Math.max(reach, hit.at);
    if (hit.print !== prior.prints[i]) corrected += 1;
  });
  const before = new Set(prior.ids);
  const added = ids.slice(0, reach + 1).filter((id) => id !== null && !before.has(id)).length;
  return { rows: prior.ids.length, corrected, removed, added };
}

export async function loadSeasonGames(ctx: GamesContext, tournamentId: string, status: number | null, onProgress?: (progress: GamesProgress) => void): Promise<GamesResult> {
  const key = gamesKey(tournamentId);
  const wipKey = gamesProgressKey(tournamentId);
  const freshAfter = ctx.forceRefresh ? Number.POSITIVE_INFINITY : (ctx.freshAfter ?? 0);
  const ttl = ttlOf(status);
  const kept = ctx.memory?.get(tournamentId);
  if (kept && kept.at >= freshAfter && ctx.now() - kept.at < ttl) return { ok: true, games: kept.value, source: 'cache', fetchedAt: kept.at, pages: 0 };
  const cached = await ctx.cache.get<SeasonGames>(key);
  if (cached && ctx.cache.isFresh(cached) && cached.fetchedAt >= freshAfter) return { ok: true, games: cached.value, source: 'cache', fetchedAt: cached.fetchedAt, pages: 0 };
  // Only a list read to the end can stand in for the season while it is being read again.
  const stale = cached?.value.complete ? cached.value : null;
  const stored = await ctx.cache.get<Checkpoint>(wipKey);
  const prior =
    stored && stored.value?.v === 5 && stored.value.tournamentId === tournamentId && ctx.cache.isFresh(stored) && stored.value.startedAt >= freshAfter && (status === N01_STATUS.FINISHED || ctx.now() - stored.value.startedAt < RUNNING_CHECKPOINT_MS)
      ? stored.value
      : null;
  if (!ctx.isOnline()) {
    if (stale) return { ok: true, games: stale, source: 'stale-cache', fetchedAt: cached!.fetchedAt, pages: 0 };
    return { ok: false, tournamentId, kind: 'offline', reason: 'オフラインで、保存済みのゲーム別データもありません。', progress: prior ? { rows: prior.ids.length, pages: prior.pages } : null, stale: null, pages: 0 };
  }
  let api = ctx.api;
  let restarts = 0;
  let startedAt = ctx.now();
  let ids: (string | null)[] = [];
  let prints: (string | null)[] = [];
  let games: RawGame[] = [];
  let dropped: SeasonGames['dropped'] = { unfinished: 0, unreadable: 0, nonLeague: 0 };
  let seen = new Set<string>();
  let pages = 0;
  let saveFailed = false;
  const progress = (): GamesProgress => ({ rows: ids.length, pages });
  const save = async (): Promise<void> => {
    if (ids.length === 0) return;
    const record: Checkpoint = { v: 5, tournamentId, startedAt, ids, prints, pages };
    if (!(await ctx.cache.put(wipKey, record, status === N01_STATUS.FINISHED ? ttl : Math.min(ttl, RUNNING_CHECKPOINT_MS)))) saveFailed = true;
  };
  const restart = (): void => {
    restarts += 1;
    startedAt = ctx.now();
    ids = [];
    prints = [];
    games = [];
    dropped = { unfinished: 0, unreadable: 0, nonLeague: 0 };
    seen = new Set();
  };

  for (;;) {
    if (ids.length >= Math.min(MAX_SEASON_ROWS, ctx.maxRows ?? MAX_SEASON_ROWS)) {
      await ctx.cache.delete(wipKey);
      return { ok: true, games: { tournamentId, games, dropped, complete: false, heldReason: RUNAWAY_REASON }, source: 'network', fetchedAt: ctx.now(), pages, saveFailed };
    }
    if (ctx.signal?.aborted) {
      await save();
      return { ok: false, tournamentId, kind: 'aborted', reason: '中断しました。', progress: progress(), stale, pages, saveFailed };
    }
    const consumed = ids.length;
    let page: Awaited<ReturnType<AnalyticsApi['gamesAt']>>;
    try {
      page = await withRetry(ctx, () => api.gamesAt(tournamentId, consumed === 0 ? 0 : consumed - 1, restarts > 0));
    } catch (error) {
      if (error instanceof RequestBudgetError) {
        // This unit is spent: go on with the next one, from the same row, in memory.
        const next = ctx.signal?.aborted ? null : await ctx.nextApi?.();
        if (next) {
          api = next;
          continue;
        }
      }
      await save();
      const kind = failureKind(error);
      if (kind !== 'budget' && kind !== 'aborted' && stale) {
        // A list read to the end earlier is better than none (shown as saved, not current).
        return { ok: true, games: stale, source: 'stale-cache', fetchedAt: cached!.fetchedAt, pages, saveFailed };
      }
      return { ok: false, tournamentId, kind, reason: error instanceof RequestBudgetError ? error.message : describeN01Error(error), progress: progress(), stale, pages, saveFailed };
    }
    pages += 1;

    // The overlap row must be the last row already read, and no row may come back twice.
    const overlap = consumed > 0;
    const added = overlap ? page.ids.slice(1) : page.ids;
    const moved =
      (overlap && (page.rows === 0 || page.ids[0] !== ids[consumed - 1])) ||
      added.some((id, i) => id !== null && (seen.has(id) || added.indexOf(id) !== i));
    if (moved) {
      if (restarts < MAX_BOUNDARY_RESTARTS) {
        restart();
        continue;
      }
      await ctx.cache.delete(wipKey);
      return { ok: true, games: { tournamentId, games: [], dropped: { unfinished: 0, unreadable: 0, nonLeague: 0 }, complete: false, heldReason: BOUNDARY_REASON }, source: 'network', fetchedAt: ctx.now(), pages, saveFailed };
    }

    const overlapId = overlap ? page.ids[0] : undefined;
    const byId = new Map(page.games.map((g) => [g.gameId, g]));
    const overlapUnreadable = overlap && !byId.has(overlapId ?? '');
    for (const id of added) {
      ids.push(id);
      const game = id === null ? undefined : byId.get(id);
      prints.push(game ? fingerprint(game) : null);
      if (id !== null) seen.add(id);
    }
    dropped.unreadable += page.unreadable - (overlapUnreadable ? 1 : 0);
    for (const game of page.games) {
      if (overlap && game.gameId === overlapId) continue;
      if (!isLeagueGame(game.matchId)) dropped.nonLeague += 1;
      else if (!game.finished) dropped.unfinished += 1;
      else games.push(compact(game));
    }
    onProgress?.(progress());

    if (page.rows < GAME_LIST_PAGE) {
      // The last page was reached. A row n01 sent that could not be read is a game we cannot
      // account for: the list is then not the whole season, however short the last page was.
      const complete = dropped.unreadable === 0;
      const result: SeasonGames = { tournamentId, games, dropped, complete, version: fnv(JSON.stringify([ids, prints])) };
      if (prior) result.recollated = compare(prior, ids, prints);
      // An incomplete list keeps the rows that were read (nothing correct is thrown away), but only
      // briefly, so the next visit retries it; projection never uses it as the season.
      if (complete) ctx.memory?.set(tournamentId, { value: result, at: ctx.now() });
      if (!(await ctx.cache.put(key, result, complete ? ttl : Math.min(ttl, 10 * 60 * 1000)))) saveFailed = true;
      await ctx.cache.delete(wipKey);
      return { ok: true, games: result, source: 'network', fetchedAt: ctx.now(), pages, saveFailed };
    }
    await save();
  }
}
