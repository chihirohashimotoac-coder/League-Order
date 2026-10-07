import type { ConfidenceLevel } from '../prediction/confidence';
import type { HistoricalPlayerStats } from './history';
import type { OpponentPositionModel } from './positionModel';

/**
 * Match intelligence snapshot (MASTER SPEC Phase 2 §11).
 *
 * Everything known about the next match, as of `generatedAt`: who it is against, both
 * rosters with their history, how the opponent has fielded players before, and how much
 * data each of those stands on. Cached in `n01Cache` (`intel:<teamId>`); re-built on
 * every sync. Not read by the optimizer directly — Phase 4 derives a much smaller,
 * self-contained `OpponentContext` from it for each order.
 */

export interface N01NextMatch {
  /** `lsid` */
  matchId: string;
  /** Raw title as n01 shows it. */
  title: string;
  /** `YYYY-MM-DD` when parsable, else `null`. */
  date: string | null;
  ourTeamId: string;
  opponentTeamId: string;
  opponentName: string;
}

export type NextMatchStatus = 'resolved' | 'ambiguous' | 'none';

export interface IntelligencePlayer {
  key: string;
  opid: string | null;
  oid: string;
  name: string;
}

export interface OpponentSnapshot {
  teamId: string;
  name: string;
  players: IntelligencePlayer[];
  stats: HistoricalPlayerStats[];
  positionModel: OpponentPositionModel;
}

export interface IntelligenceGame {
  gameId: string;
  signature: string;
  numPart: number;
  /** `CRICKET` games are predicted with less confidence. */
  cricket: boolean;
  /** Legs needed to win the game, when n01 says. */
  limitLegCount: number | null;
}

export interface IntelligenceSeason {
  tournamentId: string;
  title: string;
  seasonIndex: number;
  weight: number;
}

export interface N01MatchIntelligenceSnapshot {
  /** `intel:<teamId>` */
  id: string;
  kind: 'intel';
  teamId: string;
  generatedAt: number;
  leagueId: string;
  tournamentId: string;
  tournamentTitle: string;
  nextMatchStatus: NextMatchStatus;
  nextMatch: N01NextMatch | null;
  /** Candidates when the next match could not be decided automatically. */
  nextMatchOptions: N01NextMatch[];
  /** Our current managed format, with logical signatures. */
  games: IntelligenceGame[];
  /** Our current roster (n01 keys) and their history. */
  ourPlayers: IntelligencePlayer[];
  ourStats: HistoricalPlayerStats[];
  opponent: OpponentSnapshot | null;
  /** Recency-weighted league mean PPR — the shrinkage prior. */
  leagueMeanPpr: number | null;
  seasons: IntelligenceSeason[];
  historyDepth: number;
  /** Overall confidence of the opponent order model (LOW when there is no opponent). */
  orderConfidence: ConfidenceLevel;
}

export function intelligenceSnapshotId(teamId: string): string {
  return `intel:${teamId}`;
}
