import { standardRoute } from './checkout';
import type { LiveThrow, ThrowLeg } from './parse';

/**
 * What League Order reads out of n01's throws beyond n01's own figures: the points-left race
 * of a leg, the visits that started on a finish (上がり圏), and a card's highlights (見どころ).
 *
 * n01 records visits, not darts at a double: a visit is counted as a finishing chance when it
 * started on a score that can be finished with three darts (2–170 with a standard route, so the
 * bogey numbers 169, 168, 166, 165, 163, 162 and 159 are not chances). Legs decided by the bull
 * are left out, as in every average.
 */

export type Visit01 = Extract<LiveThrow, { kind: '01' }>;

type LegLike = Pick<ThrowLeg, 'index' | 'throws' | 'start' | 'ended' | 'winner' | 'first'> & { bull?: boolean; dartsTotal?: [number, number] | null };

/** The points a visit started on (a bust scores 0 and leaves the points unchanged). */
export const before = (visit: Visit01): number => visit.left + visit.score;

/** A score that three darts can finish (a standard route exists for it). */
export function finishable(left: number): boolean {
  return left >= 2 && left <= 170 && standardRoute(left, 3) !== null;
}

// ---------------------------------------------------------------------------
// The race: points left against darts thrown
// ---------------------------------------------------------------------------

export interface RacePoint {
  darts: number;
  left: number;
}

/** Points left after every visit, per n01 side, from the start (darts 0). */
export function raceSeries(leg: Pick<ThrowLeg, 'throws' | 'start'>, startScore: number | null): [RacePoint[], RacePoint[]] {
  return ([0, 1] as const).map((side) => {
    const mine = leg.throws.filter((entry): entry is Visit01 => entry.kind === '01' && entry.side === side).sort((a, b) => a.round - b.round);
    const start = leg.start?.[side] ?? (mine[0] ? before(mine[0]) : startScore ?? 501);
    const points: RacePoint[] = [{ darts: 0, left: start }];
    let darts = 0;
    for (const visit of mine) {
      darts += visit.finish ? visit.darts : 3;
      points.push({ darts, left: visit.left });
    }
    return points;
  }) as [RacePoint[], RacePoint[]];
}

/** The lead at the last visit both sides have thrown: who is ahead (fewer left) and by how much. */
export function raceLead(series: [RacePoint[], RacePoint[]]): { visits: number; darts: number; side: 0 | 1 | null; by: number } | null {
  const visits = Math.min(series[0].length, series[1].length) - 1;
  if (visits < 1) return null;
  const a = series[0][visits].left;
  const b = series[1][visits].left;
  return { visits, darts: Math.max(series[0][visits].darts, series[1][visits].darts), side: a === b ? null : a < b ? 0 : 1, by: Math.abs(a - b) };
}

// ---------------------------------------------------------------------------
// Finishing chances (上がり圏)
// ---------------------------------------------------------------------------

export interface FinishChance {
  leg: number;
  round: number;
  left: number;
  hit: boolean;
  member: string | null;
}

/** Visits of one n01 side that started on a finish, leg by leg. `member` narrows to one player. */
export function finishChances(legs: readonly LegLike[], side: 0 | 1, member?: string): FinishChance[] {
  const chances: FinishChance[] = [];
  for (const leg of legs) {
    if (leg.bull) continue;
    const mine = leg.throws.filter((entry): entry is Visit01 => entry.kind === '01' && entry.side === side).sort((a, b) => a.round - b.round);
    for (const visit of mine) {
      if (member !== undefined && visit.member !== member) continue;
      const left = before(visit);
      if (finishable(left)) chances.push({ leg: leg.index, round: visit.round, left, hit: visit.finish, member: visit.member });
    }
  }
  return chances;
}

export function chanceRate(chances: readonly FinishChance[]): { hits: number; chances: number; rate: number | null } {
  const hits = chances.filter((chance) => chance.hit).length;
  return { hits, chances: chances.length, rate: chances.length ? hits / chances.length : null };
}

// ---------------------------------------------------------------------------
// Highlights of a card (見どころ)
// ---------------------------------------------------------------------------

export type HighlightKind = 'comeback' | 'highOut' | 'ton80' | 'nineMark' | 'fastLeg';

export interface Highlight {
  id: string;
  kind: HighlightKind;
  schid: string;
  slotLabel: string;
  leg: number;
  /** n01 side of the visit (for the score sheet), and the card side (for the names). */
  n01Side: 0 | 1;
  cardSide: 0 | 1;
  round: number;
  who: string;
  /** Deficit overturned, checkout, count of 180s, marks, darts. */
  value: number;
  /** Starting score of the leg (fastest legs are compared within one starting score). */
  start: number | null;
  detail: string;
}

/** Overturned when the winner was this many points behind at an equal number of visits. */
export const COMEBACK_AT = 100;
/** A checkout of at least this much is a highlight. */
export const HIGH_OUT_AT = 100;

export interface HighlightGame {
  schid: string;
  slotLabel: string;
  /** n01's left side is the card's second team. */
  flip: boolean;
  /** Team names in card order. */
  names: [string, string];
}

/** Every candidate in one game; `cardHighlights` merges and ranks a card's candidates. */
export function gameHighlights(legs: readonly LegLike[], game: HighlightGame): Highlight[] {
  const out: Highlight[] = [];
  const card = (side: 0 | 1): 0 | 1 => (game.flip ? ((1 - side) as 0 | 1) : side);
  const base = (leg: LegLike, side: 0 | 1, round: number) => ({ schid: game.schid, slotLabel: game.slotLabel, leg: leg.index, n01Side: side, cardSide: card(side), round });
  for (const leg of legs) {
    if (leg.bull) continue;
    for (const entry of leg.throws) {
      const who = entry.member ?? game.names[card(entry.side)];
      if (entry.kind === '01') {
        if (entry.score === 180) out.push({ ...base(leg, entry.side, entry.round), id: `${game.schid}:${leg.index}:${entry.side}:${entry.round}:180`, kind: 'ton80', who, value: 1, start: leg.start?.[entry.side] ?? null, detail: '180' });
        if (entry.finish && entry.score >= HIGH_OUT_AT)
          out.push({ ...base(leg, entry.side, entry.round), id: `${game.schid}:${leg.index}:out`, kind: 'highOut', who, value: entry.score, start: leg.start?.[entry.side] ?? null, detail: `${entry.score} アウト` });
      } else if (entry.marks >= 9) {
        out.push({ ...base(leg, entry.side, entry.round), id: `${game.schid}:${leg.index}:${entry.side}:${entry.round}:9m`, kind: 'nineMark', who, value: entry.marks, start: null, detail: '9 マーク' });
      }
    }
    const winner = leg.ended && (leg.winner === 0 || leg.winner === 1) ? leg.winner : null;
    if (winner === null || !leg.throws.some((entry) => entry.kind === '01')) continue;
    // Fastest leg candidate: the winner's darts (n01's count when given).
    const finishVisit = leg.throws.find((entry): entry is Visit01 => entry.kind === '01' && entry.side === winner && entry.finish);
    const darts = leg.dartsTotal?.[winner] ?? leg.throws.filter((entry): entry is Visit01 => entry.kind === '01' && entry.side === winner).reduce((sum, visit) => sum + (visit.finish ? visit.darts : 3), 0);
    if (finishVisit && darts > 0) {
      out.push({
        ...base(leg, winner, finishVisit.round),
        id: `${game.schid}:${leg.index}:fast`,
        kind: 'fastLeg',
        who: finishVisit.member ?? game.names[card(winner)],
        value: darts,
        start: leg.start?.[winner] ?? before(leg.throws.find((entry): entry is Visit01 => entry.kind === '01' && entry.side === winner)!),
        detail: `${darts} 本`,
      });
    }
    // Comeback: the winner's largest deficit at an equal number of visits.
    const series = raceSeries(leg, null);
    const loser = (1 - winner) as 0 | 1;
    let worst = { by: 0, visits: 0, mine: 0, theirs: 0 };
    const both = Math.min(series[0].length, series[1].length);
    for (let visits = 1; visits < both; visits += 1) {
      const by = series[winner][visits].left - series[loser][visits].left;
      if (by > worst.by) worst = { by, visits, mine: series[winner][visits].left, theirs: series[loser][visits].left };
    }
    if (worst.by >= COMEBACK_AT) {
      out.push({
        ...base(leg, winner, worst.visits),
        id: `${game.schid}:${leg.index}:comeback`,
        kind: 'comeback',
        who: game.names[card(winner)],
        value: worst.by,
        start: null,
        detail: `残り ${worst.mine} 対 ${worst.theirs} から`,
      });
    }
  }
  return out;
}

const ORDER: HighlightKind[] = ['comeback', 'highOut', 'ton80', 'nineMark', 'fastLeg'];

/**
 * A card's highlights: comebacks (largest first), high finishes (highest first), 180s and
 * 9-mark visits (one line per player with the count, pointing at the first), and the fastest
 * leg for each starting score.
 */
export function cardHighlights(candidates: readonly Highlight[]): Highlight[] {
  const out: Highlight[] = [];
  out.push(...candidates.filter((h) => h.kind === 'comeback').sort((a, b) => b.value - a.value));
  out.push(...candidates.filter((h) => h.kind === 'highOut').sort((a, b) => b.value - a.value));
  for (const kind of ['ton80', 'nineMark'] as const) {
    const byWho = new Map<string, Highlight>();
    for (const h of candidates.filter((entry) => entry.kind === kind)) {
      const key = `${h.cardSide}:${h.who}`;
      const held = byWho.get(key);
      byWho.set(key, held ? { ...held, value: held.value + 1 } : { ...h });
    }
    out.push(
      ...[...byWho.values()]
        .sort((a, b) => b.value - a.value)
        .map((h) => ({ ...h, id: `${kind}:${h.cardSide}:${h.who}`, detail: h.value > 1 ? `${h.detail} × ${h.value}` : h.detail })),
    );
  }
  const fastest = new Map<number, Highlight>();
  for (const h of candidates.filter((entry) => entry.kind === 'fastLeg' && entry.start !== null)) {
    const held = fastest.get(h.start!);
    if (!held || h.value < held.value) fastest.set(h.start!, h);
  }
  out.push(...[...fastest.values()].sort((a, b) => (b.start ?? 0) - (a.start ?? 0)).map((h) => ({ ...h, detail: `${h.detail} (${h.start} の最短)` })));
  return out.sort((a, b) => ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind));
}
