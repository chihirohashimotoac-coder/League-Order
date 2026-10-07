import {
  excessToPenalty,
  fairnessScore,
  minimalSsd,
  minimalSsdFast,
  waterfill,
} from '../../domain/orders/fairness';
import { roleScore } from '../../domain/orders/roleFairness';
import type { GameCandidates } from '../candidates/combinations';
import type { PreparedContext } from '../prepare';

/**
 * Pre-computed quantities for the branch-and-bound upper bound (docs/DESIGN.md §6.3).
 *
 * Every suffix array is indexed by "next game to assign", so `suffixSlots[gi]` is the
 * number of slots still to fill once games `0..gi-1` are decided.
 */
export interface BoundContext {
  suffixSlots: number[];
  suffixMaxStrength: number[];
  suffixMaxGameFit: number[];
  suffixMaxPair: number[];
  suffixMaxNovelty: number[];
  /** `remainingEligible[gi][pi]` = games at index >= gi for which `pi` is eligible. */
  remainingEligible: Int32Array[];
  /** Minimum achievable SSD for the fairness basis over the whole order. */
  globalMinSsd: number;
  /** Minimum achievable SSD for the season basis over the whole order. */
  globalSeasonMinSsd: number;
  /** Ideal per-player appearance count (water-filled) for the fairness basis. */
  idealCounts: number[];
  /** Number of games with 2+ players — the basis of the pair terms. */
  pairGameCount: number;
  /** `suffixRoleSlots[gi][group]` = slots of that role in games at index >= gi. */
  suffixRoleSlots: Int32Array[];
  /** Reusable buffers for the bound's water-filling (one search runs on one thread). */
  scratchTotals: Float64Array;
  scratchSort: Float64Array;
}

export interface SearchState {
  counts: Int32Array;
  /** Index of the last game each player appeared in, or -2 when they never have. */
  lastGame: Int32Array;
  /** Length of the player's current trailing run of consecutive games. */
  runLen: Int32Array;
  /** `roleCounts[group][player]`: appearances so far inside each structural role. */
  roleCounts: Int32Array[];
  consecExcess: number;
  sumStrength: number;
  sumGameFit: number;
  sumPair: number;
  sumNovelty: number;
}

export function createState(ctx: PreparedContext): SearchState {
  return {
    counts: new Int32Array(ctx.playerCount),
    lastGame: new Int32Array(ctx.playerCount).fill(-2),
    runLen: new Int32Array(ctx.playerCount),
    roleCounts: ctx.roleGroups.map(() => new Int32Array(ctx.playerCount)),
    consecExcess: 0,
    sumStrength: 0,
    sumGameFit: 0,
    sumPair: 0,
    sumNovelty: 0,
  };
}

export function cloneState(state: SearchState): SearchState {
  return {
    counts: new Int32Array(state.counts),
    lastGame: new Int32Array(state.lastGame),
    runLen: new Int32Array(state.runLen),
    roleCounts: state.roleCounts.map((counts) => new Int32Array(counts)),
    consecExcess: state.consecExcess,
    sumStrength: state.sumStrength,
    sumGameFit: state.sumGameFit,
    sumPair: state.sumPair,
    sumNovelty: state.sumNovelty,
  };
}

export function buildBoundContext(
  ctx: PreparedContext,
  candidates: readonly GameCandidates[],
): BoundContext {
  const g = ctx.gameCount;
  const suffixSlots = new Array<number>(g + 1).fill(0);
  const suffixMaxStrength = new Array<number>(g + 1).fill(0);
  const suffixMaxGameFit = new Array<number>(g + 1).fill(0);
  const suffixMaxPair = new Array<number>(g + 1).fill(0);
  const suffixMaxNovelty = new Array<number>(g + 1).fill(0);

  for (let gi = g - 1; gi >= 0; gi -= 1) {
    const isPairGame = ctx.games[gi].playerCount >= 2;
    suffixSlots[gi] = suffixSlots[gi + 1] + ctx.games[gi].playerCount;
    suffixMaxStrength[gi] = suffixMaxStrength[gi + 1] + candidates[gi].maxStrength;
    suffixMaxGameFit[gi] = suffixMaxGameFit[gi + 1] + candidates[gi].maxGameFit;
    suffixMaxPair[gi] = suffixMaxPair[gi + 1] + (isPairGame ? candidates[gi].maxPairFit : 0);
    suffixMaxNovelty[gi] = suffixMaxNovelty[gi + 1] + (isPairGame ? candidates[gi].maxNovelty : 0);
  }

  const remainingEligible: Int32Array[] = [];
  for (let gi = 0; gi <= g; gi += 1) remainingEligible.push(new Int32Array(ctx.playerCount));
  for (let gi = g - 1; gi >= 0; gi -= 1) {
    for (let pi = 0; pi < ctx.playerCount; pi += 1) {
      remainingEligible[gi][pi] =
        remainingEligible[gi + 1][pi] + (ctx.eligible[gi][pi] ? 1 : 0);
    }
  }

  const suffixRoleSlots: Int32Array[] = [];
  for (let gi = 0; gi <= g; gi += 1) suffixRoleSlots.push(new Int32Array(ctx.roleGroups.length));
  for (let gi = g - 1; gi >= 0; gi -= 1) {
    suffixRoleSlots[gi].set(suffixRoleSlots[gi + 1]);
    suffixRoleSlots[gi][ctx.roleOfGame[gi]] += ctx.games[gi].playerCount;
  }

  return {
    suffixSlots,
    suffixMaxStrength,
    suffixMaxGameFit,
    suffixMaxPair,
    suffixMaxNovelty,
    remainingEligible,
    globalMinSsd: minimalSsd(ctx.fairnessBaseline, ctx.totalSlots),
    globalSeasonMinSsd: minimalSsd(ctx.seasonBaseline, ctx.totalSlots),
    idealCounts: waterfill(ctx.fairnessBaseline, ctx.totalSlots),
    pairGameCount: ctx.multiPlayerGameCount,
    suffixRoleSlots,
    scratchTotals: new Float64Array(ctx.playerCount),
    scratchSort: new Float64Array(ctx.playerCount),
  };
}

/**
 * Optimistic (never pessimistic) estimate of the best total score reachable from a
 * partial state where games `0..gi-1` are assigned.
 *
 * - strength / gameFit / pairFit / novelty: the per-game maxima of the remaining games.
 * - fairness / season balance / role fairness: the water-filled distribution of the
 *   remaining slots (per role, for role fairness), which ignores eligibility and caps
 *   and is therefore always at least as good as any real completion.
 * - consecutive penalty: the already-committed excess, which can only grow, so it is
 *   a valid lower bound on the penalty.
 */
export function upperBound(
  ctx: PreparedContext,
  bctx: BoundContext,
  gi: number,
  state: SearchState,
): number {
  const w = ctx.weights;
  const g = ctx.gameCount;
  if (g === 0) return 0;

  const strength = (state.sumStrength + bctx.suffixMaxStrength[gi]) / g;
  const gameFit = (state.sumGameFit + bctx.suffixMaxGameFit[gi]) / g;
  const pairFit =
    bctx.pairGameCount === 0 ? 0.5 : (state.sumPair + bctx.suffixMaxPair[gi]) / bctx.pairGameCount;
  const novelty =
    bctx.pairGameCount === 0
      ? 0.5
      : (state.sumNovelty + bctx.suffixMaxNovelty[gi]) / bctx.pairGameCount;

  const remaining = bctx.suffixSlots[gi];

  const totals = bctx.scratchTotals;
  for (let pi = 0; pi < ctx.playerCount; pi += 1) {
    totals[pi] = ctx.fairnessBaseline[pi] + state.counts[pi];
  }
  const bestFairSsd = minimalSsdFast(totals, remaining, bctx.scratchSort);
  const fairness = fairnessScore(Math.max(0, bestFairSsd - bctx.globalMinSsd), ctx.totalSlots);

  let seasonPenalty = 0;
  if (ctx.effectiveSeasonWeight > 0) {
    for (let pi = 0; pi < ctx.playerCount; pi += 1) {
      totals[pi] = ctx.seasonBaseline[pi] + state.counts[pi];
    }
    const bestSeasonSsd = minimalSsdFast(totals, remaining, bctx.scratchSort);
    seasonPenalty = excessToPenalty(Math.max(0, bestSeasonSsd - bctx.globalSeasonMinSsd));
  }

  let roleFairness = 1;
  if (w.roleFairness > 0 && ctx.roleGroups.length > 0) {
    let roleExcess = 0;
    const remainingByRole = bctx.suffixRoleSlots[gi];
    for (let k = 0; k < ctx.roleGroups.length; k += 1) {
      const best = minimalSsdFast(state.roleCounts[k], remainingByRole[k], bctx.scratchSort);
      roleExcess += Math.max(0, best - ctx.roleGroups[k].minSsd);
    }
    roleFairness = roleScore(ctx.roleGroups, roleExcess);
  }

  const consecPenalty = 1 - 1 / (1 + state.consecExcess);

  return (
    w.strength * strength +
    w.gameFit * gameFit +
    w.pairFit * pairFit +
    w.fairness * fairness +
    w.roleFairness * roleFairness +
    w.novelty * novelty -
    w.consecutive * consecPenalty -
    ctx.effectiveSeasonWeight * seasonPenalty
  );
}

/**
 * Hard feasibility of placing `members` in game `gi` given the current state:
 * max appearances, and the consecutive limit when it is configured as hard.
 */
export function canPlace(
  ctx: PreparedContext,
  gi: number,
  state: SearchState,
  members: readonly number[],
  consecutiveHard: boolean,
): boolean {
  for (const pi of members) {
    if (state.counts[pi] + 1 > ctx.maxAppearances[pi]) return false;
    if (consecutiveHard) {
      const limit = ctx.maxConsecutive[pi];
      if (Number.isFinite(limit)) {
        const run = state.lastGame[pi] === gi - 1 ? state.runLen[pi] + 1 : 1;
        if (run > limit) return false;
      }
    }
  }
  return true;
}

export interface PlaceUndo {
  members: readonly number[];
  /** Role group the placement was counted in (`-1` when the format has none). */
  roleGroup: number;
  prevLastGame: number[];
  prevRunLen: number[];
  prevExcess: number;
  prevSums: [number, number, number, number];
}

/** Applies a combo to the state, returning the information needed to undo it. */
export function applyCombo(
  ctx: PreparedContext,
  gi: number,
  state: SearchState,
  members: readonly number[],
  combo: { strength: number; gameFit: number; pairFit: number; novelty: number },
): PlaceUndo {
  const undo: PlaceUndo = {
    members,
    roleGroup: state.roleCounts.length > 0 ? ctx.roleOfGame[gi] : -1,
    prevLastGame: members.map((pi) => state.lastGame[pi]),
    prevRunLen: members.map((pi) => state.runLen[pi]),
    prevExcess: state.consecExcess,
    prevSums: [state.sumStrength, state.sumGameFit, state.sumPair, state.sumNovelty],
  };

  const role = state.roleCounts[ctx.roleOfGame[gi]];
  for (const pi of members) {
    state.counts[pi] += 1;
    if (role) role[pi] += 1;
    const run = state.lastGame[pi] === gi - 1 ? state.runLen[pi] + 1 : 1;
    state.runLen[pi] = run;
    state.lastGame[pi] = gi;
    const limit = ctx.maxConsecutive[pi];
    // Each step beyond the limit adds exactly 1, which reproduces
    // `sum over runs of max(0, runLength - limit)` incrementally.
    if (Number.isFinite(limit) && run > limit) state.consecExcess += 1;
  }

  state.sumStrength += combo.strength;
  state.sumGameFit += combo.gameFit;
  if (ctx.games[gi].playerCount >= 2) {
    state.sumPair += combo.pairFit;
    state.sumNovelty += combo.novelty;
  }
  return undo;
}

export function undoCombo(state: SearchState, undo: PlaceUndo): void {
  const role = undo.roleGroup >= 0 ? state.roleCounts[undo.roleGroup] : undefined;
  undo.members.forEach((pi, index) => {
    state.counts[pi] -= 1;
    if (role) role[pi] -= 1;
    state.lastGame[pi] = undo.prevLastGame[index];
    state.runLen[pi] = undo.prevRunLen[index];
  });
  state.consecExcess = undo.prevExcess;
  [state.sumStrength, state.sumGameFit, state.sumPair, state.sumNovelty] = undo.prevSums;
}

/**
 * Necessary condition for the remaining games to still satisfy every hard minimum
 * appearance requirement. Used as a feasibility prune, not as a guarantee.
 */
export function minAppearancesReachable(
  ctx: PreparedContext,
  bctx: BoundContext,
  gi: number,
  state: SearchState,
): boolean {
  if (ctx.input.settings.minAppearanceMode !== 'hard') return true;
  let deficitSum = 0;
  for (let pi = 0; pi < ctx.playerCount; pi += 1) {
    const deficit = ctx.minAppearances[pi] - state.counts[pi];
    if (deficit <= 0) continue;
    if (deficit > bctx.remainingEligible[gi][pi]) return false;
    if (state.counts[pi] + deficit > ctx.maxAppearances[pi]) return false;
    deficitSum += deficit;
  }
  return deficitSum <= bctx.suffixSlots[gi];
}
