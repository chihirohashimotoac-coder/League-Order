import type { SolutionMeta } from '../domain/types';
import { selectionSignature, type Combo, type GameCandidates } from './candidates/combinations';
import type { PreparedContext } from './prepare';
import { compareEvaluations, evaluateSelection, type Evaluation } from './scoring/score';
import { beamSearch } from './search/beam';
import type { BoundContext } from './search/bound';
import { dfsSearch } from './search/dfs';
import { polish } from './search/polish';

/**
 * One full search of a prepared context: beam (a strong incumbent), branch and bound
 * seeded with it, then local improvement (docs/DESIGN.md §6.3). Shared by the run itself
 * and by the even-split reference search of the bias gate, so both are the same engine
 * on different weights.
 */
export interface SearchOutcome {
  selection: Combo[];
  evaluation: Evaluation;
  stage: SolutionMeta['stage'];
  /** The beam's complete line-ups (not excluded), best first: the alternatives to judge. */
  pool: Combo[][];
  /** The branch-and-bound winner, when it found one. */
  dfsBest: Combo[] | null;
  /** True when branch and bound finished and every game's candidate set was complete. */
  exhaustive: boolean;
  nodes: number;
}

export function searchOnce(
  ctx: PreparedContext,
  bctx: BoundContext,
  candidates: readonly GameCandidates[],
  timeLimitMs: number,
  excluded: ReadonlySet<string>,
  /**
   * When every line-up the beam holds is already shown as another candidate, go on to the
   * branch and bound instead of giving up (the bias gate needs *an* even line-up that is
   * not one of those). Off for ordinary runs, which then skip the candidate as before.
   */
  searchPastExcluded = false,
): SearchOutcome | null {
  const started = performance.now();
  const deadline = started + timeLimitMs;

  // Stage 2 first: a strong incumbent makes the branch-and-bound prune hard.
  const beam = beamSearch(ctx, bctx, candidates, {
    width: Math.max(1, ctx.input.settings.beamWidth),
    deadline: started + timeLimitMs * 0.35,
  });
  if (!beam.feasible || beam.solutions.length === 0) return null;

  // Line-ups already returned as other candidates are not eligible again, so each
  // candidate the captain compares is genuinely a different order.
  const pool =
    excluded.size === 0
      ? beam.solutions
      : beam.solutions.filter((solution) => !excluded.has(selectionSignature(ctx, solution)));
  if (pool.length === 0 && !searchPastExcluded) return null;

  let bestSelection: Combo[] | null = pool[0] ?? null;
  let bestEvaluation: Evaluation | null = bestSelection ? evaluateSelection(ctx, bestSelection) : null;
  let stage: SolutionMeta['stage'] = 'beam';

  for (const solution of pool.slice(1)) {
    const evaluation = evaluateSelection(ctx, solution);
    if (
      compareEvaluations({ selection: solution, evaluation }, { selection: bestSelection!, evaluation: bestEvaluation! }) < 0
    ) {
      bestSelection = solution;
      bestEvaluation = evaluation;
    }
  }

  // Stage 1: branch and bound, seeded with the beam incumbent.
  const dfs = dfsSearch(ctx, bctx, candidates, {
    deadline,
    nodeLimit: ctx.input.settings.nodeLimit,
    incumbent: bestEvaluation ? bestEvaluation.breakdown.total : Number.NEGATIVE_INFINITY,
    fairnessUrgency: ctx.weights.fairness,
    excluded,
  });
  if (dfs.best) {
    const evaluation = evaluateSelection(ctx, dfs.best);
    if (!bestEvaluation || evaluation.breakdown.total > bestEvaluation.breakdown.total) {
      bestSelection = dfs.best;
      bestEvaluation = evaluation;
      stage = 'dfs';
    }
  }

  if (!bestSelection || !bestEvaluation) return null;

  // Stage 3: deterministic local improvement.
  const polished = polish(ctx, bestSelection, Math.max(deadline, performance.now() + 60), excluded);
  if (polished.improved && polished.evaluation.breakdown.total > bestEvaluation.breakdown.total) {
    bestSelection = polished.selection;
    bestEvaluation = polished.evaluation;
    stage = stage === 'dfs' ? 'dfs+polish' : 'beam+polish';
  }

  return {
    selection: bestSelection,
    evaluation: bestEvaluation,
    stage,
    pool,
    dfsBest: dfs.best,
    exhaustive: dfs.exhaustive && candidates.every((entry) => entry.complete),
    nodes: dfs.nodes,
  };
}
