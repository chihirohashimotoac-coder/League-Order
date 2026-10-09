import { describe, expect, it } from 'vitest';
import { aggregatePlayers, aggregateTeams, splitByFormat } from './aggregate';
import { AnalyticsApi, RequestBudgetError } from './api/readApi';
import type { AnalyticsTransport } from './api/readApi';
import { scopePlayers, scopeTeams } from './ranking';
import { buildSeasonData, teamKeys } from './seasonData';
import { line, playerRow, roster, season, simpleLine, teamRow, tournament } from './testFixtures';

const TEAMS_A = [
  { id: 'A1', name: 'Alpha', division: 0 },
  { id: 'A2', name: 'Beta', division: 0 },
  { id: 'A3', name: 'Gamma', division: 1 },
];

describe('buildSeasonData: population', () => {
  it('a registered team without a stats row is unmeasured (null), never a 0 line (TDO 71/70)', () => {
    const t = tournament('s1', TEAMS_A);
    const data = buildSeasonData(season({ tournament: t, teamStats: [teamRow('A1', simpleLine(900, 90, 1, 2)), teamRow('A2', simpleLine(600, 60, 1, 2))] }));
    expect(data.teams.find((x) => x.teamId === 'A3')!.line).toBeNull();
    expect(data.teams.find((x) => x.teamId === 'A1')!.line).not.toBeNull();
    const periods = aggregateTeams([data]);
    expect(periods.find((p) => p.name === 'Gamma')!.metrics.ppr.value).toBeNull();
  });

  it('drops stats rows of teams that are not registered and counts them', () => {
    const t = tournament('s1', TEAMS_A);
    const data = buildSeasonData(
      season({
        tournament: t,
        teamStats: [teamRow('A1', simpleLine(900, 90, 1, 2)), teamRow('ZZ', simpleLine(900, 90, 1, 2))],
        playerStats: [playerRow('p1', 'op1', 'ZZ', 'Ghost', simpleLine(100, 30, 1, 2))],
      }),
    );
    expect(data.teams.map((x) => x.teamId).sort()).toEqual(['A1', 'A2', 'A3']);
    expect(data.players).toHaveLength(0);
    expect(data.droppedUnregisteredRows).toBe(2);
  });

  it('the same oid on two teams is a conflict: held out, never summed', () => {
    const t = tournament('s1', TEAMS_A);
    const data = buildSeasonData(
      season({
        tournament: t,
        playerStats: [
          playerRow('p1', 'op1', 'A1', 'Dual', simpleLine(300, 30, 1, 2)),
          playerRow('p1', 'op1', 'A2', 'Dual', simpleLine(300, 30, 1, 2)),
          playerRow('p2', 'op2', 'A1', 'Solo', simpleLine(300, 30, 1, 2)),
        ],
      }),
    );
    expect(data.players.map((p) => p.oid)).toEqual(['p2']);
    expect(data.conflicts).toEqual([{ oid: 'p1', teamIds: ['A1', 'A2'] }]);
  });

  it('reconciles stats match/winMatch with the official standings', () => {
    const t = tournament('s1', TEAMS_A);
    const standingRow = (teamId: string, won: number) => ({ teamId, name: teamId, rank: 1, played: 2, won, drawn: 0, lost: 2 - won, points: 10 });
    const data = buildSeasonData(
      season({
        tournament: t,
        teamStats: [teamRow('A1', line({ match: 2, winMatch: 2 })), teamRow('A2', line({ match: 2, winMatch: 0 }))],
        standings: [{ divisionIndex: 0, title: 'A', rows: [standingRow('A1', 2), standingRow('A2', 1)] }],
      }),
    );
    expect(data.teams.find((x) => x.teamId === 'A1')!.matchReconciled).toBe(true);
    expect(data.teams.find((x) => x.teamId === 'A2')!.matchReconciled).toBe(false);
    const [a1] = aggregateTeams([data]).filter((p) => p.name === 'Alpha');
    expect(a1.match).toMatchObject({ played: 2, won: 2, winRate: 1, seasons: 1 });
    expect(aggregateTeams([data]).find((p) => p.name === 'Beta')!.match).toBeNull();
  });
});

describe('buildSeasonData: identity (PR #7 rules)', () => {
  const t = tournament('s1', TEAMS_A);
  const stat = (oid: string, opid: string | null, team: string, name: string) => playerRow(oid, opid, team, name, simpleLine(300, 30, 1, 2));

  it('a complete roster with a unique opid makes the player linkable across seasons', () => {
    const data = buildSeasonData(
      season({
        tournament: t,
        roster: roster([
          { oid: 'o1', opid: '02-0001', team: 'A1', name: 'Taro' },
          { oid: 'o2', opid: '02-0002', team: 'A2', name: 'Jiro' },
          { oid: 'o3', opid: '02-0003', team: 'A3', name: 'Saburo' },
        ]),
        playerStats: [stat('o1', '02-0001', 'A1', 'Taro')],
      }),
    );
    expect(data.players[0]).toMatchObject({ personKey: 'opid:02-0001', linkable: true });
    expect(data.coverage?.complete).toBe(true);
  });

  it('a roster missing a registered team proves nothing: no opid is trusted', () => {
    const data = buildSeasonData(
      season({
        tournament: t,
        roster: roster([{ oid: 'o1', opid: '02-0001', team: 'A1', name: 'Taro' }]),
        playerStats: [stat('o1', '02-0001', 'A1', 'Taro')],
      }),
    );
    expect(data.players[0]).toMatchObject({ personKey: 'oid:s1:o1', linkable: false });
    expect(data.coverage?.complete).toBe(false);
    expect(data.warnings.length).toBeGreaterThan(0);
  });

  it('no roster at all: nothing is linkable', () => {
    const data = buildSeasonData(season({ tournament: t, playerStats: [stat('o1', '02-0001', 'A1', 'Taro')] }));
    expect(data.players[0].linkable).toBe(false);
    expect(data.coverage).toBeNull();
  });

  it('extra, unregistered teams in the roster do not break completeness', () => {
    const data = buildSeasonData(
      season({
        tournament: t,
        roster: roster([
          { oid: 'o1', opid: '02-0001', team: 'A1', name: 'Taro' },
          { oid: 'o2', opid: '02-0002', team: 'A2', name: 'Jiro' },
          { oid: 'o3', opid: '02-0003', team: 'A3', name: 'Saburo' },
          { oid: 'o9', opid: '02-0009', team: 'ZZ', name: 'Extra' },
        ]),
        playerStats: [stat('o1', '02-0001', 'A1', 'Taro')],
      }),
    );
    expect(data.players[0].linkable).toBe(true);
  });

  it('one opid on two oids (same name) is shared: both stay season-local', () => {
    const data = buildSeasonData(
      season({
        tournament: t,
        roster: roster([
          { oid: 'alpp', opid: '02-0109', team: 'A1', name: '西俣 太陽' },
          { oid: 'gm3v', opid: '02-0109', team: 'A1', name: '西俣 太陽' },
          { oid: 'o2', opid: '02-0002', team: 'A2', name: 'Jiro' },
          { oid: 'o3', opid: '02-0003', team: 'A3', name: 'Saburo' },
        ]),
        playerStats: [stat('gm3v', '02-0109', 'A1', '西俣 太陽')],
      }),
    );
    expect(data.players[0]).toMatchObject({ personKey: 'oid:s1:gm3v', linkable: false });
  });

  it('a shared label (助っ人) and different names under one opid are never joined', () => {
    const data = buildSeasonData(
      season({
        tournament: t,
        roster: roster([
          { oid: 'o1', opid: '助っ人', team: 'A1', name: 'Guest1' },
          { oid: 'o2', opid: '02-0050', team: 'A2', name: 'Jiro' },
          { oid: 'o3', opid: '02-0050', team: 'A3', name: 'Someone Else' },
        ]),
        playerStats: [stat('o1', '助っ人', 'A1', 'Guest1'), stat('o2', '02-0050', 'A2', 'Jiro')],
      }),
    );
    expect(data.players.every((p) => !p.linkable)).toBe(true);
  });
});

describe('aggregatePlayers across seasons', () => {
  const rosterOf = (rows: [string, string, string, string][]) =>
    roster(rows.map(([oid, opid, team, name]) => ({ oid, opid, team, name })));
  const mk = (id: string, rosterRows: ReturnType<typeof roster>, stats: ReturnType<typeof playerRow>[]) =>
    buildSeasonData(season({ tournament: tournament(id, TEAMS_A), roster: rosterRows, playerStats: stats }));

  const newest = mk(
    's2',
    rosterOf([['a1', 'op-1', 'A1', '新 名前'], ['b1', 'op-2', 'A2', 'Jiro'], ['c1', 'op-3', 'A3', 'Saburo']]),
    [playerRow('a1', 'op-1', 'A1', '新 名前', simpleLine(3000, 300, 5, 10)), playerRow('b1', 'op-2', 'A2', 'Jiro', simpleLine(2700, 300, 5, 10))],
  );
  const older = mk(
    's1',
    rosterOf([['x1', 'op-1', 'A2', '旧 名前'], ['y1', 'op-2', 'A1', 'Jiro'], ['z1', 'op-3', 'A3', 'Saburo']]),
    [playerRow('x1', 'op-1', 'A2', '旧 名前', simpleLine(1800, 300, 2, 10)), playerRow('y1', 'op-2', 'A1', 'Jiro', simpleLine(2700, 300, 5, 10))],
  );

  it('joins a proven opid across seasons, follows a rename, pools by numerator/denominator', () => {
    const people = aggregatePlayers([newest, older]);
    const p = people.find((x) => x.personKey === 'opid:op-1')!;
    expect(p.linked).toBe(true);
    expect(p.name).toBe('新 名前');
    expect(p.seasons.map((s) => s.tournamentId)).toEqual(['s2', 's1']);
    expect(p.metrics.ppr.value).toBeCloseTo((3 * (3000 + 1800)) / 600, 10);
    expect(p.metrics.legRate).toMatchObject({ num: 7, den: 20 });
  });

  it('does not join a person whose opid is unproven in either season', () => {
    const weakOlder = buildSeasonData(season({ tournament: tournament('s1', TEAMS_A), playerStats: [playerRow('x1', 'op-1', 'A2', '旧 名前', simpleLine(1800, 300, 2, 10))] }));
    const people = aggregatePlayers([newest, weakOlder]);
    expect(people.filter((x) => x.name === '新 名前')[0].linked).toBe(false);
    expect(people.find((x) => x.personKey === 'oid:s1:x1')).toBeTruthy();
    expect(people.find((x) => x.personKey === 'opid:op-1')!.seasons).toHaveLength(1);
  });

  it('team scope uses the base season membership and division scope flags other-division seasons', () => {
    const people = aggregatePlayers([newest, older]);
    expect(scopePlayers(people, { kind: 'team', teamId: 'A1' }, 's2').members.map((p) => p.name)).toEqual(['新 名前']);
    const div = scopePlayers(people, { kind: 'division', divisionIndex: 0 }, 's2');
    expect(div.members.map((p) => p.personKey).sort()).toEqual(['opid:op-1', 'opid:op-2']);
    expect(div.includesOtherDivisions).toBe(false);
    expect(scopePlayers(people, { kind: 'league' }, 's1').members).toHaveLength(2);
  });
});

describe('splitByFormat / teams', () => {
  it('seasons with another format are excluded with a reason, not pooled', () => {
    const a = buildSeasonData(season({ tournament: tournament('s2', TEAMS_A) }));
    const b = buildSeasonData(season({ tournament: tournament('s1', TEAMS_A, { startScore: 701 }) }));
    const split = splitByFormat([a, b]);
    expect(split.compatible.map((s) => s.tournamentId)).toEqual(['s2']);
    expect(split.excluded[0]).toMatchObject({ tournamentId: 's1' });
  });

  it('links teams by a unique strict-normalised name; namesakes and renames stay apart until an alias', () => {
    const newT = buildSeasonData(season({ tournament: tournament('s2', [{ id: 'n1', name: 'ＡＬＰＨＡ' }, { id: 'n2', name: 'Dup' }, { id: 'n3', name: 'Dup' }, { id: 'n4', name: 'Renamed' }]) }));
    const oldT = buildSeasonData(season({ tournament: tournament('s1', [{ id: 'o1', name: 'alpha' }, { id: 'o2', name: 'Dup' }, { id: 'o4', name: 'Old Name' }]) }));
    const keys = teamKeys([newT, oldT]);
    expect(keys.get('s2:n1')).toBe(keys.get('s1:o1'));
    expect(keys.get('s2:n2')).not.toBe(keys.get('s1:o2'));
    expect(keys.get('s2:n4')).not.toBe(keys.get('s1:o4'));
    const aliased = teamKeys([newT, oldT], { 's1:o4': keys.get('s2:n4')! });
    expect(aliased.get('s1:o4')).toBe(aliased.get('s2:n4'));
  });

  it('team figures come from the team line only; the players\' rows are never added (no double count)', () => {
    const data = buildSeasonData(
      season({
        tournament: tournament('s1', TEAMS_A),
        teamStats: [teamRow('A1', simpleLine(900, 90, 1, 2))],
        playerStats: [playerRow('p1', 'op1', 'A1', 'P1', simpleLine(900, 90, 1, 2)), playerRow('p2', 'op2', 'A1', 'P2', simpleLine(900, 90, 1, 2))],
      }),
    );
    const team = aggregateTeams([data]).find((t) => t.name === 'Alpha')!;
    expect(team.metrics.ppr.den).toBe(90);
  });

  it('official standings stay per season: two seasons are listed, never summed into one rank', () => {
    const mkS = (id: string, rank: number) =>
      buildSeasonData(
        season({
          tournament: tournament(id, TEAMS_A),
          standings: [{ divisionIndex: 0, title: 'A', rows: [{ teamId: 'A1', name: 'Alpha', rank, played: 2, won: 1, drawn: 0, lost: 1, points: 9 }] }],
        }),
      );
    const alpha = aggregateTeams([mkS('s2', 1), mkS('s1', 3)]).find((t) => t.name === 'Alpha')!;
    expect(alpha.seasons.map((s) => s.official?.rank)).toEqual([1, 3]);
    expect(alpha).not.toHaveProperty('rank');
  });

  it('scopeTeams: division / league membership comes from the base season', () => {
    const data = buildSeasonData(season({ tournament: tournament('s1', TEAMS_A) }));
    const teams = aggregateTeams([data]);
    expect(scopeTeams(teams, { kind: 'division', divisionIndex: 0 }, 's1').members.map((t) => t.name).sort()).toEqual(['Alpha', 'Beta']);
    expect(scopeTeams(teams, { kind: 'league' }, 's1').members).toHaveLength(3);
  });
});

describe('AnalyticsApi', () => {
  const okTransport = (calls: string[]): AnalyticsTransport => ({
    async get(url) {
      calls.push(url);
      return { result: 0, stats: {} };
    },
  });

  it('sends anonymous GETs to the allow-listed host, and never the same request twice', async () => {
    const calls: string[] = [];
    const api = new AnalyticsApi({ transport: okTransport(calls) });
    await Promise.all([api.teamStats('t1'), api.teamStats('t1')]);
    await api.playerStats('t1');
    expect(calls).toHaveLength(2);
    expect(calls[0]).toBe('https://push.n01darts.com/api/v1/tournament/stats?kind=stats_list&tdid=t1');
    expect(api.requestCount).toBe(2);
  });

  it('refuses a host that is not allow-listed', () => {
    expect(() => new AnalyticsApi({ baseUrl: 'https://evil.example/api' })).toThrow();
  });

  it('stops at the request budget', async () => {
    const api = new AnalyticsApi({ transport: okTransport([]), maxRequests: 2 });
    await api.teamStats('a');
    await api.teamStats('b');
    await expect(api.teamStats('c')).rejects.toBeInstanceOf(RequestBudgetError);
  });

  it('a failed request is not memoised, so a retry really retries', async () => {
    let n = 0;
    const api = new AnalyticsApi({
      transport: {
        async get() {
          n += 1;
          if (n === 1) throw new Error('boom');
          return { result: 0, stats: {} };
        },
      },
    });
    await expect(api.teamStats('t')).rejects.toBeTruthy();
    await expect(api.teamStats('t')).resolves.toEqual([]);
    expect(n).toBe(2);
  });

  it('classifies a changed response shape as a schema error', async () => {
    const api = new AnalyticsApi({ transport: { get: async () => ({ result: 0, nothing: true }) } });
    await expect(api.teamStats('t')).rejects.toMatchObject({ kind: 'schema' });
  });
});
