import { describe, expect, it } from 'vitest';
import type { GameRow, LiveThrow, ThrowLeg } from './parse';
import { playerGames, playerThrowStats } from './playerCard';

const side = (teamId: string, members: [string, string][], score: number | null, darts: number | null): GameRow['sides'][number] =>
  ({ teamId, name: teamId, members: members.map(([oid, name]) => ({ oid, opid: null, name })), score, darts, marks: null, legsWon: null }) as unknown as GameRow['sides'][number];

const row = (mid: string, start: number, sides: GameRow['sides'], extra: Partial<GameRow> = {}): GameRow => ({
  mid,
  tmid: null,
  schid: null,
  scid: null,
  matchType: '01',
  title: mid,
  startTime: start,
  updateTime: null,
  finished: true,
  cardFinished: true,
  sides,
  ...extra,
});

const v = (s: 0 | 1, round: number, score: number, left: number, member: string | null, finish = false, darts = 3): LiveThrow => ({ kind: '01', side: s, round, score, left, darts, finish, member });

const leg = (throws: LiveThrow[], winner: 0 | 1, extra: Partial<ThrowLeg> = {}): ThrowLeg => ({
  index: 0,
  first: 0,
  ended: true,
  winner,
  thrower: null,
  round: null,
  member: null,
  left: null,
  start: [301, 301],
  numbers: null,
  marks: null,
  points: null,
  throws,
  bull: false,
  dartsTotal: null,
  ...extra,
});

describe('player card', () => {
  const games = [
    row('g2', 200, [side('T2', [['x', 'X']], 300, 18), side('T1', [['p1', 'Pat'], ['p2', 'Sam']], 301, 15)]),
    row('g1', 100, [side('T1', [['p1', 'Pat']], 301, 15), side('T2', [['x', 'X']], 280, 15)]),
    row('g3', 300, [side('T1', [['p1', 'Pat']], null, null), side('T2', [['y', 'Y']], null, null)], { finished: false }),
  ];

  it('lists the finished games by member id, oldest first, with the singles average only for singles 01', () => {
    const list = playerGames(games, 'p1');
    expect(list.map((g) => [g.mid, g.side, g.singles])).toEqual([
      ['g1', 0, true],
      ['g2', 1, false],
    ]);
    expect(list[0].singlesAverage).toBeCloseTo(60.2, 5);
    expect(list[1].singlesAverage).toBeNull();
  });

  it('counts only the player’s visits (named, or unnamed in singles) and the best singles leg', () => {
    const [singles, doubles] = playerGames(games, 'p1');
    const stats = playerThrowStats([
      { game: singles, legs: [leg([v(0, 1, 140, 161, null), v(1, 1, 60, 241, null), v(0, 2, 121, 40, null), v(1, 2, 60, 181, null), v(0, 3, 40, 0, null, true, 2)], 0)] },
      { game: doubles, legs: [leg([v(1, 1, 180, 121, 'Pat'), v(1, 2, 100, 21, 'Sam'), v(1, 3, 21, 0, 'Pat', true, 1)], 1, { start: [301, 301] })] },
    ]);
    expect(stats).toMatchObject({ games: 2, visits: 5, ton: 3, ton80: 1, highOut: 40 });
    // Started on 161 (missed), 40 (finished) in singles; 21 (finished) in doubles — Sam's 121 is not Pat's.
    expect([stats.finished, stats.chances]).toEqual([2, 3]);
    // Only the singles leg counts for the fewest darts: 3 + 3 + 2.
    expect(stats.bestLegs).toEqual([{ start: 301, darts: 8 }]);
  });
});
