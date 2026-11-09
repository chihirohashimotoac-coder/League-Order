import type { LiveThrow, ThrowLeg } from './parse';

/**
 * The figures n01's match Details shows, recomputed from the throws (`match/throws`), per side.
 *
 * - A leg decided by the bull (middle for diddle) counts as a leg won, but its darts and points
 *   are left out of every average, as n01 does (manual §4.8).
 * - 100+ / 140+ / 180 are visits of 100–139, 140–179 and 180 (n01's bands; 170+ is not shown).
 * - Best Leg is the fewest darts in a leg the side won; High Out the highest checkout.
 * - Second Legs are the legs the side threw second in; Break Legs the ones of them it won.
 * - First 9 is the average of the first three visits of each leg (3-dart scale).
 * - Cricket: MPR = marks / darts × 3, and how many visits scored 1 … 9 marks.
 *
 * Unknown stays `null` (never 0). Checkout percentage is not given: darts at a double are not
 * recorded, so it cannot be computed.
 */

export interface SideStats {
  legsWon: number;
  /** 01: 3-dart average; Cricket: MPR. */
  rate: number | null;
  first9: number | null;
  ton: number;
  ton40: number;
  ton80: number;
  highOut: number | null;
  bestLeg: number | null;
  secondLegs: number;
  breaks: number;
  /** Cricket: visits by marks scored (index 1 … 9). */
  markVisits: number[];
  darts: number;
  points: number;
}

function empty(): SideStats {
  return { legsWon: 0, rate: null, first9: null, ton: 0, ton40: 0, ton80: 0, highOut: null, bestLeg: null, secondLegs: 0, breaks: 0, markVisits: Array(10).fill(0), darts: 0, points: 0 };
}

export function gameStats(legs: readonly ThrowLeg[], cricket: boolean): [SideStats, SideStats] {
  const sides: [SideStats, SideStats] = [empty(), empty()];
  const f9: [{ points: number; visits: number }, { points: number; visits: number }] = [
    { points: 0, visits: 0 },
    { points: 0, visits: 0 },
  ];
  for (const leg of legs) {
    for (const side of [0, 1] as const) {
      const stats = sides[side];
      const won = leg.ended && leg.winner === side;
      if (won) stats.legsWon += 1;
      if (leg.ended && leg.first !== null && leg.first !== side) {
        stats.secondLegs += 1;
        if (won) stats.breaks += 1;
      }
      if (leg.bull) continue;
      const mine = leg.throws.filter((entry) => entry.side === side);
      let darts = 0;
      let points = 0;
      mine.forEach((entry, index) => {
        if (entry.kind === '01') {
          darts += entry.darts;
          points += entry.score;
          if (index < 3) {
            f9[side].points += entry.score;
            f9[side].visits += 1;
          }
          if (entry.score === 180) stats.ton80 += 1;
          else if (entry.score >= 140) stats.ton40 += 1;
          else if (entry.score >= 100) stats.ton += 1;
          if (entry.finish) stats.highOut = Math.max(stats.highOut ?? 0, entry.score);
        } else {
          darts += 3;
          points += entry.marks;
          if (entry.marks >= 1 && entry.marks <= 9) stats.markVisits[entry.marks] += 1;
        }
      });
      // n01's own darts count for the leg is authoritative (a finishing visit may use 1–2 darts).
      if (leg.dartsTotal && leg.ended) darts = leg.dartsTotal[side];
      stats.darts += darts;
      stats.points += points;
      if (won && darts > 0) stats.bestLeg = stats.bestLeg === null ? darts : Math.min(stats.bestLeg, darts);
    }
  }
  for (const side of [0, 1] as const) {
    const stats = sides[side];
    stats.rate = stats.darts > 0 ? (stats.points / stats.darts) * 3 : null;
    if (!cricket) stats.first9 = f9[side].visits > 0 ? (f9[side].points / f9[side].visits) : null;
  }
  return sides;
}

// ---------------------------------------------------------------------------
// Events worth a line in the live feed
// ---------------------------------------------------------------------------

export type LiveEventKind = '180' | 'highOut' | 'leg' | 'game' | 'card' | 'nineMark' | 'break';

export interface LiveEvent {
  id: string;
  kind: LiveEventKind;
  at: number;
  text: string;
}

/** Events in throws that were not in `before` (same leg). Throws are compared by position. */
export function throwEvents(before: readonly LiveThrow[], after: readonly LiveThrow[], names: [string, string], key: string, at: number): LiveEvent[] {
  const events: LiveEvent[] = [];
  after.slice(before.length).forEach((entry, offset) => {
    const who = entry.member ?? names[entry.side];
    const id = `${key}:${before.length + offset}`;
    if (entry.kind === '01') {
      if (entry.score === 180) events.push({ id, kind: '180', at, text: `${who} 180!` });
      else if (entry.finish && entry.score >= 100) events.push({ id, kind: 'highOut', at, text: `${who} ${entry.score} アウト` });
    } else if (entry.marks >= 9) {
      events.push({ id, kind: 'nineMark', at, text: `${who} 9マーク` });
    }
  });
  return events;
}
