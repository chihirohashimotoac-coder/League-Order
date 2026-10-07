import { recencyWeight, RECENCY_WEIGHTS } from './recency';

/**
 * Historical player statistics (MASTER SPEC Phase 2 §3–§6).
 *
 * A player is followed across seasons by `opid`, whichever team they played for: this
 * is about the *person's* form. (Which team fielded whom is a team-level question and is
 * answered from that team's own orders only — see `positionModel.ts`.)
 *
 * Only metrics n01 actually reported are used. A missing metric is `null` and simply
 * drops out of the aggregate; it is never read as 0.
 */

export interface SeasonStatLine {
  tournamentId: string;
  /** 0 = current season, 1 = the one before, … */
  seasonIndex: number;
  /** The team (`tpid`) the player was registered with in that season, when known. */
  teamTpid: string | null;
  score: number;
  darts: number;
  legs: number | null;
  matches: number | null;
  legsWon: number | null;
  first9Score: number | null;
  first9Darts: number | null;
  highOut: number | null;
  bestLeg: number | null;
  ton: number | null;
  ton40: number | null;
  ton70: number | null;
  ton80: number | null;
}

export interface HistoricalPlayerStats {
  /** `opid`, or `oid:<tournamentId>:<oid>` for a player n01 gave no opid. */
  key: string;
  opid: string | null;
  name: string;
  /** Newest season first. */
  seasons: SeasonStatLine[];
}

/** When n01 does not report legs, darts / this estimates them — for sample size only. */
export const DARTS_PER_LEG_ESTIMATE = 24;

export interface PlayerAggregate {
  /** Recency-weighted PPR (darts-weighted): `3 · Σw·score / Σw·darts`. `null` without darts. */
  ppr: number | null;
  /** Recency-weighted First 9 average, when reported. */
  first9: number | null;
  /** Recency-weighted share of legs won, when reported. */
  legWinRate: number | null;
  weightedDarts: number;
  /** Recency-weighted legs (estimated from darts when n01 omits legs). */
  weightedLegs: number;
  weightedMatches: number;
  /** Seasons with at least one dart. */
  seasonsWithData: number;
  /** Current-season PPR alone (for "recent form"), `null` when none. */
  currentPpr: number | null;
  currentLegs: number;
}

export function playerKey(opid: string | null, tournamentId: string, oid: string | null): string {
  return opid ?? `oid:${tournamentId}:${oid ?? '?'}`;
}

export function aggregatePlayer(
  stats: Pick<HistoricalPlayerStats, 'seasons'> | null | undefined,
  weights: readonly number[] = RECENCY_WEIGHTS,
): PlayerAggregate {
  let score = 0;
  let darts = 0;
  let legs = 0;
  let matches = 0;
  let f9Score = 0;
  let f9Darts = 0;
  let won = 0;
  let wonLegs = 0;
  let seasonsWithData = 0;
  let currentPpr: number | null = null;
  let currentLegs = 0;

  for (const line of stats?.seasons ?? []) {
    if (!(line.darts > 0) || line.score < 0) continue;
    const w = recencyWeight(line.seasonIndex, weights);
    if (w <= 0) continue;
    seasonsWithData += 1;
    score += w * line.score;
    darts += w * line.darts;
    const lineLegs = line.legs ?? line.darts / DARTS_PER_LEG_ESTIMATE;
    legs += w * lineLegs;
    matches += w * (line.matches ?? 0);
    if (line.first9Score !== null && line.first9Darts !== null && line.first9Darts > 0) {
      f9Score += w * line.first9Score;
      f9Darts += w * line.first9Darts;
    }
    if (line.legsWon !== null && line.legs !== null && line.legs > 0) {
      won += w * line.legsWon;
      wonLegs += w * line.legs;
    }
    if (line.seasonIndex === 0) {
      currentPpr = (3 * line.score) / line.darts;
      currentLegs = lineLegs;
    }
  }

  return {
    ppr: darts > 0 ? (3 * score) / darts : null,
    first9: f9Darts > 0 ? (3 * f9Score) / f9Darts : null,
    legWinRate: wonLegs > 0 ? won / wonLegs : null,
    weightedDarts: darts,
    weightedLegs: legs,
    weightedMatches: matches,
    seasonsWithData,
    currentPpr,
    currentLegs,
  };
}

/**
 * League-wide mean PPR (darts-weighted, recency-weighted) — the prior a player with
 * little data is shrunk towards. `null` when nobody has thrown a dart.
 */
export function leagueMeanPpr(
  lines: readonly Pick<SeasonStatLine, 'score' | 'darts' | 'seasonIndex'>[],
  weights: readonly number[] = RECENCY_WEIGHTS,
): number | null {
  let score = 0;
  let darts = 0;
  for (const line of lines) {
    if (!(line.darts > 0)) continue;
    const w = recencyWeight(line.seasonIndex, weights);
    score += w * line.score;
    darts += w * line.darts;
  }
  return darts > 0 ? (3 * score) / darts : null;
}
