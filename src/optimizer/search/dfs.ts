import { selectionSignature, type Combo, type GameCandidates } from '../candidates/combinations';
import type { PreparedContext } from '../prepare';
import {
  applyCombo,
  canPlace,
  createState,
  minAppearancesReachable,
  undoCombo,
  upperBound,
  type BoundContext,
  type SearchState,
} from './bound';

/**
 * Depth-first branch and bound (docs/DESIGN.md §6.3 Stage 1).
 *
 * Games are assigned in display order so that consecutive-appearance excess becomes
 * final as the search deepens (which is what makes it a valid lower bound inside
 * `upperBound`). Three prunes are applied at every node:
 *
 * 1. hard feasibility of the placement (max appearances, hard consecutive limit)
 * 2. reachability of the remaining hard minimum appearances
 * 3. the optimistic bound against the current incumbent
 *
 * The search is anytime: it keeps the best complete assignment found so far and stops
 * on the node or time budget. `exhaustive` reports whether the whole (pruned) tree was
 * explored, i.e. whether the returned solution is provably optimal for the candidate
 * sets it was given.
 */
export interface DfsOptions {
  deadline: number;
  nodeLimit: number;
  /** Score of a known solution; branches that cannot beat it are cut. */
  incumbent: number;
  /** Ordering bias: reward combos containing players who are behind their ideal. */
  fairnessUrgency: number;
  /** Selection signatures already returned as other candidates; never re-returned. */
  excluded?: ReadonlySet<string>;
}

export interface DfsResult {
  best: Combo[] | null;
  bestScore: number;
  nodes: number;
  exhaustive: boolean;
  /** True when at least one complete assignment was reached. */
  foundAny: boolean;
}

export function dfsSearch(
  ctx: PreparedContext,
  bctx: BoundContext,
  candidates: readonly GameCandidates[],
  options: DfsOptions,
): DfsResult {
  const consecutiveHard = ctx.input.settings.consecutiveMode === 'hard';
  const state = createState(ctx);
  const selection: Combo[] = [];

  let best: Combo[] | null = null;
  let bestScore = options.incumbent;
  let foundAny = false;
  let nodes = 0;
  let exhaustive = true;
  let aborted = false;

  const minHard = ctx.input.settings.minAppearanceMode === 'hard';

  /** Dynamic branching order: fairness urgency first, then static local score. */
  const orderCombos = (gi: number): Combo[] => {
    const list = candidates[gi].combos;
    if (list.length <= 1 || options.fairnessUrgency <= 0) return list;
    const keyed = list.map((combo) => {
      let slack = 0;
      let urgent = 0;
      for (const pi of combo.members) {
        slack += bctx.idealCounts[pi] - state.counts[pi];
        if (minHard && ctx.minAppearances[pi] - state.counts[pi] > 0) urgent += 1;
      }
      const size = combo.members.length || 1;
      return {
        combo,
        key: combo.localScore + options.fairnessUrgency * (slack / size) + 2 * urgent,
      };
    });
    keyed.sort((a, b) => b.key - a.key || a.combo.localScore - b.combo.localScore);
    return keyed.map((entry) => entry.combo);
  };

  const recurse = (gi: number): void => {
    if (aborted) return;
    nodes += 1;
    if (nodes > options.nodeLimit || performance.now() > options.deadline) {
      aborted = true;
      exhaustive = false;
      return;
    }

    if (gi === ctx.gameCount) {
      // A complete assignment. Hard minimum appearances are verified here because the
      // reachability prune is necessary but not sufficient.
      if (minHard) {
        for (let pi = 0; pi < ctx.playerCount; pi += 1) {
          if (state.counts[pi] < ctx.minAppearances[pi]) return;
        }
      }
      if (options.excluded && options.excluded.size > 0) {
        if (options.excluded.has(selectionSignature(ctx, selection))) return;
      }
      const score = finalScore(ctx, bctx, state);
      foundAny = true;
      if (best === null || score > bestScore + 1e-12) {
        bestScore = score;
        best = [...selection];
      }
      return;
    }

    // Only re-order where it pays off; deeper levels use the pre-sorted static order.
    const combos = gi <= 2 ? orderCombos(gi) : candidates[gi].combos;

    for (const combo of combos) {
      if (aborted) return;
      if (!canPlace(ctx, gi, state, combo.members, consecutiveHard)) continue;
      const undo = applyCombo(ctx, gi, state, combo.members, combo);
      if (
        minAppearancesReachable(ctx, bctx, gi + 1, state) &&
        upperBound(ctx, bctx, gi + 1, state) > bestScore + 1e-12
      ) {
        selection.push(combo);
        recurse(gi + 1);
        selection.pop();
      }
      undoCombo(state, undo);
    }
  };

  recurse(0);
  return { best, bestScore, nodes, exhaustive: exhaustive && !aborted, foundAny };
}

/**
 * Exact score of a complete state, computed from the same accumulators the bound uses.
 * Kept here (rather than calling `evaluateSelection`) so the hot loop avoids rebuilding
 * per-player appearance arrays; `generateOrder` re-evaluates the winner with
 * `evaluateSelection` and the two agree by construction.
 */
function finalScore(ctx: PreparedContext, bctx: BoundContext, state: SearchState): number {
  return upperBound(ctx, bctx, ctx.gameCount, state);
}
