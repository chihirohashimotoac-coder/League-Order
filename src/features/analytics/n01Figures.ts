import type { StatLine } from './types';

/**
 * The figures of n01's own stats page (イベント集計 / トーナメント集計), computed from one stats
 * row exactly the way that page does, so League Order never shows a different number for the
 * same row. Checked against n01's page script on 2026-11-12.
 *
 * `null` = the page has nothing to compute from; the page itself prints 0 / 0.00 / 0.00% there
 * ({@link n01Text} does the same).
 *
 * Not here: n01's "Checkout 予測" (estimated checkout %). n01 works it out with its own
 * estimation model, and a different model would print a different number.
 */

const ratio = (n: number | null | undefined, d: number | null | undefined, scale = 1): number | null => (n !== null && n !== undefined && d ? (n / d) * scale : null);

/**
 * 3 Darts 平均. n01 blends in averages entered by hand (`a` over `acnt` entries) as one more
 * entry; with only those, it is their mean.
 */
export function n01Avg3(line: StatLine): number | null {
  const manual = line.n01?.manualAvg ?? 0;
  const count = line.n01?.manualAvgCount ?? 0;
  if (line.darts && line.darts > 0 && line.score !== null) {
    const thrown = (line.score / line.darts) * 3;
    return manual > 0 ? (thrown + manual) / (count + 1) : thrown;
  }
  return manual > 0 && count > 0 ? manual / count : null;
}

/** 1 Dart 平均 = 3 Darts 平均 / 3. */
export function n01Avg1(line: StatLine): number | null {
  const avg = n01Avg3(line);
  return avg === null ? null : avg / 3;
}

/** Dynamic 平均 (only when the competition turns it on) = 1 Dart 平均 + Match Won. */
export function n01DynamicAvg(line: StatLine): number | null {
  const avg = n01Avg1(line);
  return avg === null ? null : avg + (line.winMatch ?? 0);
}

/** First 9 平均. */
export function n01First9(line: StatLine): number | null {
  return ratio(line.f9Score, line.f9Darts, 3);
}

/** MPR (Cricket): marks per round, blended with hand-entered MPR like the 3-dart average. */
export function n01Mpr(line: StatLine): number | null {
  const x = line.n01;
  if (!x) return null;
  const manual = x.manualMpr ?? 0;
  if ((x.cricketLegs ?? 0) > 0 && x.cricketDarts && x.cricketMarks !== null) {
    const thrown = (x.cricketMarks / x.cricketDarts) * 3;
    return manual > 0 ? (thrown + manual) / ((x.manualMprCount ?? 0) + 1) : thrown;
  }
  return manual > 0 && x.manualMprCount ? manual / x.manualMprCount : null;
}

/** Legs Diff = won − lost. */
export function n01LegDiff(line: StatLine): number | null {
  return line.leg === null || line.winLeg === null ? null : line.winLeg - (line.leg - line.winLeg);
}

/** 勝率 (Match / Sets / Legs), in %. */
export const n01WinRateMatch = (line: StatLine): number | null => ratio(line.winMatch, line.match, 100);
export const n01WinRateSet = (line: StatLine): number | null => ratio(line.winSet, line.set, 100);
export const n01WinRateLeg = (line: StatLine): number | null => ratio(line.winLeg, line.leg, 100);

/** Break = legs won when throwing second (Break Legs) / legs thrown second (Second Legs), in %. */
export function n01Break(line: StatLine): number | null {
  return line.breakLegs && line.breakLegs > 0 ? ratio(line.breakWins, line.breakLegs, 100) : null;
}

/**
 * Keep = legs won when throwing first / legs thrown first, in %. Like n01, only when the row has
 * thrown second at least once (n01 prints 0.00% otherwise).
 */
export function n01Keep(line: StatLine): number | null {
  if (line.leg === null || line.winLeg === null || !line.breakLegs || line.breakLegs <= 0) return null;
  const first = line.leg - line.breakLegs;
  return first > 0 ? ((line.winLeg - (line.breakWins ?? 0)) / first) * 100 : null;
}

/** How n01's page prints a figure: counts as integers, averages to 2 places, rates as "0.00%". */
export function n01Text(value: number | null, kind: 'count' | 'avg' | 'rate'): string {
  if (kind === 'count') return String(value ?? 0);
  if (kind === 'avg') return (value ?? 0).toFixed(2);
  return `${(value ?? 0).toFixed(2)}%`;
}
