import { describe, expect, it } from 'vitest';
import type { GameSlotDef, OrderInput, OrderSolution, ParticipantConfig, Player, PresetKey } from '../domain/types';
import type { ConfidenceLevel } from '../domain/prediction/confidence';
import type { OpponentContext } from '../domain/prediction/opponentContext';
import { createParticipantConfig } from '../domain/orders/participants';
import { games, orderInput, player, withEvidence } from '../test/factories';
import { generateOrder } from './generateOrder';
import { validateHardConstraints } from './constraints/validate';

/**
 * F01: appearance bias.
 *
 * 勝利優先 used to give a four-player, four-Singles order to 2/1/1/0 on the strength of a
 * min–max normalised difference — even a 0.003 Rating difference — and 4/3/1/0 over eight
 * Singles. A bias towards stronger players now needs two things the order can show: a
 * model-estimated gain over the even line-up that is large enough for the amount of bias,
 * and data confident enough to believe it. Every candidate still honours every Hard
 * condition, and arithmetic or Hard limits that force an uneven split are never "fixed".
 */

const IDS = ['A', 'B', 'C', 'D', 'E'];

/** Rating 18/14/10/6/4 with PPR = Rating × 4 + 20 (the audit's synthetic team). */
function team(count: number, ratings = [18, 14, 10, 6, 4]): Player[] {
  return IDS.slice(0, count).map((id, index) =>
    player({ id, name: id, rating: ratings[index], ppr: ratings[index] * 4 + 20 }),
  );
}

function singles(count: number): GameSlotDef[] {
  return games(
    Array.from({ length: count }, (_, index) => ({
      id: `g${index + 1}`,
      name: `Singles ${index + 1}`,
      kinds: ['SINGLES' as const, 'G501' as const],
      playerCount: 1,
    })),
  );
}

function solve(input: OrderInput): OrderSolution {
  const result = generateOrder(input, { singleCandidate: true, timeLimitMs: 4000 });
  if (!result.ok) throw new Error(result.diagnostics.map((d) => d.message).join(' / '));
  return result.candidates[0];
}

const counts = (solution: OrderSolution): number[] => solution.tallies.map((tally) => tally.count);
const sortedDesc = (solution: OrderSolution): number[] => [...counts(solution)].sort((a, b) => b - a);

function run(
  n: number,
  slots: number,
  preset: PresetKey = 'WIN_FIRST',
  overrides: Parameters<typeof orderInput>[2] = {},
  roster: Player[] = team(n),
): OrderSolution {
  return solve(orderInput(roster, singles(slots), { preset, ...overrides }));
}

describe('without calibrated evidence the split is the even one', () => {
  it('T01: equal players, four Singles → 1/1/1/1', () => {
    const equal = IDS.slice(0, 4).map((id) => player({ id, name: id, rating: 12, ppr: 68 }));
    const solution = solve(orderInput(equal, singles(4), { preset: 'WIN_FIRST' }));
    expect(counts(solution)).toEqual([1, 1, 1, 1]);
    expect(solution.metrics.appearanceSpread).toBe(0);
    expect(solution.score.roleFairness).toBe(1);
  });

  it('T02: a 0.003 Rating difference is not a reason to bench anybody', () => {
    for (const withPpr of [false, true]) {
      const ratings = [12.003, 12.002, 12.001, 12];
      const roster = ratings.map((rating, index) =>
        player({ id: IDS[index], name: IDS[index], rating, ppr: withPpr ? rating * 4 + 20 : null }),
      );
      // Even with the best possible data behind it, a difference this small is no gain.
      const solution = solve(withEvidence(orderInput(roster, singles(4), { preset: 'WIN_FIRST' }), 'HIGH'));
      expect(counts(solution), `ppr=${withPpr}`).toEqual([1, 1, 1, 1]);
    }
  });

  it('a clear Rating/PPR gap but hand-typed numbers only (no evidence) is still even', () => {
    expect(counts(run(4, 4))).toEqual([1, 1, 1, 1]);
  });

  it('low-confidence data is even however large the gap', () => {
    const solution = solve(withEvidence(orderInput(team(4), singles(4), { preset: 'WIN_FIRST' }), 'LOW'));
    expect(counts(solution)).toEqual([1, 1, 1, 1]);
  });

  it('T04: four players over eight Singles are 2/2/2/2, not 4/3/1/0', () => {
    expect(counts(run(4, 8))).toEqual([2, 2, 2, 2]);
  });

  it('T05: the standard splits when the arithmetic does not divide evenly', () => {
    expect(sortedDesc(run(4, 5))).toEqual([2, 1, 1, 1]);
    expect(sortedDesc(run(5, 4))).toEqual([1, 1, 1, 1, 0]);
    expect(sortedDesc(run(5, 8))).toEqual([2, 2, 2, 1, 1]);
    expect(sortedDesc(run(3, 4))).toEqual([2, 1, 1]);
    expect(sortedDesc(run(2, 4))).toEqual([2, 2]);
  });

  it('is the same for opponent-aware and custom runs without usable data', () => {
    expect(counts(run(4, 4, 'CUSTOM', { weights: { strength: 1, fairness: 0.25, roleFairness: 0.18 } }))).toEqual([1, 1, 1, 1]);
  });
});

describe('bias needs a gain that is large enough and data that can be believed', () => {
  it('T03: strong evidence and a clear gap may give the best player one extra game', () => {
    const solution = solve(withEvidence(orderInput(team(4), singles(4), { preset: 'WIN_FIRST' }), 'HIGH'));
    expect(sortedDesc(solution)).toEqual([2, 1, 1, 0]);
    const gate = solution.meta.skewGate!;
    expect(gate.outcome).toBe('kept');
    expect(gate.confidence).toBe('HIGH');
    expect(gate.gain).toBeGreaterThanOrEqual(gate.required!);
    expect(gate.basis).toBe('reference');
  });

  it('says why the even line-up was kept when the evidence is not enough', () => {
    const solution = run(4, 4);
    expect(solution.meta.skewGate).toMatchObject({ outcome: 'replaced' });
    expect(solution.explanation.overall.some((factor) => factor.detail.includes('均等'))).toBe(true);
  });

  it('a large bias costs more than a small one: 4/3/1/0 is never chosen over eight Singles', () => {
    const solution = solve(withEvidence(orderInput(team(4), singles(8), { preset: 'WIN_FIRST' }), 'HIGH'));
    expect(Math.max(...counts(solution))).toBeLessThanOrEqual(3);
    expect(Math.min(...counts(solution))).toBeGreaterThanOrEqual(1);
  });

  it('T03: a Hard minimum of one forbids benching, whatever the evidence says', () => {
    const participants: ParticipantConfig[] = IDS.slice(0, 4).map((id) => ({ ...createParticipantConfig(id), minAppearances: 1 }));
    const solution = solve(withEvidence(orderInput(team(4), singles(4), { preset: 'WIN_FIRST', participants }), 'HIGH'));
    expect(counts(solution)).toEqual([1, 1, 1, 1]);
  });
});

describe('Hard conditions decide what unevenness is unavoidable', () => {
  const play = (solution: OrderSolution, id: string): number => solution.tallies.find((tally) => tally.playerId === id)!.count;

  it('T06: a player who cannot play Singles gets none, the rest share evenly', () => {
    const participants = IDS.slice(0, 4).map((id) =>
      id === 'B' ? { ...createParticipantConfig(id), excludedKinds: ['SINGLES' as const] } : createParticipantConfig(id),
    );
    const input = orderInput(team(4), singles(4), { preset: 'WIN_FIRST', participants });
    const solution = solve(input);
    expect(play(solution, 'B')).toBe(0);
    const others = ['A', 'C', 'D'].map((id) => play(solution, id));
    expect(Math.max(...others) - Math.min(...others)).toBeLessThanOrEqual(1);
    expect(validateHardConstraints(input, solution.assignments)).toEqual([]);
  });

  it('T06: maximum, minimum and lock are all kept', () => {
    const participants = IDS.slice(0, 4).map((id) => {
      const base = createParticipantConfig(id);
      if (id === 'A') return { ...base, maxAppearances: 1 };
      if (id === 'D') return { ...base, minAppearances: 1 };
      return base;
    });
    const input = orderInput(team(4), singles(4), {
      preset: 'WIN_FIRST',
      participants,
      locks: [{ gameId: 'g1', slotIndex: 0, playerId: 'C' }],
    });
    const solution = solve(input);
    expect(play(solution, 'A')).toBeLessThanOrEqual(1);
    expect(play(solution, 'D')).toBeGreaterThanOrEqual(1);
    expect(solution.assignments[0].playerIds).toEqual(['C']);
    expect(validateHardConstraints(input, solution.assignments)).toEqual([]);
  });

  it('keeps an unavoidable concentration when only one person can play a role', () => {
    const participants = IDS.slice(0, 4).map((id) =>
      id === 'A' ? createParticipantConfig(id) : { ...createParticipantConfig(id), excludedKinds: ['SINGLES' as const] },
    );
    const solution = solve(orderInput(team(4), singles(4), { preset: 'WIN_FIRST', participants }));
    expect(play(solution, 'A')).toBe(4);
  });
});

describe('mixed formats', () => {
  const mixed = games([
    { id: 'g1', name: 'Singles 501', kinds: ['SINGLES', 'G501'], playerCount: 1 },
    { id: 'g2', name: 'Singles Cricket', kinds: ['SINGLES', 'CRICKET'], playerCount: 1 },
    { id: 'g3', name: 'Doubles 501', kinds: ['DOUBLES', 'G501'], playerCount: 2 },
    { id: 'g4', name: 'Doubles Cricket', kinds: ['DOUBLES', 'CRICKET'], playerCount: 2 },
    { id: 'g5', name: 'Singles 501', kinds: ['SINGLES', 'G501'], playerCount: 1 },
    { id: 'g6', name: 'Singles Cricket', kinds: ['SINGLES', 'CRICKET'], playerCount: 1 },
    { id: 'g7', name: 'Doubles 501', kinds: ['DOUBLES', 'G501'], playerCount: 2 },
    { id: 'g8', name: 'Trios', kinds: ['TRIOS'], playerCount: 3 },
  ]);

  it('T07: totals and per-role counts are measured once and agree everywhere', () => {
    const solution = solve(orderInput(team(5), mixed, { preset: 'WIN_FIRST' }));
    expect(solution.metrics.appearanceSpread).toBeLessThanOrEqual(1);
    const fielded = solution.assignments.flatMap((assignment) => assignment.playerIds);
    for (const tally of solution.tallies) {
      expect(fielded.filter((id) => id === tally.playerId).length).toBe(tally.count);
    }
    const singlesBy = solution.tallies.map((tally) => tally.countByKind.SINGLES ?? 0);
    // The metric is the largest count in any one role (Doubles and Trios included).
    expect(solution.metrics.maxRoleConcentration).toBe(
      Math.max(...solution.tallies.map((tally) => Math.max(tally.countByKind.SINGLES ?? 0, tally.countByKind.DOUBLES ?? 0, tally.countByKind.TRIOS ?? 0))),
    );
    // Four Singles over five people: nobody needs two.
    expect(Math.max(...singlesBy)).toBeLessThanOrEqual(1);
  });
});

describe('the even line-up survives pruning', () => {
  it('a tight candidate cap and node budget still end on the even split', () => {
    const input = orderInput(team(4), singles(8), {
      preset: 'WIN_FIRST',
      settings: { maxCombosPerGame: 2, nodeLimit: 50, beamWidth: 4 },
    });
    const solution = solve(input);
    expect(counts(solution)).toEqual([2, 2, 2, 2]);
    expect(solution.meta.exhaustive).toBe(false);
    expect(solution.warnings.some((warning) => warning.code === 'NOT_EXHAUSTIVE')).toBe(true);
  });
});

describe('the opponent-optimised preset obeys the same gate', () => {
  const ROSTER = team(4);
  const FORMAT = singles(4);

  function context(confidence: ConfidenceLevel, opponentStrength: number): OpponentContext {
    return {
      version: 1,
      generatedAt: 0,
      matchId: 'm1',
      matchDate: '2026-10-08',
      opponentName: 'Opp',
      leagueMeanPpr: 60,
      players: Object.fromEntries(
        ROSTER.map((entry) => [entry.id, { strength: entry.ppr!, confidence, legs: 90, imputed: false, formAdjustment: 0, first9Adjustment: 0 }]),
      ),
      games: Object.fromEntries(
        FORMAT.map((game) => [
          game.id,
          {
            gameId: game.id,
            signature: game.id,
            numPart: 1,
            legsToWin: 2,
            cricket: false,
            sides: [{ strength: opponentStrength, probability: 1 }],
            likely: [{ name: 'Opp', probability: 1 }],
            samples: 8,
            confidence,
          },
        ]),
      ),
      orderConfidence: confidence,
      confidence,
    };
  }

  const solveOpponent = (confidence: ConfidenceLevel, strength: number): OrderSolution =>
    solve({ ...orderInput(ROSTER, FORMAT, { preset: 'OPPONENT_OPTIMIZED' }), opponent: context(confidence, strength) });

  it('low-confidence opponent data does not bench anybody', () => {
    expect(counts(solveOpponent('LOW', 70))).toEqual([1, 1, 1, 1]);
  });

  it('reports the gain over the even line-up in estimated match terms when it keeps a bias', () => {
    const solution = solveOpponent('HIGH', 76);
    const gate = solution.meta.skewGate!;
    expect(gate.basis).toBe('opponent');
    if (gate.outcome === 'kept') {
      expect(gate.gain).toBeGreaterThanOrEqual(gate.required!);
      expect(Math.min(...counts(solution))).toBeGreaterThanOrEqual(0);
    } else {
      expect(counts(solution)).toEqual([1, 1, 1, 1]);
    }
  });
});
