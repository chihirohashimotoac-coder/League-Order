import { describe, expect, it } from 'vitest';
import type { DartsDiscipline, GameSlotDef, OrderInput, OrderSolution, Player, PresetKey } from '../domain/types';
import { createParticipantConfig } from '../domain/orders/participants';
import { games, orderInput, pair, player } from '../test/factories';
import { validateHardConstraints } from './constraints/validate';
import { bestShownLineUp, generateOrder } from './generateOrder';
import { describeCombo } from './candidates/combinations';
import { evaluateSelection } from './scoring/score';
import { prepare } from './prepare';

/**
 * vNext optimizer regressions: the strength model (Rating + PPR by discipline), role
 * fairness, and the three compared presets having genuinely different characters.
 *
 * Every run gets a generous budget and a single candidate so that the search completes
 * and the assertions are about the objective, not about where a clock stopped it.
 */

function solve(input: OrderInput): OrderSolution {
  const result = generateOrder(input, { singleCandidate: true, timeLimitMs: 6000 });
  if (!result.ok) throw new Error(result.diagnostics.map((d) => d.message).join(' / '));
  return result.candidates[0];
}

function run(
  roster: Player[],
  format: GameSlotDef[],
  preset: PresetKey,
  discipline: DartsDiscipline = 'UNSPECIFIED',
  overrides: Partial<Parameters<typeof orderInput>[2]> = {},
): OrderSolution {
  return solve(orderInput(roster, format, { preset, discipline, ...overrides }));
}

const countOf = (solution: OrderSolution, id: string) =>
  solution.tallies.find((tally) => tally.playerId === id)?.count ?? 0;

const singlesOf = (solution: OrderSolution, id: string) =>
  solution.tallies.find((tally) => tally.playerId === id)?.countByKind.SINGLES ?? 0;

const maxSingles = (solution: OrderSolution) =>
  Math.max(...solution.tallies.map((tally) => tally.countByKind.SINGLES ?? 0));

/** The vNext test fixture (Rt / PPR). */
function fixtureRoster(): Player[] {
  return [
    player({ id: 'pA', name: 'Player A', rating: 15, ppr: 78 }),
    player({ id: 'pB', name: 'Player B', rating: 14, ppr: 74 }),
    player({ id: 'pC', name: 'Player C', rating: 14, ppr: 67 }),
    player({ id: 'pD', name: 'Player D', rating: 11, ppr: 58 }),
    player({ id: 'pE', name: 'Player E', rating: 8, ppr: 47 }),
  ];
}

/** A very strong, B strong, C medium, D and E weak. */
function syntheticRoster(): Player[] {
  return [
    player({ id: 'pA', name: 'A', rating: 18, ppr: 95 }),
    player({ id: 'pB', name: 'B', rating: 13, ppr: 72 }),
    player({ id: 'pC', name: 'C', rating: 9, ppr: 58 }),
    player({ id: 'pD', name: 'D', rating: 5, ppr: 42 }),
    player({ id: 'pE', name: 'E', rating: 4, ppr: 40 }),
  ];
}

/** Six games, three Singles: 10 slots. */
function sixGames(): GameSlotDef[] {
  return games([
    { id: 'g1', name: 'Singles 501', kinds: ['SINGLES', 'G501'], playerCount: 1 },
    { id: 'g2', name: 'Singles Cricket', kinds: ['SINGLES', 'CRICKET'], playerCount: 1 },
    { id: 'g3', name: 'Doubles 501', kinds: ['DOUBLES', 'G501'], playerCount: 2 },
    { id: 'g4', name: 'Doubles Cricket', kinds: ['DOUBLES', 'CRICKET'], playerCount: 2 },
    { id: 'g5', name: 'Trios', kinds: ['TRIOS'], playerCount: 3 },
    { id: 'g6', name: 'Singles 501', kinds: ['SINGLES', 'G501'], playerCount: 1 },
  ]);
}

/** Eight games, four Singles, three Doubles and a Trios: 12 slots. */
function eightGames(): GameSlotDef[] {
  return games([
    { id: 'g1', name: 'Singles 501', kinds: ['SINGLES', 'G501'], playerCount: 1 },
    { id: 'g2', name: 'Singles Cricket', kinds: ['SINGLES', 'CRICKET'], playerCount: 1 },
    { id: 'g3', name: 'Doubles 501', kinds: ['DOUBLES', 'G501'], playerCount: 2 },
    { id: 'g4', name: 'Doubles Cricket', kinds: ['DOUBLES', 'CRICKET'], playerCount: 2 },
    { id: 'g5', name: 'Singles 501', kinds: ['SINGLES', 'G501'], playerCount: 1 },
    { id: 'g6', name: 'Singles Cricket', kinds: ['SINGLES', 'CRICKET'], playerCount: 1 },
    { id: 'g7', name: 'Doubles 501', kinds: ['DOUBLES', 'G501'], playerCount: 2 },
    { id: 'g8', name: 'Trios', kinds: ['TRIOS'], playerCount: 3 },
  ]);
}

// ---------------------------------------------------------------------------
// Strength model
// ---------------------------------------------------------------------------

describe('strength model in the optimizer', () => {
  /** X is the better soft player (Rating), Y the better steel player (PPR). */
  const crossed = () => [
    player({ id: 'pX', name: 'X', rating: 16, ppr: 50 }),
    player({ id: 'pY', name: 'Y', rating: 8, ppr: 90 }),
    player({ id: 'pZ', name: 'Z', rating: 12, ppr: 70 }),
  ];
  const twoSingles = () =>
    games([
      { id: 'g1', name: 'Singles 501', kinds: ['SINGLES', 'G501'], playerCount: 1 },
      { id: 'g2', name: 'Singles Cricket', kinds: ['SINGLES', 'CRICKET'], playerCount: 1 },
    ]);
  const fielded = (solution: OrderSolution) =>
    solution.assignments.flatMap((assignment) => assignment.playerIds).sort();

  it('1. soft leans on Rating', () => {
    const soft = run(crossed(), twoSingles(), 'WIN_FIRST', 'SOFT');
    expect(fielded(soft)).toEqual(['pX', 'pZ']);
    expect(soft.metrics.strengthWeights).toEqual({ rating: 0.7, ppr: 0.3 });
    expect(soft.metrics.discipline).toBe('SOFT');
  });

  it('2. steel leans on PPR', () => {
    const steel = run(crossed(), twoSingles(), 'WIN_FIRST', 'STEEL');
    expect(fielded(steel)).toEqual(['pY', 'pZ']);
    expect(steel.metrics.strengthWeights).toEqual({ rating: 0.3, ppr: 0.7 });
  });

  it('3. works with Rating only', () => {
    const roster = fixtureRoster().map((p) => ({ ...p, ppr: null }));
    const solution = run(roster, eightGames(), 'BALANCED', 'STEEL');
    expect(solution.metrics.strengthWeights).toEqual({ rating: 1, ppr: 0 });
    expect(solution.warnings.some((w) => w.code === 'NO_RATING')).toBe(false);
    expect(solution.tallies.every((tally) => tally.effectivePpr === null)).toBe(true);
  });

  it('4. works with PPR only', () => {
    const roster = fixtureRoster().map((p) => ({ ...p, rating: null }));
    const solution = run(roster, eightGames(), 'BALANCED', 'SOFT');
    expect(solution.metrics.strengthWeights).toEqual({ rating: 0, ppr: 1 });
    expect(solution.metrics.averagePpr).not.toBeNull();
    expect(solution.warnings.some((w) => w.code === 'NO_RATING')).toBe(false);
    // Rating took no part in scoring, so nothing may claim a Rating median was used.
    expect(solution.metrics.hasImputedRating).toBe(false);
    expect(solution.tallies.every((tally) => !tally.ratingImputed && tally.effectiveRating === null)).toBe(true);
    expect(solution.warnings.some((w) => w.code === 'RATING_IMPUTED')).toBe(false);
  });

  it('5. is neutral when neither metric exists', () => {
    const roster = fixtureRoster().map((p) => ({ ...p, rating: null, ppr: null }));
    const input = orderInput(roster, eightGames(), { discipline: 'STEEL' });
    const ctx = prepare(input);
    expect(ctx.strength.every((value) => value === 0.5)).toBe(true);
    const solution = solve(input);
    expect(solution.score.strength).toBe(0.5);
    expect(solution.metrics.strengthWeights).toEqual({ rating: 0, ppr: 0 });
    expect(solution.warnings.some((w) => w.code === 'NO_RATING')).toBe(true);
  });

  it('6. never treats a missing value as 0', () => {
    const roster = fixtureRoster().map((p) => (p.id === 'pA' ? { ...p, ppr: null } : p));
    const ctx = prepare(orderInput(roster, eightGames(), { discipline: 'STEEL' }));
    const a = ctx.playerIndex.get('pA')!;
    const e = ctx.playerIndex.get('pE')!;
    // A's PPR is imputed with the median (62.5), not 0 — so A is not ranked below E.
    expect(ctx.pprs.effective.get('pA')).toBe(62.5);
    expect(ctx.normPpr[a]).toBeGreaterThan(ctx.normPpr[e]);

    const solution = solve(orderInput(roster, eightGames(), { discipline: 'STEEL' }));
    const tally = solution.tallies.find((entry) => entry.playerId === 'pA')!;
    expect(tally.pprImputed).toBe(true);
    expect(tally.effectivePpr).toBe(62.5);
    expect(solution.warnings.some((w) => w.code === 'PPR_IMPUTED')).toBe(true);
  });

  it('explains the blend in the reasons', () => {
    const solution = run(fixtureRoster(), eightGames(), 'BALANCED', 'SOFT');
    const strength = solution.explanation.overall.find((factor) => factor.key === 'strength')!;
    expect(strength.detail).toContain('戦力評価 Rating 70% / PPR 30%');
    const perGame = solution.explanation.games[0].factors.find((factor) => factor.key === 'strength')!;
    expect(perGame.detail).toMatch(/Rt\.\d+ \/ PPR \d+/);
  });
});

// ---------------------------------------------------------------------------
// Presets and role fairness
// ---------------------------------------------------------------------------

describe('preset character', () => {
  const win = run(syntheticRoster(), sixGames(), 'WIN_FIRST');
  const balanced = run(syntheticRoster(), sixGames(), 'BALANCED');
  const fair = run(syntheticRoster(), sixGames(), 'FAIRNESS_FIRST');

  it('7. fairness-first minimises the total spread', () => {
    // 10 slots over 5 players divides evenly.
    expect(fair.metrics.appearanceSpread).toBe(0);
    expect(fair.metrics.appearanceSpread).toBeLessThanOrEqual(balanced.metrics.appearanceSpread);
    expect(fair.metrics.appearanceSpread).toBeLessThanOrEqual(win.metrics.appearanceSpread);
  });

  it('8. fairness-first spreads the Singles', () => {
    expect(maxSingles(fair)).toBe(1);
    expect(fair.metrics.maxRoleConcentration).toBeLessThanOrEqual(
      balanced.metrics.maxRoleConcentration ?? Infinity,
    );
  });

  it('9. win-first plays the strongest player more', () => {
    expect(countOf(win, 'pA')).toBeGreaterThan(countOf(fair, 'pA'));
    expect(singlesOf(win, 'pA')).toBeGreaterThanOrEqual(singlesOf(fair, 'pA'));
    expect(win.score.strength).toBeGreaterThan(fair.score.strength);
    // …but never benches anybody, and never by more than one game.
    expect(Math.min(...win.tallies.map((tally) => tally.count))).toBeGreaterThanOrEqual(1);
    expect(countOf(win, 'pA')).toBeLessThanOrEqual(3);
  });

  it('10. balanced sits between the two', () => {
    const a = (solution: OrderSolution) => countOf(solution, 'pA');
    expect(a(fair)).toBeLessThanOrEqual(a(balanced));
    expect(a(balanced)).toBeLessThanOrEqual(a(win));
    expect(maxSingles(fair)).toBeLessThanOrEqual(maxSingles(balanced));
    expect(maxSingles(balanced)).toBeLessThanOrEqual(maxSingles(win));
    expect(fair.score.strength).toBeLessThanOrEqual(balanced.score.strength);
    expect(balanced.score.strength).toBeLessThanOrEqual(win.score.strength);
    expect(balanced.metrics.appearanceSpread).toBeLessThanOrEqual(1);
  });

  it('makes the presets produce different orders for the same input', () => {
    const key = (solution: OrderSolution) => solution.assignments.map((a) => a.playerIds.join('.')).join('|');
    expect(key(win)).not.toBe(key(fair));
    expect(new Set([key(win), key(balanced), key(fair)]).size).toBeGreaterThanOrEqual(2);
  });
});

describe('role fairness', () => {
  it('13. never hands one player every Singles when others can play them', () => {
    for (const preset of ['WIN_FIRST', 'BALANCED', 'FAIRNESS_FIRST'] as const) {
      for (const discipline of ['SOFT', 'STEEL'] as const) {
        const solution = run(syntheticRoster(), eightGames(), preset, discipline);
        expect(maxSingles(solution), `${preset}/${discipline}`).toBeLessThan(4);
      }
    }
    const fair = run(syntheticRoster(), eightGames(), 'FAIRNESS_FIRST');
    expect(maxSingles(fair)).toBe(1);
  });

  it('14. accepts concentration when the constraints require it', () => {
    const roster = syntheticRoster();
    const participants = roster.map((p) =>
      p.id === 'pA'
        ? createParticipantConfig(p.id)
        : { ...createParticipantConfig(p.id), excludedKinds: ['SINGLES' as const] },
    );
    const solution = run(roster, eightGames(), 'FAIRNESS_FIRST', 'SOFT', {
      participants,
      settings: { consecutiveMode: 'soft' },
    });
    expect(singlesOf(solution, 'pA')).toBe(4);
    expect(solution.metrics.maxRoleConcentration).toBe(4);
    expect(validateHardConstraints(orderInput(roster, eightGames(), { participants }), solution.assignments)).toEqual([]);
  });

  it('reports role fairness in the score, the metrics and the reasons', () => {
    const solution = run(fixtureRoster(), eightGames(), 'BALANCED', 'SOFT');
    expect(solution.score.roleFairness).toBeGreaterThan(0);
    expect(solution.score.roleFairness).toBeLessThanOrEqual(1);
    const overall = solution.explanation.overall.find((factor) => factor.key === 'roleFairness');
    expect(overall?.detail).toContain('Singles 4試合');
    const singlesGame = solution.explanation.games[0].factors.find((factor) => factor.key === 'roleFairness');
    expect(singlesGame?.detail).toContain('Singles 全4試合');
  });
});

describe('11. hard constraints are never relaxed by any preset', () => {
  const roster = fixtureRoster();
  const participants = roster.map((p) => {
    const base = createParticipantConfig(p.id);
    if (p.id === 'pA') return { ...base, excludedGameIds: ['g1'], maxAppearances: 3 };
    if (p.id === 'pB') return { ...base, window: { fromOrder: 3 } };
    if (p.id === 'pC') return { ...base, excludedKinds: ['TRIOS' as const] };
    if (p.id === 'pD') return { ...base, minAppearances: 2 };
    return base;
  });
  const input = (preset: PresetKey, discipline: DartsDiscipline) =>
    orderInput(roster, eightGames(), {
      preset,
      discipline,
      participants,
      pairs: [pair('pB', 'pE', 'FORBIDDEN')],
      locks: [{ gameId: 'g8', slotIndex: 0, playerId: 'pE' }],
      settings: { consecutiveMode: 'hard' },
    });

  for (const preset of ['WIN_FIRST', 'BALANCED', 'FAIRNESS_FIRST', 'DEVELOPMENT', 'NEW_PAIR'] as const) {
    for (const discipline of ['SOFT', 'STEEL', 'UNSPECIFIED'] as const) {
      it(`${preset} / ${discipline}`, () => {
        const result = generateOrder(input(preset, discipline), { timeLimitMs: 900 });
        expect(result.ok).toBe(true);
        for (const candidate of result.candidates) {
          expect(validateHardConstraints(input(preset, discipline), candidate.assignments)).toEqual([]);
        }
      });
    }
  }
});

describe('candidates', () => {
  it('labels a preset whose own optimum was already shown as its runner-up', () => {
    const result = generateOrder(orderInput(syntheticRoster(), sixGames(), { preset: 'BALANCED' }), {
      timeLimitMs: 4000,
    });
    expect(result.ok).toBe(true);
    const [first, ...rest] = result.candidates;
    expect(first.meta.alternativeTo).toBeUndefined();
    // Balanced and fairness-first share their optimum for this roster: the fairness-first
    // candidate is therefore a different order, and says why.
    const fairness = rest.find((candidate) => candidate.meta.presetKey === 'FAIRNESS_FIRST');
    expect(fairness?.meta.alternativeTo).toBe('バランス');
    // Win-first has an optimum of its own.
    const win = rest.find((candidate) => candidate.meta.presetKey === 'WIN_FIRST');
    expect(win?.meta.alternativeTo).toBeUndefined();
  });

  it('never claims a shared optimum when the search was not exhaustive', () => {
    // Capped candidate sets make every run incomplete: nothing is proven optimal, so no
    // candidate may say it shares an optimum with another.
    const result = generateOrder(
      orderInput(syntheticRoster(), sixGames(), { preset: 'BALANCED', settings: { maxCombosPerGame: 2 } }),
      { timeLimitMs: 2000 },
    );
    expect(result.ok).toBe(true);
    for (const candidate of result.candidates) {
      expect(candidate.meta.exhaustive).toBe(false);
      expect(candidate.meta.alternativeTo).toBeUndefined();
    }
  });

  it('names the highest-scoring shown line-up as the shared optimum, not the first one', () => {
    const ctx = prepare(orderInput(syntheticRoster(), sixGames(), { preset: 'FAIRNESS_FIRST' }));
    const lineUp = (members: string[][]) => ({ members });
    const total = (members: string[][]) =>
      evaluateSelection(
        ctx,
        members.map((ids, gi) =>
          describeCombo(ctx, gi, ids.map((id) => ctx.playerIndex.get(id)!).sort((a, b) => a - b)),
        ),
      ).breakdown.total;
    // Perfectly even (every player twice, one Single each for three of them) against a
    // line-up that gives A three games: the even one scores higher under fairness-first.
    const even = [['pA'], ['pB'], ['pC', 'pD'], ['pA', 'pE'], ['pB', 'pD', 'pE'], ['pC']];
    const skewed = [['pA'], ['pA'], ['pB', 'pC'], ['pA', 'pD'], ['pB', 'pC', 'pE'], ['pD']];
    expect(total(even)).toBeGreaterThan(total(skewed));
    const achieved = Math.min(total(even), total(skewed)) - 0.5;
    // The weaker line-up was shown first; the stronger one is still the shared optimum.
    const shown = [
      { label: '勝利優先', ...lineUp(skewed) },
      { label: 'バランス', ...lineUp(even) },
    ];
    expect(bestShownLineUp(ctx, shown, achieved)).toBe('バランス');
    // Nothing reaches the run's own result: no claim at all.
    expect(bestShownLineUp(ctx, shown, total(even) + 1)).toBeUndefined();
  });
});
