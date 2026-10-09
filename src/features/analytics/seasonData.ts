import { normalizeName } from '../../domain/n01/names';
import { isUsableOpid, rosterCoverage, sharedOpids, unprovenOpids } from '../../domain/n01/identity';
import type { RosterCoverage } from '../../domain/n01/identity';
import type { N01RosterPlayer, N01Tournament } from '../../integrations/n01/types';
import { formatSignature } from './seasons';
import type { OfficialStandingGroup, OfficialStandingRow, PlayerStatsRow, StatLine, TeamStatsRow } from './types';

/**
 * One season's raw responses → a checked, normalised `SeasonData` (design §3, 季別集計).
 *
 * What it settles, and where each rule comes from:
 *  - **Population**: only teams registered in the tournament are listed; stats rows for any
 *    other `tpid` are counted and dropped. A registered team with no stats row has
 *    `line: null` — *unmeasured*, never 0.
 *  - **Identity**: `oid` is authoritative inside the season; an `opid` may link seasons only
 *    when the season's whole roster is present and the `opid` is unique in it (PR #7's
 *    `rosterCoverage` / `sharedOpids` / `unprovenOpids`, reused unchanged).
 *  - **Duplicates / conflicts**: the same `(season, oid)` twice is one row; the same `oid`
 *    on two teams is a conflict and is held out of every figure rather than summed.
 */

export interface TeamSeason {
  teamId: string;
  name: string;
  divisionIndex: number | null;
  /** `null` = n01 has no stats row for this team (not played / not measured). */
  line: StatLine | null;
  official: OfficialStandingRow | null;
  /** True when n01's stats `match`/`winMatch` equal the standings' played/won (design §3 合算). */
  matchReconciled: boolean;
}

export interface PlayerSeason {
  /** Tournament-scoped id. */
  oid: string;
  /** Cross-season key: `opid:<id>` only when provably one person in this season, else `oid:<tdid>:<oid>`. */
  personKey: string;
  /** True when {@link personKey} may be shared with other seasons. */
  linkable: boolean;
  opid: string | null;
  name: string;
  teamId: string;
  divisionIndex: number | null;
  line: StatLine;
}

export interface SeasonData {
  tournamentId: string;
  leagueId: string | null;
  title: string;
  status: number | null;
  signature: string;
  divisions: { index: number; title: string; teamIds: string[] }[];
  teams: TeamSeason[];
  players: PlayerSeason[];
  standings: OfficialStandingGroup[];
  coverage: RosterCoverage | null;
  /** `opid`s that are shared or unproven in this season. */
  sharedOpidSet: ReadonlySet<string>;
  /** Players held out because the same oid carried two teams. */
  conflicts: { oid: string; teamIds: string[] }[];
  /** Stats rows dropped because their team is not registered in this tournament. */
  droppedUnregisteredRows: number;
  warnings: string[];
}

export interface SeasonInput {
  tournament: N01Tournament;
  teamStats: readonly TeamStatsRow[];
  playerStats: readonly PlayerStatsRow[];
  standings: readonly OfficialStandingGroup[];
  /** The whole-season roster, or `null` when it could not be read. */
  roster: readonly N01RosterPlayer[] | null;
}

export function buildSeasonData(input: SeasonInput): SeasonData {
  const { tournament } = input;
  const warnings: string[] = [];
  const registered = new Map(tournament.entries.map((entry) => [entry.teamId, entry.name]));
  const divisionOfTeam = new Map<string, number>();
  for (const division of tournament.divisions) for (const teamId of division.teamIds) divisionOfTeam.set(teamId, division.index);
  const officialByTeam = new Map<string, OfficialStandingRow>();
  for (const group of input.standings) for (const row of group.rows) officialByTeam.set(row.teamId, row);

  // Teams ---------------------------------------------------------------
  const statsByTeam = new Map<string, TeamStatsRow>();
  for (const row of input.teamStats) statsByTeam.set(row.teamId, row);
  const teams: TeamSeason[] = [];
  for (const [teamId, name] of registered) {
    const stats = statsByTeam.get(teamId) ?? null;
    const official = officialByTeam.get(teamId) ?? null;
    teams.push({
      teamId,
      name,
      divisionIndex: divisionOfTeam.get(teamId) ?? stats?.divisionIndex ?? null,
      line: stats?.line ?? null,
      official,
      matchReconciled:
        !!stats && !!official && stats.line.match === official.played && stats.line.winMatch === official.won,
    });
  }
  let droppedUnregisteredRows = input.teamStats.filter((row) => !registered.has(row.teamId)).length;

  // Identity -------------------------------------------------------------
  const coverage = input.roster ? rosterCoverage(input.roster, registered.keys()) : null;
  const rosterRows = input.roster ?? [];
  // A season whose whole roster is missing or short proves nothing: no opid is trusted in it.
  const sharedOpidSet: ReadonlySet<string> =
    coverage?.complete === true
      ? sharedOpids([
          ...rosterRows.map((r) => ({ opid: r.opid, oid: r.oid, name: r.name })),
          ...input.playerStats.map((r) => ({ opid: r.opid, oid: r.oid, name: r.name })),
        ])
      : unprovenOpids();
  if (!coverage) warnings.push('名簿を取得できないため、この季の選手を他の季と結び付けません。');
  else if (!coverage.complete) warnings.push('名簿に未登録のチームがあるため、この季の選手を他の季と結び付けません。');

  // Players --------------------------------------------------------------
  const byOid = new Map<string, PlayerStatsRow[]>();
  for (const row of input.playerStats) byOid.set(row.oid, [...(byOid.get(row.oid) ?? []), row]);
  const players: PlayerSeason[] = [];
  const conflicts: SeasonData['conflicts'] = [];
  for (const [oid, rows] of byOid) {
    const teamIds = [...new Set(rows.map((r) => r.teamId ?? ''))];
    if (teamIds.length > 1) {
      conflicts.push({ oid, teamIds });
      continue;
    }
    const row = rows[rows.length - 1];
    if (!row.teamId || !registered.has(row.teamId)) {
      droppedUnregisteredRows += 1;
      continue;
    }
    const linkable = isUsableOpid(row.opid, sharedOpidSet);
    players.push({
      oid,
      personKey: linkable ? `opid:${row.opid}` : `oid:${tournament.tournamentId}:${oid}`,
      linkable,
      opid: row.opid,
      name: row.name ?? oid,
      teamId: row.teamId,
      divisionIndex: divisionOfTeam.get(row.teamId) ?? row.divisionIndex,
      line: row.line,
    });
  }
  if (conflicts.length > 0) warnings.push(`同じ選手IDが複数チームに出現しているため ${conflicts.length} 件を集計から除外しました。`);

  return {
    tournamentId: tournament.tournamentId,
    leagueId: tournament.leagueId,
    title: tournament.title,
    status: tournament.status,
    signature: formatSignature(tournament),
    divisions: tournament.divisions.map((d) => ({ index: d.index, title: d.title, teamIds: d.teamIds })),
    teams,
    players,
    standings: [...input.standings],
    coverage,
    sharedOpidSet,
    conflicts,
    droppedUnregisteredRows,
    warnings,
  };
}

/** Team identity across seasons: unique strict-normalised name, or an approved alias. */
export interface TeamAliasMap {
  /** `"<tdid>:<tpid>"` → canonical team key chosen by the user. */
  [seasonTeam: string]: string;
}

/**
 * Cross-season key of a team. Name matches only count when the name is unique among that
 * season's registered teams; renames, merges and namesakes stay separate until the user
 * confirms an alias (design §3, 季間のチーム).
 */
export function teamKeys(seasons: readonly SeasonData[], aliases: TeamAliasMap = {}): Map<string, string> {
  const keys = new Map<string, string>();
  for (const season of seasons) {
    const counts = new Map<string, number>();
    for (const team of season.teams) {
      const n = normalizeName(team.name);
      counts.set(n, (counts.get(n) ?? 0) + 1);
    }
    for (const team of season.teams) {
      const slot = `${season.tournamentId}:${team.teamId}`;
      const n = normalizeName(team.name);
      keys.set(slot, aliases[slot] ?? (counts.get(n) === 1 ? `name:${n}` : `team:${slot}`));
    }
  }
  return keys;
}
