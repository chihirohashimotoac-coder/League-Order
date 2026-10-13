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
  failures: string[];
  requestsSent: number;
}

async function readCached(ctx: GamesContext, tournamentId: string): Promise<Map<string, GameReconstruction>> {
  const entry = await ctx.cache.get<Record<string, GameReconstruction>>(detailKey(tournamentId));
  return new Map(Object.entries(entry?.value ?? {}));
}

function personGames(classified: readonly ClassifiedGame[], oid: string): ClassifiedGame[] {
  return classified.filter((g) => g.family.family === '01' && g.sides.some((s) => s.players.some((p) => p.oid === oid)));
}

export async function reconstructPerson(
  ctx: GamesContext,
  input: { seasons: readonly SeasonData[]; games: ReadonlyMap<string, SeasonGames>; personKey: string; concurrency?: number },
): Promise<PlayerDetailResult> {
  const result: PlayerDetailResult = { personKey: input.personKey, checks: [], contributions: new Map(), bestLegs: new Map(), bestLegHeld: { all: false, starts: [], reasons: [] }, notAttempted: [], failures: [], requestsSent: 0 };
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
    const rebuilt = await readCached(ctx, season.tournamentId);
    // Multi-thrower games first: they are what only a reconstruction can split.
    const pending = mine.filter((g) => !rebuilt.has(g.gameId)).sort((a, b) => Number(a.sides[0].players.length === 1) - Number(b.sides[0].players.length === 1));
    let added = 0;
    for (let i = 0; i < pending.length && !stopped; i += concurrency) {
      if (ctx.signal?.aborted) {
        stopped = true;
        break;
      }
      const batch = pending.slice(i, i + concurrency);
      const outcomes = await Promise.allSettled(batch.map((g) => ctx.api.gameDetail(g.gameId)));
      outcomes.forEach((outcome, index) => {
        if (outcome.status === 'fulfilled') {
          rebuilt.set(batch[index].gameId, safeReconstruct(outcome.value));
          added += 1;
        } else if (outcome.reason instanceof RequestBudgetError) stopped = true;
        else result.failures.push(`${season.title}: ${describeN01Error(outcome.reason)}`);
      });
    }
    if (added > 0) {
      const ttl = season.status === N01_STATUS.FINISHED ? TTL.finishedSeason : TTL.runningSeason;
      await ctx.cache.put(detailKey(season.tournamentId), Object.fromEntries(rebuilt), ttl);
    }
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

    const composition = season.composition.composition;
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
