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
export function minimalSsd(baselines: ArrayLike<number>, total: number): number {
  const n = baselines.length;
  if (n === 0) return 0;
  const sorted = Array.from(baselines).sort((a, b) => a - b);
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

/**
 * Allocation-free {@link minimalSsd} for the search's hot loop.
 *
 * `scratch` must hold at least `values.length` entries; it is overwritten. The result
 * equals `minimalSsd(values, total)` up to floating-point rounding (the tests check
 * both against the reference). The bound evaluates this once per role and per search
 * node, and the per-call arrays of the general version were what made it expensive.
 */
export function minimalSsdFast(values: ArrayLike<number>, total: number, scratch: Float64Array): number {
  const n = values.length;
  if (n === 0) return 0;
  const sorted = scratch.length === n ? scratch : scratch.subarray(0, n);
  for (let i = 0; i < n; i += 1) sorted[i] = values[i];
  sorted.sort();

  // Water level: the highest level the lowest entries can all be raised to. Written
  // without a helper closure on purpose — this runs at every search node.
  let level = Number.NEGATIVE_INFINITY;
  let extra = 0;
  if (total > 0) {
    let lo = sorted[0];
    let hi = sorted[0] + total;
    while (lo < hi) {
      const mid = Math.floor((lo + hi + 1) / 2);
      let cost = 0;
      for (let i = 0; i < n && sorted[i] < mid; i += 1) cost += mid - sorted[i];
      if (cost <= total) lo = mid;
      else hi = mid - 1;
    }
    level = lo;
    let cost = 0;
    for (let i = 0; i < n && sorted[i] < level; i += 1) cost += level - sorted[i];
    extra = total - cost;
  }

  let sum = 0;
  let sumSq = 0;
  for (let i = 0; i < n; i += 1) {
    let value = sorted[i] < level ? level : sorted[i];
    if (extra > 0 && value === level) {
      value += 1;
      extra -= 1;
    }
    sum += value;
    sumSq += value * value;
  }
  return Math.max(0, sumSq - (sum * sum) / n);
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
  /** {@link fairnessScore} of `excess`, in [0, 1]; 1 means "as even as arithmetic allows". */
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
    score: fairnessScore(excess, total),
    spread,
    stdDev: stdDev(counts),
  };
}

/**
 * Share of the saturating curve in {@link fairnessScore}; the rest is linear.
 * See that function for why both are needed.
 */
export const FAIRNESS_SATURATING_SHARE = 0.25;

/**
 * Maps an excess onto the 0..1 fairness score (design record D-05, revised by D-21).
 *
 *     score = a · 1 / (1 + excess / 2)  +  (1 − a) · max(0, 1 − excess / (2 · slots))
 *
 * with `a` = {@link FAIRNESS_SATURATING_SHARE}.
 *
 * The first part is the original curve. It makes the *first* step away from an even
 * split the most expensive one — but on its own it saturates: once one player is
 * over-used, using them again and benching somebody else costs almost nothing more.
 * Under the low fairness weight of the win-first preset that gave an all-or-nothing
 * behaviour: either a perfectly even order, or a cascade that benched the weakest
 * player. No weight produced "one extra game for the ace, nobody benched".
 *
 * The second part is linear in the excess, and the excess grows with the *square* of
 * each player's deviation, so every further step away from even costs more than the
 * last — concentrating on one player gets progressively dearer. It is scaled by the
 * number of slots, so one unit of imbalance weighs about the same in a 6-game and an
 * 11-game format.
 *
 * Both parts strictly decrease with the excess, so "lower excess ⇒ higher score" — the
 * only property the search and its tie-breaks rely on — still holds, and the score is
 * exactly 1 for the most even split arithmetic allows.
 */
export function fairnessScore(excess: number, slots: number): number {
  const e = Math.max(0, excess);
  const saturating = 1 / (1 + e / 2);
  const linear = slots > 0 ? Math.max(0, 1 - e / (2 * slots)) : e > 0 ? 0 : 1;
  return FAIRNESS_SATURATING_SHARE * saturating + (1 - FAIRNESS_SATURATING_SHARE) * linear;
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
