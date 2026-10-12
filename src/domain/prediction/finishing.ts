import type { DartsDiscipline } from '../types';
import { clamp } from '../../utils/math';
import type { ConfidenceLevel } from './confidence';
import { playerConfidence } from './confidence';

/**
 * Finishing ability for the 01 throw-order model (docs/THROW_ORDER_MODEL.md §3).
 *
 * n01 does not report a checkout rate: its public stats have no doubles thrown, no checkout
 * attempts, nothing a checkout percentage could be computed from. The rate is therefore a
 * prior, and only what n01 does report moves it:
 *
 *   prior(μ)  = clamp(at50 + slope · (μ − 50), min, max)        a mild slope: PPR alone must
 *                                                               not pin down finishing
 *   rate      = clamp(prior · exp(−γ · excess), 0.08, 0.7)
 *   excess    = (First 9 − PPR − league gap) · legs / (legs + 30)  (shrunk, from `playerStrength`)
 *
 * A First 9 average well above the overall average — beyond the league's usual gap — means the
 * scoring visits outrun the rest of the leg, i.e. the finishing costs that player more darts
 * than it costs others. It is weak evidence and is used only as a shrunk adjustment of the
 * prior; its confidence is the confidence of the legs behind it. High Out and Best Leg are
 * single extreme values (they grow with the number of legs played) and are not used.
 * Steel is double-out; soft darts usually finish on any segment, so its prior is higher.
 */

export interface FinishPrior {
  at50: number;
  slope: number;
  min: number;
  max: number;
}

export const FINISH_PRIORS: Record<'STEEL' | 'SOFT', FinishPrior> = {
  STEEL: { at50: 0.3, slope: 0.004, min: 0.15, max: 0.5 },
  SOFT: { at50: 0.4, slope: 0.004, min: 0.2, max: 0.6 },
};

/** Relative change of the finishing rate per PPR point of First 9 excess. */
export const FINISH_GAP_ELASTICITY = 0.08;
export const FINISH_RATE_MIN = 0.08;
export const FINISH_RATE_MAX = 0.7;

export interface FinishEstimate {
  /** Per-visit probability of finishing once inside the finishing range. */
  rate: number;
  /** What the rate would be with no player evidence at all. */
  prior: number;
  /** The shrunk First 9 excess behind the adjustment (`null` = none). */
  excess: number | null;
  legs: number;
  confidence: ConfidenceLevel;
  source: 'first9' | 'prior';
}

export function finishPrior(mu: number, discipline: DartsDiscipline = 'UNSPECIFIED'): number {
  const prior = FINISH_PRIORS[discipline === 'SOFT' ? 'SOFT' : 'STEEL'];
  return clamp(prior.at50 + prior.slope * (mu - 50), prior.min, prior.max);
}

export function priorFinish(mu: number, discipline: DartsDiscipline = 'UNSPECIFIED'): FinishEstimate {
  const prior = finishPrior(mu, discipline);
  return { rate: prior, prior, excess: null, legs: 0, confidence: 'LOW', source: 'prior' };
}

export function estimateFinish(
  mu: number,
  first9Excess: number | null | undefined,
  legs: number,
  discipline: DartsDiscipline = 'UNSPECIFIED',
): FinishEstimate {
  if (first9Excess === null || first9Excess === undefined || !Number.isFinite(first9Excess) || !(legs > 0)) {
    return priorFinish(mu, discipline);
  }
  const prior = finishPrior(mu, discipline);
  return {
    rate: clamp(prior * Math.exp(-FINISH_GAP_ELASTICITY * first9Excess), FINISH_RATE_MIN, FINISH_RATE_MAX),
    prior,
    excess: first9Excess,
    legs,
    confidence: playerConfidence(legs),
    source: 'first9',
  };
}

/**
 * The same estimate with only `share` of its evidence (0 = the prior, 1 = unchanged), on the
 * log scale the adjustment is made on. Used by the stability check of a throw order.
 */
export function partialFinish(estimate: Pick<FinishEstimate, 'rate' | 'prior'>, share: number): number {
  if (estimate.prior <= 0 || estimate.rate <= 0) return estimate.rate;
  return clamp(estimate.prior * (estimate.rate / estimate.prior) ** share, FINISH_RATE_MIN, FINISH_RATE_MAX);
}
