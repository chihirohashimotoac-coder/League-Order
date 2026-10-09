import { describe, expect, it } from 'vitest';
import { rosterCoverage } from '../../domain/n01/identity';
import { N01Client } from './client';
import type { N01Request } from './endpoints';
import { fetchTeamData } from './sync';
import { buildIntelligenceSnapshot, fetchIntelligence } from './intelligence';
import { allFixtureDatasets, createFixtureTransport, FAIL, fixtureResponse } from '../../test/n01/transport';
import { FIXTURE_NOW } from '../../test/n01/leagues';
import {
  BEFORE,
  PREVIOUS,
  THEM,
  buildIntel,
  managedFormat,
  orderEntry,
  rosterPlayer,
  row,
  wholeRoster,
} from '../../test/n01/intelFixtures';

/**
 * Whole rosters decide whether an `opid` names one person (docs/N01_MASTER_DESIGN.md §3.4).
 *
 * A season's stats and a team's line-ups only show the people who played. The whole roster
 * (`team/player/list` without a team) also shows the ones who did not: the real ATDO 2026
 * 3rd has two rows named 西俣 太陽 under `02-0109` with a stats row for one of them. So the
 * snapshot reads each season's whole roster, once, before it lets an `opid` join seasons —
 * and when that roster could not be read, nothing in that season is *proven*: the `opid`
 * joins nothing there, the season's own `oid`s still match, and the person falls back to
 * what is certain (their own current numbers, low confidence).
 */

const OP = 'op_twin';
const NAME = '田中 太郎';

const ours = rosterPlayer(OP, 'cx', NAME);
const nowRow = row(OP, 'cx', NAME, 60);

describe('a previous season’s whole roster has two oids under one opid, stats for one', () => {
  const previousRoster = wholeRoster([rosterPlayer(OP, 'pA', NAME, 'T9'), rosterPlayer(OP, 'pB', NAME, 'T9')]);
  const previousStats = [row(OP, 'pB', NAME, 40, 1200, 'T9')];

  it('does not hand that row to the current player', () => {
    const intel = buildIntel({
      roster: [ours],
      stats: [nowRow],
      history: [{ id: PREVIOUS, title: '2026 2nd', seasonIndex: 1, stats: previousStats, roster: previousRoster }],
    });
    expect(intel.ourStats[0].seasons.map((line) => line.seasonIndex)).toEqual([0]);
  });

  it('guard: the same stats row IS followed when the roster shows one oid for the opid', () => {
    const intel = buildIntel({
      roster: [ours],
      stats: [nowRow],
      history: [
        { id: PREVIOUS, title: '2026 2nd', seasonIndex: 1, stats: previousStats, roster: wholeRoster([rosterPlayer(OP, 'pB', NAME, 'T9')]) },
      ],
    });
    expect(intel.ourStats[0].seasons.map((line) => line.seasonIndex)).toEqual([0, 1]);
  });
});

describe('the current season’s whole roster has a same-named oid on another team', () => {
  it('keeps the player apart from their namesake and from the opid’s history', () => {
    const intel = buildIntel({
      roster: [ours],
      stats: [nowRow],
      // The other team's 田中 太郎: same name, same opid, another oid. Our own roster shows only one.
      fullRoster: wholeRoster([ours, rosterPlayer(OP, 'cy', NAME, 'T7')]),
      history: [{ id: PREVIOUS, title: '2026 2nd', seasonIndex: 1, stats: [row(OP, 'pB', NAME, 40)] }],
    });
    const player = intel.ourStats[0];
    expect(player.key).not.toBe(OP);
    expect(player.seasons.map((line) => line.seasonIndex)).toEqual([0]);
    // The current season is still read by this player's own oid.
    expect(Math.round(((player.seasons[0].score * 3) / player.seasons[0].darts))).toBe(60);
  });
});

describe('a whole roster that could not be fetched proves nothing for that season', () => {
  const unique = [rosterPlayer('op_k', 'k1', NAME)];
  const uniqueNow = [row('op_k', 'k1', NAME, 60)];
  const uniquePast = [row('op_k', 'kOld', NAME, 44)];

  it('guard: with the roster, a unique opid joins the seasons', () => {
    const intel = buildIntel({
      roster: unique,
      stats: uniqueNow,
      history: [{ id: PREVIOUS, title: '2026 2nd', seasonIndex: 1, stats: uniquePast, roster: wholeRoster([rosterPlayer('op_k', 'kOld', NAME)]) }],
    });
    expect(intel.ourStats[0].key).toBe('op_k');
    expect(intel.ourStats[0].seasons.map((line) => line.seasonIndex)).toEqual([0, 1]);
  });

  it('a past season whose roster failed adds no line through the opid', () => {
    const intel = buildIntel({
      roster: unique,
      stats: uniqueNow,
      history: [{ id: PREVIOUS, title: '2026 2nd', seasonIndex: 1, stats: uniquePast, roster: null }],
    });
    expect(intel.ourStats[0].seasons.map((line) => line.seasonIndex)).toEqual([0]);
  });

  it('only the season that failed is cut off; the other past season still joins', () => {
    const intel = buildIntel({
      roster: unique,
      stats: uniqueNow,
      history: [
        { id: PREVIOUS, title: '2026 2nd', seasonIndex: 1, stats: uniquePast, roster: null },
        { id: BEFORE, title: '2026 1st', seasonIndex: 2, stats: [row('op_k', 'kOlder', NAME, 40)], roster: wholeRoster([rosterPlayer('op_k', 'kOlder', NAME)]) },
      ],
    });
    expect(intel.ourStats[0].seasons.map((line) => line.seasonIndex)).toEqual([0, 2]);
  });

  it('a current roster that failed proves nothing: the opid joins no season, the oid still finds this season', () => {
    const intel = buildIntel({
      roster: unique,
      stats: uniqueNow,
      fullRoster: null,
      history: [{ id: PREVIOUS, title: '2026 2nd', seasonIndex: 1, stats: uniquePast, roster: wholeRoster([rosterPlayer('op_k', 'kOld', NAME)]) }],
    });
    const player = intel.ourStats[0];
    expect(player.key).toBe('oid:t_cur:k1');
    expect(player.seasons.map((line) => line.seasonIndex)).toEqual([0]);
    expect(Math.round((player.seasons[0].score * 3) / player.seasons[0].darts)).toBe(60);
  });

  it('a past season whose roster failed does not credit the opponent’s past line-ups through the opid', () => {
    const seats = (roster: ReturnType<typeof rosterPlayer>[] | null): number => {
      const intel = buildIntel({
        roster: [rosterPlayer('op_me', 'me1', '自分')],
        stats: [row('op_me', 'me1', '自分', 50)],
        withOpponent: true,
        opponentRoster: [rosterPlayer('op_x', 'x1', '山田 次郎', THEM)],
        history: [
          {
            id: PREVIOUS,
            title: '2026 2nd',
            seasonIndex: 1,
            stats: [row('op_x', 'xOld', '山田 次郎', 70, 1200, THEM)],
            roster,
            opponentOrders: [
              orderEntry('pm1', 's1', [{ opid: 'op_x', oid: 'xOld', name: '山田 次郎' }]),
              orderEntry('pm2', 's1', [{ opid: 'op_x', oid: 'xOld', name: '山田 次郎' }]),
            ],
          },
        ],
      });
      const slot = intel.opponent!.positionModel.slots.find((entry) => entry.signature === 'SINGLES|01|1')!;
      return slot.players.reduce((total, player) => total + player.appearanceCount, 0);
    };
    expect(seats(wholeRoster([rosterPlayer('op_x', 'xOld', '山田 次郎', THEM)]))).toBeGreaterThan(0);
    expect(seats(null)).toBe(0);
  });
});

describe('a rename and a normal join are unaffected', () => {
  it('follows a unique opid across a rename when the roster shows one oid', () => {
    const intel = buildIntel({
      roster: [rosterPlayer('op_k', 'k1', '田中 太郎')],
      stats: [row('op_k', 'k1', '田中 太郎', 50)],
      history: [
        {
          id: PREVIOUS,
          title: '2026 2nd',
          seasonIndex: 1,
          stats: [row('op_k', 'old1', '田中 太朗', 44, 1200, THEM)],
          roster: wholeRoster([rosterPlayer('op_k', 'old1', '田中 太朗', THEM)]),
        },
        {
          id: BEFORE,
          title: '2026 1st',
          seasonIndex: 2,
          stats: [row('op_k', 'old2', '田中 太朗', 40)],
          roster: wholeRoster([rosterPlayer('op_k', 'old2', '田中 太朗')]),
        },
      ],
    });
    expect(intel.ourStats[0].key).toBe('op_k');
    expect(intel.ourStats[0].seasons.map((line) => line.seasonIndex)).toEqual([0, 1, 2]);
  });

  it('a renamed player is still apart from a namesake shown only by the whole roster', () => {
    const intel = buildIntel({
      roster: [rosterPlayer('op_k', 'k1', '田中 太郎')],
      stats: [row('op_k', 'k1', '田中 太郎', 50)],
      history: [
        {
          id: PREVIOUS,
          title: '2026 2nd',
          seasonIndex: 1,
          stats: [row('op_k', 'old1', '田中 太朗', 44)],
          // Same opid, another oid and ANOTHER spelling: still two people under one opid.
          roster: wholeRoster([rosterPlayer('op_k', 'old1', '田中 太朗'), rosterPlayer('op_k', 'old9', '田中 太郎')]),
        },
      ],
    });
    expect(intel.ourStats[0].seasons.map((line) => line.seasonIndex)).toEqual([0]);
  });
});

describe('fetching: each season’s whole roster is requested once', () => {
  const ATDO = 'lg_l3hI_3397';
  const CURRENT_ID = 't_ABvC_5234';

  async function run(options: Parameters<typeof createFixtureTransport>[0] = {}) {
    const log: N01Request[] = [];
    const client = new N01Client(createFixtureTransport({ ...options, log }), { now: () => FIXTURE_NOW });
    const data = await fetchTeamData(client, { leagueId: ATDO, leagueTitle: 'ATDO', tournamentId: CURRENT_ID, teamTpid: 'GpiQ' }, () => FIXTURE_NOW);
    log.length = 0;
    const fetched = await fetchIntelligence(client, data, { historyDepth: 2, now: () => FIXTURE_NOW });
    return { data, fetched, log };
  }

  const wholeRosterCalls = (log: readonly N01Request[]): string[] =>
    log.filter((request) => request.operation === 'team/player/list' && request.params.tpid === undefined).map((request) => request.params.tdid);

  it('one request per season: the current one and each referenced past one', async () => {
    const { fetched, log } = await run();
    const calls = wholeRosterCalls(log);
    expect(calls).toHaveLength(1 + fetched.history.length);
    expect(new Set(calls).size).toBe(calls.length);
    expect(calls).toContain(CURRENT_ID);
    for (const season of fetched.history) expect(calls).toContain(season.tournament.tournamentId);
    expect(fetched.rosters.current?.length).toBeGreaterThan(0);
    for (const season of fetched.history) expect(fetched.rosters.byTournament[season.tournament.tournamentId]?.length).toBeGreaterThan(0);
  });

  it('a failed whole roster is a note and a null, never a failed sync', async () => {
    const failing = new Set<string>();
    const first = await run();
    const pastId = first.fetched.history[0].tournament.tournamentId;
    failing.add(pastId);
    const { data, fetched } = await run({
      override: (request) =>
        request.operation === 'team/player/list' && request.params.tpid === undefined && failing.has(request.params.tdid) ? FAIL : undefined,
    });
    expect(fetched.rosters.byTournament[pastId]).toBeNull();
    expect(fetched.rosters.current).not.toBeNull();
    expect(fetched.history.map((season) => season.tournament.tournamentId)).toContain(pastId);
    expect(fetched.notes.some((note) => note.includes('名簿'))).toBe(true);
    const intel = buildIntelligenceSnapshot({ teamId: 'team_kv', data, format: managedFormat(), fetched, historyDepth: 2, now: FIXTURE_NOW });
    // The failed season contributes no line to anybody through an opid.
    const failedIndex = fetched.history.find((season) => season.tournament.tournamentId === pastId)!.seasonIndex;
    for (const entry of intel.ourStats) expect(entry.seasons.map((line) => line.seasonIndex)).not.toContain(failedIndex);
  });
});

// ---------------------------------------------------------------------------
// A response can be a well-formed list and still not be every team's.
// ---------------------------------------------------------------------------

describe('rosterCoverage', () => {
  const team = (teamId: string) => ({ teamId });

  it('is complete when every registered team has a row', () => {
    expect(rosterCoverage([team('A'), team('B'), team('C')], ['A', 'B', 'C'])).toEqual({ complete: true, missing: [], extra: [] });
  });

  it('is not complete when one registered team is missing, and says which', () => {
    expect(rosterCoverage([team('A'), team('B')], ['A', 'B', 'C'])).toEqual({ complete: false, missing: ['C'], extra: [] });
  });

  it('stays complete when the response also names unregistered teams', () => {
    expect(rosterCoverage([team('A'), team('B'), team('Z')], ['A', 'B'])).toEqual({ complete: true, missing: [], extra: ['Z'] });
  });

  it('cannot be proven for a tournament that lists no registered team', () => {
    expect(rosterCoverage([team('A')], []).complete).toBe(false);
  });
});

describe('a partial whole roster (3 registered teams, the response has 2) proves nothing for that season', () => {
  // T3 is registered but missing from the response. Its unplayed member would share the
  // opid with the player who has the stats row — which the response cannot show.
  const registered3 = { extraTeams: ['T3'] };
  const partial = (rows: ReturnType<typeof rosterPlayer>[]) => wholeRoster(rows); // US and THEM only
  const mine = rosterPlayer('op_k', 'k1', NAME);
  const nowRows = [row('op_k', 'k1', NAME, 60)];
  const past = (seasonIndex: number, id: string, oid: string, ppr: number) => ({
    id,
    title: `season ${seasonIndex}`,
    seasonIndex,
    stats: [row('op_k', oid, NAME, ppr, 1200, 'T3')],
    ...registered3,
  });

  it('a previous season’s partial response joins nobody through the opid', () => {
    const intel = buildIntel({
      roster: [mine],
      stats: nowRows,
      history: [{ ...past(1, PREVIOUS, 'kOld', 44), roster: partial([rosterPlayer('op_other', 'o1', '別人')]) }],
    });
    expect(intel.ourStats[0].seasons.map((line) => line.seasonIndex)).toEqual([0]);
  });

  it('the same season is used once the response names every registered team', () => {
    const intel = buildIntel({
      roster: [mine],
      stats: nowRows,
      history: [
        {
          ...past(1, PREVIOUS, 'kOld', 44),
          roster: wholeRoster([rosterPlayer('op_other', 'o1', '別人'), rosterPlayer('op_k', 'kOld', NAME, 'T3')], ['US', 'T1', 'T2', 'T3']),
        },
      ],
    });
    expect(intel.ourStats[0].seasons.map((line) => line.seasonIndex)).toEqual([0, 1]);
  });

  it('the current season’s partial response holds back every season, but this season still reads by oid', () => {
    const intel = buildIntel({
      roster: [mine],
      stats: nowRows,
      ...registered3,
      fullRoster: partial([mine]),
      history: [{ ...past(1, PREVIOUS, 'kOld', 44), roster: wholeRoster([rosterPlayer('op_k', 'kOld', NAME, 'T3')], ['T1', 'T2', 'T3']) }],
    });
    const player = intel.ourStats[0];
    expect(player.key).toBe('oid:t_cur:k1');
    expect(player.seasons.map((line) => line.seasonIndex)).toEqual([0]);
    expect(Math.round((player.seasons[0].score * 3) / player.seasons[0].darts)).toBe(60);
  });

  it('a partial previous season is held back alone; a verified earlier one still joins', () => {
    const intel = buildIntel({
      roster: [mine],
      stats: nowRows,
      history: [
        { ...past(1, PREVIOUS, 'kOld', 44), roster: partial([rosterPlayer('op_other', 'o1', '別人')]) },
        {
          ...past(2, BEFORE, 'kOlder', 40),
          roster: wholeRoster([rosterPlayer('op_k', 'kOlder', NAME, 'T3')], ['T1', 'T2', 'T3']),
        },
      ],
    });
    expect(intel.ourStats[0].seasons.map((line) => line.seasonIndex)).toEqual([0, 2]);
  });

  it('an opponent’s past line-ups are not credited through the opid in a partial season', () => {
    const seats = (roster: ReturnType<typeof rosterPlayer>[]): number => {
      const intel = buildIntel({
        roster: [rosterPlayer('op_me', 'me1', '自分')],
        stats: [row('op_me', 'me1', '自分', 50)],
        withOpponent: true,
        opponentRoster: [rosterPlayer('op_x', 'x1', '山田 次郎', THEM)],
        history: [
          {
            id: PREVIOUS,
            title: '2026 2nd',
            seasonIndex: 1,
            stats: [row('op_x', 'xOld', '山田 次郎', 70, 1200, THEM)],
            extraTeams: ['T3'],
            roster,
            opponentOrders: [
              orderEntry('pm1', 's1', [{ opid: 'op_x', oid: 'xOld', name: '山田 次郎' }]),
              orderEntry('pm2', 's1', [{ opid: 'op_x', oid: 'xOld', name: '山田 次郎' }]),
            ],
          },
        ],
      });
      const slot = intel.opponent!.positionModel.slots.find((entry) => entry.signature === 'SINGLES|01|1')!;
      return slot.players.reduce((total, player) => total + player.appearanceCount, 0);
    };
    expect(seats(wholeRoster([rosterPlayer('op_x', 'xOld', '山田 次郎', THEM)], ['T1', 'T2', 'T3']))).toBeGreaterThan(0);
    expect(seats(partial([rosterPlayer('op_x', 'xOld', '山田 次郎', THEM)]))).toBe(0);
  });

  it('guard: a response that also names an unregistered team is complete', () => {
    const intel = buildIntel({
      roster: [mine],
      stats: nowRows,
      history: [
        {
          id: PREVIOUS,
          title: '2026 2nd',
          seasonIndex: 1,
          stats: [row('op_k', 'kOld', NAME, 44)],
          roster: wholeRoster([rosterPlayer('op_k', 'kOld', NAME), rosterPlayer('op_z', 'z1', '登録外', 'T-unregistered')]),
        },
      ],
    });
    expect(intel.ourStats[0].seasons.map((line) => line.seasonIndex)).toEqual([0, 1]);
  });
});

describe('fetching: a partial whole roster is told, the sync goes on, each roster is still one request', () => {
  const ATDO = 'lg_l3hI_3397';
  const CURRENT_ID = 't_ABvC_5234';

  /** The real fixture response cut down to its first two teams: well-formed, not every team. */
  const firstTwoTeams = (request: N01Request): unknown => {
    const full = fixtureResponse(request, allFixtureDatasets()) as { list: { tpid: string }[] };
    const keep = new Set([...new Set(full.list.map((entry) => entry.tpid))].slice(0, 2));
    return { ...full, list: full.list.filter((entry) => keep.has(entry.tpid)) };
  };
  /** The real fixture response plus a team that is not registered, as the live API returns. */
  const withUnregisteredTeam = (request: N01Request): unknown => {
    const full = fixtureResponse(request, allFixtureDatasets()) as { list: unknown[] };
    return { ...full, list: [...full.list, { opid: 'zz-0001', oid: 'zzOid', tpid: 'NOT_REGISTERED', oname: '登録外 太郎' }] };
  };
  const isWholeRoster = (request: N01Request): boolean => request.operation === 'team/player/list' && request.params.tpid === undefined;

  async function run(override?: (request: N01Request) => unknown, depth = 2) {
    const log: N01Request[] = [];
    const client = new N01Client(createFixtureTransport({ log, override }), { now: () => FIXTURE_NOW });
    const data = await fetchTeamData(client, { leagueId: ATDO, leagueTitle: 'ATDO', tournamentId: CURRENT_ID, teamTpid: 'GpiQ' }, () => FIXTURE_NOW);
    log.length = 0;
    const fetched = await fetchIntelligence(client, data, { historyDepth: depth, now: () => FIXTURE_NOW });
    const intel = buildIntelligenceSnapshot({ teamId: 'team_kv', data, format: managedFormat(), fetched, historyDepth: depth, now: FIXTURE_NOW });
    return { data, fetched, intel, log };
  }
  const tamuraLines = (intel: Awaited<ReturnType<typeof run>>['intel']): number[] =>
    intel.opponent!.stats.find((entry) => entry.name === '田村 翔')!.seasons.map((line) => line.seasonIndex);

  it('baseline: with every team, 田村 is followed through all three seasons', async () => {
    const { intel } = await run();
    expect(tamuraLines(intel)).toEqual([0, 1, 2]);
  });

  it('guard: unregistered team ids in the response do not make it incomplete', async () => {
    const { intel, fetched } = await run((request) => (isWholeRoster(request) ? withUnregisteredTeam(request) : undefined));
    expect(tamuraLines(intel)).toEqual([0, 1, 2]);
    expect(fetched.notes.filter((note) => note.includes('不完全'))).toEqual([]);
  });

  it('a previous season that came back with two teams is noted and held back alone', async () => {
    const first = await run();
    const partialId = first.fetched.history[0].tournament.tournamentId;
    const { intel, fetched, log } = await run((request) => (isWholeRoster(request) && request.params.tdid === partialId ? firstTwoTeams(request) : undefined));
    expect(fetched.notes.some((note) => note.includes(fetched.history[0].summary.title) && note.includes('不完全'))).toBe(true);
    expect(tamuraLines(intel)).toEqual([0, 2]);
    // The partial response was not asked for again, and the sync went on to the next season.
    expect(log.filter((request) => isWholeRoster(request) && request.params.tdid === partialId)).toHaveLength(1);
    expect(fetched.history).toHaveLength(2);
  });

  it('a current season that came back with two teams holds every season back, and is noted', async () => {
    const { intel, fetched, log } = await run((request) => (isWholeRoster(request) && request.params.tdid === CURRENT_ID ? firstTwoTeams(request) : undefined));
    expect(fetched.notes.some((note) => note.includes('不完全'))).toBe(true);
    // No past season is reached through the opid. (This season's own line is read by oid in the
    // buildIntel test above; the generated fixture's stats rows carry no oid for people who
    // have an opid, so it is not asserted here.)
    expect(tamuraLines(intel).filter((index) => index > 0)).toEqual([]);
    expect(log.filter((request) => isWholeRoster(request) && request.params.tdid === CURRENT_ID)).toHaveLength(1);
  });

  it('a failed roster and a partial one both keep the sync going, one request per season', async () => {
    const first = await run();
    const [a, b] = first.fetched.history.map((season) => season.tournament.tournamentId);
    const { fetched, log } = await run((request) => {
      if (!isWholeRoster(request)) return undefined;
      if (request.params.tdid === a) return FAIL;
      if (request.params.tdid === b) return firstTwoTeams(request);
      return undefined;
    });
    expect(fetched.history).toHaveLength(2);
    expect(fetched.notes.filter((note) => note.includes('名簿'))).toHaveLength(2);
    const calls = log.filter(isWholeRoster).map((request) => request.params.tdid);
    expect(calls).toHaveLength(3);
    expect(new Set(calls).size).toBe(3);
  });
});
