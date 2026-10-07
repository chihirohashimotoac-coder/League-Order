import { describe, expect, it } from 'vitest';
import type { OrderInput, OrderSolution, PlayerId } from '../domain/types';
import type { OpponentContext, OpponentSide } from '../domain/prediction/opponentContext';
import type { ConfidenceLevel } from '../domain/prediction/confidence';
import { CANDIDATE_PRESETS, PRESETS } from '../domain/orders/presets';
import { predictOrder } from '../domain/prediction/predictOrder';
import { evaluateManualOrder, generateOrder } from './generateOrder';
import { validateHardConstraints } from './constraints/validate';
import { createParticipantConfig } from '../domain/orders/participants';
import { games, orderInput, pair, player } from '../test/factories';

/**
 * Opponent-aware optimisation (MASTER SPEC Phase 4) on synthetic opponents whose
 * line-ups are known, so the effect of the opponent term can be checked exactly.
 */

const ROSTER = [70, 64, 58, 52, 46, 40].map((ppr, index) =>
  player({ id: `p${index + 1}`, name: `P${index + 1}`, ppr, rating: 20 - index }),
);

const FORMAT = games([
  { id: 's1', name: 'Singles 501', kinds: ['SINGLES', 'G501'], playerCount: 1 },
  { id: 'd1', name: 'Doubles 501', kinds: ['DOUBLES', 'G501'], playerCount: 2 },
  { id: 's2', name: 'Singles 501', kinds: ['SINGLES', 'G501'], playerCount: 1 },
  { id: 's3', name: 'Singles 501', kinds: ['SINGLES', 'G501'], playerCount: 1 },
  { id: 'd2', name: 'Doubles 501', kinds: ['DOUBLES', 'G501'], playerCount: 2 },
  { id: 's4', name: 'Singles 501', kinds: ['SINGLES', 'G501'], playerCount: 1 },
]);

function context(
  sides: Record<string, OpponentSide[]>,
  confidence: ConfidenceLevel = 'HIGH',
): OpponentContext {
  return {
    version: 1,
    generatedAt: 0,
    matchId: 'm1',
    matchDate: '2026-10-08',
    opponentName: 'スピンコブラ',
    leagueMeanPpr: 52,
    players: Object.fromEntries(
      ROSTER.map((entry) => [entry.id, { strength: entry.ppr!, confidence: 'HIGH', legs: 60, imputed: false, formAdjustment: 0, first9Adjustment: 0 }]),
    ),
    games: Object.fromEntries(
      FORMAT.map((game) => [
        game.id,
        {
          gameId: game.id,
          signature: game.id,
          numPart: game.playerCount,
          legsToWin: 2,
          cricket: false,
          sides: sides[game.id] ?? [{ strength: 52, probability: 1 }],
          likely: [{ name: '相手', probability: 1 }],
          samples: 8,
          confidence,
        },
      ]),
    ),
    orderConfidence: confidence,
    confidence,
  };
}

const at = (strength: number): OpponentSide[] => [{ strength, probability: 1 }];

/** Their ace plays Singles 1; everyone else in Singles is weak. */
const ACE_FIRST = context({ s1: at(78), s2: at(44), s3: at(44), s4: at(44), d1: at(56), d2: at(56) });
/** The same team, but the ace plays Singles 4. */
const ACE_LAST = context({ s1: at(44), s2: at(44), s3: at(44), s4: at(78), d1: at(56), d2: at(56) });

function input(opponent: OpponentContext | undefined, overrides: Parameters<typeof orderInput>[2] = {}): OrderInput {
  return { ...orderInput(ROSTER, FORMAT, { preset: 'OPPONENT_OPTIMIZED', ...overrides }), opponent };
}

function run(opponent: OpponentContext | undefined, overrides: Parameters<typeof orderInput>[2] = {}): OrderSolution[] {
  const result = generateOrder(input(opponent, overrides), { timeLimitMs: 4000 });
  if (!result.ok) throw new Error(result.diagnostics.map((d) => d.message).join());
  return result.candidates;
}

function playerIn(solution: OrderSolution, gameId: string): PlayerId[] {
  return solution.assignments.find((assignment) => assignment.gameId === gameId)!.playerIds;
}

describe('the opponent-optimised preset', () => {
  it('is a new preset; the existing presets are unchanged', () => {
    expect(PRESETS.OPPONENT_OPTIMIZED.label).toBe('対戦相手最適化');
    expect(PRESETS.OPPONENT_OPTIMIZED.weights.opponentWin).toBeGreaterThan(0);
    for (const key of ['WIN_FIRST', 'BALANCED', 'FAIRNESS_FIRST', 'DEVELOPMENT', 'NEW_PAIR'] as const) {
      expect(PRESETS[key].weights.opponentWin ?? 0).toBe(0);
    }
    expect(CANDIDATE_PRESETS).toEqual(['WIN_FIRST', 'BALANCED', 'FAIRNESS_FIRST']);
  });

  it('compares four candidates, each with an estimated match outcome', () => {
    const candidates = run(ACE_FIRST);
    expect(candidates.map((candidate) => candidate.meta.label)).toEqual(['対戦相手最適化', '勝利優先', 'バランス', '公平性優先']);
    for (const candidate of candidates) {
      expect(candidate.prediction).toBeDefined();
      expect(candidate.prediction!.win + candidate.prediction!.draw + candidate.prediction!.loss).toBeCloseTo(1, 9);
      expect(candidate.explanation.overall[0]).toMatchObject({ key: 'opponent' });
    }
  });

  it('raises the estimated match win probability over 勝利優先', () => {
    const [opponentOptimised, winFirst] = run(ACE_FIRST);
    expect(opponentOptimised.prediction!.win).toBeGreaterThan(winFirst.prediction!.win);
    expect(opponentOptimised.meta.opponent).toMatchObject({ mode: 'applied' });
  });

  it('answers a different opponent line-up with a different order', () => {
    const [first] = run(ACE_FIRST);
    const [last] = run(ACE_LAST);
    expect(first.assignments).not.toEqual(last.assignments);
    // The player sent against their ace is not our best one.
    expect(playerIn(first, 's1')).not.toEqual(['p1']);
    expect(playerIn(last, 's4')).not.toEqual(['p1']);
  });

  it('optimises against the whole distribution, not only the most likely opponent', () => {
    // Singles 1: 55% a weak player, 45% their ace. Against the mode alone the slot looks
    // easy; against the distribution it is a coin flip that a strong player may not be
    // worth spending on.
    const mixed = context({
      s1: [{ strength: 44, probability: 0.55 }, { strength: 80, probability: 0.45 }],
      s2: at(50),
      s3: at(50),
      s4: at(50),
      d1: at(56),
      d2: at(56),
    });
    const [solution] = run(mixed);
    const recomputed = predictOrder(mixed, solution.assignments)!;
    expect(solution.prediction!.win).toBeCloseTo(recomputed.win, 9);
    const s1 = solution.prediction!.games.find((game) => game.gameId === 's1')!;
    const modeOnly = predictOrder(context({ s1: at(44), s2: at(50), s3: at(50), s4: at(50), d1: at(56), d2: at(56) }), solution.assignments)!;
    expect(s1.probability).toBeLessThan(modeOnly.games.find((game) => game.gameId === 's1')!.probability);
  });

  it('keeps fairness: the ace does not take every Singles, and nobody is left out', () => {
    const [solution] = run(ACE_FIRST);
    const singles = ['s1', 's2', 's3', 's4'].flatMap((id) => playerIn(solution, id));
    expect(singles.filter((id) => id === 'p1').length).toBeLessThanOrEqual(2);
    expect(solution.metrics.appearanceSpread).toBeLessThanOrEqual(1);
    expect(solution.tallies.every((tally) => tally.count >= 1)).toBe(true);
  });
});

describe('robustness and fallback', () => {
  it('weakens the opponent term for low-confidence data and shifts it to strength', () => {
    const low = context({ s1: at(78), s2: at(44), s3: at(44), s4: at(44), d1: at(56), d2: at(56) }, 'LOW');
    const [solution] = run(low);
    const base = PRESETS.OPPONENT_OPTIMIZED.weights.opponentWin!;
    expect(solution.meta.opponent).toMatchObject({ mode: 'reduced', confidence: 'LOW', baseWeight: base });
    expect(solution.meta.opponent!.effectiveWeight).toBeCloseTo(base * 0.35, 12);
    expect(solution.warnings.some((warning) => warning.code === 'OPPONENT_WEIGHT_REDUCED')).toBe(true);
  });

  it('without opponent data it falls back to the ordinary win-first optimisation and says so', () => {
    const [solution] = run(undefined);
    expect(solution.meta.opponent).toMatchObject({ mode: 'fallback', effectiveWeight: 0 });
    expect(solution.prediction).toBeUndefined();
    expect(solution.warnings.some((warning) => warning.code === 'OPPONENT_DATA_MISSING')).toBe(true);
  });

  it('opponent data never changes what another preset chooses — it only adds the estimate', () => {
    for (const preset of ['WIN_FIRST', 'BALANCED', 'FAIRNESS_FIRST'] as const) {
      const plain = generateOrder(orderInput(ROSTER, FORMAT, { preset }), { singleCandidate: true, timeLimitMs: 4000 });
      const informed = generateOrder({ ...orderInput(ROSTER, FORMAT, { preset }), opponent: ACE_FIRST }, { singleCandidate: true, timeLimitMs: 4000 });
      if (!plain.ok || !informed.ok) throw new Error('should be satisfiable');
      expect(informed.candidates[0].assignments).toEqual(plain.candidates[0].assignments);
      expect(informed.candidates[0].score.total).toBeCloseTo(plain.candidates[0].score.total, 12);
      expect(plain.candidates[0].prediction).toBeUndefined();
      expect(informed.candidates[0].prediction).toBeDefined();
    }
  });

  it('is deterministic', () => {
    expect(run(ACE_FIRST)[0].assignments).toEqual(run(ACE_FIRST)[0].assignments);
  });
});

describe('hard constraints are never broken for the opponent', () => {
  it('respects exclusions, windows, caps, locks and forbidden pairs', () => {
    const participants = ROSTER.map((entry) => createParticipantConfig(entry.id));
    participants[0] = { ...participants[0], excludedGameIds: ['s2', 's3'], maxAppearances: 1 };
    participants[1] = { ...participants[1], window: { fromOrder: 3 } };
    participants[2] = { ...participants[2], excludedKinds: ['DOUBLES'] };
    const locks = [{ gameId: 's1', slotIndex: 0, playerId: 'p6' }];
    const pairs = [pair('p4', 'p5', 'FORBIDDEN')];
    for (const opponent of [ACE_FIRST, ACE_LAST]) {
      const candidates = run(opponent, { participants, locks, pairs });
      for (const candidate of candidates) {
        expect(validateHardConstraints(input(opponent, { participants, locks, pairs }), candidate.assignments)).toEqual([]);
        expect(playerIn(candidate, 's1')).toEqual(['p6']);
      }
    }
  });

  it('a hand edit is re-estimated live', () => {
    const [solution] = run(ACE_FIRST);
    // Swap Singles 1 with a Singles game played by somebody else.
    const other = ['s2', 's3', 's4'].find((id) => playerIn(solution, id)[0] !== playerIn(solution, 's1')[0])!;
    const swapped = solution.assignments.map((assignment) =>
      assignment.gameId === 's1'
        ? { ...assignment, playerIds: [...playerIn(solution, other)] }
        : assignment.gameId === other
          ? { ...assignment, playerIds: [...playerIn(solution, 's1')] }
          : assignment,
    );
    const edited = evaluateManualOrder(input(ACE_FIRST), swapped);
    expect(edited.solution?.prediction).toBeDefined();
    expect(edited.solution!.prediction!.win).not.toBeCloseTo(solution.prediction!.win, 6);
  });
});
