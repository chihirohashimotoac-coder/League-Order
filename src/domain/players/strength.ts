import type {
  DartsDiscipline,
  ParticipantConfig,
  Player,
  PlayerId,
  Ppr,
  StrengthWeights,
} from '../types';
import { PPR_MAX, PPR_MIN } from '../types';
import { median } from '../../utils/math';
import { normaliseRating, resolveRatings, type ResolvedRatings } from './rating';

/**
 * Composite strength: Rating and PPR (docs/DESIGN.md 追補 v1.3 §V1, D-19).
 *
 * The two numbers live on different scales (Rating ≈ 1–18, PPR ≈ 0–180), so their raw
 * values are never added. Each is first normalised onto 0..1 over the span of today's
 * participants — the same participant-span rule Rating has always used — and only the
 * normalised values are blended:
 *
 *     strength(p) = w_rating · normRating(p) + w_ppr · normPpr(p)
 *
 * The blend depends on the league's discipline (soft darts is rated by Rating first,
 * steel darts by PPR first). An Unknown value is imputed with the participants' median
 * of that metric, exactly like Rating — never with 0.
 *
 * A metric that carries no information about today's participants (nobody has it, or
 * everybody has the same value) is dropped and its weight handed to the other one; when
 * neither carries information every player is the neutral 0.5 and strength stops
 * influencing the order rather than guessing.
 */

/** Default blend per discipline. Each pair sums to 1. */
export const DISCIPLINE_STRENGTH_WEIGHTS: Record<DartsDiscipline, StrengthWeights> = {
  SOFT: { rating: 0.7, ppr: 0.3 },
  STEEL: { rating: 0.3, ppr: 0.7 },
  UNSPECIFIED: { rating: 0.5, ppr: 0.5 },
};

/** Reads a stored PPR; anything that is not a finite number is Unknown. */
export function asPpr(value: unknown): Ppr {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** The PPR of a player, tolerating records stored before the field existed. */
export function playerPpr(player: Pick<Player, 'ppr'>): Ppr {
  return asPpr((player as { ppr?: unknown }).ppr);
}

export type PprParseResult = { ok: true; value: Ppr } | { ok: false; message: string };

/**
 * Parses the PPR text box. Blank is Unknown (`null`), not 0. Anything else must be a
 * number between 0 and the theoretical maximum of 180.
 */
export function parsePprInput(text: string): PprParseResult {
  const trimmed = text.trim();
  if (trimmed === '') return { ok: true, value: null };
  const value = Number(trimmed);
  if (!Number.isFinite(value)) return { ok: false, message: 'PPR は数値で入力してください (例: 72.45)。' };
  if (value < PPR_MIN || value > PPR_MAX) {
    return { ok: false, message: `PPR は ${PPR_MIN}〜${PPR_MAX} の範囲で入力してください。` };
  }
  return { ok: true, value: Math.round(value * 100) / 100 };
}

/** Same shape as the rating resolution, so both metrics are handled identically. */
export type ResolvedMetric = ResolvedRatings;

/** Resolves PPR across today's participants (median imputation, never 0). */
export function resolvePprs(
  players: readonly Player[],
  participants: readonly ParticipantConfig[],
): ResolvedMetric {
  const byId = new Map(players.map((p) => [p.id, p]));
  const active = participants.filter((c) => c.include && byId.has(c.playerId));

  const known: number[] = [];
  const raw = new Map<PlayerId, Ppr>();
  for (const config of active) {
    const value = playerPpr(byId.get(config.playerId)!);
    raw.set(config.playerId, value);
    if (value !== null) known.push(value);
  }

  const imputationValue = median(known);
  const effective = new Map<PlayerId, number | null>();
  const imputed = new Set<PlayerId>();
  for (const [playerId, value] of raw) {
    if (value !== null) {
      effective.set(playerId, value);
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

/** True when the metric can tell today's participants apart. */
export function isInformative(metric: ResolvedMetric): boolean {
  return metric.min !== null && metric.max !== null && metric.max - metric.min > 1e-9;
}

/**
 * The blend actually applied: the discipline default, with any uninformative metric
 * removed and its weight redistributed. Both 0 when neither metric is informative.
 */
export function effectiveStrengthWeights(
  discipline: DartsDiscipline,
  ratings: ResolvedMetric,
  pprs: ResolvedMetric,
): StrengthWeights {
  const base = DISCIPLINE_STRENGTH_WEIGHTS[discipline] ?? DISCIPLINE_STRENGTH_WEIGHTS.UNSPECIFIED;
  const rating = isInformative(ratings) ? base.rating : 0;
  const ppr = isInformative(pprs) ? base.ppr : 0;
  const sum = rating + ppr;
  if (sum <= 0) return { rating: 0, ppr: 0 };
  return { rating: rating / sum, ppr: ppr / sum };
}

export interface StrengthModel {
  discipline: DartsDiscipline;
  ratings: ResolvedMetric;
  pprs: ResolvedMetric;
  weights: StrengthWeights;
  /** 0..1 normalised rating per player (0.5 when Rating is uninformative). */
  normRating: Map<PlayerId, number>;
  /** 0..1 normalised PPR per player (0.5 when PPR is uninformative). */
  normPpr: Map<PlayerId, number>;
  /** 0..1 composite strength per player (0.5 when neither metric is informative). */
  strength: Map<PlayerId, number>;
}

/** Builds the strength model for today's participants. */
export function resolveStrength(
  discipline: DartsDiscipline,
  players: readonly Player[],
  participants: readonly ParticipantConfig[],
): StrengthModel {
  const ratings = resolveRatings(players, participants);
  const pprs = resolvePprs(players, participants);
  const weights = effectiveStrengthWeights(discipline, ratings, pprs);

  const normRating = new Map<PlayerId, number>();
  const normPpr = new Map<PlayerId, number>();
  const strength = new Map<PlayerId, number>();
  for (const [playerId, value] of ratings.effective) {
    const r = normaliseRating(value, ratings);
    const p = normaliseRating(pprs.effective.get(playerId) ?? null, pprs);
    normRating.set(playerId, r);
    normPpr.set(playerId, p);
    strength.set(
      playerId,
      weights.rating + weights.ppr > 0 ? weights.rating * r + weights.ppr * p : 0.5,
    );
  }
  return { discipline, ratings, pprs, weights, normRating, normPpr, strength };
}

/**
 * Human-readable blend, larger share first: "Rating 70% / PPR 30%",
 * "PPR 70% / Rating 30%", "Rating 100%", or `null` when strength is not used.
 */
export function describeStrengthWeights(weights: StrengthWeights): string | null {
  const parts = [
    { label: 'Rating', value: weights.rating },
    { label: 'PPR', value: weights.ppr },
  ].filter((part) => part.value > 1e-9);
  if (parts.length === 0) return null;
  // Stable: on a tie Rating stays first.
  parts.sort((a, b) => b.value - a.value);
  return parts.map((part) => `${part.label} ${Math.round(part.value * 100)}%`).join(' / ');
}

/** What a metric told the strength model about today's participants. */
function metricState(metric: ResolvedMetric): 'informative' | 'unknown' | 'flat' {
  if (isInformative(metric)) return 'informative';
  return metric.knownCount === 0 ? 'unknown' : 'flat';
}

const METRIC_STATE_TEXT = { unknown: '未入力', flat: '全員同じ値' } as const;

/**
 * The strength line shown before generating, written from the blend the optimizer will
 * actually use (`effectiveStrengthWeights`) — so it can never say "Rating 100%" and "Rating
 * and PPR weighed equally" at the same time. The weights themselves are not changed here.
 */
export function explainStrengthWeights(
  model: Pick<StrengthModel, 'discipline' | 'ratings' | 'pprs' | 'weights'>,
): { title: string; note: string } {
  const blend = describeStrengthWeights(model.weights);
  const rating = metricState(model.ratings);
  const ppr = metricState(model.pprs);
  const imputedNote = (metrics: { label: string; metric: ResolvedMetric }[]): string =>
    metrics.some(({ metric }) => metric.imputed.size > 0)
      ? ` 未入力の${metrics
          .filter(({ metric }) => metric.imputed.size > 0)
          .map(({ label }) => label)
          .join('・')}は 0 ではなく参加者の中央値で評価します。`
      : '';

  if (!blend) {
    if (rating === 'unknown' && ppr === 'unknown') {
      return {
        title: '戦力評価なし',
        note: '参加者の Rating・PPR (3投平均) がどちらも未入力のため、適性と公平性で生成します。',
      };
    }
    return {
      title: '戦力評価なし',
      note: `Rating は${METRIC_STATE_TEXT[rating as 'unknown' | 'flat']}、PPR (3投平均) は${METRIC_STATE_TEXT[ppr as 'unknown' | 'flat']}で差が無いため、適性と公平性で生成します。`,
    };
  }
  const title = `戦力評価 ${blend}`;
  if (model.weights.ppr <= 1e-9) {
    return {
      title,
      note: `PPR (3投平均) が${METRIC_STATE_TEXT[ppr as 'unknown' | 'flat']}のため、Rating だけで評価します。${imputedNote([{ label: 'Rating', metric: model.ratings }])}`,
    };
  }
  if (model.weights.rating <= 1e-9) {
    return {
      title,
      note: `Rating が${METRIC_STATE_TEXT[rating as 'unknown' | 'flat']}のため、PPR (3投平均) だけで評価します。${imputedNote([{ label: 'PPR', metric: model.pprs }])}`,
    };
  }
  const basis =
    model.discipline === 'SOFT'
      ? 'ソフトダーツの既定の配分です (Rating 重視)。'
      : model.discipline === 'STEEL'
        ? 'ハードダーツ (スティール) の既定の配分です (PPR 重視)。'
        : 'ダーツ種別が未設定のため、Rating と PPR (3投平均) を同じ比重で評価します。';
  return {
    title,
    note: `${basis}${imputedNote([
      { label: 'Rating', metric: model.ratings },
      { label: 'PPR', metric: model.pprs },
    ])}`,
  };
}

/** `PPR 68.4`, `PPR 72.45`, or `PPR —` when unknown (never "0"). */
export function formatPpr(ppr: number | null | undefined): string {
  if (ppr === null || ppr === undefined || !Number.isFinite(ppr)) return 'PPR —';
  return `PPR ${Number.isInteger(ppr) ? String(ppr) : String(Math.round(ppr * 100) / 100)}`;
}
