import { describe, expect, it } from 'vitest';
import type { GameKind, OrderInput, ParticipantConfig, SkillLevel } from '../domain/types';
import { games, orderInput, pair, player } from '../test/factories';
import { validateHardConstraints } from './constraints/validate';
import { generateOrder } from './generateOrder';

/**
 * Invariant sweep.
 *
 * Instead of a handful of hand-picked scenarios, this walks a deterministic grid of
 * configurations (seeded pseudo-random, so a failure is exactly reproducible) and
 * asserts the hard-constraint invariants on every result. This is the regression net
 * that would catch a pruning or bound bug that happens to be invisible in the
 * hand-written cases.
 */

/** Deterministic 32-bit LCG — no Math.random, so the grid is identical on every run. */
function lcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

const KIND_SETS: GameKind[][] = [
  ['SINGLES', 'G501'],
  ['SINGLES', 'CRICKET'],
  ['DOUBLES', 'G501'],
  ['DOUBLES', 'CRICKET'],
  ['TRIOS'],
];

function buildScenario(seed: number): OrderInput {
  const rand = lcg(seed);
  const pick = <T>(list: readonly T[]): T => list[Math.floor(rand() * list.length)];

  const playerCount = 4 + Math.floor(rand() * 7); // 4..10
  const roster = Array.from({ length: playerCount }, (_, i) =>
    player({
      id: `p${i + 1}`,
      name: `Player ${i + 1}`,
      // About a fifth of the roster has no rating at all.
      rating: rand() < 0.2 ? null : Math.round(2 + rand() * 16),
      skills: {
        G501: (1 + Math.floor(rand() * 5)) as SkillLevel,
        CRICKET: (1 + Math.floor(rand() * 5)) as SkillLevel,
        SINGLES: (1 + Math.floor(rand() * 5)) as SkillLevel,
        DOUBLES: (1 + Math.floor(rand() * 5)) as SkillLevel,
        TRIOS: (1 + Math.floor(rand() * 5)) as SkillLevel,
      },
      seasonAppearances: Math.floor(rand() * 12),
    }),
  );

  const gameCount = 4 + Math.floor(rand() * 7); // 4..10
  const gameDefs = games(
    Array.from({ length: gameCount }, (_, i) => {
      const kinds = pick(KIND_SETS);
      const playerCountForGame = kinds.includes('TRIOS') ? 3 : kinds.includes('DOUBLES') ? 2 : 1;
      return {
        id: `g${i + 1}`,
        name: `Game ${i + 1}`,
        kinds: [...kinds],
        playerCount: Math.min(playerCountForGame, playerCount),
      };
    }),
  );

  // Constraints are kept deliberately mild so that most scenarios stay satisfiable;
  // the unsatisfiable path has its own dedicated tests.
  const participants: ParticipantConfig[] = roster.map((p, i) => {
    const config: ParticipantConfig = {
      playerId: p.id,
      include: true,
      excludedGameIds: [],
      excludedKinds: [],
    };
    if (rand() < 0.15) config.excludedGameIds = [gameDefs[Math.floor(rand() * gameCount)].id];
    if (rand() < 0.12) config.excludedKinds = [pick(['CRICKET', 'TRIOS'] as GameKind[])];
    if (rand() < 0.12) {
      config.window = rand() < 0.5 ? { fromOrder: 2 } : { toOrder: Math.max(2, gameCount - 1) };
    }
    if (rand() < 0.15) config.maxAppearances = Math.max(2, Math.ceil(gameCount / 2));
    if (rand() < 0.1) config.minAppearances = 1;
    if (i === 0 && rand() < 0.3) config.include = false;
    return config;
  });

  const pairs = rand() < 0.3 ? [pair(roster[0].id, roster[1].id, 'FORBIDDEN')] : [];
  if (rand() < 0.4 && roster.length > 3) {
    pairs.push(pair(roster[2].id, roster[3].id, pick(['VERY_GOOD', 'GOOD', 'DISCOURAGED'])));
  }

  return orderInput(roster, gameDefs, {
    participants,
    pairs,
    preset: pick(['WIN_FIRST', 'BALANCED', 'FAIRNESS_FIRST', 'DEVELOPMENT', 'NEW_PAIR']),
    settings: {
      timeLimitMs: 400,
      consecutiveMode: rand() < 0.3 ? 'hard' : 'soft',
      minAppearanceMode: rand() < 0.5 ? 'hard' : 'soft',
      fairnessScope: rand() < 0.3 ? 'season' : 'today',
    },
  });
}

describe('hard-constraint invariants across a deterministic scenario grid', () => {
  const SCENARIOS = 60;

  it('never returns a solution that violates a hard constraint', () => {
    let generated = 0;
    let refused = 0;

    for (let seed = 1; seed <= SCENARIOS; seed += 1) {
      const input = buildScenario(seed);
      const result = generateOrder(input, { timeLimitMs: 400 });
      if (!result.ok) {
        refused += 1;
        // A refusal must always come with at least one explained reason.
        expect(result.diagnostics.length).toBeGreaterThan(0);
        for (const diagnostic of result.diagnostics) {
          expect(diagnostic.message.length).toBeGreaterThan(0);
        }
        continue;
      }
      generated += 1;
      for (const solution of result.candidates) {
        const violations = validateHardConstraints(input, solution.assignments);
        expect(violations, `seed ${seed}: ${violations.map((v) => v.message).join('; ')}`).toEqual([]);
      }
    }

    // Sanity: the grid must actually exercise both paths.
    expect(generated).toBeGreaterThan(SCENARIOS * 0.5);
    expect(generated + refused).toBe(SCENARIOS);
  });

  it('reports metrics consistent with the assignments it returns', () => {
    for (let seed = 101; seed <= 130; seed += 1) {
      const input = buildScenario(seed);
      const result = generateOrder(input, { timeLimitMs: 300 });
      if (!result.ok) continue;

      for (const solution of result.candidates) {
        const counts = new Map<string, number>();
        let slots = 0;
        for (const assignment of solution.assignments) {
          slots += assignment.playerIds.length;
          for (const playerId of assignment.playerIds) {
            counts.set(playerId, (counts.get(playerId) ?? 0) + 1);
          }
        }
        expect(slots).toBe(solution.metrics.totalSlots);

        for (const tally of solution.tallies) {
          expect(tally.count).toBe(counts.get(tally.playerId) ?? 0);
          expect(tally.seasonTotal).toBe(tally.seasonBefore + tally.count);
          // Unknown ratings are imputed, never zeroed.
          if (tally.ratingImputed) expect(tally.effectiveRating).not.toBe(0);
        }

        const values = solution.tallies.map((tally) => tally.count);
        expect(solution.metrics.appearanceSpread).toBe(Math.max(...values) - Math.min(...values));
        expect(solution.explanation.games).toHaveLength(solution.assignments.length);
      }
    }
  });

  /**
   * Reproducibility, stated as the engine actually guarantees it.
   *
   * The search is time-bounded, and the bound is wall-clock. When it completes — the
   * solution is `exhaustive` — the answer is the optimum of a deterministically built
   * candidate set, so two runs of the same input must agree exactly. When the budget
   * cuts the search short, what comes back is the best found *so far*, and how far the
   * search got depends on how much CPU the run was given: on a loaded machine the two
   * runs can legitimately stop at different points and return different, equally valid
   * orders.
   *
   * Asserting exact agreement in that second case is asserting something the engine
   * does not promise, and it fails on a busy CI runner. So agreement is required where
   * it is guaranteed, validity is required everywhere, and the count of exhaustive
   * comparisons is checked so this cannot quietly become a test of nothing.
   */
  it('is reproducible wherever the search completes, and valid everywhere', () => {
    let compared = 0;
    let truncated = 0;

    for (let seed = 201; seed <= 215; seed += 1) {
      const input = buildScenario(seed);
      const first = generateOrder(input, { timeLimitMs: 300 });
      const second = generateOrder(input, { timeLimitMs: 300 });
      if (!first.ok || !second.ok) continue;

      // Whatever the budget allowed, neither run may break a hard constraint.
      for (const result of [first, second]) {
        const violations = validateHardConstraints(input, result.candidates[0].assignments);
        expect(violations, `seed ${seed}: ${violations.map((v) => v.message).join('; ')}`).toEqual([]);
      }

      if (first.candidates[0].meta.exhaustive && second.candidates[0].meta.exhaustive) {
        compared += 1;
        expect(
          second.candidates[0].assignments,
          `seed ${seed}: two exhaustive searches of the same input disagreed`,
        ).toEqual(first.candidates[0].assignments);
      } else {
        truncated += 1;
      }
    }

    // The grid is sized so most scenarios finish; if that stopped being true the
    // determinism assertion above would be running on almost nothing.
    expect(
      compared,
      `only ${compared} of ${compared + truncated} scenarios completed their search`,
    ).toBeGreaterThan(3);
  });
});
