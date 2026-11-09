import type { GameRow, ThrowLeg } from './parse';
import type { Visit01 } from './legAnalysis';
import { before, finishable } from './legAnalysis';

/**
 * One player's season, for the player card (選手カード):
 *
 * - from the game rows (n01's per-game totals): the Singles 01 average game by game;
 * - from the throws of every 01 game the player played: visits of 100+ and 180, the visits
 *   started on a finish (上がり圏) and how many were finished, the highest checkout, and the
 *   fewest darts in a Singles leg won (per starting score — only a singles leg is the player's
 *   own darts).
 *
 * Whose visit it is, in this order:
 * 1. n01 gives the thrower's member id (`member.oid`): the visit is the player's exactly when it
 *    is the player's id. Two players of the same name are never confused.
 * 2. No id, but a name: the player's only when that name belongs to exactly one member of the
 *    player's side in that game. A name two members share is ambiguous — counted for nobody.
 * 3. Neither: in a singles game the side's visit is the player's; otherwise it is ambiguous.
 * Ambiguous visits are counted (`ambiguous`) so the card can say figures are partial. Players
 * are matched by their season member id in the game rows, never by name across games.
 */

export interface PlayerGame {
  mid: string;
  /** The player's season member id. */
  oid: string;
  /** The player's name is held by no other member of the side in this game. */
  nameUnique: boolean;
  side: 0 | 1;
  singles: boolean;
  matchType: '01' | 'cricket';
  startTime: number | null;
  /** n01's 3-dart average for a singles 01 game (the player's own); `null` otherwise. */
  singlesAverage: number | null;
  /** Points and darts behind `singlesAverage` (to pool a season: Σ points × 3 ÷ Σ darts). */
  singlesPair: { num: number; darts: number } | null;
  name: string;
}

/** The finished games a player (season member id) played, oldest first. */
export function playerGames(games: readonly GameRow[], oid: string): PlayerGame[] {
  const out: PlayerGame[] = [];
  for (const game of [...games].filter((entry) => entry.finished).sort((a, b) => (a.startTime ?? 0) - (b.startTime ?? 0))) {
    const side = game.sides.findIndex((entry) => entry.members.some((member) => member.oid === oid));
    if (side !== 0 && side !== 1) continue;
    const row = game.sides[side];
    const member = row.members.find((entry) => entry.oid === oid)!;
    const singles = row.members.length === 1;
    const pair = singles && game.matchType === '01' && row.darts && row.darts > 0 && row.score !== null ? { num: row.score, darts: row.darts } : null;
    const average = pair ? (pair.num / pair.darts) * 3 : null;
    const nameUnique = row.members.filter((entry) => entry.name.trim() === member.name.trim()).length === 1;
    out.push({ mid: game.mid, oid, nameUnique, side, singles, matchType: game.matchType, startTime: game.startTime, singlesAverage: average, singlesPair: pair, name: member.name });
  }
  return out;
}

export interface PlayerThrowStats {
  games: number;
  visits: number;
  ton: number;
  ton80: number;
  chances: number;
  finished: number;
  highOut: number | null;
  /** Fewest darts in a singles leg won, per starting score. */
  bestLegs: { start: number; darts: number }[];
  /** Visits of the player's side that could not be told apart (counted for nobody). */
  ambiguous: number;
}

/** Whose visit (see the module comment): `true` = the player's, `false` = another's, `null` = cannot tell. */
export function visitOwner(entry: { member: string | null; memberId?: string | null }, game: Pick<PlayerGame, 'oid' | 'name' | 'nameUnique' | 'singles'>): boolean | null {
  if (entry.memberId) return entry.memberId === game.oid;
  if (entry.member !== null && entry.member.trim() !== '') {
    if (entry.member.trim() !== game.name.trim()) return false;
    return game.nameUnique ? true : null;
  }
  return game.singles ? true : null;
}

export function playerThrowStats(entries: readonly { game: PlayerGame; legs: readonly ThrowLeg[] }[]): PlayerThrowStats {
  const stats: PlayerThrowStats = { games: 0, visits: 0, ton: 0, ton80: 0, chances: 0, finished: 0, highOut: null, bestLegs: [], ambiguous: 0 };
  const best = new Map<number, number>();
  for (const { game, legs } of entries) {
    if (game.matchType !== '01') continue;
    stats.games += 1;
    for (const leg of legs) {
      if (leg.bull) continue;
      const sideVisits = leg.throws.filter((entry): entry is Visit01 => entry.kind === '01' && entry.side === game.side);
      const mine = sideVisits.filter((entry) => visitOwner(entry, game) === true);
      stats.ambiguous += sideVisits.filter((entry) => visitOwner(entry, game) === null).length;
      for (const visit of mine) {
        stats.visits += 1;
        if (visit.score >= 100) stats.ton += 1;
        if (visit.score === 180) stats.ton80 += 1;
        if (finishable(before(visit))) {
          stats.chances += 1;
          if (visit.finish) stats.finished += 1;
        }
        if (visit.finish) stats.highOut = Math.max(stats.highOut ?? 0, visit.score);
      }
      if (game.singles && leg.ended && leg.winner === game.side && mine.length) {
        const start = leg.start?.[game.side] ?? before(mine[0]);
        const darts = leg.dartsTotal?.[game.side] ?? mine.reduce((sum, visit) => sum + (visit.finish ? visit.darts : 3), 0);
        if (darts > 0) best.set(start, Math.min(best.get(start) ?? Infinity, darts));
      }
    }
  }
  stats.bestLegs = [...best.entries()].map(([start, darts]) => ({ start, darts })).sort((a, b) => a.start - b.start);
  return stats;
}
