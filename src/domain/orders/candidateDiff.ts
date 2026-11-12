import type { GameSlotDef, OrderSolution, PlayerId } from '../types';

/**
 * What changes between two generated candidates: the games whose line-up differs and the players
 * whose number of appearances differs. Read from the candidates' own assignments and tallies only —
 * no score, estimate or rule is recomputed — so two candidates shown with the same estimated win
 * rate can still be told apart.
 */
export interface CandidateGameChange {
  gameId: string;
  order: number;
  name: string;
  /** Players in the base candidate, then in the other one (slot order). */
  from: PlayerId[];
  to: PlayerId[];
}

export interface CandidateCountChange {
  playerId: PlayerId;
  from: number;
  to: number;
}

export interface CandidateDiff {
  games: CandidateGameChange[];
  counts: CandidateCountChange[];
}

const sameSet = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && [...a].sort().join('\u0000') === [...b].sort().join('\u0000');

export function diffCandidates(base: OrderSolution, other: OrderSolution, games: readonly GameSlotDef[]): CandidateDiff {
  const playersOf = (solution: OrderSolution, gameId: string): PlayerId[] => solution.assignments.find((entry) => entry.gameId === gameId)?.playerIds ?? [];
  const changed = [...games]
    .sort((a, b) => a.order - b.order)
    .flatMap((game) => {
      const from = playersOf(base, game.id);
      const to = playersOf(other, game.id);
      // The same players in another throwing order is a throw-order change, not another line-up.
      return sameSet(from, to) ? [] : [{ gameId: game.id, order: game.order, name: game.name, from, to }];
    });
  const countOf = (solution: OrderSolution): Map<PlayerId, number> => new Map(solution.tallies.map((tally) => [tally.playerId, tally.count]));
  const a = countOf(base);
  const b = countOf(other);
  const ids = [...new Set([...a.keys(), ...b.keys()])];
  const counts = ids
    .map((playerId) => ({ playerId, from: a.get(playerId) ?? 0, to: b.get(playerId) ?? 0 }))
    .filter((entry) => entry.from !== entry.to);
  return { games: changed, counts };
}
