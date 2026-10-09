import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { aggregatePlayers } from './aggregate';
import { buildInsights, buildPopulation, findPerson, rankIn, trendOf } from './playerView';
import { buildSeasonData } from './seasonData';
import type { SeasonData } from './seasonData';
import type { PeriodLoad } from './service/periodService';
import { line, playerRow, roster, season, simpleLine, tournament } from './testFixtures';
import { PlayerAnalytics } from './ui/PlayerAnalytics';
import type { Player, Team } from '../../domain/types';

afterEach(cleanup);

const TEAMS = [
  { id: 'TA', name: 'Alpha', division: 0 },
  { id: 'TB', name: 'Beta', division: 0 },
  { id: 'TC', name: 'Gamma', division: 1 },
];

interface Spec {
  oid: string;
  opid: string | null;
  team: string;
  name: string;
  ppr: number; // 3DA
  legs: number;
  wins: number;
  darts?: number;
}

function makeSeason(id: string, specs: Spec[], title = id): SeasonData {
  const t = tournament(id, TEAMS, { title });
  return buildSeasonData(
    season({
      tournament: t,
      roster: roster(specs.map((s) => ({ oid: s.oid, opid: s.opid, team: s.team, name: s.name }))),
      playerStats: specs.map((s) => {
        const darts = s.darts ?? 300;
        return playerRow(s.oid, s.opid, s.team, s.name, simpleLine((s.ppr * darts) / 3, darts, s.wins, s.legs, { highOut: 90, bestLeg: 20, match: 3 }));
      }),
    }),
  );
}

const SPECS: Spec[] = [
  { oid: 'o1', opid: 'op1', team: 'TA', name: '橋本', ppr: 60, legs: 30, wins: 9 }, // strong 3DA, weak legs
  { oid: 'o2', opid: 'op2', team: 'TA', name: '佐藤', ppr: 50, legs: 30, wins: 15 },
  { oid: 'o3', opid: 'op3', team: 'TA', name: '鈴木', ppr: 48, legs: 30, wins: 16 },
  { oid: 'o4', opid: 'op4', team: 'TB', name: '田中', ppr: 52, legs: 30, wins: 14 },
  { oid: 'o5', opid: 'op5', team: 'TB', name: '高橋', ppr: 47, legs: 30, wins: 17 },
  { oid: 'o6', opid: 'op6', team: 'TB', name: '伊藤', ppr: 49, legs: 30, wins: 15 },
  { oid: 'o7', opid: 'op7', team: 'TC', name: '渡辺', ppr: 55, legs: 30, wins: 12 },
  { oid: 'o8', opid: 'op8', team: 'TB', name: '少数', ppr: 70, legs: 4, wins: 4, darts: 30 }, // tiny sample
];

describe('findPerson', () => {
  const s = makeSeason('s1', SPECS);
  it('matches by oid inside the season, by proven opid otherwise, and says why not', () => {
    expect(findPerson(s, { opid: null, currentOid: 'o2', lastSeenTournamentId: 's1' }).personKey).toBe('opid:op2');
    expect(findPerson(s, { opid: 'op3', currentOid: 'old', lastSeenTournamentId: 'other' }).personKey).toBe('opid:op3');
    expect(findPerson(s, { opid: 'nope', currentOid: null, lastSeenTournamentId: 'x' })).toMatchObject({ personKey: null });
    expect(findPerson(s, undefined).reason).toContain('連携していない');
  });

  it('refuses an opid that is shared in the season', () => {
    const shared = makeSeason('s1', [...SPECS.slice(0, 2), { oid: 'o9', opid: 'op1', team: 'TC', name: '別人', ppr: 40, legs: 30, wins: 10 }, SPECS[3], SPECS[6]]);
    const result = findPerson(shared, { opid: 'op1', currentOid: null, lastSeenTournamentId: 'x' });
    expect(result.personKey).toBeNull();
    expect(result.reason).toContain('共有');
  });
});

describe('insights', () => {
  const base = makeSeason('s1', SPECS);
  const population = buildPopulation([base], { kind: 'league' }, 's1');
  const rankings = (m: Parameters<typeof rankIn>[1]) => rankIn(population.scoped.members, m);
  const hashimoto = population.people.find((p) => p.name === '橋本')!;

  it('reports a clear 3DA strength and a Leg-rate improvement candidate, each with sample and population', () => {
    const insights = buildInsights(hashimoto, population, rankings);
    expect(insights.held).toBeNull();
    expect(insights.strengths.map((i) => i.metric)).toContain('ppr');
    expect(insights.improvements.map((i) => i.metric)).toContain('legRate');
    const ppr = insights.strengths.find((i) => i.metric === 'ppr')!;
    expect(ppr.sample).toBe(300);
    expect(ppr.population).toBe(7); // the 30-dart player is below the sample threshold
    expect(ppr.rank).toBe(1);
    // A low win rate is never turned into a claim about finishing.
    expect(JSON.stringify(insights)).not.toMatch(/finish|フィニッシュ/i);
  });

  it('holds the verdict when the person\'s sample is too small', () => {
    const tiny = population.people.find((p) => p.name === '少数')!;
    const insights = buildInsights(tiny, population, rankings);
    expect(insights.strengths).toEqual([]);
    expect(insights.improvements).toEqual([]);
    expect(insights.held).toContain('保留');
  });

  it('holds the verdict when too few people can be compared', () => {
    const small = buildPopulation([makeSeason('s1', SPECS.slice(0, 3))], { kind: 'league' }, 's1');
    const me = small.people[0];
    const insights = buildInsights(me, small, (m) => rankIn(small.scoped.members, m));
    expect(insights.held).not.toBeNull();
  });
});

describe('trend', () => {
  it('a season without a usable denominator is a gap, not a 0', () => {
    const newer = makeSeason('s2', [SPECS[0], SPECS[1], SPECS[3], SPECS[6]]);
    const olderTournament = tournament('s1', TEAMS);
    const older = buildSeasonData(
      season({
        tournament: olderTournament,
        roster: roster([
          { oid: 'x1', opid: 'op1', team: 'TA', name: '橋本' },
          { oid: 'x2', opid: 'op2', team: 'TB', name: '佐藤' },
          { oid: 'x3', opid: 'op4', team: 'TC', name: '田中' },
        ]),
        playerStats: [playerRow('x1', 'op1', 'TA', '橋本', line({ score: 0, darts: 0, leg: 0, winLeg: 0 })), playerRow('x2', 'op2', 'TB', '佐藤', simpleLine(100, 30, 1, 2)), playerRow('x3', 'op4', 'TC', '田中', simpleLine(100, 30, 1, 2))],
      }),
    );
    const person = aggregatePlayers([newer, older]).find((p) => p.personKey === 'opid:op1')!;
    const trend = trendOf(person, 'ppr');
    expect(trend.map((p) => p.tournamentId)).toEqual(['s1', 's2']);
    expect(trend[0].value).toBeNull();
    expect(trend[1].value).toBeCloseTo(60, 6);
  });
});

// ---- component ---------------------------------------------------------------------------

function loadOf(seasons: SeasonData[]): PeriodLoad {
  return {
    request: { mode: 'current', currentTournamentId: seasons[0].tournamentId },
    seasons,
    meta: [],
    failures: [],
    skipped: [],
    formatExcluded: [],
    complete: true,
    listError: null,
    offline: false,
    usedStaleCache: false,
    fetchedAt: { oldest: 0, newest: 0 },
    requestsSent: 0,
  };
}

function team(): Team {
  return {
    id: 'team1',
    name: 'Alpha',
    createdAt: 0,
    n01: {
      provider: 'n01', leagueId: 'lg', leagueTitle: 'L', stableIdentity: { kind: 'name', value: 'alpha' }, lastTournamentId: 's1', lastTournamentTitle: 's1',
      lastTeamId: 'TA', lastTeamName: 'Alpha', lastDivisionIndex: 0, lastDivisionTitle: 'A', discipline: 'STEEL', managedFormatId: null, linkedAt: 0, lastSuccessfulSyncAt: 0,
    },
  } as Team;
}

function localPlayer(id: string, name: string, oid: string | null, opid: string | null): Player {
  return {
    id, name, teamId: 'team1', archived: false, n01: opid || oid ? { opid, currentOid: oid, currentTpid: 'TA', sourceName: name, rosterActive: true, lastSeenTournamentId: 's1', lastSeenAt: 0, stats: null } : undefined,
  } as unknown as Player;
}

describe('PlayerAnalytics screen', () => {
  const s1 = makeSeason('s1', SPECS);
  const players = [localPlayer('p1', '橋本', 'o1', 'op1'), localPlayer('p2', '佐藤', 'o2', 'op2'), localPlayer('p9', '連携なし', null, null)];

  it('lists the roster, explains who cannot be matched, and shows evidence for the selected player', () => {
    render(<PlayerAnalytics team={team()} players={players} load={loadOf([s1])} baseTournamentId="s1" />);
    const roster = screen.getByRole('list');
    expect(within(roster).getByText('橋本')).toBeTruthy();
    expect(within(roster).getByText(/連携していない/)).toBeTruthy();
    // Selected: the first matched player. 3DA is 60.00 with its sample.
    const card = screen.getByTestId('metric-3DA');
    expect(card.textContent).toContain('60.00');
    expect(card.textContent).toContain('300ダーツ');
    expect(card.textContent).toContain('基準充足');
    expect(screen.getByTestId('player-basis').textContent).toContain('勝利数ではありません');
    expect(screen.getByText('強みと改善候補')).toBeTruthy();
  });

  it('changing the population recalculates the ranking', async () => {
    const user = userEvent.setup();
    render(<PlayerAnalytics team={team()} players={players} load={loadOf([s1])} baseTournamentId="s1" />);
    const table = () => screen.getAllByRole('table')[0];
    expect(within(table()).getAllByRole('row').length).toBeLessThan(6); // team only: 3 people
    await user.click(screen.getByRole('button', { name: 'リーグ全体' }));
    expect(within(table()).getByText('渡辺')).toBeTruthy();
    // Below the sample threshold: listed only in the reference group, never ranked.
    const [ranked, reference] = Array.from(table().querySelectorAll('tbody'));
    expect(within(ranked as HTMLElement).queryByText('少数')).toBeNull();
    expect(within(reference as HTMLElement).getByText('少数')).toBeTruthy();
    expect(screen.getByText(/参考値/)).toBeTruthy();
  });

  it('compares players side by side and marks small samples as reference', async () => {
    const user = userEvent.setup();
    render(<PlayerAnalytics team={team()} players={players} load={loadOf([s1])} baseTournamentId="s1" />);
    await user.click(screen.getByRole('button', { name: 'リーグ全体' }));
    await user.selectOptions(screen.getByLabelText(/比較する選手を追加/), screen.getByRole('option', { name: '少数' }));
    const compare = screen.getByTestId('compare-table');
    expect(within(compare).getByText('少数')).toBeTruthy();
    expect(within(compare).getAllByText('参考').length).toBeGreaterThan(0);
  });

  it('shows no verdict as a fact when the base season is missing', () => {
    render(<PlayerAnalytics team={team()} players={players} load={loadOf([s1])} baseTournamentId="missing" />);
    expect(screen.getByText(/基準となるシーズンの成績を取得できませんでした/)).toBeTruthy();
  });
});
