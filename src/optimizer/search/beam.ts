import type { Combo, GameCandidates } from '../candidates/combinations';
import { compareMembers } from '../candidates/combinations';
import type { PreparedContext } from '../prepare';
import {
  applyCombo,
  canPlace,
  cloneState,
  createState,
  minAppearancesReachable,
  upperBound,
  type BoundContext,
  type SearchState,
} from './bound';

/**
 * Beam search (docs/DESIGN.md §6.3 Stage 2).
 *
 * Runs before the branch-and-bound pass to produce a strong initial solution: a good
 * incumbent makes the bound prune aggressively. It is also the fallback when the
 * branch-and-bound pass cannot complete, and the source of diversity when several
 * candidates are requested.
 *
 * States are ranked by the same optimistic bound the DFS uses, so the beam keeps the
 * partial line-ups that are most promising once the whole order is accounted for —
 * not merely the ones that look strongest so far.
 */
export interface BeamNode {
  state: SearchState;
  selection: Combo[];
  bound: number;
}

export interface BeamOptions {
  width: number;
  deadline: number;
}

export interface BeamResult {
  /** Complete selections, best first. */
  solutions: Combo[][];
  /** True when every game could be filled by at least one beam state. */
  feasible: boolean;
  /** Index of the first game for which no state could be extended. */
  blockedAtGame: number | null;
}

export function beamSearch(
  ctx: PreparedContext,
  bctx: BoundContext,
  candidates: readonly GameCandidates[],
  options: BeamOptions,
): BeamResult {
  const consecutiveHard = ctx.input.settings.consecutiveMode === 'hard';
  let frontier: BeamNode[] = [
    { state: createState(ctx), selection: [], bound: upperBound(ctx, bctx, 0, createState(ctx)) },
  ];

  for (let gi = 0; gi < ctx.gameCount; gi += 1) {
    const next: BeamNode[] = [];
    for (const node of frontier) {
      for (const combo of candidates[gi].combos) {
        if (!canPlace(ctx, gi, node.state, combo.members, consecutiveHard)) continue;
        const state = cloneState(node.state);
        applyCombo(ctx, gi, state, combo.members, combo);
        if (!minAppearancesReachable(ctx, bctx, gi + 1, state)) continue;
        next.push({
          state,
          selection: [...node.selection, combo],
          bound: upperBound(ctx, bctx, gi + 1, state),
        });
      }
      if (performance.now() > options.deadline && next.length > 0) break;
    }

    if (next.length === 0) {
      return { solutions: [], feasible: false, blockedAtGame: gi };
    }

    next.sort(
      (a, b) =>
        b.bound - a.bound ||
        compareSelections(a.selection, b.selection),
    );
    frontier = next.slice(0, Math.max(1, options.width));
  }

  return {
    solutions: frontier.map((node) => node.selection),
    feasible: true,
    blockedAtGame: null,
  };
}

function compareSelections(a: readonly Combo[], b: readonly Combo[]): number {
  for (let i = 0; i < Math.min(a.length, b.length); i += 1) {
    const diff = compareMembers(a[i].members, b[i].members);
    if (diff !== 0) return diff;
  }
  return 0;
}
