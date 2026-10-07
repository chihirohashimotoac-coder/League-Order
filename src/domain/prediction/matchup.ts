/**
 * Single matchup (MASTER SPEC Phase 3 §5).
 *
 *   P(A wins a leg) = 1 / (1 + exp(−k · (S_A − S_B)))        S in PPR points
 *
 * A game is "first to m legs" (`limit_leg_count`), so the game probability follows from
 * the leg probability exactly:
 *
 *   P(game) = Σ_{j=0}^{m−1} C(m−1+j, j) · p^m · (1−p)^j
 *
 * When n01 does not say how many legs a game needs, one leg is assumed — the most
 * cautious choice, since more legs only push probabilities further from 50%.
 *
 * Cricket is scored differently and PPR predicts it less well: the slope is scaled down
 * and the confidence lowered by the caller.
 *
 * These are model estimates ("推定"), not true probabilities.
 */

export const K_LEG = 0.09;
export const K_CRICKET_FACTOR = 0.6;
/** Probabilities are never shown or optimised as exact 0 or 1. */
export const PROBABILITY_FLOOR = 0.01;

export interface GameShape {
  /** Legs needed to win the game (`null` = unknown → 1). */
  legsToWin: number | null;
  cricket: boolean;
}

export function legWinProbability(diff: number, k = K_LEG): number {
  return 1 / (1 + Math.exp(-k * diff));
}

function binomial(n: number, r: number): number {
  let result = 1;
  for (let i = 1; i <= r; i += 1) result = (result * (n - r + i)) / i;
  return result;
}

/** P(first to `m` legs) for a leg probability `p`. */
export function raceProbability(p: number, m: number): number {
  const legs = Math.max(1, Math.round(m));
  let total = 0;
  for (let j = 0; j < legs; j += 1) total += binomial(legs - 1 + j, j) * p ** legs * (1 - p) ** j;
  return total;
}

export function clampProbability(p: number): number {
  return Math.max(PROBABILITY_FLOOR, Math.min(1 - PROBABILITY_FLOOR, p));
}

/** Estimated probability that a side of strength `ours` beats a side of strength `theirs`. */
export function gameWinProbability(ours: number, theirs: number, shape: GameShape, k = K_LEG): number {
  const slope = shape.cricket ? k * K_CRICKET_FACTOR : k;
  const p = legWinProbability(ours - theirs, slope);
  return clampProbability(raceProbability(p, shape.legsToWin ?? 1));
}
