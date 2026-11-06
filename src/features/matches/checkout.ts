/**
 * Checkout routes (アガリ候補) and a simple leg / game estimate for spectators.
 *
 * Routes: the fewest darts that finish on a double (or the bull), preferring the trebles and
 * doubles players usually aim at. Bogey numbers (169, 168, 166, 165, 163, 162, 159) and
 * anything above 170 have no 3-dart route. A reference, not advice to the player.
 */

interface Dart {
  label: string;
  value: number;
  double: boolean;
  /** Lower is preferred. */
  rank: number;
}

const DOUBLE_ORDER = [20, 16, 18, 10, 12, 8, 4, 14, 6, 2, 19, 17, 15, 13, 11, 9, 7, 5, 3, 1];

/** Setup darts: T20, T19, S20, T18, T17, S19 first; the finishing double weighs most. */
const SETUP_RANK: Record<string, number> = { T20: 0, T19: 1, S20: 2, T18: 3, T17: 4, S19: 5, T16: 6, S18: 7, S17: 8, S16: 9 };

function darts(): Dart[] {
  const all: Dart[] = [];
  for (let n = 20; n >= 1; n -= 1) all.push({ label: `T${n}`, value: n * 3, double: false, rank: SETUP_RANK[`T${n}`] ?? 10 + (20 - n) });
  for (let n = 20; n >= 1; n -= 1) all.push({ label: `S${n}`, value: n, double: false, rank: SETUP_RANK[`S${n}`] ?? 30 + (20 - n) });
  all.push({ label: 'S25', value: 25, double: false, rank: 60 });
  for (const n of DOUBLE_ORDER) all.push({ label: `D${n}`, value: n * 2, double: true, rank: 10 + DOUBLE_ORDER.indexOf(n) * 3 });
  all.push({ label: 'BULL', value: 50, double: true, rank: 45 });
  return all;
}

let table: Map<number, string[]> | null = null;

function build(): Map<number, string[]> {
  const all = darts();
  const finishers = all.filter((dart) => dart.double);
  const best = new Map<number, { route: string[]; cost: number }>();
  const offer = (total: number, route: Dart[]): void => {
    if (total < 2 || total > 170) return;
    // Setup darts count double (aiming), a double used to set up is a last resort.
    const setup = route.slice(0, -1).reduce((sum, dart) => sum + (dart.double ? dart.rank + 40 : dart.rank) * 2, 0);
    const cost = route.length * 1000 + setup + route[route.length - 1].rank;
    const current = best.get(total);
    if (!current || cost < current.cost) best.set(total, { route: route.map((dart) => dart.label), cost });
  };
  for (const end of finishers) {
    offer(end.value, [end]);
    for (const a of all) {
      offer(a.value + end.value, [a, end]);
      for (const b of all) offer(a.value + b.value + end.value, [a, b, end]);
    }
  }
  return new Map([...best.entries()].map(([total, entry]) => [total, entry.route]));
}

/** The route for `left` points, or `null` when none finishes it in three darts. */
export function checkoutRoute(left: number): string[] | null {
  table ??= build();
  return table.get(left) ?? null;
}

// ---------------------------------------------------------------------------
// Leg estimate (予測) from the points left, the averages and who throws next
// ---------------------------------------------------------------------------

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

/** Chance that side 0 wins a fresh leg from the two averages (throwing first alternates). */
export function freshLegChance(average: [number, number]): number {
  return (legChance([501, 501], average, 0) + legChance([501, 501], average, 1)) / 2;
}
