import type { ScoreBreakdown } from '../../domain/types';
import { evaluateFairness, excessToPenalty, type FairnessResult } from '../../domain/orders/fairness';
import { consecutiveExcess, longestRun } from '../../domain/orders/consecutive';
import { evaluateRoleFairness, type RoleFairnessResult } from '../../domain/orders/roleFairness';
import { mean } from '../../utils/math';
import type { Combo } from '../candidates/combinations';
import type { PreparedContext } from '../prepare';

/**
 * Scoring function (docs/DESIGN.md §7).
 *
 *   Score = w_strength    * Strength
 *         + w_gameFit     * GameFit
 *         + w_pairFit     * PairFit
 *         + w_fairness    * Fairness
 *         + w_role        * RoleFairness
 *         + w_novelty     * PairNovelty
 *         - w_consecutive * ConsecutivePenalty
 *         - w_season      * SeasonImbalance
 *         + w_opponent    * OpponentWin   (opponent-optimised preset only)
 *
 * Every component is normalised to 0..1 first, so the weights are directly
 * comparable. This is the single source of truth for scoring: the search, the
 * explanation builder and the UI all call it, which is what keeps the displayed
 * reasons identical to the numbers the optimizer actually optimised.
 */
export interface Evaluation {
  breakdown: ScoreBreakdown;
  /** Appearances per player index. */
  counts: number[];
  /** Per-player appearance game indices. */
  appearances: number[][];
  fairness: FairnessResult;
  /** Spread of each structural role (Singles, Doubles, …) across players. */
  roleFairness: RoleFairnessResult;
  /** `roleCounts[group][player]`: appearances inside each role group. */
  roleCounts: number[][];
  /** Fairness measured on season-inclusive totals (always, regardless of scope). */
  seasonFairness: FairnessResult;
  consecutiveExcessTotal: number;
  maxConsecutive: number;
  /** Mean effective rating across filled slots, or `null` if no rating is known. */
  averageRating: number | null;
  /** Mean effective PPR across filled slots, or `null` if no PPR is known. */
  averagePpr: number | null;
  strengthRaw: number;
  gameFitRaw: number;
  pairFitRaw: number;
  noveltyRaw: number;
  /** Mean estimated game win probability (0.5 per game without opponent data). */
  opponentRaw: number;
}

/** Appearance counts and per-player game indices for a selection. */
export function tallySelection(
  ctx: PreparedContext,
  selection: readonly Combo[],
): { counts: number[]; appearances: number[][]; roleCounts: number[][] } {
  const counts = new Array<number>(ctx.playerCount).fill(0);
  const appearances: number[][] = Array.from({ length: ctx.playerCount }, () => []);
  const roleCounts = ctx.roleGroups.map(() => new Array<number>(ctx.playerCount).fill(0));
  for (let gi = 0; gi < selection.length; gi += 1) {
    const role = roleCounts[ctx.roleOfGame[gi]];
    for (const member of selection[gi].members) {
      counts[member] += 1;
      appearances[member].push(gi);
      if (role) role[member] += 1;
    }
  }
  return { counts, appearances, roleCounts };
}

export function positiveWeightSum(ctx: PreparedContext): number {
  const w = ctx.weights;
  return w.strength + w.gameFit + w.pairFit + w.fairness + w.roleFairness + w.novelty + (w.opponentWin ?? 0);
}

export function negativeWeightSum(ctx: PreparedContext): number {
  return ctx.weights.consecutive + ctx.effectiveSeasonWeight;
}

/** Maps a raw weighted score onto a 0..100 display value (monotonic, so ranks match). */
export function toDisplayScore(ctx: PreparedContext, total: number): number {
  const pos = positiveWeightSum(ctx);
  const neg = negativeWeightSum(ctx);
  const span = pos + neg;
  if (span <= 0) return 0;
  return Math.max(0, Math.min(100, (100 * (total + neg)) / span));
}

export function evaluateSelection(
  ctx: PreparedContext,
  selection: readonly Combo[],
): Evaluation {
  const { counts, appearances, roleCounts } = tallySelection(ctx, selection);

  const strengthRaw = selection.length === 0 ? 0 : mean(selection.map((c) => c.strength));
  const gameFitRaw = selection.length === 0 ? 0 : mean(selection.map((c) => c.gameFit));

  const multi = selection.filter((_, gi) => ctx.games[gi].playerCount >= 2);
  const pairFitRaw = multi.length === 0 ? 0.5 : mean(multi.map((c) => c.pairFit));
  const noveltyRaw = multi.length === 0 ? 0.5 : mean(multi.map((c) => c.novelty));
  const opponentRaw = selection.length === 0 ? 0.5 : mean(selection.map((c) => c.oppWin));

  const fairness = evaluateFairness(ctx.fairnessBaseline, counts);
  const seasonFairness = evaluateFairness(ctx.seasonBaseline, counts);
  const roleFairness = evaluateRoleFairness(ctx.roleGroups, roleCounts);

  let excessTotal = 0;
  let maxConsecutive = 0;
  for (let pi = 0; pi < ctx.playerCount; pi += 1) {
    const limit = ctx.maxConsecutive[pi];
    if (Number.isFinite(limit)) excessTotal += consecutiveExcess(appearances[pi], limit);
    maxConsecutive = Math.max(maxConsecutive, longestRun(appearances[pi]));
  }
  const consecutivePenalty = 1 - 1 / (1 + excessTotal);
  const seasonImbalance = excessToPenalty(seasonFairness.excess);

  const w = ctx.weights;
  const total =
    w.strength * strengthRaw +
    w.gameFit * gameFitRaw +
    w.pairFit * pairFitRaw +
    w.fairness * fairness.score +
    w.roleFairness * roleFairness.score +
    w.novelty * noveltyRaw +
    (w.opponentWin ?? 0) * opponentRaw -
    w.consecutive * consecutivePenalty -
    ctx.effectiveSeasonWeight * seasonImbalance;

  // Mean effective rating over filled slots (weighted by appearances, which is what a
  // captain reads as "this line-up's average rating").
  const slotAverage = (values: Map<string, number | null>): number | null => {
    let sum = 0;
    let slots = 0;
    for (let pi = 0; pi < ctx.playerCount; pi += 1) {
      const value = values.get(ctx.playerIds[pi]);
      if (value === null || value === undefined) continue;
      sum += value * counts[pi];
      slots += counts[pi];
    }
    return slots > 0 ? sum / slots : null;
  };

  const breakdown: ScoreBreakdown = {
    strength: strengthRaw,
    gameFit: gameFitRaw,
    pairFit: pairFitRaw,
    fairness: fairness.score,
    roleFairness: roleFairness.score,
    novelty: noveltyRaw,
    consecutivePenalty,
    seasonImbalance,
    opponentWin: ctx.opponent ? opponentRaw : undefined,
    total,
    display: toDisplayScore(ctx, total),
  };

  return {
    breakdown,
    counts,
    appearances,
    fairness,
    roleFairness,
    roleCounts,
    seasonFairness,
    consecutiveExcessTotal: excessTotal,
    maxConsecutive,
    averageRating: slotAverage(ctx.ratings.effective),
    averagePpr: slotAverage(ctx.pprs.effective),
    strengthRaw,
    gameFitRaw,
    pairFitRaw,
    noveltyRaw,
    opponentRaw,
  };
}

/**
 * Deterministic comparison of two evaluated selections (docs/DESIGN.md §7.4).
 * Returns a negative number when `a` ranks before `b`.
 */
export function compareEvaluations(
  a: { evaluation: Evaluation; selection: readonly Combo[] },
  b: { evaluation: Evaluation; selection: readonly Combo[] },
): number {
  const EPSILON = 1e-9;
  const scoreDiff = b.evaluation.breakdown.total - a.evaluation.breakdown.total;
  if (Math.abs(scoreDiff) > EPSILON) return scoreDiff;

  const spreadDiff = a.evaluation.fairness.spread - b.evaluation.fairness.spread;
  if (spreadDiff !== 0) return spreadDiff;

  const consecDiff = a.evaluation.maxConsecutive - b.evaluation.maxConsecutive;
  if (consecDiff !== 0) return consecDiff;

  const fairnessDiff = b.evaluation.fairness.score - a.evaluation.fairness.score;
  if (Math.abs(fairnessDiff) > EPSILON) return fairnessDiff;

  // Final tie-break: lexicographic order of the player-index sequence.
  for (let gi = 0; gi < Math.min(a.selection.length, b.selection.length); gi += 1) {
    const am = a.selection[gi].members;
    const bm = b.selection[gi].members;
    for (let i = 0; i < Math.min(am.length, bm.length); i += 1) {
      if (am[i] !== bm[i]) return am[i] - bm[i];
    }
  }
  return 0;
}
