import { describe, expect, it } from 'vitest';
import { MATCH_LIST_PAGE, N01Client, N01Error, teamMatchPattern } from './client';
import type { N01Request } from './endpoints';
import { fetchTeamData, planN01Sync } from './sync';
import { buildIntelligenceSnapshot, fetchIntelligence } from './intelligence';
import { parseMatchList } from './validation';
import { FAIL, createFixtureTransport, type FixtureTransportOptions } from '../../test/n01/transport';
import { FIXTURE_NOW, atdoSpec, fixtureLeagues } from '../../test/n01/leagues';
import { playedTeamMatches, replayMatch } from '../../test/n01/replay';
import { buildRoleStrengthContext } from '../../domain/n01/historyStrength';
import { jstDayStart } from '../../domain/n01/roleHistory';

/**
 * Role evidence from n01's per-game records (`match/list`, docs/THROW_ORDER_MODEL.md §4): read
 * per team and season, optional (a failure thins the evidence, never the sync), and never from
 * the match day or later.
 */

/** A row in the shape the live API returns (field names as n01 sends them; names invented). */
const LIVE_ROW = {
  mid: 'MSDtlCbU_1789039129409',
  tdid: 't_yyGi_9918',
  tmid: 't_yyGi_9918_lg_1_o59a_RcXE_X6iU',
  schid: '8kxb',
  match_type: '01',
  title: 'League 2nd Bディビジョン ダブルス1',
  startTime: 1789039129,
  endMatch: 1,
  statsData: [
    {
      name: 'チームA',
      tpid: 'RcXE',
      order: [
        { oid: 'dqdn', opid: '02-0088', oname: '選手 一' },
        { oid: 'pLoB', opid: '02-0160', oname: '選手 二' },
      ],
      me: 0,
      winSets: 2,
      winLegs: 2,
      allScore: 1487,
      allDarts: 119,
      allMarks: 0,
    },
    {
      name: 'チームB',
      tpid: 'X6iU',
      order: [
        { oid: 'oorp', opid: '02-0131', oname: '選手 三' },
        { oid: 'grog', opid: '02-0090', oname: '選手 四' },
      ],
      me: 0,
      winSets: 0,
      winLegs: 1,
      allScore: 1489,
      allDarts: 118,
      allMarks: 0,
    },
  ],
};

describe('match/list (per-game records)', () => {
  it('reads the live shape: both sides, their registered order and totals', () => {
    const [game] = parseMatchList({ result: 0, list: [LIVE_ROW] });
    expect(game).toEqual({
      gameId: 'MSDtlCbU_1789039129409',
      matchId: 't_yyGi_9918_lg_1_o59a_RcXE_X6iU',
      schid: '8kxb',
      matchType: '01',
      startTime: 1789039129,
      sides: [
        {
          teamId: 'RcXE',
          players: [
            { oid: 'dqdn', opid: '02-0088', name: '選手 一' },
            { oid: 'pLoB', opid: '02-0160', name: '選手 二' },
          ],
          legsWon: 2,
          score: 1487,
          darts: 119,
          marks: 0,
        },
        {
          teamId: 'X6iU',
          players: [
            { oid: 'oorp', opid: '02-0131', name: '選手 三' },
            { oid: 'grog', opid: '02-0090', name: '選手 四' },
          ],
          legsWon: 1,
          score: 1489,
          darts: 118,
          marks: 0,
        },
      ],
    });
  });

  it('a team with no games yet is an empty list; a missing list is a schema change', () => {
    expect(parseMatchList({ result: 0, list: [] })).toEqual([]);
    expect(() => parseMatchList({ result: 0 })).toThrow();
    // Rows that cannot be read are skipped, not guessed.
    expect(parseMatchList({ list: [LIVE_ROW, { mid: 'x', statsData: [LIVE_ROW.statsData[0]] }] })).toHaveLength(1);
  });

  it('filters by the team\'s own matches and asks for a second page only when the first is full', async () => {
    const log: N01Request[] = [];
    const page = (count: number) => ({ result: 0, list: Array.from({ length: count }, (_, i) => ({ ...LIVE_ROW, mid: `m${i}` })) });
    const client = new N01Client(
      createFixtureTransport({
        log,
        override: (request) => (request.operation === 'match/list' ? page(request.params.skip ? 5 : MATCH_LIST_PAGE) : undefined),
      }),
      { now: () => FIXTURE_NOW },
    );
    const games = await client.teamGames('t_x', 'X6iU');
    expect(games).toHaveLength(MATCH_LIST_PAGE + 5);
    expect(log.map((request) => request.params)).toEqual([
      { tdid: 't_x', tmid__regex: '_X6iU(_|$)', count: '100' },
      { tdid: 't_x', tmid__regex: '_X6iU(_|$)', count: '100', skip: '100' },
    ]);
    expect(new RegExp(teamMatchPattern('X6iU')).test('t_yyGi_9918_lg_1_o59a_RcXE_X6iU')).toBe(true);
    expect(new RegExp(teamMatchPattern('X6iU')).test('t_yyGi_9918_lg_1_o59a_RcXE_X6iUz')).toBe(false);
  });

  it('pages on the rows n01 sent, even when some could not be read; an unreadable later page keeps what was read', async () => {
    const log: N01Request[] = [];
    const unreadable = { mid: 'bad', statsData: [LIVE_ROW.statsData[0]] };
    // Page 1: full (100 rows), three of them unreadable. Page 2: full again, all unreadable.
    const firstPage = { result: 0, list: Array.from({ length: MATCH_LIST_PAGE }, (_, i) => (i < 3 ? { ...unreadable, mid: `bad${i}` } : { ...LIVE_ROW, mid: `m${i}` })) };
    const secondPage = { result: 0, list: Array.from({ length: MATCH_LIST_PAGE }, (_, i) => ({ ...unreadable, mid: `bad2_${i}` })) };
    const client = new N01Client(
      createFixtureTransport({
        log,
        override: (request) => (request.operation === 'match/list' ? (request.params.skip ? secondPage : firstPage) : undefined),
      }),
      { now: () => FIXTURE_NOW },
    );
    const games = await client.teamGames('t_x', 'X6iU');
    expect(log).toHaveLength(2);
    expect(games).toHaveLength(MATCH_LIST_PAGE - 3);
  });
});

async function snapshotWith(override?: FixtureTransportOptions['override']) {
  const client = new N01Client(createFixtureTransport({ override }), { now: () => FIXTURE_NOW });
  const data = await fetchTeamData(client, { leagueId: 'lg_l3hI_3397', leagueTitle: 'ATDO', tournamentId: 't_ABvC_5234', teamTpid: 'GpiQ' }, () => FIXTURE_NOW);
  let n = 0;
  const plan = planN01Sync({ team: { id: 'team_kv', name: 'kalavinka', createdAt: 0 }, localPlayers: [], existingFormat: null, data, now: FIXTURE_NOW, newId: (p) => `${p}_${++n}` });
  const fetched = await fetchIntelligence(client, data, { historyDepth: 2, now: () => FIXTURE_NOW });
  const snapshot = buildIntelligenceSnapshot({ teamId: 'team_kv', data, format: plan.format, fetched, historyDepth: 2, now: FIXTURE_NOW });
  return { fetched, snapshot, plan };
}

describe('role evidence in the intelligence snapshot', () => {
  it('reads our team\'s and the opponent\'s games and credits them to the people who played', async () => {
    const { fetched, snapshot, plan } = await snapshotWith();
    expect(fetched.roleGames!.map((entry) => `${entry.team}:${entry.seasonIndex}`).sort()).toEqual([
      'opponent:0',
      'opponent:1',
      'opponent:2',
      'ours:0',
      'ours:1',
      'ours:2',
    ]);
    expect(snapshot.roleHistory!.games).toBeGreaterThan(0);
    expect(snapshot.roleHistory!.failedSeasons).toBe(0);
    const context = buildRoleStrengthContext(plan.players, snapshot);
    expect(context.source).toBe('n01');
    const withEvidence = Object.keys(context.players);
    expect(withEvidence.length).toBeGreaterThan(0);
    for (const id of withEvidence) expect(plan.players.some((player) => player.id === id)).toBe(true);
    expect(Object.keys(snapshot.opponent!.roleEvidence!).length).toBeGreaterThan(0);
  });

  it('a failed game list thins the evidence but never fails the sync', async () => {
    const { fetched, snapshot, plan } = await snapshotWith((request) => (request.operation === 'match/list' ? FAIL : undefined));
    expect(fetched.roleGames).toEqual([]);
    expect(fetched.roleGameFailures).toBe(6);
    expect(fetched.notes.some((note) => note.includes('ゲーム別の成績'))).toBe(true);
    expect(snapshot.roleHistory).toMatchObject({ games: 0, failedSeasons: 6 });
    expect(buildRoleStrengthContext(plan.players, snapshot).players).toEqual({});
    // An abort is not swallowed.
    await expect(
      snapshotWith((request) => (request.operation === 'match/list' ? new N01Error('aborted', 'stop', request.operation) : undefined)),
    ).rejects.toThrow();
  });

  it('time-travel replay: the evidence holds only games before the match day', async () => {
    const leagues = fixtureLeagues();
    const target = playedTeamMatches(leagues.atdo.games, 't_ABvC_5234')[4];
    const replay = await replayMatch(atdoSpec(), leagues.atdo.games, target, 't_ABvC_5234');
    const history = replay.intel.roleHistory!;
    expect(history.before).toBe(target.date);
    expect(history.droppedFuture).toBe(0);
    const before = jstDayStart(target.date)!;
    // Every game the fixture played on or after the match day is unknown to the replay.
    const laterGames = leagues.atdo.games.filter((game) => game.tournamentId === 't_ABvC_5234' && game.date >= target.date);
    expect(laterGames.length).toBeGreaterThan(0);
    const seenGames = leagues.atdo.games.filter(
      (game) => game.tournamentId === 't_ABvC_5234' && (game.homeTpid === target.teamTpid || game.awayTpid === target.teamTpid) && game.date < target.date,
    );
    expect(seenGames.every((game) => Date.parse(`${game.date}T19:00:00+09:00`) / 1000 < before)).toBe(true);
    expect(replay.order.input.roleStrength?.before).toBe(target.date);
  });
});
