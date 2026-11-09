import { describeN01Error } from '../../../integrations/n01/client';
import { N01_STATUS } from '../../../integrations/n01/types';
import { RequestBudgetError } from '../api/readApi';
import { TTL } from '../cache/analyticsCache';
import { addVerified, bestLegsByStart, checkPlayerSeason, safeReconstruct } from '../reconstruct';
import type { GameReconstruction, PlayerContributions, SeasonCheck } from '../reconstruct';
import { classifyGames } from '../roleGames';
import type { ClassifiedGame, SeasonGames } from '../roleGames';
import type { SeasonData } from '../seasonData';
import type { GamesContext } from './gamesLoader';

/**
 * Leg-by-leg reconstruction for **one selected player**, on request (P2: 個人別の役割別成績).
 *
 * `match/get` is one request per game, so it is never run for a whole league: only for the
 * games of the player the user picked, newest season first, within a budget. Rebuilt games are
 * cached per season (a pair's doubles game serves both partners; a team game all four), and a
 * season counts only if the rebuilt totals equal n01's totals for the player.
 *
 * Freshness (a score corrected on n01 must reach the rebuilt figures):
 * - every cached game carries the time it was read; a game older than the season's TTL, or any
 *   game when the user asked for fresh data (`forceRefresh`), is read again — only the selected
 *   player's games, never the whole league;
 * - when the rebuilt totals disagree with n01's, the games that came from the cache are read
 *   once more (a correction made after they were cached) and the season is checked again; a
 *   cached game that could not be rebuilt is read once more in any case;
 * - a game that could not be read again keeps its old reconstruction, and the season says so
 *   (`stale`): it is never presented as freshly checked.
 */

export const detailKey = (tournamentId: string): string => `detail:${tournamentId}`;
/** `match/get` requests one reconstruction may send (≈ 2–3 seasons of one player). */
export const DETAIL_MAX_REQUESTS = 60;

export interface PlayerDetailResult {
  personKey: string;
  checks: SeasonCheck[];
  contributions: PlayerContributions;
  /**
   * Best Leg per start score, only for start scores whose singles games were **all** rebuilt in
   * every season of the period the player appears in. Independent of the 3DA checksum.
   */
  bestLegs: Map<number, number>;
  /** Start scores whose Best Leg is withheld (`all` when a season could not be examined at all). */
  bestLegHeld: { all: boolean; starts: number[]; reasons: string[] };
  /** Seasons not attempted because the budget ran out or the load was cancelled. */
  notAttempted: { tournamentId: string; title: string }[];
  /** Seasons using reconstructions that should have been read again but could not be. */
  stale: { tournamentId: string; title: string; games: number }[];
  failures: string[];
  requestsSent: number;
}

/** Cached reconstructions of one season, with the time each game was read. */
interface CachedDetail {
  v: 2;
  games: Record<string, { r: GameReconstruction; at: number }>;
}

type Held = Map<string, { r: GameReconstruction; at: number }>;

async function readCached(ctx: GamesContext, tournamentId: string): Promise<Held> {
  const entry = await ctx.cache.get<CachedDetail | Record<string, GameReconstruction>>(detailKey(tournamentId));
  if (!entry) return new Map();
  const value = entry.value as Partial<CachedDetail>;
  if (value && value.v === 2 && value.games) return new Map(Object.entries(value.games));
  // Written before per-game times were kept: each game is as old as the entry.
  return new Map(Object.entries(entry.value as Record<string, GameReconstruction>).map(([id, r]) => [id, { r, at: entry.fetchedAt }]));
}

const toRebuilt = (held: Held): Map<string, GameReconstruction> => new Map([...held].map(([id, entry]) => [id, entry.r]));

function personGames(classified: readonly ClassifiedGame[], oid: string): ClassifiedGame[] {
  return classified.filter((g) => g.family.family === '01' && g.sides.some((s) => s.players.some((p) => p.oid === oid)));
}

export async function reconstructPerson(
  ctx: GamesContext,
  input: { seasons: readonly SeasonData[]; games: ReadonlyMap<string, SeasonGames>; personKey: string; concurrency?: number },
): Promise<PlayerDetailResult> {
  const result: PlayerDetailResult = { personKey: input.personKey, checks: [], contributions: new Map(), bestLegs: new Map(), bestLegHeld: { all: false, starts: [], reasons: [] }, notAttempted: [], stale: [], failures: [], requestsSent: 0 };
  const held = new Set<number>();
  const holdAll = (reason: string): void => {
    result.bestLegHeld.all = true;
    result.bestLegHeld.reasons.push(reason);
  };
  let stopped = false;
  const concurrency = Math.max(1, input.concurrency ?? 3);
  for (const season of input.seasons) {
    const me = season.players.find((p) => p.personKey === input.personKey);
    if (!me) continue;
    const raw = input.games.get(season.tournamentId);
    if (!raw?.complete) {
      result.checks.push({ tournamentId: season.tournamentId, oid: me.oid, state: 'incomplete', games: 0, reconstructed: 0, verified: { score: false, f9: false, tons: false, highOut: false, break: false }, compared: null, reason: 'ゲーム一覧を取得できていません' });
      holdAll(`${season.title}: ゲーム一覧を取得できていません`);
      continue;
    }
    if (stopped) {
      result.notAttempted.push({ tournamentId: season.tournamentId, title: season.title });
      holdAll(`${season.title}: 通信の上限のため未確認`);
      continue;
    }
    const classified = classifyGames(season, raw.games);
    const mine = personGames(classified, me.oid);
    const stored = await readCached(ctx, season.tournamentId);
    const ttl = season.status === N01_STATUS.FINISHED ? TTL.finishedSeason : TTL.runningSeason;
    const now = ctx.now();
    const due = (id: string): boolean => {
      const entry = stored.get(id);
      return !entry || ctx.forceRefresh === true || now - entry.at >= ttl;
    };
    const readAgain = new Set<string>();
    let failedAgain = 0;
    let added = 0;
    // Reads `games` (multi-thrower games first: they are what only a reconstruction can split).
    const fetchGames = async (games: readonly ClassifiedGame[]): Promise<void> => {
      const pending = [...games].sort((a, b) => Number(a.sides[0].players.length === 1) - Number(b.sides[0].players.length === 1));
      for (let i = 0; i < pending.length && !stopped; i += concurrency) {
        if (ctx.signal?.aborted) {
          stopped = true;
          break;
        }
        const batch = pending.slice(i, i + concurrency);
        const outcomes = await Promise.allSettled(batch.map((g) => ctx.api.gameDetail(g.gameId)));
        outcomes.forEach((outcome, index) => {
          const id = batch[index].gameId;
          if (outcome.status === 'fulfilled') {
            stored.set(id, { r: safeReconstruct(outcome.value), at: ctx.now() });
            readAgain.add(id);
            added += 1;
            return;
          }
          if (stored.has(id)) failedAgain += 1;
          if (outcome.reason instanceof RequestBudgetError) stopped = true;
          else result.failures.push(`${season.title}: ${describeN01Error(outcome.reason)}`);
        });
      }
    };
    await fetchGames(mine.filter((g) => due(g.gameId)));
    let rebuilt = toRebuilt(stored);

    // Read again, once, what the cache may hold from before a correction: every cached game when
    // the rebuilt totals disagree with n01's, otherwise the cached games that could not be rebuilt
    // (a record entered partly, or wrongly, when it was cached). Then check again.
    const composition = season.composition.composition;
    if (!stopped) {
      const cachedOnly = mine.filter((g) => stored.has(g.gameId) && !readAgain.has(g.gameId));
      const first = composition === 'unknown' ? null : checkPlayerSeason(season.tournamentId, me.oid, me.line, classified, rebuilt, composition === 'pure01');
      const suspect = first?.state === 'mismatch' ? cachedOnly : cachedOnly.filter((g) => !stored.get(g.gameId)!.r.ok);
      if (suspect.length > 0) {
        await fetchGames(suspect);
        rebuilt = toRebuilt(stored);
      }
    }
    if (added > 0) {
      await ctx.cache.put(detailKey(season.tournamentId), { v: 2, games: Object.fromEntries(stored) } satisfies CachedDetail, ttl);
    }
    const overdue = mine.filter((g) => stored.has(g.gameId) && !readAgain.has(g.gameId) && (ctx.forceRefresh === true || now - stored.get(g.gameId)!.at >= ttl)).length;
    if (failedAgain > 0 || overdue > 0) result.stale.push({ tournamentId: season.tournamentId, title: season.title, games: Math.max(failedAgain, overdue) });

    // Best Leg: per start score, every singles game of the season must have been rebuilt. A game
    // not fetched (budget / network) or unreadable leaves that start score unconfirmed.
    const singlesByStart = new Map<number | null, ClassifiedGame[]>();
    for (const g of mine) {
      if (!g.sides.some((side) => side.players.length === 1 && side.players[0].oid === me.oid)) continue;
      singlesByStart.set(g.startScore, [...(singlesByStart.get(g.startScore) ?? []), g]);
    }
    for (const [start, list] of singlesByStart) {
      const missing = list.filter((g) => !rebuilt.get(g.gameId)?.ok).length;
      if (missing === 0) continue;
      const reason = `${season.title}: シングルス${list.length}ゲーム中${missing}ゲームのLeg明細を確認できていません`;
      if (start === null) holdAll(reason);
      else {
        held.add(start);
        result.bestLegHeld.reasons.push(reason);
      }
    }
    for (const [start, darts] of bestLegsByStart(me.oid, mine, rebuilt)) result.bestLegs.set(start, Math.min(result.bestLegs.get(start) ?? Infinity, darts));

    if (composition === 'unknown') {
      result.checks.push({ tournamentId: season.tournamentId, oid: me.oid, state: 'mismatch', games: mine.length, reconstructed: mine.filter((g) => rebuilt.get(g.gameId)?.ok).length, verified: { score: false, f9: false, tons: false, highOut: false, break: false }, compared: null, reason: '種別不明のゲーム枠を含むため、n01公式値と照合できません' });
      continue;
    }
    const check = checkPlayerSeason(season.tournamentId, me.oid, me.line, classified, rebuilt, composition === 'pure01');
    result.checks.push(check);
    addVerified(result.contributions, check, classified, rebuilt);
  }
  // Only confirmed start scores are published; a partial minimum could be worse than the real one.
  if (result.bestLegHeld.all) result.bestLegs.clear();
  for (const start of held) result.bestLegs.delete(start);
  result.bestLegHeld.starts = [...held].sort((a, b) => a - b);
  result.requestsSent = ctx.api.requestCount;
  return result;
}
