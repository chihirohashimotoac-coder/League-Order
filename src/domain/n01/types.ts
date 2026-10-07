import type { DartsDiscipline } from '../types';

/**
 * n01 bindings (docs/N01_MASTER_DESIGN.md §2–§3).
 *
 * These records say *where on n01* a League Order entity comes from. They are kept in
 * their own `n01` namespace on the entity so that nothing n01 owns ever shares a field
 * with something the captain owns: a sync rewrites the binding, never the Rating, the
 * aptitudes, the notes or the day-of conditions.
 *
 * Pure data, no behaviour — the resolvers live in `integrations/n01`, the rules that
 * read bindings (effective PPR, roster diff, freshness) live next to this file.
 */

/**
 * How a team is recognised again next season.
 *
 * `tpid` is scoped to one tournament (season) and is never used across seasons. When
 * n01 exposes a stable team id it is used; otherwise the exact normalised team name
 * inside the league. There is deliberately no fuzzy variant: a renamed team is found
 * again by the captain picking it, never by a guess.
 */
export type N01StableIdentity =
  | { kind: 'n01'; value: string }
  | { kind: 'name'; value: string };

export interface N01TeamBinding {
  provider: 'n01';
  leagueId: string;
  leagueTitle: string;
  stableIdentity: N01StableIdentity;
  /** The tournament (season) the last successful sync resolved. */
  lastTournamentId: string;
  lastTournamentTitle: string;
  /** Season-scoped team id (`tpid`) in that tournament. */
  lastTeamId: string;
  /** The team's name on n01 at the last sync. */
  lastTeamName: string;
  /** Index into the tournament's division table, or `null` when n01 lists none. */
  lastDivisionIndex: number | null;
  lastDivisionTitle: string | null;
  /** From `softdarts`: 1 → SOFT, 0 → STEEL, missing → UNSPECIFIED (never guessed). */
  discipline: DartsDiscipline;
  /** The n01-managed format this team generates orders with. */
  managedFormatId: string | null;
  linkedAt: number;
  lastSuccessfulSyncAt: number;
}

/** PPR taken from n01 tournament stats, with the numbers it was computed from. */
export interface N01PprStats {
  /** `score / darts * 3`; `null` when there are no darts (never 0). */
  ppr: number | null;
  score: number;
  darts: number;
  /** Legs played, when n01 reports them. */
  legs: number | null;
  tournamentId: string;
  syncedAt: number;
}

export interface N01PlayerBinding {
  /** Stable player id across seasons and teams. `null` when n01 did not provide one. */
  opid: string | null;
  /** Season-scoped ids at the last sync. */
  currentOid: string | null;
  currentTpid: string | null;
  /** The player's name on n01 at the last sync. */
  sourceName: string;
  /** False once the player no longer appears on the n01 roster (never deleted locally). */
  rosterActive: boolean;
  lastSeenTournamentId: string;
  lastSeenAt: number;
  /** PPR from the last sync, or `null` when the tournament has no stats for the player. */
  stats: N01PprStats | null;
}

/** Where an effective PPR comes from. */
export type PprSource = 'n01' | 'manual';

export interface N01FormatSource {
  provider: 'n01';
  leagueId: string;
  leagueTitle: string;
  tournamentId: string;
  tournamentTitle: string;
  divisionIndex: number | null;
  divisionTitle: string | null;
  syncedAt: number;
}

/** What n01 says about one game of a format (kept for reference and signatures). */
export interface N01GameMeta {
  schid: string;
  /** `num_part`: players per side. */
  numPart: number;
  /** Raw `match_type` (`01`, `cricket`, …). */
  matchType: string;
  startScore: number | null;
  /** Legs needed to win the game, when n01 says. */
  limitLegCount: number | null;
  group: string | null;
  subtitle: string | null;
}

/**
 * The last successful sync of a team, cached for offline use and for the "last synced"
 * display (docs/N01_MASTER_DESIGN.md §5). Derived data: re-fetchable, never exported.
 */
export interface N01SyncSnapshot {
  /** `sync:<teamId>` */
  id: string;
  kind: 'sync';
  teamId: string;
  fetchedAt: number;
  leagueId: string;
  leagueTitle: string;
  tournamentId: string;
  tournamentTitle: string;
  /** `tpid` in that tournament. */
  teamTpid: string;
  teamName: string;
  divisionIndex: number | null;
  divisionTitle: string | null;
  discipline: DartsDiscipline;
  formatDescription: string;
  rosterCount: number;
  /** Roster players with a PPR from n01. */
  pprCount: number;
}

export function syncSnapshotId(teamId: string): string {
  return `sync:${teamId}`;
}

/** Any record kept in the `n01Cache` store. */
export type N01CacheRecord = N01SyncSnapshot;
