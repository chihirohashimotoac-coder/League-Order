import { aggregateLines, matchWinRate } from './metrics';
import type { SeasonData, TeamAliasMap } from './seasonData';
import { teamKeys } from './seasonData';
import type { Metrics, OfficialStandingRow, StatLine } from './types';

/**
 * Multi-season pooling (design §3, 合算). Seasons are given newest first and must share one
 * game format; {@link splitByFormat} separates the ones that do not, with the reason.
 */

export interface FormatSplit {
  compatible: SeasonData[];
  excluded: { tournamentId: string; title: string; reason: string }[];
}

/** Keeps the seasons whose format matches the base season's (default: the newest). */
export function splitByFormat(seasons: readonly SeasonData[], baseTournamentId?: string): FormatSplit {
  const base = seasons.find((s) => s.tournamentId === baseTournamentId) ?? seasons[0];
  const compatible: SeasonData[] = [];
  const excluded: FormatSplit['excluded'] = [];
  for (const season of seasons) {
    if (!base || season.signature === base.signature) compatible.push(season);
    else excluded.push({ tournamentId: season.tournamentId, title: season.title, reason: '試合形式（ゲーム種別・スコア・レッグ数）が基準の季と異なるため合算しません' });
  }
  return { compatible, excluded };
}

export interface PlayerSeasonEntry {
  tournamentId: string;
  title: string;
  teamId: string;
  divisionIndex: number | null;
  line: StatLine;
}

export interface PlayerPeriod {
  personKey: string;
  /** Name in the newest season the person appears in (a rename is followed). */
  name: string;
  /** Newest-first. */
  seasons: PlayerSeasonEntry[];
  metrics: Metrics;
  /** True when the person is joined across more than one season through a proven `opid`. */
  linked: boolean;
}

/** One person per `personKey`, pooled over the given seasons. Namesakes with unproven ids stay separate. */
export function aggregatePlayers(seasons: readonly SeasonData[]): PlayerPeriod[] {
  const byKey = new Map<string, PlayerSeasonEntry[]>();
  const names = new Map<string, string>();
  for (const season of seasons) {
    for (const player of season.players) {
      const entries = byKey.get(player.personKey) ?? [];
      entries.push({
        tournamentId: season.tournamentId,
        title: season.title,
        teamId: player.teamId,
        divisionIndex: player.divisionIndex,
        line: player.line,
      });
      byKey.set(player.personKey, entries);
      // Seasons arrive newest first, so the first name seen is the latest.
      if (!names.has(player.personKey)) names.set(player.personKey, player.name);
    }
  }
  return [...byKey].map(([personKey, entries]) => ({
    personKey,
    name: names.get(personKey) ?? personKey,
    seasons: entries,
    metrics: aggregateLines(entries.map((e) => e.line)),
    linked: entries.length > 1,
  }));
}

export interface TeamSeasonEntry {
  tournamentId: string;
  title: string;
  teamId: string;
  name: string;
  divisionIndex: number | null;
  /** `null` = no stats row that season. */
  line: StatLine | null;
  /** Official, per-season and per-division. Never summed across seasons. */
  official: OfficialStandingRow | null;
  matchReconciled: boolean;
}

export interface TeamPeriod {
  teamKey: string;
  /** Name in the newest season. */
  name: string;
  seasons: TeamSeasonEntry[];
  /** Pooled from the team's own stats lines only — never from the players' rows (no double counting). */
  metrics: Metrics;
  /** Σ over seasons whose stats and official standings agree; `null` when none does. */
  match: { played: number; won: number; drawn: number; lost: number; winRate: number | null; seasons: number } | null;
}

export function aggregateTeams(seasons: readonly SeasonData[], aliases: TeamAliasMap = {}): TeamPeriod[] {
  const keys = teamKeys(seasons, aliases);
  const byKey = new Map<string, TeamSeasonEntry[]>();
  for (const season of seasons) {
    for (const team of season.teams) {
      const key = keys.get(`${season.tournamentId}:${team.teamId}`)!;
      const entries = byKey.get(key) ?? [];
      entries.push({
        tournamentId: season.tournamentId,
        title: season.title,
        teamId: team.teamId,
        name: team.name,
        divisionIndex: team.divisionIndex,
        line: team.line,
        official: team.official,
        matchReconciled: team.matchReconciled,
      });
      byKey.set(key, entries);
    }
  }
  return [...byKey].map(([teamKey, entries]) => {
    const measured = entries.filter((e) => e.line !== null).map((e) => e.line!);
    const reconciled = entries.filter((e) => e.matchReconciled && e.official);
    let match: TeamPeriod['match'] = null;
    if (reconciled.length > 0) {
      const sum = reconciled.reduce(
        (acc, e) => ({
          played: acc.played + e.official!.played,
          won: acc.won + e.official!.won,
          drawn: acc.drawn + e.official!.drawn,
          lost: acc.lost + e.official!.lost,
        }),
        { played: 0, won: 0, drawn: 0, lost: 0 },
      );
      match = { ...sum, winRate: matchWinRate(sum.won, sum.played), seasons: reconciled.length };
    }
    return { teamKey, name: entries[0].name, seasons: entries, metrics: aggregateLines(measured), match };
  });
}
