import type { KindRecord } from './insights';

/**
 * Card win estimate (予測) for spectators, updated as the games go.
 *
 * Deliberately simple and explainable — every number comes from the two teams' season results:
 * - each team's win rate in the game's kind (Singles, Doubles …), shrunk towards 50 % by two
 *   wins and two losses so a few games cannot claim certainty;
 * - the two rates combined head to head (log5);
 * - a game in progress: its legs so far, as a race to the legs needed, with a per-leg chance
 *   that reproduces the game estimate from 0-0;
 * - the card: every finished game as it ended, the rest by their estimates (exact
 *   distribution over the remaining games).
 *
 * It is shown as an estimate with its basis, never as a result.
 */

export function shrunk(record: KindRecord | undefined): number {
  const games = record?.games ?? 0;
  const wins = record?.wins ?? 0;
  return (wins + 2) / (games + 4);
}

/** Head-to-head chance of A from two win rates (log5). */
export function log5(a: number, b: number): number {
  const num = a * (1 - b);
  const den = num + b * (1 - a);
  return den === 0 ? 0.5 : num / den;
}

/** Chance of reaching `need` legs first from (a, b) with leg chance `q`. */
export function raceChance(q: number, need: number, a: number, b: number): number {
  const memo = new Map<string, number>();
  const go = (x: number, y: number): number => {
    if (x >= need) return 1;
    if (y >= need) return 0;
    const key = `${x},${y}`;
    const cached = memo.get(key);
    if (cached !== undefined) return cached;
    const value = q * go(x + 1, y) + (1 - q) * go(x, y + 1);
    memo.set(key, value);
    return value;
  };
  return go(a, b);
}

/** The per-leg chance whose race from 0-0 gives `p` (bisection). */
export function legChanceFor(p: number, need: number): number {
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 40; i += 1) {
    const mid = (lo + hi) / 2;
    if (raceChance(mid, need, 0, 0) < p) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

export type GameOutlook =
  | { state: 'done'; winner: 0 | 1 }
  | { state: 'live'; p: number; legs: [number, number]; need: number }
  | { state: 'todo'; p: number };

export interface CardOutlook {
  win: number;
  draw: number;
  loss: number;
}

/** Card outcome for side 0 over all games (more games won wins; equal is a draw). */
export function cardOutlook(games: readonly GameOutlook[]): CardOutlook {
  let dist = [1];
  let fixedA = 0;
  for (const game of games) {
    if (game.state === 'done') {
      if (game.winner === 0) fixedA += 1;
      continue;
    }
    const p = game.state === 'live' ? raceChance(legChanceFor(game.p, game.need), game.need, game.legs[0], game.legs[1]) : game.p;
    const next = Array(dist.length + 1).fill(0);
    dist.forEach((weight, wins) => {
      next[wins + 1] += weight * p;
      next[wins] += weight * (1 - p);
    });
    dist = next;
  }
  const total = games.length;
  let win = 0;
  let draw = 0;
  let loss = 0;
  dist.forEach((weight, wins) => {
    const a = fixedA + wins;
    const b = total - a;
    if (a > b) win += weight;
    else if (a === b) draw += weight;
    else loss += weight;
  });
  return { win, draw, loss };
}
