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
 * A visit is the player's when n01 names the player on it; in a singles game an unnamed visit of
 * the player's side is the player's too. Players are matched by their season member id (`oid`)
 * in the game rows and by name only inside one game, never across games.
 */

export interface PlayerGame {
  mid: string;
  side: 0 | 1;
  singles: boolean;
  matchType: '01' | 'cricket';
  startTime: number | null;
  /** n01's 3-dart average for a singles 01 game (the player's own); `null` otherwise. */
  singlesAverage: number | null;
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
    const average = singles && game.matchType === '01' && row.darts && row.darts > 0 && row.score !== null ? (row.score / row.darts) * 3 : null;
    out.push({ mid: game.mid, side, singles, matchType: game.matchType, startTime: game.startTime, singlesAverage: average, name: member.name });
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
}

export function playerThrowStats(entries: readonly { game: PlayerGame; legs: readonly ThrowLeg[] }[]): PlayerThrowStats {
  const stats: PlayerThrowStats = { games: 0, visits: 0, ton: 0, ton80: 0, chances: 0, finished: 0, highOut: null, bestLegs: [] };
  const best = new Map<number, number>();
  for (const { game, legs } of entries) {
    if (game.matchType !== '01') continue;
    stats.games += 1;
    for (const leg of legs) {
      if (leg.bull) continue;
      const mine = leg.throws.filter(
        (entry): entry is Visit01 => entry.kind === '01' && entry.side === game.side && (entry.member === game.name || (game.singles && entry.member === null)),
      );
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
