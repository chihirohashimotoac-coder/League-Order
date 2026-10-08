import { describe, expect, it } from 'vitest';
import type { GameSlotDef, OrderInput, Player } from '../domain/types';
import type { OpponentContext } from '../domain/prediction/opponentContext';
import { createParticipantConfig } from '../domain/orders/participants';
import { games, orderInput, player } from '../test/factories';
import { generateOrder } from './generateOrder';
import { prepare } from './prepare';
import { buildAllCandidates, selectionSignature } from './candidates/combinations';
import { buildBoundContext } from './search/bound';
import { searchOnce } from './searchOnce';
import { evaluateSelection } from './scoring/score';
import { EVEN_REFERENCE_BOOST, applySkewGate, searchEvenReference } from './skewGate';
import { describeCombo } from './candidates/combinations';

/**
 * The even line-up the bias gate judges against (docs/DESIGN.md 追補 v1.5 W1) must be the
 * most even one the search can find — whatever re-ranking by match outcome does among
 * near-ties — and must be found even when the line-ups already shown as other candidates
 * leave the search nothing else to start from.
 */

const unevenness = (ctx: ReturnType<typeof prepare>, selection: Parameters<typeof evaluateSelection>[1]): number => {
  const evaluation = evaluateSelection(ctx, selection);
  return Math.max(evaluation.fairness.excess, evaluation.roleFairness.totalExcess);
};

function make(count: number, format: GameSlotDef[], seed: number, extra: Partial<OrderInput['settings']> = {}): OrderInput {
  const roster: Player[] = Array.from({ length: count }, (_, i) =>
    player({ id: `p${String(i).padStart(2, '0')}`, name: `P${i}`, rating: 20 - i * (1 + (seed % 3)), ppr: 90 - i * (4 + (seed % 5)) }),
  );
  const opponent: OpponentContext = {
    version: 1,
    generatedAt: 0,
    matchId: 'm',
    matchDate: null,
    opponentName: 'O',
    leagueMeanPpr: 60,
    players: Object.fromEntries(roster.map((p) => [p.id, { strength: p.ppr!, confidence: 'HIGH', legs: 90, imputed: false, formAdjustment: 0, first9Adjustment: 0 }])),
    games: Object.fromEntries(
      format.map((g, gi) => [
        g.id,
        {
          gameId: g.id,
          signature: g.id,
          numPart: g.playerCount,
          legsToWin: 2,
          cricket: false,
          sides: [
            { strength: 50 + ((gi * 7 + seed) % 30), probability: 0.6 },
            { strength: 75, probability: 0.4 },
          ],
          likely: [{ name: 'O', probability: 1 }],
          samples: 8,
          confidence: 'HIGH',
        },
      ]),
    ),
    orderConfidence: 'HIGH',
    confidence: 'HIGH',
  };
  const base = orderInput(roster, format, { preset: 'OPPONENT_OPTIMIZED', settings: extra });
  return {
    ...base,
    opponent,
    // Hard conditions: the first player is capped, the second cannot play Singles.
    participants: base.participants.map((c, i) =>
      i === 0 ? { ...c, maxAppearances: 2 } : i === 1 ? { ...c, excludedKinds: ['SINGLES' as const] } : createParticipantConfig(c.playerId),
    ),
  };
}

const spec = (rows: [string, number][]): GameSlotDef[] =>
  games(rows.map(([kind, playerCount], i) => ({ id: `g${i + 1}`, name: `${kind}${i + 1}`, kinds: [kind as 'SINGLES', 'G501'] as ['SINGLES', 'G501'], playerCount })));

const HUGE = spec([
  ...Array.from({ length: 10 }, (): [string, number] => ['SINGLES', 1]),
  ...Array.from({ length: 6 }, (): [string, number] => ['DOUBLES', 2]),
  ...Array.from({ length: 3 }, (): [string, number] => ['TRIOS', 3]),
]);

describe('the even line-up is the most even one found', () => {
  // Found by a sweep (opponent data, three roles, Hard conditions): re-ranking the even
  // candidates by match outcome traded a step of role evenness for estimated match value.
  it.each([
    [5, 1],
    [8, 1],
    [8, 5],
  ])('%i players, seed %i: re-ranking never returns a less even line-up than the plain search', (count, seed) => {
    const ctx = prepare(make(count, HUGE, seed));
    const reference = searchEvenReference(ctx, new Set(), 1500)!;
    const weights = ctx.input.weights;
    const evenCtx = prepare({
      ...ctx.input,
      weights: { ...weights, fairness: weights.fairness + EVEN_REFERENCE_BOOST, roleFairness: weights.roleFairness + EVEN_REFERENCE_BOOST },
    });
    const candidates = buildAllCandidates(evenCtx);
    const plain = searchOnce(evenCtx, buildBoundContext(evenCtx, candidates), candidates, 600, new Set())!;
    expect(unevenness(ctx, reference.selection)).toBeLessThanOrEqual(unevenness(evenCtx, plain.selection) + 1e-9);
  });
});

describe('the gate still judges when the shown line-ups leave the search no start', () => {
  const players = (n: number): Player[] => ['A', 'B', 'C', 'D', 'E'].slice(0, n).map((id, i) => player({ id, name: id, rating: [18, 14, 10, 6, 4][i], ppr: [18, 14, 10, 6, 4][i] * 4 + 20 }));
  const singles = (k: number) => spec(Array.from({ length: k }, (): [string, number] => ['SINGLES', 1]));

  // beamWidth 1: the beam holds one line-up. When the previous candidate already showed it,
  // the even-line-up search used to give up, and the gate let an unjudged bias through.
  it.each([
    [4, 4, 'BALANCED'],
    [4, 8, 'BALANCED'],
    [4, 4, 'FAIRNESS_FIRST'],
    [4, 8, 'FAIRNESS_FIRST'],
  ] as const)('%i players / %i Singles after %s with a one-line-up beam: no unjudged bias', (n, k, first) => {
    const result = generateOrder(orderInput(players(n), singles(k), { preset: first, settings: { beamWidth: 1 } }), { timeLimitMs: 3000 });
    expect(result.ok).toBe(true);
    const even = k / n;
    for (const candidate of result.candidates) {
      const counts = candidate.tallies.map((tally) => tally.count);
      if (candidate.meta.presetKey === 'WIN_FIRST') {
        // Either an even split, or a verdict is on record: never a bare bias.
        const isEven = counts.every((count) => count === even);
        expect(isEven || candidate.meta.skewGate !== undefined, `${first}: ${counts.join('/')}`).toBe(true);
        if (!isEven) expect(candidate.meta.skewGate!.outcome).toBe('unverified');
        if (!isEven) expect(candidate.meta.exhaustive).toBe(false);
      }
    }
    // Candidates stay distinct.
    const keys = result.candidates.map((candidate) => candidate.assignments.map((a) => a.playerIds.join('.')).join('|'));
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('the line-up shown first is never repeated as a later candidate', () => {
    const input = orderInput(players(4), singles(4), { preset: 'BALANCED', settings: { beamWidth: 1 } });
    const result = generateOrder(input, { timeLimitMs: 3000 });
    expect(result.ok).toBe(true);
    const ctx = prepare(input);
    const seen = new Set<string>();
    for (const candidate of result.candidates) {
      const key = selectionSignature(
        ctx,
        candidate.assignments.map((assignment) => ({ members: assignment.playerIds.map((id) => ctx.playerIndex.get(id)!).sort((a, b) => a - b), strength: 0, gameFit: 0, pairFit: 0, novelty: 0, oppWin: 0, localScore: 0 })),
      );
      expect(seen.has(key)).toBe(false);
      seen.add(key);
    }
  });

  it('when no even line-up may be shown, the bias is reported unverified and the search unfinished — never as checked', () => {
    const input = orderInput(players(4), singles(4), { preset: 'WIN_FIRST' });
    const ctx = prepare(input);
    // Every even split of four Singles among four players is a permutation: show them all.
    const excluded = new Set<string>();
    const permute = (rest: number[], taken: number[]): void => {
      if (rest.length === 0) {
        excluded.add(taken.map((pi) => ctx.playerIds[pi]).join('|'));
        return;
      }
      rest.forEach((pi, index) => permute([...rest.slice(0, index), ...rest.slice(index + 1)], [...taken, pi]));
    };
    permute([0, 1, 2, 3], []);
    expect(excluded.size).toBe(24);
    // A bias nobody has judged: A twice, D never.
    const bias = [[0], [0], [1], [2]].map((members, gi) => describeCombo(ctx, gi, members));
    const outcome = applySkewGate({
      ctx,
      presetKey: 'WIN_FIRST',
      best: { selection: bias, evaluation: evaluateSelection(ctx, bias) },
      pool: [bias],
      excluded,
      timeLimitMs: 500,
    });
    expect(outcome.report?.outcome).toBe('unverified');
    expect(outcome.exhaustive).toBe(false);
    expect(outcome.changed).toBe(false);
    expect(outcome.report!.evenCounts).toEqual({ A: 1, B: 1, C: 1, D: 1 });
  });
});
