import { describe, expect, it } from 'vitest';
import { gameStats, throwEvents } from './gameStats';
import { cardOutlook, legChanceFor, log5, raceChance, shrunk } from './probability';
import { RequestGovernor } from './governor';
import { groupMatches, parseAllStandings, parseCompetition, parseCompetitionReference, parseTmid, stageLabel } from './competition';
import { fixtureDate, mergeLegs, parseGameRows, parseOrders, parseThrows } from './parse';
import type { ThrowLeg } from './parse';
import { boardCards } from './ui/LiveTab';
import { parseSeasonDocument } from './parse';
import { TDID, c001Rows as rawC001Rows, gameRow, list, side, tournamentDoc } from './testFixtures';

/** n01 writes one tmid per card for all its games. */
const c001Rows = (): unknown[] => rawC001Rows().map((row) => ({ ...(row as object), tmid: `${TDID}_lg_0_c001_AAAA_BBBB` }));
import { parseWatch } from './watchSettings';

/** A 01 leg from visits [side, score, left, darts?, finish?]. */
function leg(index: number, first: 0 | 1, winner: 0 | 1 | null, visits: [0 | 1, number, number, number?, boolean?][], extra: Partial<ThrowLeg> = {}): ThrowLeg {
  return {
    index,
    first,
    ended: winner !== null,
    winner,
    thrower: null,
    round: null,
    member: null,
    left: null,
    start: [501, 501],
    numbers: null,
    marks: null,
    points: null,
    bull: false,
    dartsTotal: null,
    throws: visits.map(([p, score, left, darts, finish], i) => ({ kind: '01', side: p, round: Math.floor(i / 2) + 1, score, left, darts: darts ?? 3, finish: !!finish, member: null })),
    ...extra,
  };
}

describe('game stats from the throws (n01 Details equivalents)', () => {
  const legs = [
    // Leg 1: side 0 first, checks out 141 with 2 darts after 180 + 180 → 9-dart-ish 8 darts.
    leg(0, 0, 0, [
      [0, 180, 321],
      [1, 100, 401],
      [0, 180, 141],
      [1, 140, 261],
      [0, 141, 0, 2, true],
    ]),
    // Leg 2: side 1 first, side 0 breaks.
    leg(1, 1, 0, [
      [1, 60, 441],
      [0, 100, 401],
      [1, 45, 396],
      [0, 140, 261],
      [1, 26, 370],
      [0, 121, 140],
      [1, 85, 285],
      [0, 140, 0, 3, true],
    ]),
    // Leg 3: decided by the bull — counted as won, kept out of the averages.
    leg(2, 0, 1, [[0, 60, 441]], { bull: true }),
  ];
  const [a, b] = gameStats(legs, false);

  it('counts legs, tons, 180s, high out, best leg and breaks as n01 does', () => {
    // A checkout visit counts in its band too (141 and 140 are 140+).
    expect(a).toMatchObject({ legsWon: 2, ton80: 2, ton40: 3, ton: 2, highOut: 141, bestLeg: 8, secondLegs: 1, breaks: 1 });
    expect(b).toMatchObject({ legsWon: 1, ton: 1, ton40: 1, ton80: 0, highOut: null, secondLegs: 2, breaks: 1 });
  });

  it('leaves the bull-decided leg out of averages and darts, and First 9 is the first three visits', () => {
    expect(a.darts).toBe(8 + 12);
    expect(a.points).toBe(501 + 501);
    expect(a.rate).toBeCloseTo((1002 / 20) * 3, 5);
    // First 9: leg 1 (180,180,141) + leg 2 (100,140,121) over 6 visits.
    expect(a.first9).toBeCloseTo((180 + 180 + 141 + 100 + 140 + 121) / 6, 5);
  });

  it('uses n01’s own darts count of a finished leg when given', () => {
    const [x] = gameStats([{ ...legs[0], dartsTotal: [9, 6] }], false);
    expect(x.darts).toBe(9);
    expect(x.bestLeg).toBe(9);
  });

  it('Cricket: MPR and visits by marks', () => {
    const cricket: ThrowLeg = {
      ...leg(0, 0, 0, []),
      throws: [
        { kind: 'cricket', side: 0, round: 1, hits: [{ number: 20, mark: 3 }, { number: 20, mark: 3 }, { number: 20, mark: 3 }], marks: 9, points: 120, member: null },
        { kind: 'cricket', side: 1, round: 1, hits: [{ number: 19, mark: 1 }], marks: 1, points: 0, member: null },
      ],
    };
    const [x, y] = gameStats([cricket], true);
    expect(x.markVisits[9]).toBe(1);
    expect(x.rate).toBeCloseTo(9, 5);
    expect(y.rate).toBeCloseTo(1, 5);
    expect(throwEvents([], cricket.throws, ['A', 'B'], 'k', 1).map((event) => event.kind)).toEqual(['nineMark']);
  });

  it('events: 180 and a 100+ checkout, each once (only throws not seen before)', () => {
    const events = throwEvents(legs[0].throws.slice(0, 2), legs[0].throws, ['A', 'B'], 'g:0', 5);
    expect(events.map((event) => event.text)).toEqual(['A 180!', 'A 141 アウト']);
  });
});

describe('card estimate (予測)', () => {
  it('shrinks small samples towards 50 % and combines two teams with log5', () => {
    expect(shrunk(undefined)).toBe(0.5);
    expect(shrunk({ games: 2, wins: 2 })).toBeCloseTo(4 / 6, 5);
    expect(log5(0.5, 0.5)).toBe(0.5);
    expect(log5(0.7, 0.3)).toBeGreaterThan(0.8);
  });

  it('a leg chance reproduces the game chance from 0-0, and a lead raises it', () => {
    const q = legChanceFor(0.6, 2);
    expect(raceChance(q, 2, 0, 0)).toBeCloseTo(0.6, 4);
    expect(raceChance(q, 2, 1, 0)).toBeGreaterThan(0.6);
    expect(raceChance(q, 2, 0, 1)).toBeLessThan(0.6);
  });

  it('finished games are fixed; the rest are an exact distribution; the three outcomes sum to 1', () => {
    const decided = cardOutlook([{ state: 'done', winner: 0 }, { state: 'done', winner: 0 }, { state: 'done', winner: 0 }, { state: 'todo', p: 0.5 }, { state: 'todo', p: 0.5 }]);
    expect(decided.win).toBeCloseTo(1, 10);
    const open = cardOutlook([{ state: 'todo', p: 0.5 }, { state: 'todo', p: 0.5 }]);
    expect(open).toEqual({ win: 0.25, draw: 0.5, loss: 0.25 });
    const live = cardOutlook([{ state: 'live', p: 0.5, legs: [1, 0], need: 2 }]);
    expect(live.win).toBeGreaterThan(0.5);
    expect(live.win + live.draw + live.loss).toBeCloseTo(1, 10);
  });
});

describe('the shared request budget', () => {
  it('lets a minute’s budget through, then waits; a 429 pauses everyone', async () => {
    let now = 0;
    const slept: number[] = [];
    const governor = new RequestGovernor(3, () => now, async (ms) => {
      slept.push(ms);
      now += ms;
    });
    for (let i = 0; i < 3; i += 1) await governor.acquire();
    expect(slept).toEqual([]);
    await governor.acquire();
    expect(slept[0]).toBe(60_000);
    governor.pause(60, 0);
    const before = slept.length;
    await governor.acquire();
    expect(slept.slice(before).reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(60_000);
  });
});

describe('throws, orders and dates', () => {
  it('reads every leg with the bull flag and n01’s dart counts, and an unchanged reply', () => {
    const parsed = parseThrows({
      result: 0,
      changed: 1,
      mid: 'm',
      match_type: '01',
      end_match: 1,
      updateTime: 5,
      leg_data: [{ leg: 0, first: 0, end: 1, winner: 1, middle_for_diddle: 1, darts: [30, 30], throws: [{ p: 0, r: 1, score: 60, left: 441, darts: 3 }] }],
    });
    expect(parsed.legs[0]).toMatchObject({ bull: true, dartsTotal: [30, 30], winner: 1 });
    expect(parseThrows({ result: 0, changed: 0, mid: 'm', updateTime: 5 }).changed).toBe(false);
  });

  it('a since reply replaces the legs it returns, whole (a corrected throw is not appended)', () => {
    const one = parseThrows({ result: 0, changed: 1, leg_data: [{ leg: 0, throws: [{ p: 0, r: 1, score: 60, left: 441 }] }, { leg: 1, throws: [] }] }).legs;
    const fixed = parseThrows({ result: 0, changed: 1, leg_data: [{ leg: 0, throws: [{ p: 0, r: 1, score: 26, left: 475 }] }] }).legs;
    const merged = mergeLegs(one, fixed);
    expect(merged).toHaveLength(2);
    expect(merged[0].throws).toHaveLength(1);
    expect(merged[0].throws[0]).toMatchObject({ score: 26, left: 475 });
  });

  it('orders and fixture dates', () => {
    expect(parseOrders({ result: 0, list: [{ tmid: 'x', tpid: 'AAAA', schid: 's1', fix: 1, order: [{ oid: 'o', oname: '佐藤' }] }] })).toEqual([{ teamId: 'AAAA', schid: 's1', fixed: true, members: ['佐藤'] }]);
    expect(fixtureDate('第1戦 10月1日 木曜日')).toEqual({ month: 10, day: 1 });
    expect(fixtureDate('2026-09-10')).toEqual({ month: 9, day: 10 });
    expect(fixtureDate('第3節')).toBeNull();
  });
});

describe('competitions of any kind', () => {
  it('reads where a match sits from its tmid (league, round robin, bracket, single match)', () => {
    expect(parseTmid('t_A_1_lg_2_qo65_iTGA_rIdl', 't_A_1')).toEqual({ ttype: 'lg', stage: 2, lsid: 'qo65', teamIds: ['iTGA', 'rIdl'] });
    expect(parseTmid('t_A_1_rr_0_QeX0_jbJj', 't_A_1')).toEqual({ ttype: 'rr', stage: 0, lsid: null, teamIds: ['QeX0', 'jbJj'] });
    expect(parseTmid('t_A_1_s2_3_1_aa_bb', 't_A_1')).toEqual({ ttype: 's2_3', stage: 1, lsid: null, teamIds: ['aa', 'bb'] });
    expect(parseTmid('t_A_1_t_0_aa_bb', 't_A_1')?.ttype).toBe('t');
    expect(parseTmid(null, 't_A_1')).toBeNull();
    expect(stageLabel({ ttype: 't', stage: 1, lsid: null, teamIds: ['a', 'b'] })).toBe('トーナメント 2回戦');
    expect(stageLabel({ ttype: 'rr', stage: 0, lsid: null, teamIds: ['a', 'b'] }, { rrGroups: ['Group A'] })).toBe('ラウンドロビン Group A');
  });

  it('reads a pasted league, tournament or match id / link', () => {
    expect(parseCompetitionReference('https://n01darts.com/n01/league/portal.php?lgid=lg_l3hI_3397')).toEqual({ kind: 'league', id: 'lg_l3hI_3397' });
    expect(parseCompetitionReference('https://n01darts.com/n01/tournament/comp.php?id=t_Ab1c_2345')).toEqual({ kind: 'tournament', id: 't_Ab1c_2345' });
    expect(parseCompetitionReference('ZV5PhBK8_1793955202222')).toEqual({ kind: 'match', id: 'ZV5PhBK8_1793955202222' });
    expect(parseCompetitionReference('ATDO')).toBeNull();
  });

  it('groups a team event’s games into one match and counts games; a single game counts legs', () => {
    const doc = parseCompetition(tournamentDoc(), TDID);
    const matches = groupMatches(parseGameRows(list(c001Rows())).games, doc.entries, TDID);
    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatchObject({ names: ['Bulls', 'Arrows'], finished: true });
    // Left side of the first game is BBBB (Bulls): Arrows won 3 of 5.
    expect(matches[0].score).toEqual([2, 3]);
    const single = groupMatches(
      parseGameRows(list([{ mid: 'x', tdid: 't_Z_1', tmid: 't_Z_1_t_0_a_b', schid: '', match_type: '01', endMatch: 0, statsData: [{ name: 'Ann', tpid: 'a', winLegs: 2 }, { name: 'Bo', tpid: 'b', winLegs: 1 }] }])).games,
      new Map(),
      't_Z_1',
    );
    expect(single[0]).toMatchObject({ names: ['Ann', 'Bo'], score: [2, 1], finished: false });
  });

  it('a game outside any competition is read by its players’ names', () => {
    const rows = parseGameRows(list([{ mid: 'free_1', match_type: '01', endMatch: 0, statsData: [{ name: 'teddy', tpid: null, winLegs: 0 }, { name: 'Sam', tpid: null, winLegs: 1 }] }]));
    expect(rows.unreadable).toBe(0);
    expect(rows.games[0].sides.map((s) => s.name)).toEqual(['teddy', 'Sam']);
  });

  it('standings of every kind (round robin groups too)', () => {
    const groups = parseAllStandings({ result: 0, groups: [{ kind: 'rr', index: 1, title: 'G2', players: [{ tpid: 'a', name: 'A', rank: 1, p: 2, w: 2, d: 0, l: 0, diff: 4 }] }] });
    expect(groups[0]).toMatchObject({ kind: 'rr', index: 1, rows: [{ teamId: 'a', won: 2, diff: 4, points: null }] });
    expect(parseAllStandings({ result: -51, error: 'no league' })).toEqual([]);
  });
});

describe('the board of the day', () => {
  it('one card per tmid with games won, the game in progress, and the card finished', () => {
    const season = parseSeasonDocument(tournamentDoc(), TDID);
    const rows = parseGameRows(
      list([
        ...c001Rows(),
        gameRow('c003', 'AAAA', 'CCCC', 'tm01', [side('AAAA', [['a1', 'A1']], 1, 1001, 60), side('CCCC', [['c1', 'C1']], 0, 900, 60)]),
        gameRow('c003', 'AAAA', 'CCCC', 'db01', [side('AAAA', [['a1', 'A1'], ['a2', 'A2']], 1, 400, 30), side('CCCC', [['c1', 'C1'], ['c2', 'C2']], 0, 300, 30)], { finished: false }),
      ]),
    ).games;
    const cards = boardCards(season, rows);
    const c001 = cards.find((card) => card.lsid === 'c001')!;
    const c003 = cards.find((card) => card.lsid === 'c003')!;
    expect(c001).toMatchObject({ won: [3, 2], finished: true, current: null });
    expect(c001.teams.map((t) => t.name)).toEqual(['Arrows', 'Bulls']);
    expect(c003.won).toEqual([1, 0]);
    expect(c003.current?.schid).toBe('db01');
    expect(c003.finished).toBe(false);
  });

  it('a stored watch target must be a real n01 id', () => {
    expect(parseWatch({ kind: 'tournament', id: 't_Ab1c_2345', title: 'Open' })).toEqual({ kind: 'tournament', id: 't_Ab1c_2345', title: 'Open' });
    expect(parseWatch({ kind: 'league', id: 'lg_l3hI_3397', title: 'ATDO' })?.kind).toBe('league');
    expect(parseWatch({ kind: 'league', id: 'javascript:alert(1)' })).toBeUndefined();
  });
});

describe('checkout routes and the leg estimate (League Order additions to the live sheet)', () => {
  it('routes the standard finishes and none for bogeys or above 170', async () => {
    const { checkoutRoute } = await import('./checkout');
    expect(checkoutRoute(170)).toEqual(['T20', 'T20', 'BULL']);
    expect(checkoutRoute(141)).toEqual(['T20', 'T19', 'D12']);
    expect(checkoutRoute(100)).toEqual(['T20', 'D20']);
    expect(checkoutRoute(60)).toEqual(['S20', 'D20']);
    expect(checkoutRoute(40)).toEqual(['D20']);
    expect(checkoutRoute(50)).toEqual(['BULL']);
    for (const bogey of [169, 168, 166, 165, 163, 162, 159, 171, 1]) expect(checkoutRoute(bogey)).toBeNull();
    // Every route really adds up and ends on a double.
    const value = (label: string): number => (label === 'BULL' ? 50 : label === 'S25' ? 25 : Number(label.slice(1)) * { S: 1, D: 2, T: 3 }[label[0] as 'S' | 'D' | 'T']);
    for (let left = 2; left <= 170; left += 1) {
      const route = checkoutRoute(left);
      if (!route) continue;
      expect(route.reduce((sum, label) => sum + value(label), 0)).toBe(left);
      expect(route[route.length - 1] === 'BULL' || route[route.length - 1].startsWith('D')).toBe(true);
    }
  });

  it('the leg estimate favours fewer points left, a better average and throwing next', async () => {
    const { legChance, freshLegChance, shrunkAverage } = await import('./checkout');
    expect(legChance([40, 300], [45, 45], 0)).toBeGreaterThan(0.9);
    expect(legChance([300, 300], [45, 45], 0)).toBeGreaterThan(legChance([300, 300], [45, 45], 1));
    expect(freshLegChance([45, 45])).toBeCloseTo(0.5, 5);
    expect(freshLegChance([60, 40])).toBeGreaterThan(0.6);
    // A few darts barely move the average from 45.
    expect(shrunkAverage(90, 6)).toBeCloseTo(49.5, 5);
  });
});
