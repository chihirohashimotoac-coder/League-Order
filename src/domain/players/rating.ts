import type { ParticipantConfig, Player, PlayerId, Rating } from '../types';
import { median } from '../../utils/math';

/**
 * Rating resolution (design record D-06).
 *
 * An Unknown rating (`null`) is NEVER converted to `0`. Instead it is imputed with
 * the **median of the known ratings among the participants**, which makes an
 * Unknown player score as exactly average: neither penalised nor favoured. Fairness
 * never reads ratings at all, so an Unknown player's playing time is unaffected.
 *
 * When no participant has a rating, every player is marked imputed with a `null`
 * reference value and the strength term degenerates to a flat 0.5 for everyone,
 * i.e. strength stops influencing the result rather than guessing.
 */
export interface ResolvedRatings {
  /** Effective rating per player; `null` only when no rating exists anywhere. */
  effective: Map<PlayerId, number | null>;
  imputed: Set<PlayerId>;
  /** Median of known ratings, or `null` when none are known. */
  imputationValue: number | null;
  min: number | null;
  max: number | null;
  knownCount: number;
}

/** The rating that applies to a participant today (an order-level override wins). */
export function participantRating(player: Player, config: ParticipantConfig): Rating {
  return config.ratingOverride !== undefined ? config.ratingOverride : player.rating;
}

export function resolveRatings(
  players: readonly Player[],
  participants: readonly ParticipantConfig[],
): ResolvedRatings {
  const byId = new Map(players.map((p) => [p.id, p]));
  const active = participants.filter((c) => c.include && byId.has(c.playerId));

  const known: number[] = [];
  const raw = new Map<PlayerId, Rating>();
  for (const config of active) {
    const player = byId.get(config.playerId)!;
    const rating = participantRating(player, config);
    raw.set(config.playerId, rating);
    if (rating !== null && Number.isFinite(rating)) known.push(rating);
  }

  const imputationValue = median(known);
  const effective = new Map<PlayerId, number | null>();
  const imputed = new Set<PlayerId>();

  for (const [playerId, rating] of raw) {
    if (rating !== null && Number.isFinite(rating)) {
      effective.set(playerId, rating);
    } else {
      effective.set(playerId, imputationValue);
      imputed.add(playerId);
    }
  }

  return {
    effective,
    imputed,
    imputationValue,
    min: known.length > 0 ? Math.min(...known) : null,
    max: known.length > 0 ? Math.max(...known) : null,
    knownCount: known.length,
  };
}

/**
 * Normalises an effective rating onto 0..1 using the participant rating span.
 * Returns the neutral 0.5 when the span is degenerate (all equal / all Unknown).
 */
export function normaliseRating(value: number | null, resolved: ResolvedRatings): number {
  if (value === null) return 0.5;
  const { min, max } = resolved;
  if (min === null || max === null || max - min < 1e-9) return 0.5;
  return (value - min) / (max - min);
}
