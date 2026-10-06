import { describe, expect, it } from 'vitest';
import type { GameAssignment, OrderInput, OrderSolution } from '../domain/types';
import { validateHardConstraints } from './constraints/validate';
import { evaluateManualOrder, generateOrder, reoptimise } from './generateOrder';
import {
  games,
  orderInput,
  pair,
  player,
  sampleFormatGames,
  sampleFormatGames11,
  sampleRoster,
} from '../test/factories';
import { createParticipantConfig } from '../domain/orders/participants';

function expectOk(result: ReturnType<typeof generateOrder>): OrderSolution[] {
  if (!result.ok) {
    throw new Error(
      `generation failed: ${result.diagnostics.map((d) => d.message).join(' / ')}`,
    );
  }
  return result.candidates;
}

function countsOf(solution: OrderSolution): Map<string, number> {
  const counts = new Map<string, number>();
  for (const assignment of solution.assignments) {
    for (const playerId of assignment.playerIds) {
      counts.set(playerId, (counts.get(playerId) ?? 0) + 1);
    }
  }
  return counts;
}

function assertNoHardViolation(input: OrderInput, solution: OrderSolution): void {
  expect(validateHardConstraints(input, solution.assignments)).toEqual([]);
}

// ---------------------------------------------------------------------------
// Baseline: the sample from spec §38
// ---------------------------------------------------------------------------

describe('spec §38 sample (5 players rated 14/14/11/8/4, Singles+Doubles+Trios)', () => {
  const roster = sampleRoster();
  const gameDefs = sampleFormatGames();

  it('fills every game with the required number of distinct players', () => {
    const input = orderInput(roster, gameDefs);
    const [best] = expectOk(generateOrder(input));
    expect(best.assignments).toHaveLength(gameDefs.length);
    for (const assignment of best.assignments) {
      const game = gameDefs.find((g) => g.id === assignment.gameId)!;
      expect(assignment.playerIds).toHaveLength(game.playerCount);
      expect(new Set(assignment.playerIds).size).toBe(game.playerCount);
    }
    assertNoHardViolation(input, best);
  });

  it('gives all five players exactly 2 appearances for 10 slots', () => {
    const input = orderInput(roster, gameDefs);
    const [best] = expectOk(generateOrder(input));
    const counts = countsOf(best);
    expect([...counts.values()].sort()).toEqual([2, 2, 2, 2, 2]);
    expect(best.metrics.appearanceSpread).toBe(0);
    expect(best.metrics.totalSlots).toBe(10);
  });

  it('keeps the max spread at 1 for 11 slots that cannot divide evenly', () => {
    const input = orderInput(roster, sampleFormatGames11());
    const [best] = expectOk(generateOrder(input));
    const counts = [...countsOf(best).values()].sort((a, b) => b - a);
    expect(counts.reduce((a, b) => a + b, 0)).toBe(11);
    expect(counts).toEqual([3, 2, 2, 2, 2]);
    expect(best.metrics.appearanceSpread).toBe(1);
  });

  it('reports metrics, tallies and reasons for every game', () => {
    const input = orderInput(roster, gameDefs);
    const [best] = expectOk(generateOrder(input));
    expect(best.tallies).toHaveLength(5);
    expect(best.metrics.averageRating).not.toBeNull();
    expect(best.explanation.games).toHaveLength(gameDefs.length);
    for (const explanation of best.explanation.games) {
      expect(explanation.factors.length).toBeGreaterThan(0);
      // Every game must carry a rating, aptitude, fairness and hard-constraint reason.
      const keys = explanation.factors.map((factor) => factor.key);
      expect(keys).toContain('strength');
      expect(keys).toContain('gameFit');
      expect(keys).toContain('fairness');
      expect(keys).toContain('constraint');
    }
    expect(best.explanation.overall.length).toBeGreaterThan(2);
  });

  it('returns several distinct candidates to compare', () => {
    const candidates = expectOk(generateOrder(orderInput(roster, gameDefs)));
    expect(candidates.length).toBeGreaterThanOrEqual(2);
    const labels = candidates.map((candidate) => candidate.meta.label);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it('is reproducible: the same input yields the same assignment', () => {
    const input = orderInput(roster, gameDefs);
    const first = expectOk(generateOrder(input))[0];
    const second = expectOk(generateOrder(input))[0];
    expect(second.assignments).toEqual(first.assignments);
  });
});

// ---------------------------------------------------------------------------
// §32 Hard Constraints
// ---------------------------------------------------------------------------

describe('hard constraints', () => {
  const roster = sampleRoster();
  const gameDefs = sampleFormatGames();

  it('never fields a player in a game they are excluded from', () => {
    const participants = roster.map((p) => createParticipantConfig(p.id));
    participants[0] = { ...participants[0], excludedGameIds: ['g1', 'g5'] };
    const input = orderInput(roster, gameDefs, { participants });
    for (const solution of expectOk(generateOrder(input))) {
      const g1 = solution.assignments.find((a) => a.gameId === 'g1')!;
      const g5 = solution.assignments.find((a) => a.gameId === 'g5')!;
      expect(g1.playerIds).not.toContain('p1');
      expect(g5.playerIds).not.toContain('p1');
      assertNoHardViolation(input, solution);
    }
  });

  it('never fields a player in a kind they are excluded from', () => {
    const participants = roster.map((p) => createParticipantConfig(p.id));
    // p2 cannot play Cricket at all; g2 and g4 both carry CRICKET.
    participants[1] = { ...participants[1], excludedKinds: ['CRICKET'] };
    const input = orderInput(roster, gameDefs, { participants });
    for (const solution of expectOk(generateOrder(input))) {
      for (const assignment of solution.assignments) {
        const game = gameDefs.find((g) => g.id === assignment.gameId)!;
        if (game.kinds.includes('CRICKET')) expect(assignment.playerIds).not.toContain('p2');
      }
      assertNoHardViolation(input, solution);
    }
  });

  it('respects an appearance window (a player who arrives late)', () => {
    const participants = roster.map((p) => createParticipantConfig(p.id));
    participants[4] = { ...participants[4], window: { fromOrder: 4 } };
    const input = orderInput(roster, gameDefs, { participants });
    for (const solution of expectOk(generateOrder(input))) {
      for (const assignment of solution.assignments) {
        const game = gameDefs.find((g) => g.id === assignment.gameId)!;
        if (game.order < 4) expect(assignment.playerIds).not.toContain('p5');
      }
      assertNoHardViolation(input, solution);
    }
  });

  it('respects an appearance window (a player who leaves early)', () => {
    const participants = roster.map((p) => createParticipantConfig(p.id));
    participants[3] = { ...participants[3], window: { toOrder: 3 } };
    const input = orderInput(roster, gameDefs, { participants });
    for (const solution of expectOk(generateOrder(input))) {
      for (const assignment of solution.assignments) {
        const game = gameDefs.find((g) => g.id === assignment.gameId)!;
        if (game.order > 3) expect(assignment.playerIds).not.toContain('p4');
      }
      assertNoHardViolation(input, solution);
    }
  });

  it('never exceeds a maximum appearance count', () => {
    const participants = roster.map((p) => createParticipantConfig(p.id));
    participants[0] = { ...participants[0], maxAppearances: 1 };
    participants[1] = { ...participants[1], maxAppearances: 1 };
    const input = orderInput(roster, gameDefs, { participants });
    for (const solution of expectOk(generateOrder(input))) {
      const counts = countsOf(solution);
      expect(counts.get('p1') ?? 0).toBeLessThanOrEqual(1);
      expect(counts.get('p2') ?? 0).toBeLessThanOrEqual(1);
      assertNoHardViolation(input, solution);
    }
  });

  it('satisfies a hard minimum appearance count', () => {
    const participants = roster.map((p) => createParticipantConfig(p.id));
    participants[4] = { ...participants[4], minAppearances: 3 };
    const input = orderInput(roster, gameDefs, { participants });
    for (const solution of expectOk(generateOrder(input))) {
      expect(countsOf(solution).get('p5') ?? 0).toBeGreaterThanOrEqual(3);
      assertNoHardViolation(input, solution);
    }
  });

  it('never places a forbidden pair in the same game', () => {
    const input = orderInput(roster, gameDefs, {
      pairs: [pair('p1', 'p2', 'FORBIDDEN'), pair('p3', 'p4', 'FORBIDDEN')],
    });
    for (const solution of expectOk(generateOrder(input))) {
      for (const assignment of solution.assignments) {
        const ids = new Set(assignment.playerIds);
        expect(ids.has('p1') && ids.has('p2')).toBe(false);
        expect(ids.has('p3') && ids.has('p4')).toBe(false);
      }
      assertNoHardViolation(input, solution);
    }
  });

  it('keeps locked placements exactly where they were pinned', () => {
    const input = orderInput(roster, gameDefs, {
      locks: [
        { gameId: 'g6', slotIndex: 0, playerId: 'p5' },
        { gameId: 'g3', slotIndex: 1, playerId: 'p1' },
      ],
    });
    for (const solution of expectOk(generateOrder(input))) {
      const g6 = solution.assignments.find((a) => a.gameId === 'g6')!;
      const g3 = solution.assignments.find((a) => a.gameId === 'g3')!;
      expect(g6.playerIds[0]).toBe('p5');
      expect(g3.playerIds[1]).toBe('p1');
      assertNoHardViolation(input, solution);
    }
  });

  it('honours a hard consecutive-appearance limit', () => {
    const input = orderInput(roster, gameDefs, {
      settings: { consecutiveMode: 'hard', defaultMaxConsecutive: 2 },
    });
    for (const solution of expectOk(generateOrder(input))) {
      for (const tally of solution.tallies) {
        expect(tally.maxConsecutive).toBeLessThanOrEqual(2);
      }
      assertNoHardViolation(input, solution);
    }
  });

  it('excludes a player marked absent', () => {
    const participants = roster.map((p) => createParticipantConfig(p.id));
    participants[2] = { ...participants[2], include: false };
    const input = orderInput(roster, gameDefs, { participants });
    for (const solution of expectOk(generateOrder(input))) {
      for (const assignment of solution.assignments) {
        expect(assignment.playerIds).not.toContain('p3');
      }
      assertNoHardViolation(input, solution);
    }
  });

  it('combines several hard constraints at once without violating any', () => {
    const participants = roster.map((p) => createParticipantConfig(p.id));
    participants[0] = { ...participants[0], excludedKinds: ['TRIOS'], maxAppearances: 2 };
    participants[1] = { ...participants[1], excludedGameIds: ['g1'] };
    participants[2] = { ...participants[2], window: { fromOrder: 2 } };
    participants[4] = { ...participants[4], minAppearances: 2 };
    const input = orderInput(roster, gameDefs, {
      participants,
      pairs: [pair('p1', 'p2', 'FORBIDDEN')],
      locks: [{ gameId: 'g2', slotIndex: 0, playerId: 'p4' }],
    });
    const solutions = expectOk(generateOrder(input));
    expect(solutions.length).toBeGreaterThan(0);
    for (const solution of solutions) assertNoHardViolation(input, solution);
  });
});

// ---------------------------------------------------------------------------
// §32 Fairness
// ---------------------------------------------------------------------------

describe('fairness', () => {
  it('keeps win-first within one extra game of an even split, and spreads balanced evenly', () => {
    // Win-first may hand its strongest player one extra game (vNext: "強い選手の出場増加を
    // 許容する"), but the convex part of the fairness score stops it from going further.
    // The hard max-appearance cap is the full game count here, so only the fairness
    // weight keeps the two strongest players from taking every slot.
    const input = orderInput(sampleRoster(), sampleFormatGames(), { preset: 'WIN_FIRST' });
    const [best] = expectOk(generateOrder(input));
    expect(best.metrics.appearanceSpread).toBeLessThanOrEqual(2);
    const counts = [...countsOf(best).values()];
    expect(Math.max(...counts)).toBeLessThanOrEqual(3);
    expect(Math.min(...counts)).toBeGreaterThanOrEqual(1);
    expect(counts).toHaveLength(5);

    const balanced = expectOk(generateOrder(orderInput(sampleRoster(), sampleFormatGames())))[0];
    expect(balanced.metrics.appearanceSpread).toBeLessThanOrEqual(1);
  });

  it('never leaves a participant on the bench when the slots allow everyone to play', () => {
    const input = orderInput(sampleRoster(), sampleFormatGames(), { preset: 'WIN_FIRST' });
    for (const solution of expectOk(generateOrder(input))) {
      const counts = countsOf(solution);
      for (const p of sampleRoster()) expect(counts.get(p.id) ?? 0).toBeGreaterThan(0);
    }
  });

  it('prioritises the players with fewer season appearances under the development preset', () => {
    const roster = [
      player({ id: 'p1', name: 'Veteran A', rating: 14, seasonAppearances: 20 }),
      player({ id: 'p2', name: 'Veteran B', rating: 13, seasonAppearances: 18 }),
      player({ id: 'p3', name: 'Rookie C', rating: 6, seasonAppearances: 1 }),
      player({ id: 'p4', name: 'Rookie D', rating: 5, seasonAppearances: 0 }),
    ];
    const gameDefs = games([
      { id: 'g1', name: 'Singles 1', kinds: ['SINGLES', 'G501'], playerCount: 1 },
      { id: 'g2', name: 'Singles 2', kinds: ['SINGLES', 'CRICKET'], playerCount: 1 },
      { id: 'g3', name: 'Doubles', kinds: ['DOUBLES', 'G501'], playerCount: 2 },
    ]);
    const input = orderInput(roster, gameDefs, {
      preset: 'DEVELOPMENT',
      settings: { fairnessScope: 'season' },
    });
    const [best] = expectOk(generateOrder(input));
    const counts = countsOf(best);
    const rookies = (counts.get('p3') ?? 0) + (counts.get('p4') ?? 0);
    const veterans = (counts.get('p1') ?? 0) + (counts.get('p2') ?? 0);
    expect(rookies).toBeGreaterThan(veterans);
  });

  it('gives the fairness-first preset a better or equal fairness score than win-first', () => {
    const roster = sampleRoster();
    const gameDefs = sampleFormatGames11();
    const fair = expectOk(generateOrder(orderInput(roster, gameDefs, { preset: 'FAIRNESS_FIRST' })))[0];
    const win = expectOk(generateOrder(orderInput(roster, gameDefs, { preset: 'WIN_FIRST' })))[0];
    expect(fair.metrics.fairnessExcess).toBeLessThanOrEqual(win.metrics.fairnessExcess);
  });
});

// ---------------------------------------------------------------------------
// §32 Rating / Unknown Rating
// ---------------------------------------------------------------------------

describe('rating handling', () => {
  const strengthRoster = () => [
    player({ id: 'p1', name: 'Strong', rating: 18 }),
    player({ id: 'p2', name: 'Mid', rating: 10 }),
    player({ id: 'p3', name: 'Low', rating: 3 }),
  ];
  const singles = (count: number) =>
    games(
      Array.from({ length: count }, (_, i) => ({
        id: `g${i + 1}`,
        name: `S${i + 1}`,
        kinds: ['SINGLES', 'G501'] as const,
        playerCount: 1,
      })).map((spec) => ({ ...spec, kinds: [...spec.kinds] })),
    );

  it('leans on the stronger player under the win-first preset', () => {
    const input = orderInput(strengthRoster(), singles(3), { preset: 'WIN_FIRST' });
    const [best] = expectOk(generateOrder(input));
    const counts = countsOf(best);
    expect(counts.get('p1') ?? 0).toBeGreaterThanOrEqual(counts.get('p3') ?? 0);
  });

  it('does not let the strongest player take every slot even under win-first', () => {
    // Spec §32: strength must not bias without limit. With 3 slots the strongest
    // player is preferred, but the fairness weight (never 0, even for win-first) and
    // the consecutive-appearance penalty together stop a clean sweep.
    const input = orderInput(strengthRoster(), singles(3), { preset: 'WIN_FIRST' });
    const [best] = expectOk(generateOrder(input));
    expect(countsOf(best).get('p1') ?? 0).toBeLessThan(3);
  });

  it('lets the ace take at most one extra game of a roomier schedule under win-first', () => {
    // 6 slots over 3 players. Win-first may give the ace a third game (3/2/1) — never a
    // fourth, and never benches anyone — while the balanced preset still splits 2/2/2.
    const win = expectOk(generateOrder(orderInput(strengthRoster(), singles(6), { preset: 'WIN_FIRST' })))[0];
    const winCounts = [...countsOf(win).values()];
    expect(Math.max(...winCounts)).toBeLessThanOrEqual(3);
    expect(Math.min(...winCounts)).toBeGreaterThanOrEqual(1);
    expect(countsOf(win).get('p1') ?? 0).toBeGreaterThanOrEqual(countsOf(win).get('p3') ?? 0);

    const balanced = expectOk(generateOrder(orderInput(strengthRoster(), singles(6), { preset: 'BALANCED' })))[0];
    expect([...countsOf(balanced).values()].sort()).toEqual([2, 2, 2]);
    expect(balanced.metrics.appearanceSpread).toBe(0);
  });

  it('does not treat an unknown rating as 0', () => {
    const roster = [
      player({ id: 'p1', name: 'Known high', rating: 15 }),
      player({ id: 'p2', name: 'Unknown', rating: null }),
      player({ id: 'p3', name: 'Known low', rating: 2 }),
    ];
    const gameDefs = games([
      { id: 'g1', name: 'S1', kinds: ['SINGLES', 'G501'], playerCount: 1 },
      { id: 'g2', name: 'S2', kinds: ['SINGLES', 'G501'], playerCount: 1 },
    ]);
    const input = orderInput(roster, gameDefs, { preset: 'WIN_FIRST' });
    const [best] = expectOk(generateOrder(input));
    const counts = countsOf(best);
    // Only two slots for three players. With median imputation the unknown player is
    // rated 15 (the median of {15, 2} is 8.5 — above the known low), so the weakest
    // known player sits out, not the unknown one. Treating null as 0 would have
    // benched the unknown player instead.
    expect(counts.get('p2') ?? 0).toBeGreaterThan(0);
    const unknownTally = best.tallies.find((tally) => tally.playerId === 'p2')!;
    expect(unknownTally.ratingImputed).toBe(true);
    expect(unknownTally.effectiveRating).not.toBe(0);
    expect(unknownTally.effectiveRating).toBeCloseTo(8.5, 10);
  });

  it('gives an unknown-rating player the same playing time as the rest', () => {
    const roster = [
      player({ id: 'p1', name: 'A', rating: 14 }),
      player({ id: 'p2', name: 'B', rating: 11 }),
      player({ id: 'p3', name: 'C', rating: null }),
      player({ id: 'p4', name: 'D', rating: 8 }),
      player({ id: 'p5', name: 'E', rating: 4 }),
    ];
    const input = orderInput(roster, sampleFormatGames());
    const [best] = expectOk(generateOrder(input));
    expect(countsOf(best).get('p3')).toBe(2);
  });

  it('works with no ratings at all and says so', () => {
    const roster = [
      player({ id: 'p1', name: 'A', skills: { SINGLES: 5 } }),
      player({ id: 'p2', name: 'B', skills: { DOUBLES: 5 } }),
      player({ id: 'p3', name: 'C' }),
      player({ id: 'p4', name: 'D' }),
      player({ id: 'p5', name: 'E' }),
    ];
    const input = orderInput(roster, sampleFormatGames());
    const [best] = expectOk(generateOrder(input));
    expect(best.metrics.averageRating).toBeNull();
    expect([...countsOf(best).values()].sort()).toEqual([2, 2, 2, 2, 2]);
    expect(best.warnings.some((warning) => warning.code === 'NO_RATING')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// §32 Pair affinity
// ---------------------------------------------------------------------------

describe('pair affinity', () => {
  it('prefers a very-good pair over a discouraged one when the rest is symmetric', () => {
    const roster = [
      player({ id: 'p1', name: 'A', rating: 10 }),
      player({ id: 'p2', name: 'B', rating: 10 }),
      player({ id: 'p3', name: 'C', rating: 10 }),
      player({ id: 'p4', name: 'D', rating: 10 }),
    ];
    const gameDefs = games([
      { id: 'g1', name: 'Doubles 1', kinds: ['DOUBLES', 'G501'], playerCount: 2 },
      { id: 'g2', name: 'Doubles 2', kinds: ['DOUBLES', 'CRICKET'], playerCount: 2 },
    ]);
    const input = orderInput(roster, gameDefs, {
      pairs: [pair('p1', 'p2', 'VERY_GOOD'), pair('p3', 'p4', 'VERY_GOOD'), pair('p1', 'p3', 'DISCOURAGED')],
    });
    const [best] = expectOk(generateOrder(input));
    const pairsPlayed = best.assignments.map((a) => [...a.playerIds].sort().join('-'));
    expect(pairsPlayed).toContain('p1-p2');
    expect(pairsPlayed).toContain('p3-p4');
  });

  it('prefers unfamiliar pairs under the new-pair preset', () => {
    const roster = [
      player({ id: 'p1', name: 'A', rating: 10 }),
      player({ id: 'p2', name: 'B', rating: 10 }),
      player({ id: 'p3', name: 'C', rating: 10 }),
      player({ id: 'p4', name: 'D', rating: 10 }),
    ];
    const gameDefs = games([
      { id: 'g1', name: 'Doubles 1', kinds: ['DOUBLES', 'G501'], playerCount: 2 },
      { id: 'g2', name: 'Doubles 2', kinds: ['DOUBLES', 'CRICKET'], playerCount: 2 },
    ]);
    const input = orderInput(roster, gameDefs, {
      preset: 'NEW_PAIR',
      pairs: [
        pair('p1', 'p2', 'NEUTRAL', 20),
        pair('p3', 'p4', 'NEUTRAL', 20),
        pair('p1', 'p3', 'NEUTRAL', 0),
        pair('p2', 'p4', 'NEUTRAL', 0),
      ],
    });
    const [best] = expectOk(generateOrder(input));
    const pairsPlayed = best.assignments.map((a) => [...a.playerIds].sort().join('-'));
    expect(pairsPlayed).not.toContain('p1-p2');
    expect(pairsPlayed).not.toContain('p3-p4');
  });
});

// ---------------------------------------------------------------------------
// §32 Game aptitude
// ---------------------------------------------------------------------------

describe('game aptitude', () => {
  it('fields the specialist in their own discipline when ratings are equal', () => {
    const roster = [
      player({ id: 'p1', name: 'Cricket specialist', rating: 10, skills: { CRICKET: 5, G501: 1 } }),
      player({ id: 'p2', name: '501 specialist', rating: 10, skills: { CRICKET: 1, G501: 5 } }),
    ];
    const gameDefs = games([
      { id: 'g1', name: 'Singles Cricket', kinds: ['SINGLES', 'CRICKET'], playerCount: 1 },
      { id: 'g2', name: 'Singles 501', kinds: ['SINGLES', 'G501'], playerCount: 1 },
    ]);
    const input = orderInput(roster, gameDefs, { preset: 'WIN_FIRST' });
    const [best] = expectOk(generateOrder(input));
    expect(best.assignments.find((a) => a.gameId === 'g1')!.playerIds).toEqual(['p1']);
    expect(best.assignments.find((a) => a.gameId === 'g2')!.playerIds).toEqual(['p2']);
  });
});

// ---------------------------------------------------------------------------
// §32 Reoptimisation
// ---------------------------------------------------------------------------

describe('partial reoptimisation', () => {
  const roster = sampleRoster();
  const gameDefs = sampleFormatGames();

  it('keeps every locked game untouched while re-optimising the rest', () => {
    const base = orderInput(roster, gameDefs);
    const [first] = expectOk(generateOrder(base));

    // Lock everything except game 3, then re-optimise.
    const locks = first.assignments
      .filter((assignment) => assignment.gameId !== 'g3')
      .flatMap((assignment) =>
        assignment.playerIds.map((playerId, slotIndex) => ({
          gameId: assignment.gameId,
          slotIndex,
          playerId,
        })),
      );
    const input: OrderInput = { ...base, locks };
    const [second] = expectOk(reoptimise(input));

    for (const assignment of second.assignments) {
      if (assignment.gameId === 'g3') continue;
      const original = first.assignments.find((a) => a.gameId === assignment.gameId)!;
      expect(assignment.playerIds).toEqual(original.playerIds);
    }
    assertNoHardViolation(input, second);
  });

  it('re-optimises around a late absence while keeping the games already played', () => {
    const base = orderInput(roster, gameDefs);
    const [first] = expectOk(generateOrder(base));

    // Games 1 and 2 are already played; p1 then goes home.
    const locks = first.assignments
      .filter((assignment) => assignment.gameId === 'g1' || assignment.gameId === 'g2')
      .flatMap((assignment) =>
        assignment.playerIds.map((playerId, slotIndex) => ({
          gameId: assignment.gameId,
          slotIndex,
          playerId,
        })),
      )
      .filter((lock) => lock.playerId !== 'p1');

    const participants = base.participants.map((config) =>
      config.playerId === 'p1' ? { ...config, window: { toOrder: 2 } } : config,
    );
    const input: OrderInput = { ...base, locks, participants };
    const [second] = expectOk(reoptimise(input));

    for (const assignment of second.assignments) {
      const game = gameDefs.find((g) => g.id === assignment.gameId)!;
      if (game.order > 2) expect(assignment.playerIds).not.toContain('p1');
    }
    assertNoHardViolation(input, second);
  });
});

// ---------------------------------------------------------------------------
// §32 Unsatisfiable detection (spec §31)
// ---------------------------------------------------------------------------

describe('unsatisfiable inputs', () => {
  it('detects a Trios game with only two eligible players and names the remedy', () => {
    const roster = [
      player({ id: 'p1', name: 'A', rating: 10 }),
      player({ id: 'p2', name: 'B', rating: 10 }),
      player({ id: 'p3', name: 'C', rating: 10 }),
    ];
    const participants = roster.map((p) => createParticipantConfig(p.id));
    participants[2] = { ...participants[2], excludedKinds: ['TRIOS'] };
    const gameDefs = games([{ id: 'g1', name: 'Trios', kinds: ['TRIOS'], playerCount: 3 }]);
    const result = generateOrder(orderInput(roster, gameDefs, { participants }));

    expect(result.ok).toBe(false);
    expect(result.candidates).toEqual([]);
    const diagnostic = result.diagnostics.find((d) => d.code === 'GAME_INSUFFICIENT_ELIGIBLE');
    expect(diagnostic).toBeDefined();
    expect(diagnostic!.message).toContain('3 名必要');
    expect(diagnostic!.message).toContain('2 名のみ');
    expect(diagnostic!.suggestions.some((s) => s.playerId === 'p3')).toBe(true);
  });

  it('detects insufficient total capacity and says how high the cap must go', () => {
    const roster = sampleRoster();
    const participants = roster.map((p) => ({ ...createParticipantConfig(p.id), maxAppearances: 1 }));
    const result = generateOrder(orderInput(roster, sampleFormatGames(), { participants }));
    expect(result.ok).toBe(false);
    const diagnostic = result.diagnostics.find((d) => d.code === 'CAPACITY_TOO_LOW');
    expect(diagnostic).toBeDefined();
    const suggestion = diagnostic!.suggestions.find((s) => s.kind === 'raiseMaxAppearances');
    expect(suggestion?.value).toBe(2);
  });

  it('detects a hard minimum that exceeds the number of slots', () => {
    const roster = sampleRoster();
    const participants = roster.map((p) => ({ ...createParticipantConfig(p.id), minAppearances: 4 }));
    const result = generateOrder(
      orderInput(roster, sampleFormatGames(), {
        participants,
        settings: { minAppearanceMode: 'hard' },
      }),
    );
    expect(result.ok).toBe(false);
    expect(result.diagnostics.some((d) => d.code === 'MIN_TOTAL_TOO_HIGH')).toBe(true);
  });

  it('still generates when an unreachable minimum is only a soft constraint', () => {
    // 5 players asking for 4 appearances each cannot all be satisfied by 10 slots. In
    // soft mode that is a warning on the result, not a refusal to generate.
    const roster = sampleRoster();
    const participants = roster.map((p) => ({ ...createParticipantConfig(p.id), minAppearances: 4 }));
    const input = orderInput(roster, sampleFormatGames(), {
      participants,
      settings: { minAppearanceMode: 'soft' },
    });
    const solutions = expectOk(generateOrder(input));
    expect(solutions.length).toBeGreaterThan(0);
    assertNoHardViolation(input, solutions[0]);
    expect(solutions[0].warnings.some((warning) => warning.code === 'MIN_UNMET_SOFT')).toBe(true);
  });

  it('still generates when a per-player minimum is unreachable in soft mode', () => {
    const roster = sampleRoster();
    const participants = roster.map((p) => createParticipantConfig(p.id));
    // p5 may only play game 6 yet asks for 3 appearances.
    participants[4] = {
      ...participants[4],
      window: { fromOrder: 6 },
      minAppearances: 3,
    };
    const input = orderInput(roster, sampleFormatGames(), {
      participants,
      settings: { minAppearanceMode: 'soft' },
    });
    const solutions = expectOk(generateOrder(input));
    assertNoHardViolation(input, solutions[0]);
    expect(countsOf(solutions[0]).get('p5') ?? 0).toBeLessThanOrEqual(1);
  });

  it('detects a lock that conflicts with an exclusion', () => {
    const roster = sampleRoster();
    const participants = roster.map((p) => createParticipantConfig(p.id));
    participants[0] = { ...participants[0], excludedGameIds: ['g1'] };
    const result = generateOrder(
      orderInput(roster, sampleFormatGames(), {
        participants,
        locks: [{ gameId: 'g1', slotIndex: 0, playerId: 'p1' }],
      }),
    );
    expect(result.ok).toBe(false);
    const diagnostic = result.diagnostics.find((d) => d.code === 'LOCK_INVALID');
    expect(diagnostic).toBeDefined();
    expect(diagnostic!.suggestions.some((s) => s.kind === 'removeLock')).toBe(true);
  });

  it('detects a game where forbidden pairs rule out every combination', () => {
    const roster = [
      player({ id: 'p1', name: 'A', rating: 10 }),
      player({ id: 'p2', name: 'B', rating: 10 }),
      player({ id: 'p3', name: 'C', rating: 10 }),
    ];
    const gameDefs = games([{ id: 'g1', name: 'Trios', kinds: ['TRIOS'], playerCount: 3 }]);
    const result = generateOrder(
      orderInput(roster, gameDefs, { pairs: [pair('p1', 'p2', 'FORBIDDEN')] }),
    );
    expect(result.ok).toBe(false);
    const diagnostic = result.diagnostics.find((d) => d.code === 'GAME_ALL_COMBOS_FORBIDDEN');
    expect(diagnostic).toBeDefined();
    expect(diagnostic!.suggestions.some((s) => s.kind === 'relaxForbiddenPair')).toBe(true);
  });

  it('never relaxes a hard constraint to produce a result', () => {
    const roster = sampleRoster();
    const participants = roster.map((p) => ({
      ...createParticipantConfig(p.id),
      excludedKinds: ['TRIOS' as const],
    }));
    const result = generateOrder(orderInput(roster, sampleFormatGames(), { participants }));
    expect(result.ok).toBe(false);
    expect(result.candidates).toHaveLength(0);
  });

  it('reports no participants and no games', () => {
    const noPlayers = generateOrder(orderInput([], sampleFormatGames()));
    expect(noPlayers.ok).toBe(false);
    expect(noPlayers.diagnostics.some((d) => d.code === 'NO_PARTICIPANTS')).toBe(true);

    const noGames = generateOrder(orderInput(sampleRoster(), []));
    expect(noGames.ok).toBe(false);
    expect(noGames.diagnostics.some((d) => d.code === 'NO_GAMES')).toBe(true);
  });

  /**
   * A head count that is not a positive integer cannot come from the FORMAT screen
   * (the stepper is bounded 1..8) or from a JSON import (which clamps it), but it must
   * still produce an actionable diagnostic rather than an exception: generation runs in
   * a worker, where a thrown error reaches the captain as "generation failed" with
   * nothing to act on.
   */
  it.each([
    ['zero', 0],
    ['negative', -1],
    ['fractional', 1.5],
  ])('reports a malformed head count (%s) instead of throwing', (_label, playerCount) => {
    const gameDefs = games([{ id: 'g1', name: 'Broken', kinds: ['SINGLES'], playerCount }]);
    const result = generateOrder(orderInput(sampleRoster(), gameDefs));

    expect(result.ok).toBe(false);
    const diagnostic = result.diagnostics.find((d) => d.code === 'INVALID_GAME');
    expect(diagnostic).toBeDefined();
    expect(diagnostic!.gameId).toBe('g1');
    expect(diagnostic!.suggestions.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// §15 manual editing
// ---------------------------------------------------------------------------

describe('manual editing', () => {
  const roster = sampleRoster();
  const gameDefs = sampleFormatGames();

  it('re-evaluates a hand-made change and reports the new tallies', () => {
    const input = orderInput(roster, gameDefs);
    const [best] = expectOk(generateOrder(input));

    const edited: GameAssignment[] = best.assignments.map((assignment) =>
      assignment.gameId === 'g1' ? { ...assignment, playerIds: ['p5'] } : assignment,
    );
    const result = evaluateManualOrder(input, edited);
    expect(result.solution).not.toBeNull();
    expect(result.solution!.assignments.find((a) => a.gameId === 'g1')!.playerIds).toEqual(['p5']);
    expect(result.solution!.metrics.totalSlots).toBe(10);
  });

  it('flags a hard-constraint violation introduced by hand but still reports metrics', () => {
    const participants = roster.map((p) => createParticipantConfig(p.id));
    participants[0] = { ...participants[0], excludedGameIds: ['g1'] };
    const input = orderInput(roster, gameDefs, { participants });
    const [best] = expectOk(generateOrder(input));

    const edited: GameAssignment[] = best.assignments.map((assignment) =>
      assignment.gameId === 'g1' ? { ...assignment, playerIds: ['p1'] } : assignment,
    );
    const result = evaluateManualOrder(input, edited);
    expect(result.ok).toBe(false);
    expect(result.violations.some((violation) => violation.code === 'NOT_ELIGIBLE')).toBe(true);
    expect(result.solution).not.toBeNull();
    expect(result.solution!.metrics.participantCount).toBe(5);
  });

  it('detects a duplicate player inside one game', () => {
    const input = orderInput(roster, gameDefs);
    const [best] = expectOk(generateOrder(input));
    const edited: GameAssignment[] = best.assignments.map((assignment) =>
      assignment.gameId === 'g3' ? { ...assignment, playerIds: ['p1', 'p1'] } : assignment,
    );
    const result = evaluateManualOrder(input, edited);
    expect(result.ok).toBe(false);
    expect(result.violations.some((v) => v.code === 'DUPLICATE_PLAYER_IN_GAME')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Explanation ↔ validator agreement (spec §19)
// ---------------------------------------------------------------------------

/**
 * The reasons shown on screen must never contradict the validator shown next to them.
 *
 * A hand-edited line-up is the only way to produce an illegal order, and it is exactly
 * when the captain most needs the reasons to be honest: a green "nothing is violated"
 * on the very game that breaks a rule trains them to ignore the panel entirely.
 */
describe('explanation agrees with the hard-constraint validator', () => {
  const roster = sampleRoster();
  const gameDefs = sampleFormatGames();

  const constraintFactorFor = (solution: OrderSolution, gameId: string) =>
    solution.explanation.games
      .find((game) => game.gameId === gameId)!
      .factors.find((factor) => factor.key === 'constraint')!;

  it('claims no violation only when the validator agrees', () => {
    const input = orderInput(roster, gameDefs);
    const [best] = expectOk(generateOrder(input));
    expect(validateHardConstraints(input, best.assignments)).toEqual([]);

    for (const game of best.explanation.games) {
      const factor = constraintFactorFor(best, game.gameId);
      expect(factor.tone).toBe('positive');
      expect(factor.detail).toContain('違反していません');
    }
    expect(best.explanation.overall.some((factor) => factor.tone === 'negative' && factor.key === 'constraint')).toBe(
      false,
    );
  });

  it('names the breached constraint on the game that breaks it', () => {
    const participants = roster.map((p) => createParticipantConfig(p.id));
    participants[0] = { ...participants[0], excludedGameIds: ['g1'] };
    const input = orderInput(roster, gameDefs, { participants });
    const [best] = expectOk(generateOrder(input));

    const edited: GameAssignment[] = best.assignments.map((assignment) =>
      assignment.gameId === 'g1' ? { ...assignment, playerIds: ['p1'] } : assignment,
    );
    const result = evaluateManualOrder(input, edited);
    expect(result.ok).toBe(false);

    const offending = constraintFactorFor(result.solution!, 'g1');
    expect(offending.tone).toBe('negative');
    expect(offending.detail).not.toContain('違反していません');
    expect(offending.detail).toContain('出場不可');

    // Games that are still legal keep saying so.
    const clean = constraintFactorFor(result.solution!, 'g2');
    expect(clean.tone).toBe('positive');
  });

  it('reports a forbidden pair forced in by hand', () => {
    const input = orderInput(roster, gameDefs, { pairs: [pair('p1', 'p2', 'FORBIDDEN')] });
    const [best] = expectOk(generateOrder(input));
    const edited: GameAssignment[] = best.assignments.map((assignment) =>
      assignment.gameId === 'g3' ? { ...assignment, playerIds: ['p1', 'p2'] } : assignment,
    );
    const result = evaluateManualOrder(input, edited);
    expect(result.violations.some((violation) => violation.code === 'FORBIDDEN_PAIR')).toBe(true);

    const factor = constraintFactorFor(result.solution!, 'g3');
    expect(factor.tone).toBe('negative');
    expect(factor.detail).toContain('禁止ペア');
  });

  it('surfaces a violation that belongs to no single game in the summary', () => {
    const participants = roster.map((p) => createParticipantConfig(p.id));
    participants[0] = { ...participants[0], maxAppearances: 1 };
    const input = orderInput(roster, gameDefs, { participants });
    const [best] = expectOk(generateOrder(input));

    // Force p1 into three games, well past their cap of one.
    const edited: GameAssignment[] = best.assignments.map((assignment) =>
      assignment.gameId === 'g1' || assignment.gameId === 'g2' || assignment.gameId === 'g6'
        ? { ...assignment, playerIds: ['p1'] }
        : assignment,
    );
    const result = evaluateManualOrder(input, edited);
    expect(result.violations.some((violation) => violation.code === 'MAX_APPEARANCES_EXCEEDED')).toBe(true);

    const summary = result.solution!.explanation.overall.find((factor) => factor.key === 'constraint');
    expect(summary).toBeDefined();
    expect(summary!.tone).toBe('negative');
    expect(summary!.detail).toContain('最大出場回数');
  });

  it('never reports an imputed rating as if it were entered', () => {
    const unrated = roster.map((player, index) => (index === 4 ? { ...player, rating: null } : player));
    const input = orderInput(unrated, gameDefs);
    const [best] = expectOk(generateOrder(input));

    const tally = best.tallies.find((entry) => entry.playerId === 'p5')!;
    expect(tally.ratingImputed).toBe(true);
    expect(tally.effectiveRating).not.toBe(0);
    expect(best.metrics.hasImputedRating).toBe(true);

    // Every game p5 appears in says the value is provisional, rather than quoting it flat.
    const appearances = best.explanation.games.filter((game) => game.playerIds.includes('p5'));
    expect(appearances.length).toBeGreaterThan(0);
    for (const game of appearances) {
      const strengthFactors = game.factors.filter((factor) => factor.key === 'strength');
      expect(strengthFactors.some((factor) => factor.detail.includes('中央値'))).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Scale
// ---------------------------------------------------------------------------

describe('scale', () => {
  it('handles 12 players across 12 games within the time budget', () => {
    const roster = Array.from({ length: 12 }, (_, i) =>
      player({
        id: `p${i + 1}`,
        name: `Player ${i + 1}`,
        rating: i % 3 === 0 ? null : 4 + i,
        skills: { SINGLES: ((i % 5) + 1) as 1 | 2 | 3 | 4 | 5, DOUBLES: (((i + 2) % 5) + 1) as 1 | 2 | 3 | 4 | 5 },
      }),
    );
    const gameDefs = games(
      Array.from({ length: 12 }, (_, i) => ({
        id: `g${i + 1}`,
        name: `Game ${i + 1}`,
        kinds: (i % 3 === 2 ? ['TRIOS'] : i % 3 === 1 ? ['DOUBLES', 'G501'] : ['SINGLES', 'CRICKET']) as never,
        playerCount: i % 3 === 2 ? 3 : i % 3 === 1 ? 2 : 1,
      })),
    );
    const input = orderInput(roster, gameDefs, { settings: { timeLimitMs: 1500 } });
    const started = Date.now();
    const solutions = expectOk(generateOrder(input));
    const elapsed = Date.now() - started;

    expect(solutions.length).toBeGreaterThan(0);
    for (const solution of solutions) assertNoHardViolation(input, solution);
    // 24 slots over 12 players — everybody should get 2.
    expect(solutions[0].metrics.appearanceSpread).toBeLessThanOrEqual(1);
    expect(elapsed).toBeLessThan(12_000);
  });
});
