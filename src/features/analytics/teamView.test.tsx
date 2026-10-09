import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { aggregatePlayers, aggregateTeams } from './aggregate';
import { buildSeasonData } from './seasonData';
import type { SeasonData } from './seasonData';
import type { PeriodLoad } from './service/periodService';
import { buildTeamPopulation, findTeamPeriod, officialOf, officialPerSeason, rankTeams, resolveBaseTeam, teamPlayerRows, teamTrend, unlinkedSeasons } from './teamView';
import { playerRow, roster, season, simpleLine, teamRow, tournament } from './testFixtures';
import { TeamAnalytics } from './ui/TeamAnalytics';
import type { Team } from '../../domain/types';
import type { OfficialStandingGroup } from './types';

afterEach(cleanup);

const TEAMS = [
  { id: 'TA', name: 'Alpha', division: 0 },
  { id: 'TB', name: 'Beta', division: 0 },
  { id: 'TC', name: 'Gamma', division: 0 },
  { id: 'TD', name: 'Delta', division: 0 },
  { id: 'TE', name: 'Epsilon', division: 0 },
  { id: 'TF', name: 'Zeta', division: 1 },
  { id: 'TG', name: 'NoStats', division: 1 },
];
const PPR: Record<string, number> = { TA: 55, TB: 50, TC: 48, TD: 46, TE: 44, TF: 60 };

function standingsFor(ranks: Record<string, number>): OfficialStandingGroup[] {
  const rows = (ids: string[]) =>
    ids.map((teamId) => ({ teamId, name: TEAMS.find((t) => t.id === teamId)!.name, rank: ranks[teamId] ?? 0, played: 2, won: 1, drawn: 0, lost: 1, points: 9 }));
  return [
    { divisionIndex: 0, title: 'A', rows: rows(['TA', 'TB', 'TC', 'TD', 'TE']) },
    { divisionIndex: 1, title: 'B', rows: rows(['TF', 'TG']) },
  ];
}

function makeSeason(id: string, opts: { names?: Record<string, string>; ranks?: Record<string, number>; dropTeamStats?: string[] } = {}): SeasonData {
  const teams = TEAMS.map((t) => ({ ...t, name: opts.names?.[t.id] ?? t.name }));
  const t = tournament(id, teams, { title: id });
  const teamStats = Object.keys(PPR)
    .filter((tp) => !opts.dropTeamStats?.includes(tp))
    .map((tp) => teamRow(tp, simpleLine((PPR[tp] * 600) / 3, 600, tp === 'TA' ? 12 : 8, 30, { match: 2, winMatch: 1, set: 10, winSet: 5, highOut: 100, bestLeg: 18 }), TEAMS.find((x) => x.id === tp)!.division));
  // Two players on Alpha who both appear in every leg of the doubles-like data: their legs add up to 2x the team's.
  const people = [
    playerRow('o1', 'op1', 'TA', '橋本', simpleLine(300 * 18, 300, 7, 30)),
    playerRow('o2', 'op2', 'TA', '佐藤', simpleLine(300 * 15, 300, 5, 30)),
  ];
  return buildSeasonData(
    season({
      tournament: t,
      teamStats,
      playerStats: people,
      standings: standingsFor(opts.ranks ?? { TA: 1, TB: 2, TC: 3, TD: 4, TE: 5, TF: 1 }),
      roster: roster([
        { oid: 'o1', opid: 'op1', team: 'TA', name: '橋本' },
        { oid: 'o2', opid: 'op2', team: 'TA', name: '佐藤' },
        ...['TB', 'TC', 'TD', 'TE', 'TF', 'TG'].map((tp) => ({ oid: `r${tp}`, opid: `op${tp}`, team: tp, name: `x${tp}` })),
      ]),
    }),
  );
}

function binding(tournamentId: string, teamId: string, name: string) {
  return {
    provider: 'n01' as const, leagueId: 'lg', leagueTitle: 'L', stableIdentity: { kind: 'name' as const, value: name }, lastTournamentId: tournamentId, lastTournamentTitle: tournamentId,
    lastTeamId: teamId, lastTeamName: name, lastDivisionIndex: 0, lastDivisionTitle: 'A', discipline: 'STEEL' as const, managedFormatId: null, linkedAt: 0, lastSuccessfulSyncAt: 0,
  };
}

describe('teamView', () => {
  const s1 = makeSeason('s1');
  const s2 = makeSeason('s2');

  it('resolveBaseTeam: same season by tpid; another season only by an exact unique name', () => {
    const b = binding('s2', 'TA', 'Alpha');
    expect(resolveBaseTeam(s2, b)?.teamId).toBe('TA');
    expect(resolveBaseTeam(s1, b)?.teamId).toBe('TA'); // unique name
    const renamed = makeSeason('s0', { names: { TA: 'Old Alpha' } });
    expect(resolveBaseTeam(renamed, b)).toBeNull();
    const dup = makeSeason('s0', { names: { TB: 'Alpha' } });
    expect(resolveBaseTeam(dup, b)).toBeNull();
  });

  it('official standing is read per season & division; rank 0 is "not ranked"; seasons are never combined', () => {
    const view = officialOf(s2, s2.teams.find((t) => t.teamId === 'TA')!);
    expect(view.group?.title).toBe('A');
    expect(view.row?.rank).toBe(1);
    const old = makeSeason('s1', { ranks: { TA: 0, TB: 2, TC: 3, TD: 4, TE: 5, TF: 1 } });
    const team = aggregateTeams([s2, old]).find((t) => t.name === 'Alpha')!;
    const lines = officialPerSeason(team);
    expect(lines.map((l) => l.rank)).toEqual([1, null]);
    expect(Object.keys(lines[0])).not.toContain('total');
  });

  it('ranks only measured teams; an unmeasured team is "no data", not last', () => {
    const pop = buildTeamPopulation([s2], { kind: 'league' }, 's2');
    const r = rankTeams(pop.scoped.members, 'ppr');
    expect(r.ranked.map((e) => e.label)).toEqual(['Zeta', 'Alpha', 'Beta', 'Gamma', 'Delta', 'Epsilon']);
    expect(r.noData.map((e) => e.label)).toEqual(['NoStats']);
  });

  it('division scope is limited to the base season division; league scope spans divisions', () => {
    const div = buildTeamPopulation([s2], { kind: 'division', divisionIndex: 0 }, 's2');
    expect(div.scoped.members.map((t) => t.name).sort()).toEqual(['Alpha', 'Beta', 'Delta', 'Epsilon', 'Gamma']);
    expect(buildTeamPopulation([s2], { kind: 'league' }, 's2').scoped.members).toHaveLength(7);
  });

  it('a multi-season division scope flags members who played elsewhere in the period', () => {
    const moved = buildSeasonData(season({ ...{ tournament: tournament('s1', TEAMS.map((t) => (t.id === 'TB' ? { ...t, division: 1 } : t)), { title: 's1' }) }, teamStats: [teamRow('TB', simpleLine(900, 90, 1, 2), 1)] }));
    const pop = buildTeamPopulation([s2, moved], { kind: 'division', divisionIndex: 0 }, 's2');
    expect(pop.scoped.includesOtherDivisions).toBe(true);
  });

  it('team figures never include the players\' rows; involvement is a share of legs, not wins, and may exceed 100% in total', () => {
    const teams = aggregateTeams([s2]);
    const alpha = findTeamPeriod(teams, 's2', 'TA')!;
    expect(alpha.metrics.ppr.den).toBe(600); // the team row, not 600 + the players' 300 + 300
    const rows = teamPlayerRows(aggregatePlayers([s2]), 's2', 'TA', alpha);
    expect(rows.map((r) => r.person.name).sort()).toEqual(['佐藤', '橋本']);
    expect(rows.every((r) => r.involvement === 1)).toBe(true); // 30 of the team's 30 legs each
    expect(rows.reduce((sum, r) => sum + (r.involvement ?? 0), 0)).toBeGreaterThan(1);
  });

  it('trend: a season without a team stats row is a gap; renamed seasons are reported as unlinked', () => {
    const noStats = makeSeason('s1', { dropTeamStats: ['TA'] });
    const renamed = makeSeason('s0', { names: { TA: 'Old Alpha' } });
    const teams = aggregateTeams([s2, noStats, renamed]);
    const alpha = findTeamPeriod(teams, 's2', 'TA')!;
    expect(teamTrend(alpha, 'ppr').map((p) => p.value === null)).toEqual([true, false]); // s1 gap, s2 value
    expect(unlinkedSeasons(alpha, [s2, noStats, renamed]).map((s) => s.tournamentId)).toEqual(['s0']);
  });
});

// ---- component ---------------------------------------------------------------------------

function loadOf(seasons: SeasonData[]): PeriodLoad {
  return {
    request: { mode: 'current', currentTournamentId: seasons[0].tournamentId }, seasons, meta: [], failures: [], skipped: [], formatExcluded: [],
    complete: true, listError: null, offline: false, usedStaleCache: false, fetchedAt: { oldest: 0, newest: 0 }, requestsSent: 0,
  };
}
const team = (b = binding('s2', 'TA', 'Alpha')): Team => ({ id: 'team1', name: 'Alpha', createdAt: 0, n01: b }) as Team;

describe('TeamAnalytics screen', () => {
  it('shows the scorecard from the team row, with sample and rank, and says player rows are not added', () => {
    render(<TeamAnalytics team={team()} players={[]} load={loadOf([makeSeason('s2')])} baseTournamentId="s2" />);
    const card = screen.getByTestId('metric-3DA');
    expect(card.textContent).toContain('55.00');
    expect(card.textContent).toContain('600ダーツ');
    expect(card.textContent).toContain('基準充足');
    expect(screen.getByTestId('team-basis').textContent).toContain('加算していません');
    expect(screen.getByTestId('team-match').textContent).toBe('1勝0分1敗（2試合）');
  });

  it('keeps the official table and the own ranking apart, and refuses to rank divisions against each other', async () => {
    const user = userEvent.setup();
    render(<TeamAnalytics team={team()} players={[]} load={loadOf([makeSeason('s2')])} baseTournamentId="s2" />);
    const official = screen.getByTestId('official-table');
    expect(within(official).getAllByRole('row')).toHaveLength(6); // header + 5 teams of division A
    expect(screen.getByTestId('official-basis').textContent).toContain('この季・このディビジョンだけ');
    expect(screen.getByTestId('own-ranking-note').textContent).toContain('公式順位とは別物');
    expect(screen.queryByTestId('cross-division-note')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'リーグ全体' }));
    expect(screen.getByTestId('cross-division-note').textContent).toContain('優劣を示すものではありません');
  });

  it('an unmeasured team says so instead of showing zeros', () => {
    const s = makeSeason('s2', { dropTeamStats: ['TA'] });
    render(<TeamAnalytics team={team()} players={[]} load={loadOf([s])} baseTournamentId="s2" />);
    expect(screen.getByTestId('team-unmeasured').textContent).toContain('0 とは扱いません');
    expect(screen.queryByTestId('metric-3DA')).toBeNull();
  });

  it('a missing standings read is reported, not shown as an empty table', () => {
    const s = makeSeason('s2');
    const noStandings = { ...s, standings: [] };
    render(<TeamAnalytics team={team()} players={[]} load={loadOf([noStandings])} baseTournamentId="s2" />);
    expect(screen.getByTestId('official-missing')).toBeTruthy();
  });

  it('compares teams side by side', async () => {
    const user = userEvent.setup();
    render(<TeamAnalytics team={team()} players={[]} load={loadOf([makeSeason('s2')])} baseTournamentId="s2" />);
    await user.selectOptions(screen.getByLabelText(/比較するチームを追加/), screen.getByRole('option', { name: 'Beta' }));
    const table = screen.getByTestId('team-compare-table');
    expect(within(table).getByText('Beta')).toBeTruthy();
    expect(within(table).getAllByText('50.00').length).toBeGreaterThan(0);
  });

  it('cannot resolve the team in a season where the name changed', () => {
    const renamed = makeSeason('s1', { names: { TA: 'Old Alpha' } });
    render(<TeamAnalytics team={team()} players={[]} load={loadOf([renamed])} baseTournamentId="s1" />);
    expect(screen.getByTestId('team-unresolved').textContent).toContain('一意に特定できません');
  });
});

