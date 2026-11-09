import type { StandardRoute } from './standardRoutes.generated';
import { STANDARD_ROUTES, STANDARD_ROUTES_TWO_DARTS } from './standardRoutes.generated';

/**
 * Checkout routes (アガリ候補) and a simple leg / game estimate for spectators.
 *
 * Routes are the standard routes (基準ルート) of 01 Arrangement Support, imported unchanged
 * (`standardRoutes.generated.ts`, see `scripts/import-standard-routes.ts`): the Excel first
 * candidates for 41–170, the approved rules for 2–40 and for two darts left at 51–70. Bogey
 * numbers (169, 168, 166, 165, 163, 162, 159) and anything above 170 have none. Shown as a
 * reference for spectators, never as advice to the player.
 */

/** The standard route for `left` with `dartsInHand` darts (3 at the start of a visit), or `null`. */
export function standardRoute(left: number, dartsInHand = 3): StandardRoute | null {
  if (dartsInHand === 2 && STANDARD_ROUTES_TWO_DARTS[left]) return STANDARD_ROUTES_TWO_DARTS[left];
  const route = STANDARD_ROUTES[left] ?? null;
  return route && route.route.length <= dartsInHand ? route : null;
}

/** Display labels of the standard route (`SB` is the single bull), or `null` when none. */
export function checkoutRoute(left: number, dartsInHand = 3): string[] | null {
  const route = standardRoute(left, dartsInHand);
  return route ? route.route.map((id) => (id === 'SB' ? 'S-BULL' : id)) : null;
}

// ---------------------------------------------------------------------------
// Leg estimate (参考予測) from the points left, the averages and who throws next
// ---------------------------------------------------------------------------
//
// A reference model, **not calibrated** against real games (docs/LIVE_ESTIMATE.md). Its
// assumptions are fixed numbers, not a player's record: an average with little evidence is
// pulled towards 45; finishing takes about 1.6 visits from a number with a standard route and
// 2 otherwise; the spread of visits is a fixed function of their mean. It is applied only to a
// 01 leg with the points left, the next thrower and (for the game) the start score and the legs
// needed known — see `liveEstimateScope`. Never to Cricket, never with 501 assumed.

const erf = (x: number): number => {
  // Abramowitz–Stegun 7.1.26.
  const t = 1 / (1 + 0.3275911 * Math.abs(x));
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return x >= 0 ? y : -y;
};
const phi = (x: number): number => 0.5 * (1 + erf(x / Math.SQRT2));

/** A 3-dart average with little evidence is pulled towards 45 (a typical league average). */
export function shrunkAverage(average: number | null, darts: number): number {
  const weight = Math.min(1, darts / 60);
  return (average ?? 45) * weight + 45 * (1 - weight);
}

/** Visits still needed to finish `left`: setting up at the average, then about two visits at a double. */
function visits(left: number, average: number): { mean: number; sd: number } {
  if (left <= 0) return { mean: 0, sd: 0.01 };
  const setup = Math.max(0, (left - 40) / Math.max(15, average));
  const mean = setup + (left <= 170 && checkoutRoute(left) ? 1.6 : 2);
  return { mean, sd: 0.45 * Math.sqrt(mean) + 0.5 };
}

/** Chance that side 0 wins the leg. `next` throws first from here. */
export function legChance(left: [number, number], average: [number, number], next: 0 | 1): number {
  const a = visits(left[0], average[0]);
  const b = visits(left[1], average[1]);
  const sd = Math.sqrt(a.sd * a.sd + b.sd * b.sd);
  // Throwing first wins a tie in visits.
  const edge = next === 0 ? 0.5 : -0.5;
  return Math.min(0.99, Math.max(0.01, phi((b.mean - a.mean + edge) / sd)));
}

/** Chance that side 0 wins a fresh leg of `start` from the two averages (throwing first alternates). */
export function freshLegChance(average: [number, number], start = 501): number {
  return (legChance([start, start], average, 0) + legChance([start, start], average, 1)) / 2;
}

/** What the live estimate needs, and why it is withheld when something is missing. */
export type EstimateScope =
  | { leg: true; game: true }
  | { leg: true; game: false; reason: string }
  | { leg: false; game: false; reason: string };

export function liveEstimateScope(input: {
  cricket: boolean;
  left: [number, number] | null;
  thrower: 0 | 1 | null;
  startScore: number | null;
  limitLeg: number | null;
  drawMode: number | null;
  /** The game's throws are all read (the averages come from them). */
  complete: boolean;
}): EstimateScope {
  if (input.cricket) return { leg: false, game: false, reason: 'Cricket は対象外です' };
  if (!input.complete) return { leg: false, game: false, reason: 'このゲームの記録がそろっていません' };
  if (!input.left || input.thrower === null) return { leg: false, game: false, reason: 'Leg の合間です' };
  if (!input.startScore || input.startScore <= 0) return { leg: true, game: false, reason: '開始点数が不明です' };
  if (!input.limitLeg || input.limitLeg < 1) return { leg: true, game: false, reason: '勝利に必要な Leg 数が不明です' };
  if (input.drawMode === 1) return { leg: true, game: false, reason: '引き分けのある形式は対象外です' };
  return { leg: true, game: true };
}
