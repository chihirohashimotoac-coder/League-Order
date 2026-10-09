import type { Counts, Extremes, MetricId, Metrics, Ratio, Reliability, StatLine } from './types';

/**
 * Pure metric maths. A ratio is pooled as Σ numerator / Σ denominator over the lines whose
 * *own* denominator is usable; a line without one adds nothing (it is not a 0).
 */

const RATIO_KEYS = [
  'ppr',
  'first9',
  'legRate',
  'setRate',
  'keep',
  'break',
  'ton00Rate',
  'ton40Rate',
  'ton70Rate',
  'ton80Rate',
] as const satisfies readonly MetricId[];

type Pair = { num: number; den: number } | null;

function ok(value: number | null): value is number {
  return value !== null && Number.isFinite(value) && value >= 0;
}

/** The (numerator, denominator) a single line contributes to a metric, or `null` when unusable. */
export function pairOf(metric: MetricId, line: StatLine): Pair {
  switch (metric) {
    case 'ppr':
      return ok(line.score) && ok(line.darts) && line.darts > 0 ? { num: 3 * line.score, den: line.darts } : null;
    case 'first9':
      return ok(line.f9Score) && ok(line.f9Darts) && line.f9Darts > 0 ? { num: 3 * line.f9Score, den: line.f9Darts } : null;
    case 'legRate':
      return ok(line.winLeg) && ok(line.leg) && line.leg > 0 && line.winLeg <= line.leg ? { num: line.winLeg, den: line.leg } : null;
    case 'setRate':
      return ok(line.winSet) && ok(line.set) && line.set > 0 && line.winSet <= line.set ? { num: line.winSet, den: line.set } : null;
    case 'break':
      return ok(line.breakWins) && ok(line.breakLegs) && line.breakLegs > 0 && line.breakWins <= line.breakLegs
        ? { num: line.breakWins, den: line.breakLegs }
        : null;
    case 'keep': {
      if (!ok(line.winLeg) || !ok(line.leg) || !ok(line.breakWins) || !ok(line.breakLegs)) return null;
      const den = line.leg - line.breakLegs;
      const num = line.winLeg - line.breakWins;
      return den > 0 && num >= 0 && num <= den ? { num, den } : null;
    }
    case 'ton00Rate':
      return ok(line.ton00) && ok(line.leg) && line.leg > 0 ? { num: line.ton00, den: line.leg } : null;
    case 'ton40Rate':
      return ok(line.ton40) && ok(line.leg) && line.leg > 0 ? { num: line.ton40, den: line.leg } : null;
    case 'ton70Rate':
      return ok(line.ton70) && ok(line.leg) && line.leg > 0 ? { num: line.ton70, den: line.leg } : null;
    case 'ton80Rate':
      return ok(line.ton80) && ok(line.leg) && line.leg > 0 ? { num: line.ton80, den: line.leg } : null;
  }
}

/** 3DA / First 9 are per-dart ×3 figures; the rest are 0–1 ratios or per-leg frequencies. */
export function ratioOf(num: number, den: number): Ratio {
  return { num, den, value: den > 0 ? num / den : null };
}

/** Pools the lines. Empty input gives an all-`null` result. */
export function aggregateLines(lines: readonly StatLine[]): Metrics {
  const ratios = {} as Record<MetricId, Ratio>;
  for (const key of RATIO_KEYS) {
    let num = 0;
    let den = 0;
    for (const line of lines) {
      const pair = pairOf(key, line);
      if (pair) {
        num += pair.num;
        den += pair.den;
      }
    }
    ratios[key] = ratioOf(num, den);
  }
  return { ...ratios, extremes: extremesOf(lines), counts: countsOf(lines), seasons: lines.length };
}

function sumOrNull(lines: readonly StatLine[], pick: (line: StatLine) => number | null): number | null {
  let total: number | null = null;
  for (const line of lines) {
    const value = pick(line);
    if (ok(value)) total = (total ?? 0) + value;
  }
  return total;
}

export function countsOf(lines: readonly StatLine[]): Counts {
  return {
    ton00: sumOrNull(lines, (l) => l.ton00),
    ton40: sumOrNull(lines, (l) => l.ton40),
    ton70: sumOrNull(lines, (l) => l.ton70),
    ton80: sumOrNull(lines, (l) => l.ton80),
    match: sumOrNull(lines, (l) => l.match),
  };
}

/** High Finish = max of recorded values, Best Leg = min; 0 means "no record", not a record. */
export function extremesOf(lines: readonly StatLine[]): Extremes {
  let highOut: number | null = null;
  let bestLeg: number | null = null;
  for (const line of lines) {
    if (ok(line.highOut) && line.highOut > 0) highOut = highOut === null ? line.highOut : Math.max(highOut, line.highOut);
    if (ok(line.bestLeg) && line.bestLeg > 0) bestLeg = bestLeg === null ? line.bestLeg : Math.min(bestLeg, line.bestLeg);
  }
  return { highOut, bestLeg };
}

/**
 * Provisional UX thresholds for showing a value in a ranking (design §3): they decide what
 * is listed as "reference only"; they are not a statistical guarantee.
 */
export const MIN_SAMPLE: Record<MetricId, number> = {
  ppr: 90,
  first9: 90,
  legRate: 20,
  setRate: 10,
  keep: 10,
  break: 10,
  ton00Rate: 20,
  ton40Rate: 20,
  ton70Rate: 20,
  ton80Rate: 20,
};

/** Higher is better for every ratio here. (Best Leg is the one "lower is better" figure; see ranking.) */
export function reliabilityOf(metric: MetricId, ratio: Ratio): Reliability {
  if (ratio.value === null || ratio.den <= 0) return 'none';
  return ratio.den >= MIN_SAMPLE[metric] ? 'sufficient' : 'reference';
}

/** Match win rate from W-D-L: wins over matches played (draws count as played, not as wins). */
export function matchWinRate(won: number, played: number): number | null {
  return played > 0 && won >= 0 && won <= played ? won / played : null;
}
