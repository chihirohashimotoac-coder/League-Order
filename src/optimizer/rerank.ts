import { riskValue } from '../domain/orders/presets';
import { independentGamesModel } from '../domain/prediction/matchWinProbability';
import { selectionSignature, type Combo } from './candidates/combinations';
import type { PreparedContext } from './prepare';
import { compareEvaluations, evaluateSelection, negativeWeightSum, positiveWeightSum, type Evaluation } from './scoring/score';
import { hardFeasible } from './search/polish';

/**
 * Share of the score span a line-up may give up to be preferred for its estimated match
 * outcome (docs/OPPONENT_OPTIMIZER.md §4). Fairness, role spread and consecutive runs
 * are all inside the score, so a line-up that gives them up badly never qualifies.
 */
export const RERANK_SCORE_TOLERANCE = 0.015;

/** Risk-neutral match value (win + ½ draw) of a selection, over games with opponent data. */
export function selectionMatchValue(ctx: PreparedContext, selection: readonly Combo[]): number {
  const probabilities = selection.flatMap((combo, gi) => (ctx.opponentGames[gi] ? [combo.oppWin] : []));
  return riskValue(independentGamesModel.outcome(probabilities));
}

/**
 * Opponent-aware runs: the search ranks by the additive score (expected games won plus
 * the soft terms); the final pick among the near-optimal line-ups is the one with the
 * best estimated *match* outcome, which is not additive in the games.
 */
export function rerankByMatchOutcome(
  ctx: PreparedContext,
  pool: readonly Combo[][],
  best: Evaluation,
): { selection: Combo[]; evaluation: Evaluation } | null {
  const span = positiveWeightSum(ctx) + negativeWeightSum(ctx);
  const floor = best.breakdown.total - RERANK_SCORE_TOLERANCE * span;
  const seen = new Set<string>();
  let chosen: { selection: Combo[]; evaluation: Evaluation; value: number } | null = null;
  for (const selection of pool) {
    if (selection.length !== ctx.gameCount) continue;
    const key = selectionSignature(ctx, selection);
    if (seen.has(key)) continue;
    seen.add(key);
    if (!hardFeasible(ctx, selection)) continue;
    const evaluation = evaluateSelection(ctx, selection);
    if (evaluation.breakdown.total < floor - 1e-12) continue;
    const value = selectionMatchValue(ctx, selection);
    if (
      !chosen ||
      value > chosen.value + 1e-12 ||
      (Math.abs(value - chosen.value) <= 1e-12 &&
        compareEvaluations({ selection, evaluation }, { selection: chosen.selection, evaluation: chosen.evaluation }) < 0)
    ) {
      chosen = { selection: [...selection], evaluation, value };
    }
  }
  return chosen;
}
