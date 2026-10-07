/**
 * Recency weighting (docs/N01_MASTER_DESIGN.md §7, MASTER SPEC Phase 2 §6).
 *
 * Older seasons count, but less: a player's form two seasons ago says less about next
 * week than this season does. Index 0 is the current season. The values are constants
 * so they can be calibrated later (Phase 6 sensitivity analysis varies them).
 */
export const RECENCY_WEIGHTS: readonly number[] = [1.0, 0.6, 0.35];
/** Weight of any season older than those listed. */
export const RECENCY_FLOOR = 0.2;

/** How many previous seasons are read by default (current + 2). */
export const HISTORY_DEPTH_DEFAULT = 2;
export const HISTORY_DEPTH_MAX = 4;

export function recencyWeight(seasonIndex: number, weights: readonly number[] = RECENCY_WEIGHTS): number {
  if (!Number.isInteger(seasonIndex) || seasonIndex < 0) return 0;
  return seasonIndex < weights.length ? weights[seasonIndex] : RECENCY_FLOOR;
}

export function clampHistoryDepth(value: unknown): number {
  const depth = typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : HISTORY_DEPTH_DEFAULT;
  return Math.max(0, Math.min(HISTORY_DEPTH_MAX, depth));
}
