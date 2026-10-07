/**
 * Data confidence (MASTER SPEC Phase 2 §10, Phase 3 §9).
 *
 * Confidence is about how much data an estimate stands on — not about how far apart
 * two players are. Every threshold is a named constant so it can be calibrated.
 *
 * Displayed as 高 / 中 / 低; a LOW estimate is labelled "参考値".
 */
export type ConfidenceLevel = 'LOW' | 'MEDIUM' | 'HIGH';

export const CONFIDENCE_LABELS: Record<ConfidenceLevel, string> = {
  HIGH: '高',
  MEDIUM: '中',
  LOW: '低',
};

/** Player data: recency-weighted legs played. */
export const PLAYER_CONFIDENCE_LEGS = { HIGH: 40, MEDIUM: 12 } as const;
/** Order model: recency-weighted past matches observed for the opponent team. */
export const ORDER_CONFIDENCE_MATCHES = { HIGH: 8, MEDIUM: 3 } as const;
/** One slot of the order model: recency-weighted observations of that slot. */
export const SLOT_CONFIDENCE_SAMPLES = { HIGH: 6, MEDIUM: 2.5 } as const;

const RANK: Record<ConfidenceLevel, number> = { LOW: 0, MEDIUM: 1, HIGH: 2 };

export function byThreshold(value: number, thresholds: { HIGH: number; MEDIUM: number }): ConfidenceLevel {
  if (!Number.isFinite(value)) return 'LOW';
  if (value >= thresholds.HIGH) return 'HIGH';
  if (value >= thresholds.MEDIUM) return 'MEDIUM';
  return 'LOW';
}

export function playerConfidence(weightedLegs: number): ConfidenceLevel {
  return byThreshold(weightedLegs, PLAYER_CONFIDENCE_LEGS);
}

export function orderModelConfidence(weightedMatches: number): ConfidenceLevel {
  return byThreshold(weightedMatches, ORDER_CONFIDENCE_MATCHES);
}

export function slotConfidence(weightedSamples: number): ConfidenceLevel {
  return byThreshold(weightedSamples, SLOT_CONFIDENCE_SAMPLES);
}

/** The weaker of two confidences (an estimate is only as sure as its weakest input). */
export function minConfidence(...levels: ConfidenceLevel[]): ConfidenceLevel {
  return levels.reduce((low, level) => (RANK[level] < RANK[low] ? level : low), 'HIGH' as ConfidenceLevel);
}

/** One step lower (e.g. cricket, where PPR predicts less). */
export function lowerConfidence(level: ConfidenceLevel): ConfidenceLevel {
  return level === 'HIGH' ? 'MEDIUM' : 'LOW';
}

/**
 * Typical confidence of a set (used for a whole match): MEDIUM or better only when at
 * least half of the inputs are.
 */
export function aggregateConfidence(levels: readonly ConfidenceLevel[]): ConfidenceLevel {
  if (levels.length === 0) return 'LOW';
  const sorted = [...levels].sort((a, b) => RANK[a] - RANK[b]);
  return sorted[Math.floor((sorted.length - 1) / 2)];
}

export function confidenceRank(level: ConfidenceLevel): number {
  return RANK[level];
}
