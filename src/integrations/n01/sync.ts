import type { LeagueFormat, Player, Team } from '../../domain/types';
import type { N01SyncSnapshot, N01TeamBinding } from '../../domain/n01/types';
import { syncSnapshotId } from '../../domain/n01/types';
import { planRosterSync, type RosterSyncResult } from '../../domain/n01/roster';
import { emptyChangeSummary, type N01ChangeSummary } from '../../domain/n01/changes';
import { DARTS_DISCIPLINE_TAGS } from '../../domain/types';
import type { N01Client } from './client';
import { N01Error } from './client';
import type {
  N01Division,
  N01Entry,
  N01LeagueSummary,
  N01PlayerStats,
  N01RosterPlayer,
  N01Tournament,
  N01TournamentSummary,
} from './types';
import { knownLeague } from './leagueRegistry';
import { newestFirst, pickSeasonByMembership, seasonPriorityGroups } from './seasonResolver';
import { entryById, findTeamEntries, identityOfEntry, teamChoices, type TeamChoice } from './teamResolver';
import { resolveDivision } from './divisionResolver';
import { buildManagedFormat, describeFormat, disciplineOf, formatShape } from './formatResolver';
import { rosterSource } from './rosterResolver';

/**
 * Sync orchestration (docs/N01_MASTER_DESIGN.md §4).
 *
 * Two halves:
 *
 * - **fetch** (`browseLeague`, `resolveLinkedTeam`, `fetchTeamData`): talks to n01
 *   through an injected client and reports progress step by step;
 * - **plan** (`planN01Sync`): a pure function from what was fetched plus the current
 *   local records to the exact records to write and a summary of what changed.
 *
 * Nothing here writes to storage. The app store applies a plan in one batch, so a sync
 * either lands completely or not at all.
 */

export const N01_SYNC_STEPS = ['season', 'team', 'roster', 'ppr', 'format', 'opponent', 'analysis'] as const;
export type N01SyncStep = (typeof N01_SYNC_STEPS)[number];

export const N01_SYNC_STEP_LABELS: Record<N01SyncStep, string> = {
  season: 'Season',
  team: 'Team',
  roster: 'Roster',
  ppr: 'PPR',
  format: 'Format',
  opponent: 'Opponent',
  analysis: 'Analysis',
};

export type N01StepStatus = 'pending' | 'running' | 'done' | 'skipped' | 'error';
export type N01ProgressListener = (step: N01SyncStep, status: N01StepStatus) => void;

const silent: N01ProgressListener = () => undefined;

export interface N01TeamSelection {
  leagueId: string;
  leagueTitle: string;
  tournamentId: string;
  /** `tpid` in that tournament. */
  teamTpid: string;
}

export interface N01TeamData {
  league: N01LeagueSummary;
  tournaments: N01TournamentSummary[];
  tournament: N01Tournament;
  entry: N01Entry;
  division: N01Division | null;
  roster: N01RosterPlayer[];
  stats: N01PlayerStats[];
  /**
   * True when n01 had no usable stats for the season (404 or an unreadable shape). The
   * roster and format are still synced; PPR keeps its previous values (MASTER SPEC
   * Phase 6 §6 "missing stats").
   */
  statsUnavailable?: boolean;
  fetchedAt: number;
}

function leagueTitleOf(leagueId: string, fromN01: string, fallback?: string): string {
  return fromN01 || fallback || knownLeague(leagueId)?.title || leagueId;
}

// ---------------------------------------------------------------------------
// Fetch
// ---------------------------------------------------------------------------

export interface LeagueBrowse {
  league: N01LeagueSummary;
  tournaments: N01TournamentSummary[];
  /** Details of the current-season candidates (the first non-empty priority group). */
  candidates: N01Tournament[];
  /** One row per team across those candidates. */
  choices: TeamChoice[];
}

/** Everything the team picker needs for a league. */
export async function browseLeague(
  client: N01Client,
  leagueId: string,
  fallbackTitle?: string,
  onProgress: N01ProgressListener = silent,
): Promise<LeagueBrowse> {
  onProgress('season', 'running');
  const list = await client.leagueTournaments(leagueId);
  const groups = seasonPriorityGroups(list.tournaments);
  if (groups.length === 0) {
    onProgress('season', 'error');
    throw new N01Error('notFound', 'このリーグには開催中・受付中・終了済みのシーズンがありません。', 'league/tournament/list');
  }
  const candidates = await Promise.all(groups[0].map((t) => client.tournament(t.tournamentId)));
  onProgress('season', 'done');
  return {
    league: { leagueId, title: leagueTitleOf(leagueId, list.league.title, fallbackTitle) },
    tournaments: list.tournaments,
    candidates,
    choices: teamChoices(candidates),
  };
}

export type LinkedResolution =
  | { kind: 'ok'; selection: N01TeamSelection }
  | { kind: 'seasonAmbiguous'; options: { tournamentId: string; title: string; teamTpid: string }[] }
  | { kind: 'teamNotFound'; browse: LeagueBrowse };

/**
 * Re-resolves a linked team's season and `tpid` (MASTER SPEC Phase 1 §3, §5): the first
 * priority group containing the team's stable identity wins. Several matching seasons
 * are left to the captain; no matching season means the team was renamed or did not
 * enter, and the captain picks the team again.
 */
export async function resolveLinkedTeam(
  client: N01Client,
  binding: N01TeamBinding,
  onProgress: N01ProgressListener = silent,
): Promise<LinkedResolution> {
  onProgress('season', 'running');
  const list = await client.leagueTournaments(binding.leagueId);
  const groups = seasonPriorityGroups(list.tournaments);
  const details = new Map<string, N01Tournament>();
  for (const group of groups) {
    const fetched = await Promise.all(group.map((t) => client.tournament(t.tournamentId)));
    for (const tournament of fetched) details.set(tournament.tournamentId, tournament);
    if (fetched.some((tournament) => findTeamEntries(tournament, binding.stableIdentity).length > 0)) break;
  }
  const pick = pickSeasonByMembership(groups, (id) => {
    const tournament = details.get(id);
    return tournament ? findTeamEntries(tournament, binding.stableIdentity).length > 0 : false;
  });
  onProgress('season', pick.kind === 'notFound' ? 'error' : 'done');
  const leagueTitle = leagueTitleOf(binding.leagueId, list.league.title, binding.leagueTitle);

  const notFoundBrowse = (): LeagueBrowse => {
    const candidates = groups.length > 0 ? groups[0].map((t) => details.get(t.tournamentId)!).filter(Boolean) : [];
    return {
      league: { leagueId: binding.leagueId, title: leagueTitle },
      tournaments: list.tournaments,
      candidates,
      choices: teamChoices(candidates),
    };
  };
  if (pick.kind === 'notFound') return { kind: 'teamNotFound', browse: notFoundBrowse() };

  // Never go back in time: a team already synced in a newer season that is no longer
  // found there (most often a renamed team) is not silently re-synced to an older one.
  const order = newestFirst(list.tournaments).map((t) => t.tournamentId);
  const lastIndex = order.indexOf(binding.lastTournamentId);
  const notOlder = (id: string): boolean => lastIndex < 0 || order.indexOf(id) <= lastIndex;
  const ids = (pick.kind === 'resolved' ? [pick.tournamentId] : pick.tournamentIds).filter(notOlder);
  if (ids.length === 0) {
    onProgress('season', 'error');
    return { kind: 'teamNotFound', browse: notFoundBrowse() };
  }
  const options = ids.flatMap((id) => {
    const tournament = details.get(id)!;
    const entries = findTeamEntries(tournament, binding.stableIdentity);
    // The same name twice in one tournament is not resolvable automatically either.
    return entries.map((entry) => ({ tournamentId: id, title: tournament.title, teamTpid: entry.teamId }));
  });
  if (options.length === 1) {
    return {
      kind: 'ok',
      selection: {
        leagueId: binding.leagueId,
        leagueTitle,
        tournamentId: options[0].tournamentId,
        teamTpid: options[0].teamTpid,
      },
    };
  }
  return { kind: 'seasonAmbiguous', options };
}

/** Fetches everything Phase 1 needs for one selected team. */
export async function fetchTeamData(
  client: N01Client,
  selection: N01TeamSelection,
  now: () => number,
  onProgress: N01ProgressListener = silent,
): Promise<N01TeamData> {
  onProgress('season', 'running');
  const [list, tournament] = await Promise.all([
    client.leagueTournaments(selection.leagueId),
    client.tournament(selection.tournamentId),
  ]);
  onProgress('season', 'done');

  onProgress('team', 'running');
  const entry = entryById(tournament, selection.teamTpid);
  if (!entry) {
    onProgress('team', 'error');
    throw new N01Error('notFound', 'n01 のエントリーにチームが見つかりません。', 'tournament/get');
  }
  const division = resolveDivision(tournament, entry.teamId);
  onProgress('team', 'done');

  onProgress('roster', 'running');
  const roster = await client.roster(tournament.tournamentId, entry.teamId);
  onProgress('roster', 'done');

  onProgress('ppr', 'running');
  let stats: N01PlayerStats[] = [];
  let statsUnavailable = false;
  try {
    stats = await client.stats(tournament.tournamentId);
    onProgress('ppr', 'done');
  } catch (error) {
    // Being offline fails the whole sync (the previous data stays as it was); stats that
    // are missing or unreadable only cost the PPR update.
    if (!(error instanceof N01Error) || (error.kind !== 'notFound' && error.kind !== 'schema')) throw error;
    statsUnavailable = true;
    onProgress('ppr', 'error');
  }

  onProgress('format', 'running');
  if (tournament.schedule.length === 0 && tournament.gameSettings.length === 0) {
    onProgress('format', 'error');
    throw new N01Error('schema', 'n01 のフォーマット (lg_setting.schedule) が空です。', 'tournament/get');
  }
  onProgress('format', 'done');

  return {
    league: { leagueId: selection.leagueId, title: leagueTitleOf(selection.leagueId, list.league.title, selection.leagueTitle) },
    tournaments: list.tournaments,
    tournament,
    entry,
    division,
    roster,
    stats,
    ...(statsUnavailable ? { statsUnavailable } : {}),
    fetchedAt: now(),
  };
}

// ---------------------------------------------------------------------------
// Plan
// ---------------------------------------------------------------------------

export interface N01SyncPlanInput {
  team: Team;
  /** The team's current local players. */
  localPlayers: readonly Player[];
  /** The managed format, when the team already has one. */
  existingFormat: LeagueFormat | null;
  data: N01TeamData;
  now: number;
  newId: (prefix: string) => string;
  /** Captain's choices when linking an existing team (see `planRosterSync`). */
  explicit?: ReadonlyMap<string, string | null>;
  /** Hold back n01 players who might be hand-made members, for the captain to confirm. */
  deferAmbiguous?: boolean;
}

export interface N01SyncPlan {
  team: Team;
  /** Player records to upsert (new and changed only). */
  players: Player[];
  format: LeagueFormat;
  snapshot: N01SyncSnapshot;
  changes: N01ChangeSummary;
  roster: RosterSyncResult;
}

export function planN01Sync(input: N01SyncPlanInput): N01SyncPlan {
  const { team, data, now } = input;
  const previous = team.n01;
  const discipline = disciplineOf(data.tournament);

  const format = buildManagedFormat({
    formatId: input.existingFormat?.id ?? input.newId('fmt'),
    teamId: team.id,
    leagueId: data.league.leagueId,
    leagueTitle: data.league.title,
    tournament: data.tournament,
    division: data.division,
    now,
    createdAt: input.existingFormat?.createdAt,
  });

  const tournamentId = data.tournament.tournamentId;
  const source = rosterSource(data.roster, data.stats, tournamentId, now);
  const changes = emptyChangeSummary(!previous);
  if (data.statsUnavailable) {
    // Each matched player keeps its last known n01 stats (planRosterSync `retainStats`).
    changes.notes.push('n01 の成績データを取得できなかったため、PPR は前回の値のままです。');
  }
  let roster: RosterSyncResult;
  if (source.length === 0 && input.localPlayers.some((player) => player.n01?.rosterActive)) {
    // An empty roster for a team that had players is far more likely a data problem than
    // everybody leaving at once: nothing is deactivated, and the captain is told.
    roster = { upserts: [], added: [], deactivated: [], reactivated: [], renamed: [], pprChanged: [], ambiguous: [], pending: [] };
    changes.notes.push('n01 の登録メンバーが 0 名だったため、メンバーは更新しませんでした。');
  } else {
    roster = planRosterSync({
      teamId: team.id,
      localPlayers: input.localPlayers,
      source,
      tournamentId: data.tournament.tournamentId,
      now,
      newId: () => input.newId('pl'),
      explicit: input.explicit,
      retainStats: data.statsUnavailable,
      deferAmbiguous: input.deferAmbiguous,
    });
  }

  const binding: N01TeamBinding = {
    provider: 'n01',
    leagueId: data.league.leagueId,
    leagueTitle: data.league.title,
    stableIdentity: identityOfEntry(data.entry),
    lastTournamentId: data.tournament.tournamentId,
    lastTournamentTitle: data.tournament.title,
    lastTeamId: data.entry.teamId,
    lastTeamName: data.entry.name,
    lastDivisionIndex: data.division?.index ?? null,
    lastDivisionTitle: data.division?.title ?? null,
    discipline,
    managedFormatId: format.id,
    linkedAt: previous?.linkedAt ?? now,
    lastSuccessfulSyncAt: now,
  };

  const nextTeam: Team = {
    ...team,
    leagueName: team.leagueName?.trim() ? team.leagueName : data.league.title,
    n01: binding,
  };

  if (previous) {
    if (previous.lastTournamentId !== binding.lastTournamentId) {
      changes.season = { from: previous.lastTournamentTitle, to: binding.lastTournamentTitle };
    }
    if (previous.lastDivisionTitle !== binding.lastDivisionTitle) {
      changes.division = { from: previous.lastDivisionTitle, to: binding.lastDivisionTitle };
    }
    if (previous.discipline !== binding.discipline) {
      changes.discipline = {
        from: DARTS_DISCIPLINE_TAGS[previous.discipline],
        to: DARTS_DISCIPLINE_TAGS[binding.discipline],
      };
    }
    if (input.existingFormat && formatShape(input.existingFormat) !== formatShape(format)) {
      changes.format = { from: describeFormat(input.existingFormat.games), to: describeFormat(format.games) };
    }
    changes.rosterAdded = roster.added.map((entry) => entry.name);
    changes.rosterInactive = roster.deactivated.map((entry) => entry.name);
    changes.rosterReturned = roster.reactivated.map((entry) => entry.name);
    changes.rosterRenamed = roster.renamed.map((entry) => ({ from: entry.from, to: entry.to }));
    changes.pprChanged = roster.pprChanged.map((entry) => ({ name: entry.name, from: entry.from, to: entry.to }));
  }
  changes.ambiguousNames = roster.ambiguous;

  const snapshot: N01SyncSnapshot = {
    id: syncSnapshotId(team.id),
    kind: 'sync',
    teamId: team.id,
    fetchedAt: data.fetchedAt,
    leagueId: data.league.leagueId,
    leagueTitle: data.league.title,
    tournamentId: data.tournament.tournamentId,
    tournamentTitle: data.tournament.title,
    teamTpid: data.entry.teamId,
    teamName: data.entry.name,
    divisionIndex: data.division?.index ?? null,
    divisionTitle: data.division?.title ?? null,
    discipline,
    formatDescription: describeFormat(format.games),
    rosterCount: source.length,
    pprCount: source.filter((player) => player.stats?.ppr !== null && player.stats?.ppr !== undefined).length,
  };

  return { team: nextTeam, players: roster.upserts, format, snapshot, changes, roster };
}
