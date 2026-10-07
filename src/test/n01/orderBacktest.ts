import type { GameAssignment, OrderInput, OrderSolution } from '../../domain/types';
import { predictOrder } from '../../domain/prediction/predictOrder';
import { buildOpponentContext, type OpponentContext } from '../../domain/prediction/opponentContext';
import type { ConfidenceLevel } from '../../domain/prediction/confidence';
import { PRIOR_LEGS } from '../../domain/prediction/playerStrength';
import { RECENCY_WEIGHTS } from '../../domain/n01/recency';
import type { ReplayedMatch } from './replay';

/**
 * Optimizer backtest summary (test-only, MASTER SPEC Phase 6 §3).
 *
 * For each replayed match: the model's estimated match win for the recommended order and
 * for the order actually fielded, both under the same pre-match opponent context. The
 * difference is an estimate of the *model's* view, not a claim about what would have
 * happened on the night.
 */

export interface OrderBacktestRow {
  matchId: string;
  date: string;
  teamTpid: string;
  opponentTpid: string;
  confidence: string;
  input: OrderInput;
  actual: GameAssignment[];
  recommended: number;
  winFirst: number;
  fielded: number;
  gamesWonActually: number;
  gameCount: number;
  optimizerMs: number;
}

export interface OrderBacktestSummary {
  rows: OrderBacktestRow[];
  meanUplift: number;
  worstUplift: number;
  /** Share of matches where the recommendation's estimate is at least the fielded order's. */
  notWorseShare: number;
  meanUpliftOverWinFirst: number;
}

const matchValue = (prediction: { win: number; draw: number } | null | undefined): number =>
  prediction ? prediction.win + 0.5 * prediction.draw : Number.NaN;

export function orderBacktestSummary(
  replays: readonly ReplayedMatch[],
  generate: (input: OrderInput) => OrderSolution[],
): OrderBacktestSummary {
  const rows = replays.map((replay): OrderBacktestRow => {
    const context = replay.order.input.opponent!;
    const started = performance.now();
    const candidates = generate(replay.order.input);
    const optimizerMs = performance.now() - started;
    const winFirst = candidates.find((candidate) => candidate.meta.presetKey === 'WIN_FIRST');
    return {
      matchId: replay.matchId,
      date: replay.date,
      teamTpid: replay.teamTpid,
      opponentTpid: replay.opponentTpid,
      confidence: context.confidence,
      input: replay.order.input,
      actual: replay.actual,
      recommended: matchValue(candidates[0].prediction),
      winFirst: matchValue(winFirst?.prediction),
      fielded: matchValue(predictOrder(context, replay.actual)),
      gamesWonActually: replay.actualGamesWon,
      gameCount: replay.actual.length,
      optimizerMs,
    };
  });
  const uplifts = rows.map((row) => row.recommended - row.fielded);
  const overWinFirst = rows.filter((row) => Number.isFinite(row.winFirst)).map((row) => row.recommended - row.winFirst);
  return {
    rows,
    meanUplift: uplifts.reduce((a, b) => a + b, 0) / uplifts.length,
    worstUplift: Math.min(...uplifts),
    notWorseShare: uplifts.filter((value) => value >= -1e-9).length / uplifts.length,
    meanUpliftOverWinFirst: overWinFirst.reduce((a, b) => a + b, 0) / Math.max(1, overWinFirst.length),
  };
}

/** Share of seats (game × player) that differ between two orders of the same format. */
export function seatChange(a: readonly GameAssignment[], b: readonly GameAssignment[]): number {
  const byGame = new Map(b.map((assignment) => [assignment.gameId, new Set(assignment.playerIds)]));
  let seats = 0;
  let changed = 0;
  for (const assignment of a) {
    const other = byGame.get(assignment.gameId) ?? new Set<string>();
    for (const id of assignment.playerIds) {
      seats += 1;
      if (!other.has(id)) changed += 1;
    }
  }
  return seats === 0 ? 0 : changed / seats;
}

// ---------------------------------------------------------------------------
// Sensitivity (MASTER SPEC Phase 6 §4)
// ---------------------------------------------------------------------------

/**
 * `P(leg) = logistic(k · Δ)`: scaling every strength's distance from the league mean by
 * `s` is exactly the same as scaling k by `s` (pair bonuses aside; the replays have no
 * pairs). So the k sensitivity is tested without a second code path.
 */
export function scaleK(context: OpponentContext, s: number): OpponentContext {
  const mean = context.leagueMeanPpr;
  const scale = (value: number): number => mean + s * (value - mean);
  return {
    ...context,
    players: Object.fromEntries(Object.entries(context.players).map(([id, player]) => [id, { ...player, strength: scale(player.strength) }])),
    games: Object.fromEntries(
      Object.entries(context.games).map(([id, game]) => [id, { ...game, sides: game.sides.map((side) => ({ ...side, strength: scale(side.strength) })) }]),
    ),
  };
}

const LEVELS: ConfidenceLevel[] = ['LOW', 'MEDIUM', 'HIGH'];

/** Moving a confidence threshold a little moves a level by at most one step. */
export function shiftConfidence(context: OpponentContext, step: -1 | 1): OpponentContext {
  const index = Math.min(2, Math.max(0, LEVELS.indexOf(context.confidence) + step));
  return { ...context, confidence: LEVELS[index] };
}

function rebuilt(replay: ReplayedMatch, parameters: { priorLegs: number; weights: readonly number[] }): OpponentContext {
  const context = buildOpponentContext({ snapshot: replay.intel, games: replay.format.games, players: replay.order.input.players, parameters });
  if (!context) throw new Error('no context');
  return context;
}

export interface Perturbation {
  name: string;
  apply: (replay: ReplayedMatch, context: OpponentContext) => OpponentContext;
}

export const PERTURBATIONS: Perturbation[] = [
  { name: 'recency flatter (1 / 0.8 / 0.6)', apply: (replay) => rebuilt(replay, { priorLegs: PRIOR_LEGS, weights: [1, 0.8, 0.6] }) },
  { name: 'recency steeper (1 / 0.4 / 0.2)', apply: (replay) => rebuilt(replay, { priorLegs: PRIOR_LEGS, weights: [1, 0.4, 0.2] }) },
  { name: 'shrinkage prior 20 legs', apply: (replay) => rebuilt(replay, { priorLegs: 20, weights: RECENCY_WEIGHTS }) },
  { name: 'shrinkage prior 45 legs', apply: (replay) => rebuilt(replay, { priorLegs: 45, weights: RECENCY_WEIGHTS }) },
  { name: 'logistic k × 0.8', apply: (_replay, context) => scaleK(context, 0.8) },
  { name: 'logistic k × 1.2', apply: (_replay, context) => scaleK(context, 1.2) },
  { name: 'confidence one level lower', apply: (_replay, context) => shiftConfidence(context, -1) },
  { name: 'confidence one level higher', apply: (_replay, context) => shiftConfidence(context, 1) },
];

export interface SensitivityResult {
  meanRegret: number;
  maxRegret: number;
  meanSeatChange: number;
}

/**
 * Re-optimises each replay under the perturbed model. Regret = how much better (under
 * the perturbed model) the new best order is than the original one; seat change = how
 * much of the order moved.
 */
export function sensitivity(
  replays: readonly ReplayedMatch[],
  perturbation: Perturbation,
  solve: (input: OrderInput) => OrderSolution,
): SensitivityResult {
  let regretSum = 0;
  let maxRegret = 0;
  let changeSum = 0;
  for (const replay of replays) {
    const base = solve(replay.order.input);
    const context = perturbation.apply(replay, replay.order.input.opponent!);
    const perturbed = solve({ ...replay.order.input, opponent: context });
    const regret = Math.max(0, predictOrder(context, perturbed.assignments)!.win - predictOrder(context, base.assignments)!.win);
    regretSum += regret;
    maxRegret = Math.max(maxRegret, regret);
    changeSum += seatChange(base.assignments, perturbed.assignments);
  }
  return { meanRegret: regretSum / replays.length, maxRegret, meanSeatChange: changeSum / replays.length };
}
