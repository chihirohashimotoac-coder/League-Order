import { describe, expect, it, vi } from 'vitest';
import { MatchesApi, MatchBudgetError } from './api';
import type { AnalyticsOperation, AnalyticsTransport } from '../analytics/api/readApi';
import { N01Error } from '../../integrations/n01/client';
import { buildCards, cardScore } from './cards';
import { parseFixtures, parseGameDetail, parseGameRows, parseLive, parseSeasonDocument } from './parse';
import { checkReproduction, projectStandings } from './standings';
import { headToHead, linkOrder, percent, playerForms, teamProfile } from './insights';
import { LivePoller } from './livePoller';
import type { LiveStatus } from './livePoller';
import type { LiveState } from './parse';
import { TDID, c001Rows, fixtures, gameRow, list, liveBody, side, tournamentDoc } from './testFixtures';
import type { OfficialStandingGroup } from '../analytics/types';
import type { SavedOrder } from '../../domain/types';

const officialC001 = { '0_c001': { AAAA: { BBBB: { r: 3, a: 55.5 } }, BBBB: { AAAA: { r: 2, a: 50.1 } } } };

function season(results = officialC001) {
  return parseSeasonDocument(tournamentDoc(results), TDID);
}

describe('MATCH RESULTS: parsing and cards', () => {
  it('reads the season document: teams, divisions, slots, official card results, point rule', () => {
    const doc = season();
    expect(doc.teams.get('AAAA')).toBe('Arrows');
    expect(doc.divisions).toEqual([{ index: 0, title: 'A Division', teamIds: ['AAAA', 'BBBB', 'CCCC', 'DDDD'] }]);
    expect(doc.slots.map((slot) => slot.schid)).toEqual(['tm01', 'db01', 'db02', 'sg01', 'sg02']);
    expect(doc.results.get('0_c001')?.get('AAAA')).toEqual({ r: 3, avg: 55.5 });
    expect(doc.pointRule).toMatchObject({ win: 2, draw: 1, loss: 0, includeGames: true, includeLegs: false });
    expect(doc.url).toBe(`https://n01darts.com/n01/league/season.php?id=${TDID}`);
  });

  it('never takes a page link that is not n01’s', () => {
    const doc = parseSeasonDocument({ ...(tournamentDoc() as object), url: 'https://evil.example/x' }, TDID);
    expect(doc.url).toBeNull();
  });

  it('drops byes and unset slots from the fixtures', () => {
    expect(parseFixtures(fixtures()).map((f) => f.lsid)).toEqual(['c001', 'c002', 'c003', 'c004']);
  });

  it('keeps official, live, unrecorded and scheduled apart, and says whose score is shown', () => {
    const rows = [
      ...c001Rows(),
      // c003: one game finished, one being played.
      gameRow('c003', 'AAAA', 'CCCC', 'tm01', [side('AAAA', [['a1', 'A1']], 1, 1001, 60), side('CCCC', [['c1', 'C1']], 0, 900, 60)]),
      gameRow('c003', 'AAAA', 'CCCC', 'db01', [side('AAAA', [['a1', 'A1'], ['a2', 'A2']], 1, 400, 30), side('CCCC', [['c1', 'C1'], ['c2', 'C2']], 0, 300, 30)], { finished: false }),
      // c004: all played, no card result entered.
      ...['tm01', 'db01', 'db02', 'sg01', 'sg02'].map((schid) => gameRow('c004', 'BBBB', 'DDDD', schid, [side('BBBB', [['b1', 'B1']], 2, 900, 45), side('DDDD', [['d1', 'D1']], 0, 600, 45)])),
    ];
    const games = parseGameRows(list(rows)).games;
    const cards = buildCards(season(), parseFixtures(fixtures()), games);
    const byKey = new Map(cards.map((card) => [card.lsid, card]));
    expect(byKey.get('c001')).toMatchObject({ state: 'official', official: [3, 2], counted: [3, 2] });
    expect(cardScore(byKey.get('c001')!)).toEqual({ score: [3, 2], source: 'official' });
    expect(byKey.get('c003')?.state).toBe('live');
    expect(byKey.get('c004')?.state).toBe('unrecorded');
    expect(cardScore(byKey.get('c004')!)).toEqual({ score: [5, 0], source: 'counted' });
    expect(byKey.get('c002')?.state).toBe('scheduled');
    expect(cardScore(byKey.get('c002')!)).toBeNull();
    // The team game was stored with BBBB on the left: it is still AAAA's win on the card.
    const team = byKey.get('c001')!.games[0];
    expect(team).toMatchObject({ winner: 0, legs: [1, 0], flip: true });
    expect(team.members[0]).toEqual(['A1', 'A2', 'A3', 'A4']);
    // Cricket shows MPR (marks / darts × 3), 01 the 3-dart average; a slot not played is not 0.
    expect(byKey.get('c001')!.games[2].rate).toEqual([5, 6]);
    expect(byKey.get('c001')!.games[3].rate[0]).toBeCloseTo(66.8, 1);
    expect(byKey.get('c003')!.games[3]).toMatchObject({ state: 'notPlayed', rate: [null, null], legs: [null, null] });
  });

  it('a row it cannot read is counted, never guessed', () => {
    const parsed = parseGameRows(list([{ mid: 'x', statsData: [{}] }, ...c001Rows()]));
    expect(parsed.unreadable).toBe(1);
    expect(parsed.games).toHaveLength(5);
  });

  it('reads 01 and Cricket legs: winner, darts, First 9, a bull-decided leg flagged', () => {
    const zeroOne = parseGameDetail({
      result: 0,
      match: {
        mid: 'm1',
        match_type: '01',
        startScore: 501,
        endMatch: 1,
        legData: [
          {
            first: 0,
            endFlag: 1,
            winner: 0,
            playerData: [
              [{ score: 0, left: 501 }, { score: 180, left: 321 }, { score: 180, left: 141 }, { score: 81, left: 60 }, { score: -2, left: 0 }],
              [{ score: 0, left: 501 }, { score: 60, left: 441 }, { score: 45, left: 396 }, { score: 100, left: 296 }],
            ],
          },
          { first: 1, endFlag: 1, winner: 1, middleForDiddle: 1, playerData: [[{ score: 0, left: 501 }], [{ score: 0, left: 501 }]] },
        ],
      },
    });
    expect(zeroOne.legs[0]).toMatchObject({ winner: 0, darts: [11, 9], scored: [501, 205], left: [0, 296], first9: [441, 205] });
    expect(zeroOne.legs[1].bull).toBe(true);
    const cricket = parseGameDetail({
      result: 0,
      match: { mid: 'm2', match_type: 'cricket', endMatch: 1, legData: [{ first: 0, endFlag: 1, winner: 1, turns: [{ p: 0, r: 1, h: [[0, 3]] }, { p: 1, r: 1, h: [[0, 1], [1, 2]] }, { p: 0, r: 2, h: [] }] }] },
    });
    expect(cricket.legs[0]).toMatchObject({ winner: 1, scored: [3, 3], darts: [6, 3] });
  });
});

describe('standings what-if', () => {
  const group = (points: [number, number]): OfficialStandingGroup => ({
    divisionIndex: 0,
    title: 'A Division',
    rows: [
      { teamId: 'AAAA', name: 'Arrows', rank: 1, played: 1, won: 1, drawn: 0, lost: 0, points: points[0] },
      { teamId: 'BBBB', name: 'Bulls', rank: 2, played: 1, won: 0, drawn: 0, lost: 1, points: points[1] },
      { teamId: 'CCCC', name: 'Corks', rank: 0, played: 0, won: 0, drawn: 0, lost: 0, points: 0 },
      { teamId: 'DDDD', name: 'Doubles', rank: 0, played: 0, won: 0, drawn: 0, lost: 0, points: 0 },
    ],
  });
  const cards = buildCards(season(), parseFixtures(fixtures()), parseGameRows(list(c001Rows())).games);

  it('is offered only when n01’s points are reproduced exactly (2×win + games won here: 5 and 2)', () => {
    expect(checkReproduction(season().pointRule, group([5, 2]), cards)).toEqual({ ok: true, reason: null, mismatches: [] });
    const off = checkReproduction(season().pointRule, group([6, 2]), cards);
    expect(off.ok).toBe(false);
    expect(off.mismatches).toEqual([{ teamId: 'AAAA', official: 6, computed: 5 }]);
  });

  it('is withheld when n01 adds anything the card results do not carry', () => {
    const manual = parseSeasonDocument(tournamentDoc(officialC001, { lg_pts: [{ tpid: 'AAAA', pt: 1 }] }), TDID);
    expect(checkReproduction(manual.pointRule, group([5, 2]), cards).reason).toMatch(/手動/);
  });

  it('projects a hypothetical result and shows ties as ties', () => {
    const c003 = cards.find((card) => card.lsid === 'c003')!;
    const rows = projectStandings(season().pointRule, group([5, 2]), c003, [0, 5]);
    // AAAA loses 0-5: +0 → 5; CCCC wins: 2 + 5 = 7.
    expect(rows.map((row) => [row.teamId, row.projectedPoints, row.projectedPosition, row.tied])).toEqual([
      ['CCCC', 7, 1, false],
      ['AAAA', 5, 2, false],
      ['BBBB', 2, 3, false],
      ['DDDD', 0, 4, false],
    ]);
    const tie = projectStandings(season().pointRule, group([5, 2]), c003, [0, 3]);
    expect(tie.filter((row) => row.tied).map((row) => row.teamId).sort()).toEqual(['AAAA', 'CCCC']);
  });
});

describe('MATCH INTELLIGENCE', () => {
  const doc = season();
  const cards = buildCards(doc, parseFixtures(fixtures()), parseGameRows(list(c001Rows())).games);
  const games = parseGameRows(list(c001Rows())).games;
  const c001 = cards.find((card) => card.lsid === 'c001')!;

  function order(overrides: Partial<SavedOrder['input']> = {}, opponentName = 'Bulls', matchId = 'c001'): SavedOrder {
    const ids = ['tm01', 'db01', 'db02', 'sg01', 'sg02'].map((schid) => `n01g_${TDID}_${schid}`);
    return {
      id: 'o1',
      teamId: 't',
      title: '第1戦',
      createdAt: 0,
      updatedAt: 0,
      versions: [],
      seasonApplied: false,
      input: {
        games: ids.map((id, index) => ({ id, order: index + 1, name: id, kinds: ['SINGLES'], playerCount: 1 })),
        opponent: { matchId, opponentName } as never,
        ...overrides,
      } as never,
      solution: {
        assignments: [],
        prediction: { win: 0.6, games: ids.map((gameId, index) => ({ gameId, probability: index === 4 ? 0.8 : 0.5 })) },
      } as never,
    };
  }

  it('links an order only to the very card it was made for, and flags a surprise', () => {
    const link = linkOrder(order(), c001)!;
    expect(link.ourSide).toBe(0);
    expect(link.actual).toBe('W');
    expect(link.games.map((game) => game.actual)).toEqual(['W', 'W', 'L', 'W', 'L']);
    // sg02 was estimated at 80% and lost.
    expect(link.games[4]).toMatchObject({ surprise: true, predicted: 0.8 });
    expect(link.hints).toHaveLength(1);
    expect(linkOrder(order({}, 'Bulls', 'c003'), c001)).toBeNull();
    expect(linkOrder(order({}, 'Someone else'), c001)).toBeNull();
    expect(linkOrder(order({ games: [{ id: 'g_manual', order: 1, name: 'x', kinds: ['SINGLES'], playerCount: 1 }] } as never), c001)).toBeNull();
  });

  it('player form: per member id, singles averages only from singles, small samples marked', () => {
    const forms = playerForms(doc, games, 'AAAA');
    const a1 = forms.find((form) => form.oid === 'a1')!;
    expect(a1.byStructure).toEqual({ TEAM: { games: 1, wins: 1 }, DOUBLES: { games: 1, wins: 1 }, SINGLES: { games: 1, wins: 1 } });
    expect(a1.singles01.games).toBe(1);
    expect(a1.singles01.recent).toBeNull();
    expect(percent(a1.byStructure.SINGLES)).toBe('100% (参考 1試合)');
    // A doubles average is never credited to one player.
    const a3 = forms.find((form) => form.oid === 'a3')!;
    expect(a3.singles01.games).toBe(0);
    expect(a3.singlesCricket.games).toBe(0);
  });

  it('team profile and head-to-head (by id in this season, by exact name elsewhere)', () => {
    expect(teamProfile(doc, cards, games, 'AAAA').cards).toEqual({ w: 1, d: 0, l: 0 });
    const old = parseSeasonDocument(
      { ...(tournamentDoc({ '0_x9': { ZZ01: { ZZ02: { r: 1 } }, ZZ02: { ZZ01: { r: 4 } } } }) as { tournament: object }), tournament: { ...(tournamentDoc() as { tournament: object }).tournament, tdid: 't_old', title: 'Old', entry_list: [{ tpid: 'ZZ01', name: 'Arrows' }, { tpid: 'ZZ02', name: 'Bulls' }], lg_result: { '0_x9': { ZZ01: { ZZ02: { r: 1 } }, ZZ02: { ZZ01: { r: 4 } } } } } },
      't_old',
    );
    const rows = headToHead([doc, old], { tournamentId: TDID, ourId: 'AAAA', theirId: 'BBBB', ourName: 'Arrows', theirName: 'Bulls' });
    expect(rows).toEqual([
      { tournamentId: TDID, seasonTitle: 'Test League 1st', ours: 3, theirs: 2, matchedBy: 'id' },
      { tournamentId: 't_old', seasonTitle: 'Old', ours: 1, theirs: 4, matchedBy: 'name' },
    ]);
  });
});

describe('LIVE MATCH: parsing', () => {
  it('reads the scoreboard: card games, legs, left, next thrower, throws with members', () => {
    const state = parseLive(liveBody()) as LiveState;
    expect(state).toMatchObject({ changed: true, isSchedule: true, sets: [2, 1], legs: [1, 0], startScore: 501, gameEnded: false, cardEnded: false });
    expect(state.leg).toMatchObject({ left: [321, 401], thrower: 1, member: 'C1', round: 3 });
    expect(state.leg?.throws[3]).toMatchObject({ kind: '01', side: 0, score: 80, left: 321, member: 'A1' });
    expect(state.sides[0]).toMatchObject({ name: 'Arrows', members: ['A1'], rate: 60.1 });
  });

  it('reads Cricket marks and points, and an unchanged reply as unchanged', () => {
    const state = parseLive(
      liveBody({
        match_type: 'cricket',
        stats: [{ mpr: 2.1 }, { mpr: 1.5 }],
        leg: { leg: 0, first: 0, end: 0, thrower: 0, numbers: [20, 19, 18, 17, 16, 15, 25], marks: [[3, 1, 0, 0, 0, 0, 0], [2, 0, 0, 0, 0, 0, 0]], score: [40, 0], throws: [{ p: 0, r: 1, darts: [{ number: 20, mark: 3 }], marks: 3, points: 0, score: [0, 0] }] },
      }),
    ) as LiveState;
    expect(state.leg).toMatchObject({ points: [40, 0], numbers: [20, 19, 18, 17, 16, 15, 25] });
    expect(state.leg?.marks?.[0][0]).toBe(3);
    expect(state.sides[0].rate).toBe(2.1);
    expect(parseLive({ result: 0, changed: 0, mid: 'x', updateTime: 5 })).toEqual({ changed: false, mid: 'x', updateTime: 5 });
  });
});

/** A manual clock + timer queue, so polling is tested step by step. */
function harness(replies: (since: number | null, target: unknown) => Promise<unknown>) {
  let now = 1_800_000_011_000;
  const timers: { at: number; fn: () => void; id: number }[] = [];
  let id = 0;
  const calls: (number | null)[] = [];
  const states: LiveState[] = [];
  const statuses: LiveStatus[] = [];
  const source = {
    live: async (target: { tmid: string } | { mid: string }, since: number | null) => {
      calls.push(since);
      return parseLive(await replies(since, target));
    },
  };
  const poller = new LivePoller(source, { tmid: 'x' }, {
    intervalMs: 1500,
    maxRequests: 20,
    now: () => now,
    setTimer: (fn, ms) => {
      id += 1;
      timers.push({ at: now + ms, fn, id });
      return id;
    },
    clearTimer: (handle) => {
      const index = timers.findIndex((timer) => timer.id === handle);
      if (index >= 0) timers.splice(index, 1);
    },
    onState: (state) => states.push(state),
    onStatus: (status) => statuses.push(status),
  });
  const step = async (): Promise<void> => {
    timers.sort((a, b) => a.at - b.at);
    const next = timers.shift();
    if (!next) return;
    now = Math.max(now, next.at);
    next.fn();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
  };
  return { poller, step, calls, states, statuses, timers, advance: (ms: number) => (now += ms) };
}

describe('LIVE MATCH: polling', () => {
  it('uses since, applies only newer states, follows the next game, and stops when the card ends', async () => {
    let n = 0;
    const h = harness(async () => {
      n += 1;
      if (n === 1) return liveBody();
      if (n === 2) return { result: 0, changed: 0, mid: 'c003_sg01', updateTime: 1_800_000_010_000 };
      if (n === 3) return liveBody({ updateTime: 1_800_000_009_000, legs: [9, 9] }); // older: stale
      if (n === 4) return liveBody({ mid: 'c003_sg02', updateTime: 1_800_000_020_000, sets: [3, 1], legs: [0, 0] });
      return liveBody({ mid: 'c003_sg02', updateTime: 1_800_000_030_000, end_match: 1, end_schedule: 1, sets: [4, 1] });
    });
    h.poller.start();
    for (let i = 0; i < 5; i += 1) await h.step();
    expect(h.calls).toEqual([null, 1_800_000_010_000, 1_800_000_010_000, 1_800_000_010_000, 1_800_000_020_000]);
    expect(h.states.map((s) => s.mid)).toEqual(['c003_sg01', 'c003_sg02', 'c003_sg02']);
    expect(h.states.some((s) => s.legs[0] === 9)).toBe(false);
    expect(h.statuses.at(-1)).toEqual({ kind: 'finished' });
    expect(h.timers).toHaveLength(0);
  });

  it('a corrected throw replaces the leg (the whole leg is re-read)', async () => {
    let n = 0;
    const h = harness(async () => {
      n += 1;
      if (n === 1) return liveBody();
      const corrected = liveBody({ updateTime: 1_800_000_012_000 });
      (corrected.leg as { left: number[]; throws: { score: number; left: number }[] }).left = [341, 401];
      (corrected.leg as { throws: { score: number; left: number }[] }).throws[3] = { ...(corrected.leg as { throws: object[] }).throws[3], score: 60, left: 341 } as never;
      return corrected;
    });
    h.poller.start();
    await h.step();
    await h.step();
    expect(h.states.at(-1)?.leg?.left).toEqual([341, 401]);
    expect(h.states.at(-1)?.leg?.throws[3]).toMatchObject({ score: 60, left: 341 });
  });

  it('pauses while hidden, backs off on failure, waits 60 s on HTTP 429, and stops at its budget', async () => {
    let n = 0;
    const h = harness(async () => {
      n += 1;
      if (n === 1) throw new N01Error('network', 'down');
      if (n === 2) throw new N01Error('http', 'busy', 'match/live', 429);
      return liveBody({ updateTime: 1_800_000_010_000 + n });
    });
    h.poller.start();
    await h.step();
    expect(h.statuses.at(-1)).toMatchObject({ kind: 'retrying', attempt: 1, retryInMs: 3000 });
    await h.step();
    expect(h.statuses.at(-1)).toMatchObject({ kind: 'retrying', retryInMs: 60_000 });
    h.poller.setHidden(true);
    expect(h.timers).toHaveLength(0);
    expect(h.statuses.at(-1)).toEqual({ kind: 'paused-hidden' });
    h.poller.setHidden(false);
    for (let i = 0; i < 40; i += 1) await h.step();
    // Never more than the budget, never two requests at once.
    expect(h.calls.length).toBe(20);
    expect(h.statuses.at(-1)).toEqual({ kind: 'budget', requests: 20 });
  });
});

describe('the read adapter', () => {
  function fake(handler: (operation: AnalyticsOperation, params: Record<string, string>) => unknown) {
    const calls: { operation: AnalyticsOperation; params: Record<string, string> }[] = [];
    const transport: AnalyticsTransport = {
      request: vi.fn(async (operation: AnalyticsOperation, params: Record<string, string>) => {
        calls.push({ operation, params });
        return handler(operation, params);
      }),
    };
    return { transport, calls };
  }

  it('memoises season reads, never live ones, and shares one live request in flight', async () => {
    const { transport, calls } = fake((operation) => (operation === 'match/live' ? liveBody() : tournamentDoc()));
    const api = new MatchesApi({ transport });
    await Promise.all([api.season(TDID), api.season(TDID)]);
    await Promise.all([api.live({ tmid: 'x' }, null), api.live({ tmid: 'x' }, null)]);
    await api.live({ tmid: 'x' }, null);
    expect(calls.map((c) => c.operation)).toEqual(['tournament/get', 'match/live', 'match/live']);
  });

  it('reads every page of a season, and stops at its request budget', async () => {
    const page = Array.from({ length: 100 }, () => c001Rows()[0]);
    const { transport, calls } = fake((_, params) => list(params.skip === '100' ? c001Rows() : page));
    const api = new MatchesApi({ transport });
    const result = await api.seasonGames(TDID);
    expect(result.games).toHaveLength(105);
    expect(calls.map((c) => c.params.skip ?? '0')).toEqual(['0', '100']);
    expect(calls[0].params).toMatchObject({ tmid__regex: '_lg_', sort: 'startTime', order: 'asc' });
    const capped = new MatchesApi({ transport, maxRequests: 1 });
    await capped.season(TDID).catch(() => undefined);
    await expect(capped.fixtures(TDID)).rejects.toBeInstanceOf(MatchBudgetError);
  });

  it('refuses a host that is not n01', () => {
    expect(() => new MatchesApi({ baseUrl: 'https://example.com/api/v1' })).toThrow(N01Error);
  });
});
