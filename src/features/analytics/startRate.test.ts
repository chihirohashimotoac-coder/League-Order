import { describe, expect, it } from 'vitest';
import type { RawGameDetail, RawLeg, RawVisit } from './api/parse';
import { parseGameDetail } from './api/parse';
import { formatStart, isStartTally, periodStart, startTallyOf } from './startRate';
import type { SeasonStart } from './startRate';

/**
 * ダブルイン成功率 on **intentional test data** (not n01 records): each leg below is written to
 * pin one rule of the definition. The measured n01 examples are in `realData.startRate.test.ts`.
 */

const START = 501;

/** Visits of one side: a number is points; `['out', n]` a checkout with n darts. */
type V = number | ['out', number];
function visits(list: V[]): RawVisit[] {
  let left = START;
  return list.map((v) => {
    if (Array.isArray(v)) {
      left = 0;
      return { score: -v[1], left: 0 };
    }
    left -= v;
    return { score: v, left };
  });
}

function leg(first: 0 | 1, winner: 0 | 1 | null, a: V[], b: V[], extra: Partial<RawLeg> = {}): RawLeg {
  return { first, winner, ended: winner !== null, visits: [visits(a), visits(b)], ...extra };
}

/** A doubles game: our pair A (order [A, B]) against X (order [X, Y]). Totals are not checked here. */
function game(legs: RawLeg[]): RawGameDetail {
  return {
    gameId: 'g',
    matchId: 't_lg_0_m_P_Q',
    schid: 'd1',
    matchType: '01',
    startScore: START,
    finished: true,
    legs,
    sides: [
      { teamId: 'P', players: [{ oid: 'A', opid: null, name: null }, { oid: 'B', opid: null, name: null }], legsWon: 0, score: null, darts: null },
      { teamId: 'Q', players: [{ oid: 'X', opid: null, name: null }, { oid: 'Y', opid: null, name: null }], legsWon: 0, score: null, darts: null },
    ],
  };
}

/** The opponents start at once and finish with a checkout after `rounds` visits. */
const opponentFinishing = (rounds: number): V[] => [...Array.from({ length: rounds - 1 }, () => 60), ['out', 2]];

describe('start attempts per leg (C2)', () => {
  it('initial row → A 0 → B 40 (start) → A 60: A 0/1, B 1/1; the initial row and the visits after the start are not attempts', () => {
    // Through the parser, so the row n01 writes before the first visit is really there and dropped.
    const wire = {
      result: 0,
      match: {
        mid: 'g', schid: 'd1', startScore: START, endMatch: 1,
        statsData: [
          { tpid: 'P', order: [{ oid: 'A' }, { oid: 'B' }], winLegs: 1, allScore: 501, allDarts: 30 },
          { tpid: 'Q', order: [{ oid: 'X' }, { oid: 'Y' }], winLegs: 0, allScore: 0, allDarts: 0 },
        ],
        legData: [
          {
            first: 0, endFlag: 1, winner: 0,
            playerData: [
              [{ score: 0, left: 501 }, { score: 0, left: 501 }, { score: 40, left: 461 }, { score: 60, left: 401 }, { score: 100, left: 301 }, { score: 100, left: 201 }, { score: 101, left: 100 }, { score: 60, left: 40 }, { score: -2, left: 0 }],
              [{ score: 0, left: 501 }, { score: 0, left: 501 }, { score: 0, left: 501 }, { score: 0, left: 501 }, { score: 0, left: 501 }, { score: 0, left: 501 }, { score: 0, left: 501 }, { score: 0, left: 501 }],
            ],
          },
        ],
      },
    };
    const tally = startTallyOf(parseGameDetail(wire))!;
    expect(tally.perPlayer.A).toEqual({ attempts: 1, successes: 0 });
    expect(tally.perPlayer.B).toEqual({ attempts: 1, successes: 1 });
    expect(tally.hits).toEqual([{ time: null, oid: 'B', score: 40 }]);
    // The opponents never started and our side checked out: every throw of theirs failed (X 4, Y 3 of 7 visits).
    expect(tally.perPlayer.X).toEqual({ attempts: 4, successes: 0 });
    expect(tally.perPlayer.Y).toEqual({ attempts: 3, successes: 0 });
  });

  it('a second leg where A starts at once and B never throws unstarted: A 1/2, B 1/1 over both legs', () => {
    const tally = startTallyOf(
      game([
        leg(0, 0, [0, 40, 60, ...opponentFinishing(6).slice(0, 5), ['out', 2]], [57, 60, 60, 60, 60, 60, 60]),
        leg(1, 0, [100, 100, 100, 100, 61, ['out', 2]], [60, 60, 60, 60, 60, 60]),
      ]),
    )!;
    expect(tally.perPlayer.A).toEqual({ attempts: 2, successes: 1 });
    expect(tally.perPlayer.B).toEqual({ attempts: 1, successes: 1 });
    expect(tally.sides[0]).toEqual({ legs: 2, excluded: {} });
  });

  it('the opponents check out before the pair ever starts: every attempt it threw failed', () => {
    const tally = startTallyOf(game([leg(1, 1, [0, 0, 0], opponentFinishing(4))]))!;
    expect(tally.perPlayer.A).toEqual({ attempts: 2, successes: 0 });
    expect(tally.perPlayer.B).toEqual({ attempts: 1, successes: 0 });
  });

  it('a player who never threw while the pair was unstarted is out of the denominator (0/0)', () => {
    const tally = startTallyOf(game([leg(0, 0, [41, 100, 100, 100, 100, ['out', 1]], [60, 60, 60, 60, 60])]))!;
    expect(tally.perPlayer.B).toEqual({ attempts: 0, successes: 0 });
  });
});

describe('what is never turned into a failure (C3)', () => {
  it('an unfinished leg is left out (not failures), counted by reason', () => {
    const tally = startTallyOf(game([leg(0, null, [0, 0], [0])]))!;
    expect(tally.perPlayer.A).toEqual({ attempts: 0, successes: 0 });
    expect(tally.sides[0]).toEqual({ legs: 0, excluded: { unfinished: 1 } });
  });

  it('a leg decided by the bull-off: a pair that started counts up to its start; one that never started is left out', () => {
    const middle = leg(0, 1, [0, 30, 0, 0, 0], [0, 0, 0, 0, 0], { middle: true });
    const tally = startTallyOf(game([middle]))!;
    expect(tally.perPlayer.A).toEqual({ attempts: 1, successes: 0 });
    expect(tally.perPlayer.B).toEqual({ attempts: 1, successes: 1 });
    // The opponents never started and the leg was not won by a checkout: their rows are not counted.
    expect(tally.perPlayer.X).toEqual({ attempts: 0, successes: 0 });
    expect(tally.sides[1]).toEqual({ legs: 0, excluded: { 'middle-unstarted': 1 } });
  });

  it('a leg given to a side that never started (no middle flag, no checkout) is left out for that side', () => {
    const tally = startTallyOf(game([leg(0, 0, [0, 0, 0, 0], [60, 60, 60, 60])]))!;
    expect(tally.sides[0]).toEqual({ legs: 0, excluded: { 'middle-unstarted': 1 } });
    expect(tally.perPlayer.A).toEqual({ attempts: 0, successes: 0 });
  });

  it('a record that does not read as attempts (the left moves without points, a checkout before the start) leaves the side\'s leg out', () => {
    const moved: RawLeg = { first: 0, winner: 0, ended: true, visits: [[{ score: 0, left: START }, { score: 0, left: 480 }], visits(opponentFinishing(3))] };
    const outBeforeStart: RawLeg = { first: 0, winner: 0, ended: true, visits: [[{ score: 0, left: START }, { score: -3, left: 0 }], visits([60])] };
    const wrongLeft: RawLeg = { first: 0, winner: 1, ended: true, visits: [[{ score: 40, left: 470 }], visits(opponentFinishing(3))] };
    const tally = startTallyOf(game([moved, outBeforeStart, wrongLeft]))!;
    expect(tally.perPlayer.A).toEqual({ attempts: 0, successes: 0 });
    expect(tally.sides[0].excluded).toEqual({ unreadable: 3 });
  });

  it('no start score or a player without id: no tally at all', () => {
    expect(startTallyOf({ ...game([]), startScore: null })).toBeNull();
    const g = game([]);
    expect(startTallyOf({ ...g, sides: [{ ...g.sides[0], players: [{ oid: null, opid: 'x', name: null }] }, g.sides[1]] })).toBeNull();
  });

  it('a reconstruction cached before the tally existed is "missing", never 0/0', () => {
    expect(isStartTally(undefined)).toBe(false);
    expect(isStartTally({ perPlayer: {} })).toBe(false);
    expect(isStartTally(startTallyOf(game([])))).toBe(true);
  });
});

const season = (o: Partial<SeasonStart>): SeasonStart => ({ tournamentId: 't', title: 'S', doublesGames: 2, counted: 2, attempts: 0, successes: 0, legs: 4, excludedLegs: {}, excludedGames: {}, ruleNotes: [], highInAgreements: 0, ...o });

describe('the period figure (Σ successes / Σ attempts)', () => {
  it('pools seasons by counts, not by averaging rates', () => {
    const p = periodStart([season({ attempts: 2, successes: 1 }), season({ tournamentId: 'u', attempts: 8, successes: 2 })]);
    expect(p).toMatchObject({ state: 'value', attempts: 10, successes: 3, partial: false });
    expect(p.value).toBeCloseTo(0.3); // not (0.5 + 0.25) / 2
    expect(formatStart({ value: 0.5, successes: 3, attempts: 6 })).toEqual({ value: '50.0%', sample: '3/6スロー' });
  });

  it('attempts without a success is 0%, not "no data"', () => {
    const p = periodStart([season({ attempts: 4, successes: 0 })]);
    expect(p).toMatchObject({ state: 'value', value: 0 });
    expect(formatStart(p).value).toBe('0.0%');
  });

  it('no attempt at all (分母0), no doubles games (対象なし), only unknown slots (ルール不明), straight-in only (対象外), not read (取得失敗) and nothing readable (算出不可) carry no number', () => {
    expect(periodStart([season({ attempts: 0 })])).toMatchObject({ state: 'no-trials', value: null });
    expect(periodStart([season({ doublesGames: 0, counted: 0 })])).toMatchObject({ state: 'no-games', value: null });
    expect(periodStart([])).toMatchObject({ state: 'no-games', value: null });
    expect(periodStart([season({ counted: 0, excludedGames: { 'rule-unknown': 2 } })])).toMatchObject({ state: 'rule-unknown', value: null });
    expect(periodStart([season({ counted: 0, excludedGames: { 'straight-in': 2 } })])).toMatchObject({ state: 'excluded', value: null, reason: expect.stringContaining('ストレートインと確認できた') }); // a known exclusion, not ルール不明
    expect(periodStart([season({ counted: 0, excludedGames: { 'order-unverified': 2 } })])).toMatchObject({ state: 'unavailable', value: null });
    expect(periodStart([season({ counted: 0, doublesGames: null, seasonReason: 'ゲーム一覧を取得できていません' })])).toMatchObject({ state: 'failed', reason: 'ゲーム一覧を取得できていません' }); // 取得失敗
    expect(formatStart(periodStart([season({ attempts: 0 })])).value).toBe('—');
  });

  it('games admitted but every leg unreadable: "算出不可", never a confirmed 分母0 (Codex audit)', () => {
    const p = periodStart([season({ attempts: 0, legs: 0, excludedLegs: { unreadable: 2 } })]);
    expect(p).toMatchObject({ state: 'unavailable', value: null, partial: true });
    expect(p.reason).toContain('判定できるLegがない');
    // Some legs read with no attempt in them: 分母0, said to cover the readable legs only.
    expect(periodStart([season({ attempts: 0, legs: 1, excludedLegs: { unreadable: 1 } })])).toMatchObject({ state: 'no-trials', reason: expect.stringContaining('判定できたLegの範囲') });
  });

  it('a figure over part of the games or legs says so (一部集計), and keeps the reasons', () => {
    const p = periodStart([
      season({ attempts: 3, successes: 1, counted: 1, excludedGames: { 'not-fetched': 1 }, excludedLegs: { unfinished: 1 } }),
      season({ tournamentId: 'old', doublesGames: 3, counted: 0, excludedGames: { 'rule-unknown': 3 }, ruleNotes: ['n01のハイイン記録がなく'] }),
      season({ tournamentId: 'gone', doublesGames: null, counted: 0, seasonReason: '通信の上限または中断のため未取得' }),
    ]);
    expect(p).toMatchObject({ state: 'value', partial: true, attempts: 3, successes: 1, excludedGames: { 'not-fetched': 1, 'rule-unknown': 3 }, excludedLegs: { unfinished: 1 } });
    expect(p.seasonsMissing).toEqual([{ title: 'S', reason: '通信の上限または中断のため未取得' }]);
    expect(p.ruleNotes).toEqual(['n01のハイイン記録がなく']);
  });
});
