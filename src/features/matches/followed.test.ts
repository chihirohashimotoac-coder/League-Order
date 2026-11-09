import { describe, expect, it } from 'vitest';
import { MAX_FOLLOWED, parseFollowed } from './watchSettings';
import { followedSpots } from './ui/LiveTab';
import type { BoardCard } from './ui/LiveTab';
import type { GameRow } from './parse';

describe('followed players (注目選手)', () => {
  it('keeps trimmed names once each, drops anything else, and stops at the limit', () => {
    expect(parseFollowed([{ name: ' 田中 ', team: 'Arrows' }, { name: '田中', team: null }, { name: '' }, { name: 3 }, null, { name: '佐藤', team: 7 }])).toEqual([
      { name: '田中', team: 'Arrows' },
      { name: '佐藤', team: null },
    ]);
    expect(parseFollowed('x')).toBeUndefined();
    expect(parseFollowed(Array.from({ length: 40 }, (_, i) => ({ name: `P${i}` })))).toHaveLength(MAX_FOLLOWED);
    expect(parseFollowed([{ name: 'x'.repeat(61) }])).toEqual([]);
  });

  it('finds each followed player on today’s board, the game in progress before a finished one', () => {
    const game = (mid: string, finished: boolean, names: string[], start: number): GameRow =>
      ({ mid, schid: mid, finished, startTime: start, sides: [{ name: 'A', members: names.map((name) => ({ oid: name, opid: null, name })) }, { name: 'B', members: [] }] }) as unknown as GameRow;
    const card = { tmid: 't1', teams: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }], games: [game('g1', true, ['田中'], 1), game('g2', false, ['田中', '鈴木'], 2), game('g3', true, ['佐藤'], 3)] } as unknown as BoardCard;
    const spots = followedSpots([card], new Set(['田中', '佐藤', '山田']));
    expect(spots.map((spot) => [spot.name, spot.game.mid, spot.live])).toEqual([
      ['田中', 'g2', true],
      ['佐藤', 'g3', false],
    ]);
  });
});
