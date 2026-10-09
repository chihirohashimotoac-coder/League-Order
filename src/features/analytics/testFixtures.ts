import type { N01RosterPlayer, N01Tournament } from '../../integrations/n01/types';
import type { SeasonInput } from './seasonData';
import type { PlayerStatsRow, StatLine, TeamStatsRow } from './types';

/** Small test builders (shapes follow the real ATDO 2026 3rd responses in the design doc). */

export const EMPTY_LINE: StatLine = {
  score: null,
  darts: null,
  f9Score: null,
  f9Darts: null,
  leg: null,
  winLeg: null,
  set: null,
  winSet: null,
  breakLegs: null,
  breakWins: null,
  match: null,
  winMatch: null,
  ton00: null,
  ton40: null,
  ton70: null,
  ton80: null,
  highOut: null,
  bestLeg: null,
};

export function line(partial: Partial<StatLine>): StatLine {
  return { ...EMPTY_LINE, ...partial };
}

/** A line with plain darts/score/legs; handy when only the denominators matter. */
export function simpleLine(score: number, darts: number, winLeg: number, leg: number, extra: Partial<StatLine> = {}): StatLine {
  return line({ score, darts, winLeg, leg, f9Score: Math.round(score / 3), f9Darts: Math.round(darts / 3), ...extra });
}

export function tournament(
  id: string,
  teams: { id: string; name: string; division?: number }[],
  options: { title?: string; status?: number; startScore?: number; legs?: number } = {},
): N01Tournament {
  const divisionIndexes = [...new Set(teams.map((t) => t.division ?? 0))].sort();
  return {
    tournamentId: id,
    title: options.title ?? `Season ${id}`,
    leagueId: 'lg_test',
    status: options.status ?? 40,
    softdarts: false,
    entries: teams.map((t) => ({ teamId: t.id, name: t.name })),
    divisions: divisionIndexes.map((index) => ({
      index,
      title: `Div ${index}`,
      teamIds: teams.filter((t) => (t.division ?? 0) === index).map((t) => t.id),
    })),
    schedule: [{ schid: 's1', numPart: 1, subtitle: null, matchType: '01', startScore: options.startScore ?? 501, limitLegCount: options.legs ?? 2, group: null }],
    gameSettings: [],
    results: new Map(),
  };
}

export function roster(rows: { oid: string; opid: string | null; team: string; name: string }[]): N01RosterPlayer[] {
  return rows.map((r) => ({ oid: r.oid, opid: r.opid, teamId: r.team, name: r.name }));
}

export function playerRow(oid: string, opid: string | null, team: string, name: string, lineValue: StatLine, division: number | null = 0): PlayerStatsRow {
  return { oid, opid, teamId: team, name, divisionIndex: division, line: lineValue };
}

export function teamRow(teamId: string, lineValue: StatLine, division: number | null = 0): TeamStatsRow {
  return { teamId, divisionIndex: division, line: lineValue };
}

export function season(input: Partial<SeasonInput> & { tournament: N01Tournament }): SeasonInput {
  return { teamStats: [], playerStats: [], standings: [], roster: null, ...input };
}
