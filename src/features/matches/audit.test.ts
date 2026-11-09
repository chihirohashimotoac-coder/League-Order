import { describe, expect, it, vi } from 'vitest';
import { MatchesApi, MatchBudgetError, COMPETITION_PAGE_TTL_MS, MATCHES_POLL_PER_MINUTE } from './api';
import type { AnalyticsOperation, AnalyticsTransport } from '../analytics/api/readApi';
import { RequestGovernor } from './governor';
import { gameStats } from './gameStats';
import { isTeamEvent, parseGameRows, parseLive, parseThrows, parseSeasonDocument, withLiveLeg } from './parse';
import { parseCompetition } from './competition';
import type { LiveLeg, LiveThrow, ThrowLeg } from './parse';
import { playerForms, pooledRate } from './insights';
import { playerGames, playerThrowStats } from './playerCard';
import { freshLegChance, liveEstimateScope } from './checkout';
import { TDID, gameRow, list, liveBody, side, tournamentDoc } from './testFixtures';

/**
 * Regression tests of the technical audit of 2026-11-09 (docs/AUDIT_2026-11-09.md), one block
 * per finding. Those of F02, F04 and F07–F10 fail on main 53d04de (checked before the fix).
 */

/** A fake clock shared by the two governors: sleeping advances it. */
function clock(start = 1_800_000_000_000) {
  const state = { now: start };
  const now = (): number => state.now;
  const sleep = async (ms: number): Promise<void> => {
    state.now += ms;
  };
  return { state, now, sleep, governor: () => new RequestGovernor(150, now, sleep), poll: (perMinute = MATCHES_POLL_PER_MINUTE) => new RequestGovernor(perMinute, now, sleep) };
}

/**
 * A fake `match/list` honouring what n01 does with it: `tdid`, `live` / `endMatch`,
 * `startTime__gte`, `sort=startTime` (desc by default), `skip`, `count`.
 */
function listServer(rows: () => Record<string, unknown>[]) {
  const calls: Record<string, string>[] = [];
  const transport: AnalyticsTransport = {
    request: vi.fn(async (operation: AnalyticsOperation, params: Record<string, string>) => {
      if (operation !== 'match/list') throw new Error(`unexpected ${operation}`);
      calls.push(params);
      let all = rows().filter((row) => row.tdid === params.tdid);
      if (params.endMatch === '0') all = all.filter((row) => row.endMatch === 0);
      if (params.startTime__gte) all = all.filter((row) => (row.startTime as number) >= Number(params.startTime__gte));
      const dir = params.order === 'asc' ? 1 : -1;
      all = [...all].sort((a, b) => dir * ((a.startTime as number) - (b.startTime as number)));
      const skip = Number(params.skip ?? 0);
      return list(all.slice(skip, skip + Number(params.count ?? 100)));
    }),
  };
  return { transport, calls };
}

const finishedRow = (i: number, start: number, extra: { finished?: boolean; legs?: number } = {}): Record<string, unknown> =>
  gameRow(`c${i}`, 'AAAA', 'BBBB', 'sg01', [side('AAAA', [['a1', 'A1']], extra.legs ?? 2, 501, 45), side('BBBB', [['b1', 'B1']], 0, 400, 45)], { start, mid: `m${i}`, finished: extra.finished ?? true }) as Record<string, unknown>;

// ---------------------------------------------------------------------------
// F02 — a long evening: polling is rate-limited, not stopped by the visit's budget
// ---------------------------------------------------------------------------

describe('F02: the board keeps refreshing on a screen left open', () => {
  it('2,000 board reads on one instance all succeed; the one-off budget is untouched', async () => {
    const c = clock();
    const { transport } = listServer(() => [finishedRow(1, 1_800_000_000)]);
    const api = new MatchesApi({ transport, governor: c.governor(), pollGovernor: c.poll(), now: c.now });
    for (let i = 0; i < 2000; i += 1) {
      const board = await api.todayGames(TDID, 1_799_990_000);
      expect(board.games).toHaveLength(1);
      c.state.now += 5000; // the board's 5 s interval
    }
    expect(api.pollCount).toBe(2000);
    expect(api.requestCount).toBe(0);
  });

  it('the polling rate is capped per minute (waits for a slot instead of failing)', async () => {
    const c = clock();
    const { transport } = listServer(() => []);
    const api = new MatchesApi({ transport, governor: c.governor(), pollGovernor: c.poll(10), now: c.now });
    const started = c.now();
    for (let i = 0; i < 25; i += 1) await api.todayGames(TDID, 0);
    // 25 reads at 10 a minute need at least two full minutes of waiting.
    expect(c.now() - started).toBeGreaterThanOrEqual(120_000);
  });

  it('one-off reads still stop at the budget (a runaway loop), polling does not', async () => {
    const c = clock();
    const transport: AnalyticsTransport = { request: async (op) => (op === 'tournament/get' ? tournamentDoc() : list([])) };
    const api = new MatchesApi({ transport, maxRequests: 1, governor: c.governor(), pollGovernor: c.poll(), now: c.now });
    await api.season(TDID);
    await expect(api.fixtures(TDID)).rejects.toBeInstanceOf(MatchBudgetError);
    await expect(api.todayGames(TDID, 0)).resolves.toMatchObject({ games: [] });
  });

  it('HTTP 429 on a poll still pauses every screen (the app-wide governor)', async () => {
    const c = clock();
    const governor = c.governor();
    const { N01Error } = await import('../../integrations/n01/client');
    const transport: AnalyticsTransport = {
      request: async () => {
        throw new N01Error('http', 'too many', 'match/list', 429);
      },
    };
    const api = new MatchesApi({ transport, governor, pollGovernor: c.poll(), now: c.now });
    await expect(api.todayGames(TDID, 0)).rejects.toBeInstanceOf(N01Error);
    expect(governor.status().pausedUntil).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// F04 — more than 100 games
// ---------------------------------------------------------------------------

describe('F04: lists longer than a page', () => {
  it('today: 100 finished games and a newer one in progress → the one in progress is there', async () => {
    const rows = [...Array.from({ length: 100 }, (_, i) => finishedRow(i, 1_800_000_000 + i)), finishedRow(999, 1_800_009_999, { finished: false, legs: 0 })];
    const { transport, calls } = listServer(() => rows);
    const api = new MatchesApi({ transport, governor: clock().governor() });
    const board = await api.todayGames(TDID, 1_799_000_000);
    expect(board.games).toHaveLength(101);
    expect(board.games.some((game) => game.mid === 'm999' && !game.finished)).toBe(true);
    expect(board.truncated).toBe(false);
    expect(calls[0]).toMatchObject({ sort: 'startTime', order: 'desc' });
    // Oldest first for the board, whatever order n01 sent.
    expect(board.games[0].startTime).toBeLessThan(board.games[100].startTime!);
  });

  it.each([99, 100, 101, 200, 201])('today: %i games are all read, once each', async (n) => {
    const rows = Array.from({ length: n }, (_, i) => finishedRow(i, 1_800_000_000 + i));
    const { transport } = listServer(() => rows);
    const api = new MatchesApi({ transport, governor: clock().governor() });
    const board = await api.todayGames(TDID, 0);
    expect(board.games).toHaveLength(n);
    expect(new Set(board.games.map((game) => game.mid)).size).toBe(n);
  });

  it('today: a game added between two page reads is not lost and not doubled', async () => {
    let rows = Array.from({ length: 150 }, (_, i) => finishedRow(i, 1_800_000_000 + i));
    const { transport } = listServer(() => rows);
    const inner = transport.request;
    let calls = 0;
    transport.request = async (op, params, signal) => {
      calls += 1;
      // After the first page, a new game starts (it is newest: it pushes every row down by one).
      if (calls === 2) rows = [...rows, finishedRow(500, 1_800_001_000, { finished: false, legs: 0 })];
      return inner(op, params, signal);
    };
    const api = new MatchesApi({ transport, governor: clock().governor() });
    const board = await api.todayGames(TDID, 0);
    expect(board.games.filter((game) => game.mid === 'm149')).toHaveLength(1);
    expect(board.games).toHaveLength(150); // the new game appears on the next refresh
  });

  it('today: the page cap is reported, never passed off as the whole night', async () => {
    const rows = Array.from({ length: 600 }, (_, i) => finishedRow(i, 1_800_000_000 + i));
    const { transport } = listServer(() => rows);
    const api = new MatchesApi({ transport, governor: clock().governor() });
    const board = await api.todayGames(TDID, 0);
    expect(board.truncated).toBe(true);
    expect(board.games).toHaveLength(500);
    expect(board.games.some((game) => game.mid === 'm599')).toBe(true); // newest kept
  });

  it.each([99, 100, 101, 200, 201])('competition: %i games, then a change on the last one is read on the next refresh', async (n) => {
    const c = clock();
    let rows = Array.from({ length: n }, (_, i) => finishedRow(i, 1_800_000_000 + i, { finished: i !== n - 1, legs: i === n - 1 ? 0 : 2 }));
    const { transport } = listServer(() => rows);
    const api = new MatchesApi({ transport, governor: c.governor(), pollGovernor: c.poll(), now: c.now });
    const first = await api.competitionGames(TDID);
    expect(first.games).toHaveLength(n);
    expect(first.games.find((game) => game.mid === `m${n - 1}`)?.finished).toBe(false);
    rows = rows.map((row, i) => (i === n - 1 ? finishedRow(i, 1_800_000_000 + i) : row));
    c.state.now += 10_000;
    const second = await api.competitionGames(TDID);
    expect(second.games.find((game) => game.mid === `m${n - 1}`)?.finished).toBe(true);
  });

  it('competition: a new game appended after 101 is found; full finished pages are reused, then re-read after the TTL (a correction)', async () => {
    const c = clock();
    let rows = Array.from({ length: 201 }, (_, i) => finishedRow(i, 1_800_000_000 + i));
    const { transport, calls } = listServer(() => rows);
    const api = new MatchesApi({ transport, governor: c.governor(), pollGovernor: c.poll(), now: c.now });
    await api.competitionGames(TDID);
    expect(calls).toHaveLength(3);

    rows = [...rows, finishedRow(900, 1_800_009_000, { finished: false, legs: 0 })];
    c.state.now += 10_000;
    const second = await api.competitionGames(TDID);
    expect(second.games.some((game) => game.mid === 'm900')).toBe(true);
    // Pages 1 and 2 (full, all finished, fresh) came from the instance: only the last page was read.
    expect(calls.slice(3).map((call) => call.skip ?? '0')).toEqual(['200']);

    // A finished game of page 2 is corrected on n01 (the loser's legs).
    rows = rows.map((row, i) => (i === 150 ? finishedRow(150, 1_800_000_150, { legs: 3 }) : row));
    c.state.now += COMPETITION_PAGE_TTL_MS;
    const third = await api.competitionGames(TDID);
    expect(third.games.find((game) => game.mid === 'm150')?.sides[0].legsWon).toBe(3);
  });

  it('competition: a page with a game in progress is always read again', async () => {
    const c = clock();
    let rows = Array.from({ length: 150 }, (_, i) => finishedRow(i, 1_800_000_000 + i, { finished: i !== 20, legs: i === 20 ? 0 : 2 }));
    const { transport } = listServer(() => rows);
    const api = new MatchesApi({ transport, governor: c.governor(), pollGovernor: c.poll(), now: c.now });
    await api.competitionGames(TDID);
    rows = rows.map((row, i) => (i === 20 ? finishedRow(20, 1_800_000_020) : row));
    c.state.now += 10_000;
    const second = await api.competitionGames(TDID);
    expect(second.games.find((game) => game.mid === 'm20')?.finished).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// F01 — which stats a competition has: team or individual event
// ---------------------------------------------------------------------------

describe('F01: team or individual event (where the per-player figures are)', () => {
  it('a team league with team_games 0 but lg_setting.setOrder 1 (ATDO / TDA, 2026-11-09) is a team event', () => {
    const atdo = { tdid: 't_ABvC_5234', team_games: 0, lg_setting: { setOrder: 1, schedule: [{ schid: 'kwcg', num_part: 4 }] } };
    expect(isTeamEvent(atdo)).toBe(true);
    expect(parseSeasonDocument({ result: 0, tournament: { ...atdo, title: 'ATDO', entry_list: [], lg_table: [] } }, 't_ABvC_5234').teamGames).toBe(true);
  });

  it('an individual tournament (t_xMuJ_7854: team_games 0, setOrder 0 everywhere, default schedules) is not', () => {
    const solo = { tdid: 't_xMuJ_7854', team_games: 0, rr_setting: { setOrder: 0, schedule: [{ schid: 'k1ze', num_part: 4 }] }, t_setting: { setOrder: 0 } };
    expect(isTeamEvent(solo)).toBe(false);
    expect(parseCompetition({ result: 0, tournament: { ...solo, title: 'Open', entry_list: [] } }, 't_xMuJ_7854').teamGames).toBe(false);
  });

  it('team_games 1 is a team event', () => {
    expect(isTeamEvent({ team_games: 1 })).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// F07 — two players with one name in a doubles game
// ---------------------------------------------------------------------------

const v01 = (side: 0 | 1, round: number, score: number, left: number, member: { oid?: string; name: string } | null, finish = false, darts = 3): LiveThrow => ({
  kind: '01',
  side,
  round,
  score,
  left,
  darts,
  finish,
  member: member?.name ?? null,
  memberId: member?.oid ?? null,
});

function throwLeg(index: number, throws: LiveThrow[], extra: Partial<ThrowLeg> = {}): ThrowLeg {
  return { index, first: 0, ended: true, winner: 0, thrower: null, round: null, member: null, left: null, start: [501, 501], numbers: null, marks: null, points: null, throws, bull: false, dartsTotal: null, ...extra };
}

describe('F07: a visit belongs to the member id that threw it', () => {
  const rows = parseGameRows(
    list([gameRow('c1', 'AAAA', 'BBBB', 'db01', [side('AAAA', [['x1', '佐藤'], ['x2', '佐藤']], 2, 501, 45), side('BBBB', [['b1', 'B1'], ['b2', 'B2']], 0, 300, 45)], { mid: 'g1' })]),
  ).games;
  const legs = [throwLeg(0, [v01(0, 1, 180, 321, { oid: 'x1', name: '佐藤' }), v01(1, 1, 60, 441, { oid: 'b1', name: 'B1' }), v01(0, 2, 100, 221, { oid: 'x2', name: '佐藤' })])];

  it('only the player who threw the 180 is credited with it', () => {
    const [x1] = playerGames(rows, 'x1');
    const [x2] = playerGames(rows, 'x2');
    expect(playerThrowStats([{ game: x1, legs }])).toMatchObject({ ton80: 1, ton: 1, visits: 1, ambiguous: 0 });
    expect(playerThrowStats([{ game: x2, legs }])).toMatchObject({ ton80: 0, ton: 1, visits: 1, ambiguous: 0 });
  });

  it('without ids, a name two members share is counted for nobody (and said so)', () => {
    const noIds = [throwLeg(0, [v01(0, 1, 180, 321, { name: '佐藤' }), v01(0, 2, 100, 221, { name: '佐藤' })])];
    const [x1] = playerGames(rows, 'x1');
    expect(playerThrowStats([{ game: x1, legs: noIds }])).toMatchObject({ ton80: 0, visits: 0, ambiguous: 2 });
  });

  it('parses the thrower id n01 sends on each visit', () => {
    const reply = parseThrows({ result: 0, changed: 1, mid: 'g1', updateTime: 1, leg_data: [{ leg: 0, first: 0, end: 1, winner: 0, throws: [{ p: 0, r: 1, score: 180, left: 321, darts: 3, member: { oid: 'x1', name: '佐藤' } }] }] });
    expect(reply.legs[0].throws[0]).toMatchObject({ member: '佐藤', memberId: 'x1' });
  });
});

// ---------------------------------------------------------------------------
// F08 — season averages pooled
// ---------------------------------------------------------------------------

describe('F08: a season 3DA is Σ points × 3 ÷ Σ darts', () => {
  it('501 in 15 darts + 501 in 30 darts = 66.80, not the 75.15 mean of the game averages', () => {
    expect(pooledRate([{ num: 501, darts: 15 }, { num: 501, darts: 30 }])).toBeCloseTo(66.8, 2);
    const doc = parseSeasonDocument(tournamentDoc(), TDID);
    const games = parseGameRows(
      list([
        gameRow('c1', 'AAAA', 'BBBB', 'sg01', [side('AAAA', [['a1', 'A1']], 1, 501, 15), side('BBBB', [['b1', 'B1']], 0, 300, 15)], { mid: 'g1', start: 1_800_000_000 }),
        gameRow('c2', 'AAAA', 'CCCC', 'sg01', [side('AAAA', [['a1', 'A1']], 1, 501, 30), side('CCCC', [['c1', 'C1']], 0, 300, 30)], { mid: 'g2', start: 1_800_000_100 }),
      ]),
    ).games;
    const form = playerForms(doc, games, 'AAAA').find((entry) => entry.oid === 'a1')!;
    expect(form.singles01.season).toBeCloseTo(66.8, 2);
    expect(form.singles01.trend.map((value) => Number(value.toFixed(2)))).toEqual([100.2, 50.1]);
  });

  it('no darts → no average (never 0)', () => {
    expect(pooledRate([])).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// F09 — bull-decided legs stay out of averages, live or not
// ---------------------------------------------------------------------------

describe('F09: middle for diddle is kept through the live overlay', () => {
  const visits = [v01(0, 1, 100, 401, null), v01(1, 1, 100, 401, null)];

  it('the live leg carries the flag and darts n01 sends (same leg format as match/throws)', () => {
    const live = parseLive(liveBody({ leg: { leg: 1, first: 0, end: 1, winner: 0, middle_for_diddle: 1, darts: [3, 3], throws: [{ p: 0, r: 1, score: 100, left: 401, darts: 3 }] } }));
    if (!live.changed) throw new Error('unchanged');
    expect(live.leg).toMatchObject({ bull: true, dartsTotal: [3, 3] });
  });

  it('history only, overlay of the live leg, after the next leg starts: the leg never counts in the average', () => {
    const bullLeg = throwLeg(0, visits, { bull: true, dartsTotal: [3, 3] });
    const normal = throwLeg(1, [v01(0, 1, 140, 361, null), v01(1, 1, 60, 441, null)], { ended: false, winner: null });
    const history = gameStats([bullLeg], false);
    expect(history[0].rate).toBeNull();
    // The live leg (with its own flag) laid over the history: still out.
    const overlaid = gameStats(withLiveLeg([bullLeg], bullLeg as LiveLeg), false);
    expect(overlaid[0].rate).toBeNull();
    expect(overlaid[0].legsWon).toBe(1);
    // Next leg in progress: only that leg counts.
    const next = gameStats(withLiveLeg([bullLeg], normal), false);
    expect(next[0].rate).toBeCloseTo(140, 5);
  });
});

// ---------------------------------------------------------------------------
// F10 — First 9 of a leg shorter than nine darts
// ---------------------------------------------------------------------------

describe('F10: First 9 counts the darts thrown', () => {
  it('301 as 120, 120, 61 (two darts) = 301 × 3 ÷ 8 = 112.875', () => {
    const leg = throwLeg(0, [v01(0, 1, 120, 181, null), v01(1, 1, 60, 241, null), v01(0, 2, 120, 61, null), v01(1, 2, 60, 181, null), v01(0, 3, 61, 0, null, true, 2)], { start: [301, 301] });
    const [a] = gameStats([leg], false);
    expect(a.first9).toBeCloseTo(112.875, 5);
  });

  it('a normal nine-dart start is unchanged, and no visit means no First 9', () => {
    const leg = throwLeg(0, [v01(0, 1, 100, 401, null), v01(0, 2, 60, 341, null), v01(0, 3, 45, 296, null), v01(0, 4, 180, 116, null)], { ended: false, winner: null });
    expect(gameStats([leg], false)[0].first9).toBeCloseTo(205 / 3, 5);
    expect(gameStats([], false)[0].first9).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// F11 — the live estimate: where it applies
// ---------------------------------------------------------------------------

describe('F11: the reference estimate is withheld where the model does not apply', () => {
  const base = { cricket: false, left: [301, 301] as [number, number], thrower: 0 as const, startScore: 501, limitLeg: 3, drawMode: 0, complete: true };

  it('a 01 leg with everything known: leg and game', () => {
    expect(liveEstimateScope(base)).toEqual({ leg: true, game: true });
  });

  it.each([
    [{ cricket: true }, false, false],
    [{ complete: false }, false, false],
    [{ thrower: null }, false, false],
    [{ left: null }, false, false],
    [{ startScore: null }, true, false],
    [{ limitLeg: null }, true, false],
    [{ drawMode: 1 }, true, false],
  ])('%o → leg %s, game %s', (change, leg, game) => {
    const scope = liveEstimateScope({ ...base, ...change });
    expect(scope.leg).toBe(leg);
    expect(scope.game).toBe(game);
    if (!scope.game) expect(scope.reason).toBeTruthy();
  });

  it('a fresh leg uses the game’s start score, not 501', () => {
    expect(freshLegChance([60, 40], 301)).not.toBeCloseTo(freshLegChance([60, 40], 501), 3);
    expect(freshLegChance([45, 45], 301)).toBeCloseTo(0.5, 5);
  });
});
