import type { HistoricalPlayerStats } from '../n01/history';
import { aggregatePlayer } from '../n01/history';
import { RECENCY_WEIGHTS } from '../n01/recency';
import type { ConfidenceLevel } from './confidence';
import { playerConfidence } from './confidence';

/**
 * Player performance rating (MASTER SPEC Phase 3 §2–§4).
 *
 * Deliberately simple and explainable — no learned model:
 *
 *   base     = recency-weighted PPR (3-dart average), darts-weighted
 *   shrunk   = (n · base + k · leagueMean) / (n + k)       n = weighted legs, k = PRIOR_LEGS
 *   form     = clamp(FORM_WEIGHT · (shrunk current-season PPR − shrunk), ±FORM_CAP)
 *   first9   = clamp(FIRST9_WEIGHT · (First9 − PPR − league First9 gap), ±FIRST9_CAP)
 *   strength = shrunk + form + first9                     (PPR points)
 *
 * A player with little data is pulled towards the league mean instead of being trusted
 * at an extreme value; a player with none *is* the league mean, at LOW confidence.
 * Leg-win rate is not part of the strength: it mostly reflects who a player happened to
 * face, so it is shown as context only. Every constant can be calibrated (Phase 6).
 */

export const PRIOR_LEGS = 30;
export const FORM_WEIGHT = 0.25;
export const FORM_CAP = 3;
export const FIRST9_WEIGHT = 0.1;
export const FIRST9_CAP = 2;
/** Used only when nothing at all is known about the league. */
export const FALLBACK_LEAGUE_PPR = 45;
/** A hand-entered PPR counts as this many legs of evidence. */
export const MANUAL_PPR_LEGS = 10;

export interface StrengthParameters {
  priorLegs: number;
  weights: readonly number[];
}

export const DEFAULT_STRENGTH_PARAMETERS: StrengthParameters = {
  priorLegs: PRIOR_LEGS,
  weights: RECENCY_WEIGHTS,
};

export interface PlayerStrength {
  /** Strength in PPR points. */
  strength: number;
  /** Recency-weighted PPR before shrinkage (`null` without data). */
  rawPpr: number | null;
  shrunkPpr: number;
  formAdjustment: number;
  first9Adjustment: number;
  /** Recency-weighted legs behind the estimate. */
  legs: number;
  seasons: number;
  confidence: ConfidenceLevel;
  /** True when there was no data and the league mean was used. */
  imputed: boolean;
  legWinRate: number | null;
}

function shrink(value: number, n: number, mean: number, k: number): number {
  return (n * value + k * mean) / (n + k);
}

function clamp(value: number, cap: number): number {
  return Math.max(-cap, Math.min(cap, value));
}

export interface LeaguePrior {
  meanPpr: number | null;
  /** League-wide First9 − PPR gap, when First9 data exists. */
  first9Gap: number | null;
}

/** League-wide First9 gap from every player's aggregate (players with First9 only). */
export function leagueFirst9Gap(
  stats: readonly Pick<HistoricalPlayerStats, 'seasons'>[],
  weights: readonly number[] = RECENCY_WEIGHTS,
): number | null {
  let gap = 0;
  let total = 0;
  for (const entry of stats) {
    const aggregate = aggregatePlayer(entry, weights);
    if (aggregate.first9 === null || aggregate.ppr === null) continue;
    gap += (aggregate.first9 - aggregate.ppr) * aggregate.weightedLegs;
    total += aggregate.weightedLegs;
  }
  return total > 0 ? gap / total : null;
}

export function playerStrength(
  stats: Pick<HistoricalPlayerStats, 'seasons'> | null | undefined,
  prior: LeaguePrior,
  parameters: StrengthParameters = DEFAULT_STRENGTH_PARAMETERS,
): PlayerStrength {
  const mean = prior.meanPpr ?? FALLBACK_LEAGUE_PPR;
  const aggregate = aggregatePlayer(stats, parameters.weights);
  if (aggregate.ppr === null || aggregate.weightedLegs <= 0) {
    return {
      strength: mean,
      rawPpr: null,
      shrunkPpr: mean,
      formAdjustment: 0,
      first9Adjustment: 0,
      legs: 0,
      seasons: 0,
      confidence: 'LOW',
      imputed: true,
      legWinRate: null,
    };
  }
  const k = parameters.priorLegs;
  const shrunk = shrink(aggregate.ppr, aggregate.weightedLegs, mean, k);
  const form =
    aggregate.currentPpr !== null && aggregate.seasonsWithData > 1
      ? clamp(FORM_WEIGHT * (shrink(aggregate.currentPpr, aggregate.currentLegs, mean, k) - shrunk), FORM_CAP)
      : 0;
  const first9 =
    aggregate.first9 !== null && prior.first9Gap !== null
      ? clamp(
          FIRST9_WEIGHT * (aggregate.first9 - aggregate.ppr - prior.first9Gap) * (aggregate.weightedLegs / (aggregate.weightedLegs + k)),
          FIRST9_CAP,
        )
      : 0;
  return {
    strength: shrunk + form + first9,
    rawPpr: aggregate.ppr,
    shrunkPpr: shrunk,
    formAdjustment: form,
    first9Adjustment: first9,
    legs: aggregate.weightedLegs,
    seasons: aggregate.seasonsWithData,
    confidence: playerConfidence(aggregate.weightedLegs),
    imputed: false,
    legWinRate: aggregate.legWinRate,
  };
}

/**
 * A player League Order knows only by a hand-entered PPR (a guest, an unlinked player):
 * the value counts as {@link MANUAL_PPR_LEGS} legs of evidence. Without one, the league
 * mean at LOW confidence.
 */
export function manualStrength(ppr: number | null, prior: LeaguePrior, priorLegs = PRIOR_LEGS): PlayerStrength {
  const mean = prior.meanPpr ?? FALLBACK_LEAGUE_PPR;
  if (ppr === null || !Number.isFinite(ppr)) return playerStrength(null, prior);
  const shrunk = shrink(ppr, MANUAL_PPR_LEGS, mean, priorLegs);
  return {
    strength: shrunk,
    rawPpr: ppr,
    shrunkPpr: shrunk,
    formAdjustment: 0,
    first9Adjustment: 0,
    legs: MANUAL_PPR_LEGS,
    seasons: 0,
    confidence: 'LOW',
    imputed: false,
    legWinRate: null,
  };
}
