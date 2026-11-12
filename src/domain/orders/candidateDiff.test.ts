import { describe, expect, it } from 'vitest';
import type { GameSlotDef, OrderSolution } from '../types';
import { diffCandidates } from './candidateDiff';

const game = (id: string, order: number): GameSlotDef => ({ id, order, name: `G${order}` }) as GameSlotDef;
const solution = (assignments: Record<string, string[]>, counts: Record<string, number>): OrderSolution =>
  ({
    assignments: Object.entries(assignments).map(([gameId, playerIds]) => ({ gameId, playerIds })),
    tallies: Object.entries(counts).map(([playerId, count]) => ({ playerId, count })),
  }) as unknown as OrderSolution;

describe('diffCandidates', () => {
  const games = [game('g2', 2), game('g1', 1), game('g3', 3)];
  it('lists the games whose players differ, in game order, and the appearance counts that differ', () => {
    const a = solution({ g1: ['p1'], g2: ['p1', 'p2'], g3: ['p3'] }, { p1: 2, p2: 1, p3: 1 });
    const b = solution({ g1: ['p3'], g2: ['p2', 'p1'], g3: ['p1'] }, { p1: 2, p2: 1, p3: 1 });
    const diff = diffCandidates(a, b, games);
    expect(diff.games.map((entry) => entry.gameId)).toEqual(['g1', 'g3']);
    expect(diff.games[0]).toMatchObject({ from: ['p1'], to: ['p3'] });
    expect(diff.counts).toEqual([]);
  });
  it('reports appearance changes, including a player who does not play in one candidate', () => {
    const a = solution({ g1: ['p1'], g2: ['p1', 'p2'], g3: ['p1'] }, { p1: 3, p2: 1 });
    const b = solution({ g1: ['p4'], g2: ['p1', 'p2'], g3: ['p1'] }, { p1: 2, p2: 1, p4: 1 });
    expect(diffCandidates(a, b, games).counts).toEqual([
      { playerId: 'p1', from: 3, to: 2 },
      { playerId: 'p4', from: 0, to: 1 },
    ]);
  });
  it('finds nothing between identical candidates', () => {
    const a = solution({ g1: ['p1'], g2: ['p1', 'p2'], g3: ['p3'] }, { p1: 2, p2: 1, p3: 1 });
    expect(diffCandidates(a, a, games)).toEqual({ games: [], counts: [] });
  });
});
