import type { PairAffinity } from '../types';

/**
 * Doubles / Trios / Team / Gallon strength (MASTER SPEC Phase 3 §6–§7).
 *
 * A side's strength is the mean of its players' strengths — robust (trimmed: the
 * highest and lowest dropped) from five players up, so one outlier cannot carry a
 * team game — plus a small pair-affinity term for sides of two or more:
 *
 *   VERY_GOOD +1.5 · GOOD +0.75 · NEUTRAL 0 · DISCOURAGED −1.5   PPR points (pair mean)
 *
 * Affinity is the captain's own judgement from League Order; n01 has no pair data.
 */

export const PAIR_AFFINITY_PPR_BONUS: Record<Exclude<PairAffinity, 'FORBIDDEN'>, number> = {
  VERY_GOOD: 1.5,
  GOOD: 0.75,
  NEUTRAL: 0,
  DISCOURAGED: -1.5,
};

export const TRIMMED_MEAN_FROM = 5;

export function sideStrength(strengths: readonly number[], pairBonus = 0): number {
  if (strengths.length === 0) return 0;
  const sorted = [...strengths].sort((a, b) => a - b);
  const used = sorted.length >= TRIMMED_MEAN_FROM ? sorted.slice(1, -1) : sorted;
  const mean = used.reduce((acc, value) => acc + value, 0) / used.length;
  return mean + (strengths.length >= 2 ? pairBonus : 0);
}

/** Mean affinity bonus over every pair in the side (0 for a single player). */
export function meanPairBonus(affinities: readonly (Exclude<PairAffinity, 'FORBIDDEN'> | undefined)[]): number {
  if (affinities.length === 0) return 0;
  const total = affinities.reduce((acc, affinity) => acc + PAIR_AFFINITY_PPR_BONUS[affinity ?? 'NEUTRAL'], 0);
  return total / affinities.length;
}
