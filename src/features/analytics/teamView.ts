import type { PlayerPeriod, TeamPeriod } from './aggregate';
import { aggregateTeams } from './aggregate';
import { normalizeName } from '../../domain/n01/names';
import type { N01TeamBinding } from '../../domain/n01/types';
import { pairOf } from './metrics';
import { pooledAverage, rankBestLeg, rankMetric, scopeTeams } from './ranking';
import type { RankingResult, ScopedPopulation, TeamScope } from './ranking';
import type { RankMetric } from './format';
import type { SeasonData, TeamAliasMap, TeamSeason } from './seasonData';
import type { TrendPoint } from './playerView';
import type { MetricId, OfficialStandingGroup, OfficialStandingRow, Ratio } from './types';

/**
 * Team Analytics view-model (design §5). Pure.
 *
 * The three rules that shape it:
 *  1. Team totals come from the team's own stats row only. Player rows are shown next to it
 *     but never added to it (a doubles leg is on both partners' rows).
 *  2. n01's official standing is per season and per division. It is shown as given, and never
 *     summed or averaged across seasons; League Order's own ordering is a separate list.
 *  3. A claim that needs a number we do not have is not made: no "win contribution", no
 *     "the stronger division".
 */

/** The linked team in the base season. A past season's `tpid` is season-scoped, so it is found by an exact, unique name. */
export function resolveBaseTeam(base: SeasonData, binding: N01TeamBinding): TeamSeason | null {
  if (base.tournamentId === binding.lastTournamentId) return base.teams.find((t) => t.teamId === binding.lastTeamId) ?? null;
  const wanted = normalizeName(binding.lastTeamName);
  const named = base.teams.filter((t) => normalizeName(t.name) === wanted);
  return named.length === 1 ? named[0] : null;
}

export interface TeamPopulation {
  teams: TeamPeriod[];
  scoped: ScopedPopulation<TeamPeriod>;
  averages: Record<MetricId, Ratio>;
}

const AVERAGED: MetricId[] = ['ppr', 'first9', 'legRate', 'setRate', 'keep', 'break', 'ton00Rate', 'ton40Rate', 'ton70Rate', 'ton80Rate'];

export function buildTeamPopulation(seasons: readonly SeasonData[], scope: TeamScope, baseTournamentId: string, aliases: TeamAliasMap = {}): TeamPopulation {
  const teams = aggregateTeams(seasons, aliases);
  const scoped = scopeTeams(teams, scope, baseTournamentId);
  const averages = {} as Record<MetricId, Ratio>;
  for (const metric of AVERAGED) averages[metric] = pooledAverage(scoped.members.map((t) => t.metrics[metric]));
  return { teams, scoped, averages };
}

export function rankTeams(members: readonly TeamPeriod[], metric: RankMetric): RankingResult {
  const id = (t: TeamPeriod): string => t.teamKey;
  const label = (t: TeamPeriod): string => t.name;
  return metric === 'bestLeg' ? rankBestLeg(members, id, label) : rankMetric(members, metric, id, label);
}

/** The team's period figures: its entry in the base season identifies it. */
export function findTeamPeriod(teams: readonly TeamPeriod[], baseTournamentId: string, baseTeamId: string): TeamPeriod | null {
  return teams.find((t) => t.seasons.some((s) => s.tournamentId === baseTournamentId && s.teamId === baseTeamId)) ?? null;
}

// ---- official standings ----------------------------------------------------------------------

export interface OfficialView {
  /** The base season's division table as n01 computed it. `null` when not read. */
  group: OfficialStandingGroup | null;
  row: OfficialStandingRow | null;
}

export function officialOf(base: SeasonData, baseTeam: TeamSeason): OfficialView {
  const group = base.standings.find((g) => g.rows.some((r) => r.teamId === baseTeam.teamId)) ?? null;
  return { group, row: group?.rows.find((r) => r.teamId === baseTeam.teamId) ?? null };
}

export interface OfficialSeasonLine {
  tournamentId: string;
  title: string;
  divisionIndex: number | null;
  /** `null` for rank 0 (not ranked yet) or no standings. */
  rank: number | null;
  points: number | null;
  record: string | null;
}

/** One line per season, newest first. Deliberately no total, no average, no combined rank. */
export function officialPerSeason(team: TeamPeriod): OfficialSeasonLine[] {
  return team.seasons.map((s) => ({
    tournamentId: s.tournamentId,
    title: s.title,
    divisionIndex: s.divisionIndex,
    rank: s.official && s.official.rank > 0 ? s.official.rank : null,
    points: s.official ? s.official.points : null,
    record: s.official ? `${s.official.won}勝${s.official.drawn}分${s.official.lost}敗` : null,
  }));
}

// ---- trend ----------------------------------------------------------------------------------

/** One point per season the team has a stats row for, oldest first; a season without a usable denominator is a gap. */
export function teamTrend(team: TeamPeriod, metric: MetricId): TrendPoint[] {
  return [...team.seasons].reverse().map((s) => {
    const pair = s.line ? pairOf(metric, s.line) : null;
    return { tournamentId: s.tournamentId, title: s.title, value: pair ? pair.num / pair.den : null, sample: pair?.den ?? 0, divisionIndex: s.divisionIndex };
  });
}

/** Seasons of the period in which this team could not be tied to the base team (renamed, namesake, or absent). */
export function unlinkedSeasons(team: TeamPeriod, seasons: readonly SeasonData[]): { tournamentId: string; title: string }[] {
  const linked = new Set(team.seasons.map((s) => s.tournamentId));
  return seasons.filter((s) => !linked.has(s.tournamentId)).map((s) => ({ tournamentId: s.tournamentId, title: s.title }));
}

// ---- the team's players -------------------------------------------------------------------------

export interface TeamPlayerRow {
  person: PlayerPeriod;
  /** Legs this player took part in during the base season, as a share of the team's legs that season. Doubles legs count for both partners, so shares add up to more than 100%. */
  involvement: number | null;
}

/**
 * The people who were on the team in the base season, with their period figures. The
 * "involvement" share is the only contribution-like figure: it is a share of *legs played*,
 * not of wins, because no verified per-player win attribution exists in the public stats.
 */
export function teamPlayerRows(people: readonly PlayerPeriod[], baseTournamentId: string, baseTeamId: string, team: TeamPeriod | null): TeamPlayerRow[] {
  const baseTeamLegs = team?.seasons.find((s) => s.tournamentId === baseTournamentId)?.line?.leg ?? 0;
  return people
    .filter((p) => p.seasons.some((s) => s.tournamentId === baseTournamentId && s.teamId === baseTeamId))
    .map((person) => {
      // The base season only: the share compares like with like (one season's legs of one team).
      const legs = person.seasons.filter((s) => s.teamId === baseTeamId && s.tournamentId === baseTournamentId).reduce((sum, s) => sum + (s.line.leg ?? 0), 0);
      return { person, involvement: baseTeamLegs > 0 ? legs / baseTeamLegs : null };
    })
    .sort((a, b) => (b.person.metrics.ppr.value ?? -1) - (a.person.metrics.ppr.value ?? -1) || a.person.name.localeCompare(b.person.name, 'ja'));
}
