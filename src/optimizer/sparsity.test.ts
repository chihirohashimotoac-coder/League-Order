import { describe, expect, it } from 'vitest';
import type { OrderInput, Player } from '../domain/types';
import { buildNextMatchOrder } from '../domain/n01/nextMatch';
import { DEFAULT_OPTIMIZER_SETTINGS, DEFAULT_WEIGHTS } from '../domain/orders/presets';
import { predictOrder } from '../domain/prediction/predictOrder';
import { PLAYER_CONFIDENCE_LEGS } from '../domain/prediction/confidence';
import { FIRST9_CAP, FORM_CAP, PRIOR_LEGS } from '../domain/prediction/playerStrength';
import { generateOrder } from './generateOrder';
import { validateHardConstraints } from './constraints/validate';
import { atdoSpec, fixtureLeagues } from '../test/n01/leagues';
import { playedTeamMatches, replayMatch, type ReplayedMatch } from '../test/n01/replay';

/**
 * Data sparsity (MASTER SPEC Phase 6 §5): with 0 matches, 1 match, a few legs or a new
 * player, the estimate must fall back towards 50% at LOW confidence, the optimizer must
 * lean on the ordinary strength model, and nothing may break or turn into NaN.
 */

async function kalavinkaOn(date: string, historyDepth: number): Promise<ReplayedMatch> {
  const full = fixtureLeagues().atdo.games;
  const target = playedTeamMatches(full, 't_ABvC_5234').find((entry) => entry.teamTpid === 'GpiQ' && entry.date === date)!;
  return replayMatch(atdoSpec(), full, target, 't_ABvC_5234', historyDepth);
}

function solve(input: OrderInput) {
  const result = generateOrder(input);
  if (!result.ok) throw new Error('generation failed');
  return result.candidates[0];
}

function expectSane(input: OrderInput): void {
  const best = solve(input);
  expect(validateHardConstraints(input, best.assignments)).toEqual([]);
  const prediction = best.prediction!;
  for (const value of [prediction.win, prediction.draw, prediction.loss, prediction.expectedGames]) expect(Number.isFinite(value)).toBe(true);
  for (const game of prediction.games) {
    expect(game.probability).toBeGreaterThanOrEqual(0.01);
    expect(game.probability).toBeLessThanOrEqual(0.99);
  }
}

describe('data sparsity (Phase 6 §5)', () => {
  it('0 matches: no data at all → every game is 50%, LOW, and the opponent term is weakened', async () => {
    const replay = await kalavinkaOn('2026-09-10', 0);
    const context = replay.order.input.opponent!;
    expect(context.confidence).toBe('LOW');
    expect(context.orderConfidence).toBe('LOW');
    expect(Object.values(context.players).every((player) => player.confidence === 'LOW' && player.imputed)).toBe(true);
    const best = solve(replay.order.input);
    for (const game of best.prediction!.games) expect(game.probability).toBeCloseTo(0.5, 9);
    expect(best.prediction!.confidence).toBe('LOW');
    expect(best.meta.opponent).toMatchObject({ mode: 'reduced', confidence: 'LOW' });
    expect(best.warnings.map((warning) => warning.code)).toContain('OPPONENT_WEIGHT_REDUCED');
    expectSane(replay.order.input);
  });

  it('1 match: estimates move off 50% only a little, and stay LOW', async () => {
    const replay = await kalavinkaOn('2026-09-17', 0);
    const context = replay.order.input.opponent!;
    expect(context.orderConfidence).toBe('LOW');
    const prediction = predictOrder(context, replay.actual)!;
    expect(prediction.confidence).toBe('LOW');
    for (const game of prediction.games) expect(Math.abs(game.probability - 0.5)).toBeLessThan(0.25);
    expectSane(replay.order.input);
  });

  it('few legs: a player with little evidence is LOW and shrunk towards the league mean', async () => {
    const replay = await kalavinkaOn('2026-09-17', 0);
    const context = replay.order.input.opponent!;
    for (const player of Object.values(context.players)) {
      if (player.legs < PLAYER_CONFIDENCE_LEGS.MEDIUM) expect(player.confidence).toBe('LOW');
      // Shrinkage: at most legs / (legs + PRIOR_LEGS) of the way from the mean to the raw
      // figure (raw PPRs here are within 25 points of it), plus the capped adjustments.
      const bound = (player.legs / (player.legs + PRIOR_LEGS)) * 25 + FORM_CAP + FIRST9_CAP;
      expect(Math.abs(player.strength - context.leagueMeanPpr)).toBeLessThanOrEqual(bound);
    }
  });

  it('new player: a hand-added player with no PPR is the league mean at LOW, and the order still works', async () => {
    const replay = await kalavinkaOn('2026-09-24', 2);
    const newcomer: Player = {
      id: 'pl_new',
      teamId: replay.order.input.teamId,
      name: '新加入 太郎',
      rating: null,
      ppr: null,
      skills: {},
      seasonAppearances: 0,
      seasonAppearancesByKind: {},
      archived: false,
      createdAt: 0,
    };
    const players = [...replay.players, newcomer];
    const order = buildNextMatchOrder({
      team: { id: replay.order.input.teamId, name: 'kalavinka', createdAt: 0 },
      players,
      format: replay.format,
      pairs: [],
      settings: { activeTeamId: null, optimizer: DEFAULT_OPTIMIZER_SETTINGS, lastPreset: 'BALANCED', customWeights: DEFAULT_WEIGHTS },
      intel: replay.intel,
      attending: new Set([...replay.actual.flatMap((assignment) => assignment.playerIds), newcomer.id]),
    });
    const context = order.input.opponent!;
    expect(context.players[newcomer.id]).toMatchObject({ confidence: 'LOW', imputed: true, strength: context.leagueMeanPpr });
    expectSane(order.input);
  });
});
