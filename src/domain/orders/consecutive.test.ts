import { describe, expect, it } from 'vitest';
import {
  buildAppearanceIndices,
  consecutiveExcess,
  longestRun,
  runLengths,
} from './consecutive';
import { games } from '../../test/factories';

describe('longestRun', () => {
  it('counts the longest adjacent streak', () => {
    expect(longestRun([])).toBe(0);
    expect(longestRun([3])).toBe(1);
    expect(longestRun([0, 1, 2])).toBe(3);
    expect(longestRun([0, 2, 4])).toBe(1);
    expect(longestRun([0, 1, 3, 4, 5])).toBe(3);
  });

  it('ignores order and duplicates', () => {
    expect(longestRun([5, 4, 4, 3])).toBe(3);
  });
});

describe('runLengths', () => {
  it('lists every streak', () => {
    expect(runLengths([0, 1, 3, 6, 7, 8])).toEqual([2, 1, 3]);
    expect(runLengths([])).toEqual([]);
  });
});

describe('consecutiveExcess', () => {
  it('is 0 while every streak is within the limit', () => {
    expect(consecutiveExcess([0, 1, 3, 4], 2)).toBe(0);
  });

  it('charges one unit per game beyond the limit (spec §13)', () => {
    // Games 1-2-3 against a limit of 2 is one game too many.
    expect(consecutiveExcess([0, 1, 2], 2)).toBe(1);
    expect(consecutiveExcess([0, 1, 2, 3], 2)).toBe(2);
    expect(consecutiveExcess([0, 1, 2, 4, 5, 6], 2)).toBe(2);
  });

  it('never charges when the limit is unbounded', () => {
    expect(consecutiveExcess([0, 1, 2, 3, 4], 0)).toBe(0);
  });
});

describe('buildAppearanceIndices', () => {
  it('maps each player to the game positions they appear in', () => {
    const gameDefs = games([
      { id: 'g1', name: 'A', kinds: ['SINGLES'], playerCount: 1 },
      { id: 'g2', name: 'B', kinds: ['DOUBLES'], playerCount: 2 },
      { id: 'g3', name: 'C', kinds: ['SINGLES'], playerCount: 1 },
    ]);
    const indices = buildAppearanceIndices(gameDefs, [
      { gameId: 'g1', playerIds: ['p1'] },
      { gameId: 'g2', playerIds: ['p1', 'p2'] },
      { gameId: 'g3', playerIds: ['p2'] },
    ]);
    expect(indices.get('p1')).toEqual([0, 1]);
    expect(indices.get('p2')).toEqual([1, 2]);
  });
});
