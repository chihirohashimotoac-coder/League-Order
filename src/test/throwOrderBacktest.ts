import type { GameAssignment, OrderInput, OrderSolution, ThrowOrderRecord, UnderdogReason, UnderdogSuggestion } from '../domain/types';
import type { ConfidenceLevel } from '../domain/prediction/confidence';
import { predictOrder, predictionOptionsOf } from '../domain/prediction/predictOrder';
import { independentGamesModel } from '../domain/prediction/matchWinProbability';
import type { OrderFallback } from '../domain/prediction/throwOrder';
import { evaluateManualOrder, generateOrder, type GenerateOptions } from '../optimizer/generateOrder';
import { validateHardConstraints } from '../optimizer/constraints/validate';
import { displayedPercent, planMetrics } from '../optimizer/underdog';
import type { ThrowOrderCase } from './throwOrderScenarios';

/**
 * Throw-order and underdog backtests (test-only; `npm run backtest` sections 5 and 6).
 *
 * Everything here is a model estimate on fixture or synthetic data: it shows what the decision
 * rules do across many inputs and that the guardrails hold, never that a real team would win more.
 */

export interface OrderEstimate {
  /** Match value: P(win) + ½ P(draw). */
  value: number;
  /** Mean estimated game win over the games. */
  gameWin: number;
  /** P(W ≥ 1). */
  atLeastOne: number;
  /** E[W]. */
  expectedWins: number;
}

/** An order's estimate under the input's own model (the throw-order model when the input carries it). */
export function estimateOf(input: OrderInput, assignments: readonly GameAssignment[]): OrderEstimate | null {
  if (!input.opponent) return null;
  const prediction = predictOrder(input.opponent, assignments, input.pairs, independentGamesModel, predictionOptionsOf(input));
  if (!prediction) return null;
  const metrics = planMetrics(prediction);
  return {
    value: prediction.win + 0.5 * prediction.draw,
    gameWin: prediction.games.reduce((acc, game) => acc + game.probability, 0) / prediction.games.length,
    atLeastOne: metrics.atLeastOne,
    expectedWins: prediction.expectedGames,
  };
}

/** The same members, each multi-player game written in internal-id order (what the order must never follow). */
export function idOrdered(assignments: readonly GameAssignment[]): GameAssignment[] {
  return assignments.map((assignment) => ({ ...assignment, playerIds: [...assignment.playerIds].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)) }));
}

/** The same members, each multi-player game in its strong order under the input's model. */
export function strongOrdered(input: OrderInput, assignments: readonly GameAssignment[]): GameAssignment[] {
  const records = evaluateManualOrder(input, assignments).solution?.throwOrder ?? [];
  const strong = new Map(records.map((record) => [record.gameId, record.strongOrder]));
  return assignments.map((assignment) => ({ ...assignment, playerIds: strong.get(assignment.gameId) ?? assignment.playerIds }));
}

/** The input as orders saved before the throw-order model were made (no model version, no role evidence). */
export function withoutThrowOrderModel(input: OrderInput): OrderInput {
  const legacy: OrderInput = { ...input };
  delete legacy.throwOrderModel;
  delete legacy.roleStrength;
  return legacy;
}

export const sameOrder = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((id, index) => id === b[index]);

/** Share of multi-player games whose members are the same but whose throwing order differs. */
export function orderOnlyChanges(a: readonly GameAssignment[], b: readonly GameAssignment[]): { games: number; changed: number } {
  const byGame = new Map(b.map((assignment) => [assignment.gameId, assignment.playerIds]));
  let games = 0;
  let changed = 0;
  for (const assignment of a) {
    const other = byGame.get(assignment.gameId);
    if (!other || assignment.playerIds.length < 2) continue;
    const sameMembers = other.length === assignment.playerIds.length && assignment.playerIds.every((id) => other.includes(id));
    if (!sameMembers) continue;
    games += 1;
    if (!sameOrder(assignment.playerIds, other)) changed += 1;
  }
  return { games, changed };
}

export interface DecisionTally {
  records: number;
  cricket: number;
  adopted: number;
  /** Adopted non-strong orders whose confidence was LOW (must stay 0). */
  adoptedLow: number;
  lowRecords: number;
  /** Adopted non-strong orders whose estimated gain is under 2 points (must stay 0). */
  adoptedUnderThreshold: number;
  fallbacks: Partial<Record<OrderFallback | 'best', number>>;
  bestGains: number[];
  adoptedGains: number[];
  /** Games whose shown order differs from internal-id order. */
  notIdOrder: number;
}

export function emptyTally(): DecisionTally {
  return { records: 0, cricket: 0, adopted: 0, adoptedLow: 0, lowRecords: 0, adoptedUnderThreshold: 0, fallbacks: {}, bestGains: [], adoptedGains: [], notIdOrder: 0 };
}

export function tallyRecords(tally: DecisionTally, records: readonly ThrowOrderRecord[], minGain: number): void {
  for (const record of records) {
    tally.records += 1;
    if (record.fallback === 'cricket') tally.cricket += 1;
    if (record.confidence === 'LOW') tally.lowRecords += 1;
    const key = record.fallback ?? 'best';
    tally.fallbacks[key] = (tally.fallbacks[key] ?? 0) + 1;
    if (record.bestGain !== null) tally.bestGains.push(Math.max(0, record.bestGain));
    if (!sameOrder(record.order, [...record.order].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)))) tally.notIdOrder += 1;
    if (record.adopted === 'model') {
      tally.adopted += 1;
      const gain = record.probability !== null && record.strongProbability !== null ? record.probability - record.strongProbability : 0;
      tally.adoptedGains.push(gain);
      if (record.confidence === 'LOW') tally.adoptedLow += 1;
      if (gain < minGain - 1e-9) tally.adoptedUnderThreshold += 1;
    }
  }
}

export function hardViolations(input: OrderInput, solutions: readonly OrderSolution[]): number {
  return solutions.reduce((acc, solution) => acc + validateHardConstraints(input, solution.assignments).length, 0);
}

// ---------------------------------------------------------------------------
// Synthetic throw-order cases
// ---------------------------------------------------------------------------

export interface StressRow {
  confidence: ConfidenceLevel;
  extreme: boolean;
  orderKnown: boolean;
  record: ThrowOrderRecord;
  reversed: ThrowOrderRecord;
  /** The order chosen after every player's internal id was relabelled, mapped back by name. */
  relabelled: string[];
  violations: number;
  ms: number;
}

/** Ids relabelled so that their sort order is reversed; names (and everything else) unchanged. */
function relabel(input: OrderInput): { input: OrderInput; back: Map<string, string> } {
  const ids = input.players.map((player) => player.id);
  const fresh = new Map(ids.map((id, index) => [id, `z${String(ids.length - index).padStart(2, '0')}_${id}`]));
  const back = new Map([...fresh].map(([from, to]) => [to, from]));
  const opponent = input.opponent
    ? { ...input.opponent, players: Object.fromEntries(Object.entries(input.opponent.players).map(([id, value]) => [fresh.get(id) ?? id, value])) }
    : undefined;
  return {
    input: {
      ...input,
      players: input.players.map((player) => ({ ...player, id: fresh.get(player.id)! })),
      participants: input.participants.map((config) => ({ ...config, playerId: fresh.get(config.playerId)! })),
      ...(opponent ? { opponent } : {}),
    },
    back,
  };
}

export function runStressCase(entry: ThrowOrderCase, options: GenerateOptions): StressRow {
  const single = (input: OrderInput): OrderSolution => {
    const result = generateOrder(input, { ...options, singleCandidate: true, underdog: false });
    if (!result.ok) throw new Error('generation failed');
    return result.candidates[0];
  };
  const started = performance.now();
  const solution = single(entry.input);
  const ms = performance.now() - started;
  const reversed = single(entry.reversed);
  const relabelled = relabel(entry.input);
  const again = single(relabelled.input);
  return {
    confidence: entry.confidence,
    extreme: entry.extreme,
    orderKnown: entry.orderKnown,
    record: solution.throwOrder![0],
    reversed: reversed.throwOrder![0],
    relabelled: again.throwOrder![0].order.map((id) => relabelled.back.get(id)!),
    violations: hardViolations(entry.input, [solution]) + hardViolations(entry.reversed, [reversed]),
    ms,
  };
}

// ---------------------------------------------------------------------------
// Underdog
// ---------------------------------------------------------------------------

export interface UnderdogRow {
  reason: UnderdogReason | 'offered';
  standard: OrderSolution;
  suggestion: UnderdogSuggestion | null;
  /** Offered although the shown standard win is above 20% or the data confidence is LOW (must stay 0). */
  ruleBreaks: number;
  violations: number;
  ms: number;
}

export function runUnderdogCase(input: OrderInput, options: GenerateOptions): UnderdogRow {
  const started = performance.now();
  const result = generateOrder(input, options);
  const ms = performance.now() - started;
  if (!result.ok) throw new Error('generation failed');
  const standard = result.candidates.find((candidate) => candidate.meta.presetKey === 'OPPONENT_OPTIMIZED' && !candidate.meta.underdog) ?? result.candidates[0];
  const suggestion = result.underdog ?? null;
  const status = result.underdogStatus;
  const reason: UnderdogRow['reason'] = suggestion ? 'offered' : status && !status.eligible ? status.reason : 'not-run';
  let ruleBreaks = 0;
  if (suggestion) {
    if (!standard.prediction || displayedPercent(standard.prediction.win) > 20) ruleBreaks += 1;
    if (suggestion.confidence === 'LOW') ruleBreaks += 1;
    if (suggestion.improvement < 0.02 - 1e-9) ruleBreaks += 1;
  }
  return {
    reason,
    standard,
    suggestion,
    ruleBreaks,
    violations: hardViolations(input, [...result.candidates, ...(suggestion ? [suggestion.solution] : [])]),
    ms,
  };
}
