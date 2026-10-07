import { describe, expect, it } from 'vitest';
import { games } from '../../test/factories';
import { evaluateFairness } from './fairness';
import {
  buildRoleGroups,
  evaluateRoleFairness,
  maximalSsd,
  roleFairShare,
  roleOfGame,
} from './roleFairness';

describe('roleOfGame', () => {
  it('counts a "Doubles 501" game once, as Doubles — never as 501', () => {
    expect(roleOfGame({ kinds: ['DOUBLES', 'G501'], playerCount: 2 })).toBe('DOUBLES');
    expect(roleOfGame({ kinds: ['G501', 'SINGLES'], playerCount: 1 })).toBe('SINGLES');
    expect(roleOfGame({ kinds: ['TRIOS', 'CRICKET'], playerCount: 3 })).toBe('TRIOS');
  });

  it('places a game with no structural kind by its head count', () => {
    expect(roleOfGame({ kinds: ['G501'], playerCount: 1 })).toBe('SINGLES');
    expect(roleOfGame({ kinds: ['CRICKET'], playerCount: 2 })).toBe('DOUBLES');
    expect(roleOfGame({ kinds: ['CUSTOM'], playerCount: 3 })).toBe('TRIOS');
    expect(roleOfGame({ kinds: ['CUSTOM'], playerCount: 5 })).toBe('TEAM');
    expect(roleOfGame({ kinds: ['GALLON'], playerCount: 4 })).toBe('GALLON');
  });
});

describe('maximalSsd', () => {
  it('is the SSD of the most concentrated spread', () => {
    // 4 Singles over 5 players, one per game: 4,0,0,0,0.
    expect(maximalSsd(4, 4, 5)).toBeCloseTo(12.8, 10);
    // 6 Doubles slots over 3 games: 3,3,0,0,0.
    expect(maximalSsd(6, 3, 5)).toBeCloseTo(10.8, 10);
  });
});

const fourSingles = () =>
  games([
    { id: 'g1', name: 'S1', kinds: ['SINGLES', 'G501'], playerCount: 1 },
    { id: 'g2', name: 'S2', kinds: ['SINGLES', 'CRICKET'], playerCount: 1 },
    { id: 'g3', name: 'S3', kinds: ['SINGLES', 'G501'], playerCount: 1 },
    { id: 'g4', name: 'S4', kinds: ['SINGLES', 'CRICKET'], playerCount: 1 },
    { id: 'g5', name: 'D1', kinds: ['DOUBLES', 'G501'], playerCount: 2 },
    { id: 'g6', name: 'D2', kinds: ['DOUBLES', 'CRICKET'], playerCount: 2 },
  ]);

describe('evaluateRoleFairness', () => {
  const groups = buildRoleGroups(fourSingles(), 5);

  it('groups the games by role and never double counts 501 / Cricket', () => {
    expect(groups.map((group) => group.role)).toEqual(['SINGLES', 'DOUBLES']);
    expect(groups[0].slots).toBe(4);
    expect(groups[1].slots).toBe(4);
    expect(roleFairShare(groups[0], 5)).toBe(1);
  });

  it('ranks A B C D above A A B C above A A A B above A A A A in Singles', () => {
    const doubles = [1, 1, 1, 1, 0];
    const score = (singles: number[]) => evaluateRoleFairness(groups, [singles, doubles]).score;
    const spread = score([1, 1, 1, 1, 0]);
    const twice = score([2, 1, 1, 0, 0]);
    const thrice = score([3, 1, 0, 0, 0]);
    const all = score([4, 0, 0, 0, 0]);
    expect(spread).toBe(1);
    expect(spread).toBeGreaterThan(twice);
    expect(twice).toBeGreaterThan(thrice);
    expect(thrice).toBeGreaterThan(all);
    // Convex: each further step of concentration costs more than the one before.
    expect(thrice - all).toBeGreaterThan(twice - thrice);
    expect(twice - thrice).toBeGreaterThan(spread - twice);
    for (const value of [spread, twice, thrice, all]) {
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(1);
    }
  });

  it('tells apart orders that total appearances alone cannot', () => {
    // A: Singles 4 / Doubles 0, B: Singles 0 / Doubles 4 — against A and B each playing
    // two of each. Totals are 4 and 4 in both, so the total metric is identical.
    const concentrated = { singles: [4, 0, 0, 0, 0], doubles: [0, 4, 0, 0, 0] };
    const mixed = { singles: [2, 2, 0, 0, 0], doubles: [2, 2, 0, 0, 0] };
    const totals = (o: { singles: number[]; doubles: number[] }) => o.singles.map((s, i) => s + o.doubles[i]);
    const zeros = [0, 0, 0, 0, 0];
    expect(evaluateFairness(zeros, totals(concentrated)).score).toBe(evaluateFairness(zeros, totals(mixed)).score);

    const roleA = evaluateRoleFairness(groups, [concentrated.singles, concentrated.doubles]);
    const roleB = evaluateRoleFairness(groups, [mixed.singles, mixed.doubles]);
    expect(roleB.score).toBeGreaterThan(roleA.score);
    expect(roleA.maxConcentration).toBe(4);
    expect(roleB.maxConcentration).toBe(2);
  });

  it('is 1 when no role can be concentrated at all', () => {
    const single = buildRoleGroups(games([{ id: 'g1', name: 'S', kinds: ['SINGLES'], playerCount: 1 }]), 5);
    expect(evaluateRoleFairness(single, [[1, 0, 0, 0, 0]]).score).toBe(1);
  });
});
