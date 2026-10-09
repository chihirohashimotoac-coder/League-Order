import type { LeagueFormat, Player } from '../../domain/types';
import type { N01MatchIntelligenceSnapshot } from '../../domain/n01/intelligence';
import type { N01PlayerBinding } from '../../domain/n01/types';
import { buildIntelligenceSnapshot, type HistoricalSeasonData, type IntelligenceFetch } from '../../integrations/n01/intelligence';
import type { N01TeamData } from '../../integrations/n01/sync';
import type {
  N01OrderEntry,
  N01PlayerStats,
  N01RosterPlayer,
  N01ScheduleSlot,
  N01Tournament,
  N01TournamentSummary,
} from '../../integrations/n01/types';

/**
 * Small hand-made n01 seasons for identity and history tests.
 *
 * Everything is built from plain literals (no fixture transport), so a test states exactly
 * which people share which `opid`, and which season each stats row belongs to.
 */

export const US = 'T1';
export const THEM = 'T2';
export const CURRENT = 't_cur';
export const PREVIOUS = 't_prev';
export const BEFORE = 't_before';

export function slot(schid: string, numPart = 1, matchType = '01'): N01ScheduleSlot {
  return { schid, numPart, subtitle: null, matchType, startScore: matchType === '01' ? 501 : null, limitLegCount: 2, group: null };
}

/** `extraTeams`: more registered teams than the two the tests usually need. */
export function tournament(id: string, title: string, extraTeams: readonly string[] = []): N01Tournament {
  const teams = [US, THEM, ...extraTeams];
  return {
    tournamentId: id,
    title,
    leagueId: 'lg_test',
    status: id === CURRENT ? 30 : 40,
    softdarts: true,
    entries: teams.map((teamId) => ({ teamId, name: teamId === US ? 'Us' : teamId === THEM ? 'Them' : teamId })),
    divisions: [{ index: 0, title: 'D', teamIds: teams }],
    schedule: [slot('s1'), slot('s2')],
    gameSettings: [],
    results: new Map(),
  };
}

export function summary(id: string, title: string, startedAt: number, listIndex: number): N01TournamentSummary {
  return { tournamentId: id, title, status: id === CURRENT ? 30 : 40, startedAt, listIndex };
}

/** PPR is `3 · score / darts`, so score = ppr · darts / 3. */
export function row(
  opid: string | null,
  oid: string | null,
  name: string,
  ppr: number,
  darts = 1200,
  teamId: string | null = US,
): N01PlayerStats {
  return {
    opid,
    oid,
    teamId,
    name,
    score: Math.round((ppr * darts) / 3),
    darts,
    legs: Math.round(darts / 24),
    matches: null,
    legsWon: null,
    first9Score: null,
    first9Darts: null,
    highOut: null,
    bestLeg: null,
    ton: null,
    ton40: null,
    ton70: null,
    ton80: null,
  };
}

export function rosterPlayer(opid: string | null, oid: string, name: string, teamId = US): N01RosterPlayer {
  return { opid, oid, teamId, name };
}

export function orderEntry(matchId: string, schid: string, players: { opid: string | null; oid: string; name: string }[]): N01OrderEntry {
  return { matchId, schid, position: null, players };
}

export function managedFormat(): LeagueFormat {
  return {
    id: 'fmt_test',
    teamId: 'team_test',
    name: 'Test',
    discipline: 'SOFT',
    createdAt: 0,
    games: [
      { id: 'g1', order: 1, name: 'Singles 501', kinds: ['SINGLES', 'G501'], playerCount: 1 },
      { id: 'g2', order: 2, name: 'Singles 501', kinds: ['SINGLES', 'G501'], playerCount: 1 },
    ],
  };
}

export interface HistorySpec {
  id: string;
  title: string;
  /** 1 = the season before the current one. */
  seasonIndex: number;
  stats: N01PlayerStats[];
  opponentOrders?: N01OrderEntry[];
  /** Registered teams beyond `US` and `THEM`. */
  extraTeams?: string[];
  /**
   * The season's whole roster (`team/player/list` without a team): every team's rows.
   * `null` = the request failed. Omitted = the stats rows' people, which is what the
   * snapshot saw before whole rosters were fetched.
   */
  roster?: N01RosterPlayer[] | null;
}

export interface IntelSpec {
  roster: N01RosterPlayer[];
  stats: N01PlayerStats[];
  history?: HistorySpec[];
  opponentRoster?: N01RosterPlayer[];
  opponentOrders?: N01OrderEntry[];
  /** The current season's whole roster: every team (see {@link HistorySpec.roster}). */
  fullRoster?: N01RosterPlayer[] | null;
  /** Registered teams beyond `US` and `THEM` in the current season. */
  extraTeams?: string[];
  /** Resolve the next match (an opponent exists) or not. */
  withOpponent?: boolean;
  now?: number;
}

/**
 * A whole-roster response as the live API gives it: every registered team has members in
 * it. Teams the given rows leave out get one bare row (no `opid`, so it is no evidence about
 * anybody) — a test then states only the people it is about. Teams in `rows` that are not
 * registered stay (the live API returns some).
 */
export function wholeRoster(rows: readonly N01RosterPlayer[], registered: readonly string[] = [US, THEM]): N01RosterPlayer[] {
  const present = new Set(rows.map((row) => row.teamId));
  const filler = registered
    .filter((teamId) => !present.has(teamId))
    .map((teamId) => ({ opid: null, oid: `bare:${teamId}`, teamId, name: `(${teamId})` }));
  return [...rows, ...filler];
}

/** The people a season's stats rows name, as roster rows (the pre-whole-roster evidence). */
function rosterFromStats(stats: readonly N01PlayerStats[], registered: readonly string[]): N01RosterPlayer[] {
  return wholeRoster(
    stats.flatMap((row) => (row.oid ? [{ opid: row.opid, oid: row.oid, teamId: row.teamId ?? US, name: row.name ?? '' }] : [])),
    registered,
  );
}

export function buildIntel(spec: IntelSpec): N01MatchIntelligenceSnapshot {
  const current = tournament(CURRENT, '2026 3rd', spec.extraTeams);
  const data: N01TeamData = {
    league: { leagueId: 'lg_test', title: 'L' },
    tournaments: [],
    tournament: current,
    entry: { teamId: US, name: 'Us' },
    division: current.divisions[0],
    roster: spec.roster,
    stats: spec.stats,
    fetchedAt: spec.now ?? 1_000,
  };
  const history: HistoricalSeasonData[] = (spec.history ?? []).map((season) => ({
    summary: summary(season.id, season.title, 1_000 - season.seasonIndex * 100, season.seasonIndex),
    seasonIndex: season.seasonIndex,
    tournament: tournament(season.id, season.title, season.extraTeams),
    stats: season.stats,
    opponentTeamId: season.opponentOrders ? THEM : null,
    opponentOrders: season.opponentOrders ?? [],
  }));
  const withOpponent = spec.withOpponent ?? false;
  const fetched: IntelligenceFetch = {
    schedule: [],
    resolution: withOpponent
      ? {
          kind: 'resolved',
          match: { matchId: 'm1', title: 'm1', date: '2026-10-08', ourTeamId: US, opponentTeamId: THEM, opponentName: 'Them' },
        }
      : { kind: 'none' },
    opponentRoster: spec.opponentRoster ?? [],
    opponentOrders: spec.opponentOrders ?? [],
    history,
    rosters: {
      current:
        spec.fullRoster === undefined ? rosterFromStats(spec.stats, [US, THEM, ...(spec.extraTeams ?? [])]) : spec.fullRoster,
      byTournament: Object.fromEntries(
        (spec.history ?? []).map((season) => [
          season.id,
          season.roster === undefined ? rosterFromStats(season.stats, [US, THEM, ...(season.extraTeams ?? [])]) : season.roster,
        ]),
      ),
    },
    notes: [],
  };
  return buildIntelligenceSnapshot({
    teamId: 'team_test',
    data,
    format: managedFormat(),
    fetched,
    historyDepth: 2,
    now: spec.now ?? 1_000,
  });
}

/** A League Order player linked to an n01 roster row of the current tournament. */
export function linkedPlayer(
  id: string,
  source: { opid: string | null; oid: string; name: string },
  overrides: Partial<Player> & { statsPpr?: number | null; legs?: number | null } = {},
): Player {
  const { statsPpr = null, legs = null, ...rest } = overrides;
  const binding: N01PlayerBinding = {
    opid: source.opid,
    currentOid: source.oid,
    currentTpid: US,
    sourceName: source.name,
    rosterActive: true,
    lastSeenTournamentId: CURRENT,
    lastSeenAt: 1_000,
    stats:
      statsPpr === null
        ? null
        : { ppr: statsPpr, score: Math.round((statsPpr * 600) / 3), darts: 600, legs, tournamentId: CURRENT, syncedAt: 1_000 },
  };
  return {
    id,
    teamId: 'team_test',
    name: source.name,
    rating: null,
    ppr: null,
    skills: {},
    seasonAppearances: 0,
    seasonAppearancesByKind: {},
    archived: false,
    createdAt: 0,
    n01: binding,
    ...rest,
  };
}
