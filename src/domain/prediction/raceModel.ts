/**
 * The 01 race between two sides whose members throw in rotation (docs/THROW_ORDER_MODEL.md §2).
 *
 * A 01 leg is a race: each side needs its own number of visits to reach zero, and the side
 * that gets there first wins. In a Doubles / Trios / Gallon game the members of a side throw
 * one visit each in their registered order (1投目, 2投目, …) and start again from the first,
 * so the order decides who throws the extra visit of an odd-length leg, who throws the early
 * scoring visits and who is at the board when the side reaches its finish.
 *
 * Per side, closed form plus one small convolution — no simulation, no randomness:
 *
 *   scoring phase   S_j = Σ_{v≤j} X_{m(v)},  X_m ~ N(μ_m, σ(μ_m)²)          (normal approximation)
 *                   P(J ≤ j) = P(S_j ≥ start − FINISH_ZONE) = 1 − Φ((need − ΣE) / √ΣVar)
 *   finish phase    from visit J + 1 on, the member at the board finishes with probability f_m
 *   visits          P(T = t) = Σ_j P(J = j) · Π_{J<u<t} (1 − f_{m(u)}) · f_{m(t)}
 *
 * The two sides are independent (a 01 board is not shared), so a leg is decided by the two
 * visit counts alone:
 *
 *   P(A wins | A throws first)  = Σ_t P(T_A = t) · P(T_B ≥ t)
 *   P(A wins | B throws first)  = Σ_t P(T_A = t) · P(T_B > t)
 *
 * and the leg estimate is the mean of the two (who starts the first leg is not known).
 *
 * The model is used only for what the order changes (see `orderEffect.ts`); the overall
 * strength difference keeps coming from the calibrated logistic model in `matchup.ts`.
 * Every constant is a provisional prior, documented with its sensitivity, not a measurement.
 */

/** Points per visit treated as the finishing range: below it a side is trying to finish. */
export const FINISH_ZONE = 60;
/** Per-visit score SD as a function of the mean: σ(μ) = VISIT_SD_BASE + VISIT_SD_SLOPE · μ. */
export const VISIT_SD_BASE = 10;
export const VISIT_SD_SLOPE = 0.35;
/** The leg horizon is generous enough that only a vanishing tail is cut off. */
export const MIN_VISIT_POINTS = 18;
export const HORIZON_MARGIN = 40;
export const MAX_HORIZON = 200;

export interface RaceMember {
  /** Mean points per visit (the member's PPR in this role). */
  mu: number;
  /** Probability of finishing in one visit once the side is inside the finishing range. */
  finish: number;
  /** Override of the per-visit SD (stability checks only). */
  sd?: number;
}

export function visitSd(mu: number, slope = VISIT_SD_SLOPE): number {
  return VISIT_SD_BASE + slope * Math.max(0, mu);
}

/**
 * Standard normal CDF (Abramowitz & Stegun 26.2.17, absolute error < 7.5e-8). Deterministic,
 * with no dependency on the platform's `Math.erf` (which JavaScript does not have).
 */
export function normalCdf(x: number): number {
  if (!Number.isFinite(x)) return x > 0 ? 1 : 0;
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989422804014327 * Math.exp((-x * x) / 2);
  const p = d * t * (0.31938153 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return x > 0 ? 1 - p : p;
}

/** Visits a leg from `startScore` is followed for (both sides of a race use the same one). */
export function raceHorizon(startScore: number): number {
  const need = Math.max(0, startScore - FINISH_ZONE);
  return Math.min(MAX_HORIZON, Math.ceil(need / MIN_VISIT_POINTS) + HORIZON_MARGIN);
}

/**
 * Distribution of the number of visits the side needs to finish a leg.
 *
 * `result[t]` (1 ≤ t ≤ horizon) is P(T = t); `result[horizon + 1]` is P(T > horizon), the cut
 * tail; `result[0]` is unused (a leg needs at least one visit).
 */
export function visitDistribution(members: readonly RaceMember[], startScore: number, horizon = raceHorizon(startScore)): Float64Array {
  const k = members.length;
  const result = new Float64Array(horizon + 2);
  if (k === 0) {
    result[horizon + 1] = 1;
    return result;
  }
  const need = Math.max(0, startScore - FINISH_ZONE);
  // P(J = j): the visit after which the side is inside the finishing range.
  const enter = new Float64Array(horizon + 1);
  if (need <= 0) {
    enter[0] = 1;
  } else {
    let mean = 0;
    let variance = 0;
    let previous = 0;
    for (let j = 1; j <= horizon; j += 1) {
      const member = members[(j - 1) % k];
      const sd = member.sd ?? visitSd(member.mu);
      mean += member.mu;
      variance += sd * sd;
      const reached = 1 - normalCdf((need - mean) / Math.sqrt(variance));
      const cumulative = Math.max(previous, reached);
      enter[j] = cumulative - previous;
      previous = cumulative;
    }
  }
  for (let j = 0; j < horizon; j += 1) {
    const pj = enter[j];
    if (pj <= 1e-15) continue;
    let survive = 1;
    for (let t = j + 1; t <= horizon; t += 1) {
      const finish = members[(t - 1) % k].finish;
      result[t] += pj * survive * finish;
      survive *= 1 - finish;
      if (survive < 1e-12) break;
    }
  }
  let total = 0;
  for (let t = 1; t <= horizon; t += 1) total += result[t];
  result[horizon + 1] = Math.max(0, 1 - total);
  return result;
}

export interface LegRace {
  /** Our side throws first in the leg. */
  first: number;
  /** The opponent throws first. */
  second: number;
  /** Mean of the two: who starts is not known in advance. */
  average: number;
}

/** P(our side wins the leg) from the two visit-count distributions (same horizon). */
export function legRace(ours: Float64Array, theirs: Float64Array): LegRace {
  const horizon = Math.min(ours.length, theirs.length) - 2;
  let first = 0;
  let second = 0;
  // P(T_B ≥ t) = 1 − Σ_{u<t} P(T_B = u); the cut tail counts as "not finished yet".
  let theirsBefore = 0;
  for (let t = 1; t <= horizon; t += 1) {
    const atLeast = 1 - theirsBefore;
    const after = atLeast - theirs[t];
    first += ours[t] * atLeast;
    second += ours[t] * after;
    theirsBefore += theirs[t];
  }
  // Both sides past the horizon: a coin flip (the mass is negligible by construction).
  const tie = 0.5 * ours[horizon + 1] * theirs[horizon + 1];
  first += tie;
  second += tie;
  return { first, second, average: (first + second) / 2 };
}

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

/**
 * Visit distributions by side (members in order, start score). The optimizer asks for the same
 * side many times — every candidate run, every opponent line-up — so they are kept. The cache
 * never changes a number: a hit returns exactly what a miss computes.
 */
const CACHE_LIMIT = 40_000;
const cache = new Map<string, Float64Array>();

function memberKey(member: RaceMember): string {
  return `${member.mu.toFixed(3)}:${member.finish.toFixed(5)}${member.sd === undefined ? '' : `:${member.sd.toFixed(3)}`}`;
}

export function cachedVisitDistribution(members: readonly RaceMember[], startScore: number): Float64Array {
  const horizon = raceHorizon(startScore);
  const key = `${startScore}|${members.map(memberKey).join(',')}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const computed = visitDistribution(members, startScore, horizon);
  if (cache.size >= CACHE_LIMIT) cache.clear();
  cache.set(key, computed);
  return computed;
}

/** Test hook: the cache is an optimisation only, so clearing it must change nothing. */
export function clearRaceCache(): void {
  cache.clear();
}
