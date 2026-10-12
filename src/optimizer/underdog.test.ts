import { describe, expect, it } from 'vitest';
import type { GameSlotDef, OrderInput, UnderdogPlanMetrics } from '../domain/types';
import type { OpponentContext } from '../domain/prediction/opponentContext';
import type { MatchPrediction } from '../domain/prediction/predictOrder';
import { THROW_ORDER_MODEL_VERSION } from '../domain/prediction/throwOrder';
import { finishPrior } from '../domain/prediction/finishing';
import type { ConfidenceLevel } from '../domain/prediction/confidence';
import { orderInput, player } from '../test/factories';
import { generateOrder, UNDERDOG_LABEL } from './generateOrder';
import { validateHardConstraints } from './constraints/validate';
import {
  UNDERDOG_MIN_GAIN,
  chooseUnderdogPlan,
  displayedPercent,
  planMetrics,
  underdogEligibility,
  underdogGains,
} from './underdog';
import { createUndoable, undoableReducer } from '../state/orderSession';

/**
 * The underdog plan (格上対策案, docs/UNDERDOG_PLAN.md): offered — never applied — only when the
 * standard plan's estimated match win is 20% or less against a stronger opponent known with
 * MEDIUM+ confidence, and only when one of the two internal plans improves meaningfully.
 */

function prediction(win: number, games: { p: number; ours: number; theirs: number }[], confidence: ConfidenceLevel = 'MEDIUM'): MatchPrediction {
  return {
    win,
    draw: 0,
    loss: 1 - win,
    expectedGames: games.reduce((acc, game) => acc + game.p, 0),
    need: Math.floor(games.length / 2) + 1,
    gameCount: games.length,
    confidence,
    games: games.map((game, index) => ({
      gameId: `g${index}`,
      probability: game.p,
      confidence,
      samples: 5,
      ourStrength: game.ours,
      opponentStrength: game.theirs,
      reasons: [],
    })),
    model: 'independent-games',
    opponentName: '強豪',
  };
}

const contextOf = (confidence: ConfidenceLevel, orderConfidence: ConfidenceLevel = confidence) =>
  ({ confidence, orderConfidence }) as unknown as OpponentContext;

const weakGames = [
  { p: 0.2, ours: 45, theirs: 60 },
  { p: 0.25, ours: 47, theirs: 60 },
  { p: 0.3, ours: 50, theirs: 58 },
];

describe('[13–15] when an underdog plan may be offered', () => {
  it('[13] standard plan ≤ 20% shown, MEDIUM or HIGH opponent data, stronger opponent → eligible', () => {
    expect(underdogEligibility(prediction(0.12, weakGames), contextOf('MEDIUM'))).toEqual({ eligible: true });
    expect(underdogEligibility(prediction(0.12, weakGames), contextOf('HIGH'))).toEqual({ eligible: true });
  });

  it('[14] exactly 20% is included — judged on the whole percent the screen shows', () => {
    expect(displayedPercent(0.2)).toBe(20);
    expect(underdogEligibility(prediction(0.2, weakGames), contextOf('MEDIUM')).eligible).toBe(true);
    expect(underdogEligibility(prediction(0.2049, weakGames), contextOf('MEDIUM')).eligible).toBe(true);
  });

  it('[15] above 20%, LOW data, no opponent, or an opponent not stronger → not offered', () => {
    expect(underdogEligibility(prediction(0.205, weakGames), contextOf('MEDIUM'))).toEqual({ eligible: false, reason: 'not-underdog' });
    expect(underdogEligibility(prediction(0.21, weakGames), contextOf('MEDIUM'))).toEqual({ eligible: false, reason: 'not-underdog' });
    expect(underdogEligibility(prediction(0.1, weakGames), contextOf('LOW'))).toEqual({ eligible: false, reason: 'low-confidence' });
    expect(underdogEligibility(prediction(0.1, weakGames), contextOf('HIGH', 'LOW'))).toEqual({ eligible: false, reason: 'low-confidence' });
    expect(underdogEligibility(undefined, contextOf('HIGH'))).toEqual({ eligible: false, reason: 'no-opponent' });
    expect(underdogEligibility(prediction(0.1, weakGames), null)).toEqual({ eligible: false, reason: 'no-opponent' });
    const even = [
      { p: 0.45, ours: 55, theirs: 55 },
      { p: 0.45, ours: 55, theirs: 55 },
    ];
    expect(underdogEligibility(prediction(0.2, even), contextOf('HIGH'))).toEqual({ eligible: false, reason: 'not-stronger' });
  });
});

describe('[16] one plan, chosen by the documented rule', () => {
  const standard: UnderdogPlanMetrics = { win: 0.1, draw: 0, atLeastOne: 0.6, expectedGames: 1, gameCount: 5 };
  const plan = (atLeastOne: number, expectedGames: number, win = 0.09): UnderdogPlanMetrics => ({ win, draw: 0, atLeastOne, expectedGames, gameCount: 5 });

  it('compares P(W ≥ 1) gain with E[W] / n gain on the same 0..1 scale', () => {
    expect(underdogGains(standard, { atLeastOne: plan(0.65, 1), expectedWins: plan(0.6, 1.2) })).toEqual({
      atLeastOne: expect.closeTo(0.05, 12),
      expectedWins: expect.closeTo(0.04, 12),
    });
    expect(chooseUnderdogPlan(standard, { atLeastOne: plan(0.65, 1), expectedWins: plan(0.6, 1.2) })).toMatchObject({ objective: 'atLeastOne' });
    expect(chooseUnderdogPlan(standard, { atLeastOne: plan(0.61, 1), expectedWins: plan(0.6, 1.25) })).toMatchObject({ objective: 'expectedWins' });
  });

  it('a plan counts from exactly 2 points; below that nothing is offered', () => {
    expect(chooseUnderdogPlan(standard, { atLeastOne: plan(0.6 + UNDERDOG_MIN_GAIN, 1) })).toMatchObject({ objective: 'atLeastOne' });
    expect(chooseUnderdogPlan(standard, { atLeastOne: plan(0.6199, 1), expectedWins: plan(0.6, 1 + 0.0199 * 5) })).toBeNull();
    expect(chooseUnderdogPlan(standard, {})).toBeNull();
  });

  it('on a tie, the plan giving up less estimated match win; then P(W ≥ 1)', () => {
    expect(chooseUnderdogPlan(standard, { atLeastOne: plan(0.63, 1, 0.05), expectedWins: plan(0.6, 1.15, 0.08) })).toMatchObject({ objective: 'expectedWins' });
    expect(chooseUnderdogPlan(standard, { atLeastOne: plan(0.63, 1, 0.08), expectedWins: plan(0.6, 1.15, 0.08) })).toMatchObject({ objective: 'atLeastOne' });
  });
});

// ---------------------------------------------------------------------------
// End to end
// ---------------------------------------------------------------------------

const GAMES: GameSlotDef[] = [
  { id: 's1', order: 1, name: 'Singles 1', kinds: ['SINGLES', 'G501'], playerCount: 1 },
  { id: 's2', order: 2, name: 'Singles 2', kinds: ['SINGLES', 'G501'], playerCount: 1 },
  { id: 's3', order: 3, name: 'Singles 3', kinds: ['SINGLES', 'G501'], playerCount: 1 },
  { id: 's4', order: 4, name: 'Singles 4', kinds: ['SINGLES', 'G501'], playerCount: 1 },
  { id: 'd1', order: 5, name: 'Doubles 1', kinds: ['DOUBLES', 'G501'], playerCount: 2 },
];
const STRENGTHS = [58, 50, 46, 44, 42];
const ROSTER = STRENGTHS.map((strength, index) => player({ id: `p${index + 1}`, name: `選手${index + 1}`, ppr: strength }));

function underdogInput(opponent: Record<string, number>, confidence: ConfidenceLevel = 'MEDIUM', games = GAMES): OrderInput {
  const context: OpponentContext = {
    version: 2,
    generatedAt: 0,
    matchId: 'm',
    matchDate: '2026-10-20',
    opponentName: '強豪',
    leagueMeanPpr: 55,
    players: Object.fromEntries(
      ROSTER.map((p, index) => [p.id, { strength: STRENGTHS[index], confidence: 'HIGH', legs: 60, imputed: false, formAdjustment: 0, first9Adjustment: 0, first9Excess: null }]),
    ),
    games: Object.fromEntries(
      games.map((game) => [
        game.id,
        {
          gameId: game.id,
          signature: game.id,
          numPart: game.playerCount,
          legsToWin: 2,
          cricket: false,
          likely: [],
          samples: 6,
          confidence,
          sides:
            game.playerCount === 1
              ? [{ strength: opponent[game.id], probability: 1 }]
              : [{ strength: opponent[game.id], probability: 1, members: [0, 1].map(() => ({ strength: opponent[game.id], finish: finishPrior(opponent[game.id]) })) }],
          ...(game.playerCount > 1 ? { order: { known: true, confidence, samples: 6, leaders: [] }, startScore: 501 } : {}),
        },
      ]),
    ),
    orderConfidence: confidence,
    confidence,
    discipline: 'STEEL',
  };
  return { ...orderInput(ROSTER, games, { preset: 'OPPONENT_OPTIMIZED' }), opponent: context, throwOrderModel: THROW_ORDER_MODEL_VERSION, discipline: 'STEEL' };
}

const OVERWHELMING = { s1: 70, s2: 68, s3: 66, s4: 50, d1: 66 };

describe('the underdog plan, end to end', () => {
  it('[13][16] against an overwhelming opponent: one plan is offered, by the rule, within every hard condition', () => {
    const input = underdogInput(OVERWHELMING);
    const result = generateOrder(input, { timeLimitMs: 6000 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.underdogStatus).toEqual({ eligible: true });
    const suggestion = result.underdog!;
    expect(suggestion).toBeDefined();
    const standard = result.candidates[0];
    expect(displayedPercent(standard.prediction!.win)).toBeLessThanOrEqual(20);
    // The standard plan is untouched and comes first; the plan is separate and labelled.
    expect(standard.meta.label).toBe('対戦相手最適化');
    expect(standard.meta.underdog).toBeUndefined();
    expect(suggestion.solution.meta.label).toBe(UNDERDOG_LABEL);
    expect(suggestion.solution.meta.underdog).toEqual({ objective: suggestion.objective });
    expect(result.candidates.some((candidate) => candidate === suggestion.solution)).toBe(false);
    // Metrics are what the predictions say, and the choice is the documented rule's.
    expect(suggestion.standard).toEqual(planMetrics(standard.prediction!));
    expect(suggestion.plan).toEqual(planMetrics(suggestion.solution.prediction!));
    const rule = chooseUnderdogPlan(suggestion.standard, {
      ...(suggestion.objective === 'atLeastOne' ? { atLeastOne: suggestion.plan } : { expectedWins: suggestion.plan }),
    });
    expect(rule?.objective).toBe(suggestion.objective);
    expect(suggestion.improvement).toBeGreaterThanOrEqual(UNDERDOG_MIN_GAIN);
    expect(suggestion.matchWinLoss).toBeCloseTo(suggestion.standard.win - suggestion.plan.win, 12);
    expect(validateHardConstraints(input, suggestion.solution.assignments)).toEqual([]);
    expect(suggestion.solution.explanation.overall[0].label).toBe(UNDERDOG_LABEL);
    expect(suggestion.solution.explanation.overall[0].detail).not.toMatch(/確実|必勝/);
  });

  it('[15] LOW opponent data: nothing is offered (and nothing extra is searched)', () => {
    const result = generateOrder(underdogInput(OVERWHELMING, 'LOW'), { timeLimitMs: 6000 });
    expect(result.ok && result.underdogStatus).toEqual({ eligible: false, reason: 'low-confidence' });
    expect(result.ok && result.underdog).toBeUndefined();
  });

  it('[15] an opponent we can beat: nothing is offered', () => {
    const result = generateOrder(underdogInput({ s1: 44, s2: 44, s3: 44, s4: 44, d1: 44 }), { timeLimitMs: 6000 });
    expect(result.ok && result.underdogStatus).toEqual({ eligible: false, reason: 'not-underdog' });
  });

  it('[15] no improvement possible (a single game: every objective is the same): nothing is offered', () => {
    const single = [GAMES[0]];
    const result = generateOrder(underdogInput({ s1: 75 }, 'HIGH', single), { timeLimitMs: 6000 });
    expect(result.ok && result.underdogStatus).toEqual({ eligible: false, reason: 'no-improvement' });
    expect(result.ok && result.underdog).toBeUndefined();
  });

  it('[15] no opponent data: nothing is offered', () => {
    const input = { ...underdogInput(OVERWHELMING), opponent: undefined };
    const result = generateOrder(input, { timeLimitMs: 6000 });
    expect(result.ok && result.underdog).toBeUndefined();
    expect(result.ok && result.underdogStatus).toEqual({ eligible: false, reason: 'no-opponent' });
  });

  it('[17][18] never applied on its own; one tap to the plan, one tap back to the standard plan', () => {
    const input = underdogInput(OVERWHELMING);
    const result = generateOrder(input, { timeLimitMs: 6000 });
    if (!result.ok) throw new Error('no order');
    let session = undoableReducer(createUndoable(input), { type: 'generated', candidates: result.candidates, underdog: result.underdog ?? null });
    // [18] Not auto-applied: the standard plan is on screen.
    expect(session.present.current).toBe(result.candidates[0]);
    expect(session.present.showingUnderdog).toBe(false);
    session = undoableReducer(session, { type: 'applyUnderdog' });
    expect(session.present.current).toBe(result.underdog!.solution);
    expect(session.present.showingUnderdog).toBe(true);
    // [17] Back to the standard plan in one tap, and by undo too.
    const restored = undoableReducer(session, { type: 'restoreStandard' });
    expect(restored.present.current).toBe(result.candidates[0]);
    expect(restored.present.showingUnderdog).toBe(false);
    const undone = undoableReducer(session, { type: 'undo' });
    expect(undone.present.current).toBe(result.candidates[0]);
  });

  it('[21] the same input gives the same plans (deterministic: no clock-bound search here)', () => {
    const input = { ...underdogInput(OVERWHELMING), settings: { ...underdogInput(OVERWHELMING).settings, timeLimitMs: 600_000 } };
    const a = generateOrder(input, { timeLimitMs: 600_000 });
    const b = generateOrder(input, { timeLimitMs: 600_000 });
    if (!a.ok || !b.ok) throw new Error('no order');
    expect(a.candidates.map((c) => c.assignments)).toEqual(b.candidates.map((c) => c.assignments));
    expect(a.candidates.map((c) => c.prediction)).toEqual(b.candidates.map((c) => c.prediction));
    expect(a.underdog?.solution.assignments).toEqual(b.underdog?.solution.assignments);
    expect(a.underdog?.objective).toBe(b.underdog?.objective);
  });
});
