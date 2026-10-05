/**
 * Fairness metric (design record D-05, docs/DESIGN.md §4).
 *
 * The metric is the **excess sum of squared deviations** of per-player totals from
 * their mean, measured against the best distribution that the same number of slots
 * could possibly achieve. Minimising the sum of squared deviations of an integer
 * distribution with a fixed sum is exactly equivalent to using only `floor(T/N)`
 * and `ceil(T/N)`, so "equal when divisible, spread of 1 otherwise" follows from
 * this single metric — while still distinguishing 3,1,2,2,2 from 3,2,2,2,2, which a
 * max-spread metric cannot.
 */

import { mean, stdDev } from '../../utils/math';

/**
 * Distributes `total` additional appearances over the given baselines as evenly as
 * possible, always giving the next appearance to the currently lowest total.
 *
 * The objective (sum of squared deviations) is separable and convex, so this greedy
 * assignment is the exact minimiser — not an approximation.
 */
export function waterfill(baselines: readonly number[], total: number): number[] {
  const n = baselines.length;
  const added = new Array<number>(n).fill(0);
  if (n === 0 || total <= 0) return added;

  const totals = [...baselines];
  for (let unit = 0; unit < total; unit += 1) {
    let best = 0;
    for (let i = 1; i < n; i += 1) {
      if (totals[i] < totals[best]) best = i;
    }
    totals[best] += 1;
    added[best] += 1;
  }
  return added;
}

/** Sum of squared deviations from the mean. */
export function sumSquaredDeviation(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const m = mean(values);
  let acc = 0;
  for (const value of values) acc += (value - m) ** 2;
  return acc;
}

/**
 * The smallest sum of squared deviations reachable for these baselines and slots.
 *
 * Equivalent to `sumSquaredDeviation` of a `waterfill` distribution, but computed by
 * binary-searching the water level in O(n log total) instead of distributing unit by
 * unit, because the optimizer evaluates this bound at every search node.
 * `minimalSsdReference` below is the straightforward implementation the tests check
 * this against.
 */
export function minimalSsd(baselines: readonly number[], total: number): number {
  const n = baselines.length;
  if (n === 0) return 0;
  const sorted = [...baselines].sort((a, b) => a - b);
  if (total <= 0) return sumSquaredDeviation(sorted);

  /** Units needed to raise everybody below `level` up to `level`. */
  const costTo = (level: number): number => {
    let cost = 0;
    for (const value of sorted) {
      if (value >= level) break;
      cost += level - value;
    }
    return cost;
  };

  let lo = sorted[0];
  let hi = sorted[0] + total;
  while (lo < hi) {
    const mid = Math.floor((lo + hi + 1) / 2);
    if (costTo(mid) <= total) lo = mid;
    else hi = mid - 1;
  }
  const level = lo;
  let extra = total - costTo(level);
  const finals = sorted.map((value) => (value < level ? level : value));
  // `extra` is always smaller than the number of entries sitting exactly at `level`,
  // so this loop always places every remaining unit.
  for (let i = 0; i < finals.length && extra > 0; i += 1) {
    if (finals[i] === level) {
      finals[i] += 1;
      extra -= 1;
    }
  }
  return sumSquaredDeviation(finals);
}

/** Reference implementation of {@link minimalSsd}, used as a test oracle. */
export function minimalSsdReference(baselines: readonly number[], total: number): number {
  const added = waterfill(baselines, total);
  return sumSquaredDeviation(baselines.map((base, i) => base + added[i]));
}

export interface FairnessResult {
  /** Sum of squared deviations of the actual distribution. */
  ssd: number;
  /** The unconstrained optimum for the same baselines and slot count. */
  minSsd: number;
  /** `ssd - minSsd`, clamped at 0. Zero means "as even as arithmetic allows". */
  excess: number;
  /** `1 / (1 + excess / 2)`, in (0, 1]. */
  score: number;
  spread: number;
  stdDev: number;
}

/**
 * Evaluates fairness for a distribution of `counts` on top of `baselines`.
 *
 * `spread` and `stdDev` are reported over `counts` only (today's appearances), which
 * is what a captain inspects, while `score` uses baselines + counts so the season
 * scope can be folded in.
 */
export function evaluateFairness(
  baselines: readonly number[],
  counts: readonly number[],
): FairnessResult {
  const totals = baselines.map((base, i) => base + (counts[i] ?? 0));
  const total = counts.reduce((acc, c) => acc + c, 0);
  const ssd = sumSquaredDeviation(totals);
  const minSsd = minimalSsd(baselines, total);
  const excess = Math.max(0, ssd - minSsd);
  const spread = counts.length === 0 ? 0 : Math.max(...counts) - Math.min(...counts);
  return {
    ssd,
    minSsd,
    excess,
    score: 1 / (1 + excess / 2),
    spread,
    stdDev: stdDev(counts),
  };
}

/** Converts an excess value into a 0..1 penalty (the complement of the score). */
export function excessToPenalty(excess: number): number {
  return 1 - 1 / (1 + Math.max(0, excess) / 2);
}

/**
 * The ideal appearance count per player given baselines and a slot total — used by
 * the UI ("理想との差") and by the optimizer's ordering heuristic.
 */
export function idealCounts(baselines: readonly number[], total: number): number[] {
  return waterfill(baselines, total);
}
