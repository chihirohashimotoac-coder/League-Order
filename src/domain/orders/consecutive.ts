import type { GameAssignment, GameSlotDef, PlayerId } from '../types';

/**
 * Consecutive-appearance analysis.
 *
 * "Consecutive" means appearing in games that are adjacent in display order. A run
 * of length `L` for a player whose limit is `M` contributes `max(0, L - M)` to the
 * penalty, so a 3-game run against a limit of 2 costs 1.
 */

/** Longest run of consecutive game indices in a sorted, de-duplicated index list. */
export function longestRun(indices: readonly number[]): number {
  if (indices.length === 0) return 0;
  const sorted = [...new Set(indices)].sort((a, b) => a - b);
  let best = 1;
  let current = 1;
  for (let i = 1; i < sorted.length; i += 1) {
    if (sorted[i] === sorted[i - 1] + 1) {
      current += 1;
      if (current > best) best = current;
    } else {
      current = 1;
    }
  }
  return best;
}

/** All run lengths, in ascending order of first game index. */
export function runLengths(indices: readonly number[]): number[] {
  if (indices.length === 0) return [];
  const sorted = [...new Set(indices)].sort((a, b) => a - b);
  const runs: number[] = [];
  let current = 1;
  for (let i = 1; i <= sorted.length; i += 1) {
    if (i < sorted.length && sorted[i] === sorted[i - 1] + 1) {
      current += 1;
    } else {
      runs.push(current);
      current = 1;
    }
  }
  return runs;
}

/** Excess over the limit, summed across the player's runs. */
export function consecutiveExcess(indices: readonly number[], limit: number): number {
  if (limit <= 0) return 0;
  let excess = 0;
  for (const run of runLengths(indices)) excess += Math.max(0, run - limit);
  return excess;
}

/** Per-player sorted game indices (position in the ordered game list). */
export function buildAppearanceIndices(
  games: readonly GameSlotDef[],
  assignments: readonly GameAssignment[],
): Map<PlayerId, number[]> {
  const indexOfGame = new Map<string, number>();
  games.forEach((game, index) => indexOfGame.set(game.id, index));

  const result = new Map<PlayerId, number[]>();
  for (const assignment of assignments) {
    const index = indexOfGame.get(assignment.gameId);
    if (index === undefined) continue;
    for (const playerId of assignment.playerIds) {
      const list = result.get(playerId);
      if (list) list.push(index);
      else result.set(playerId, [index]);
    }
  }
  for (const list of result.values()) list.sort((a, b) => a - b);
  return result;
}
