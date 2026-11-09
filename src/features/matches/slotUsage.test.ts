import { describe, expect, it } from 'vitest';
import type { GameRow, SeasonDocument } from './parse';
import { slotUsage } from './insights';

const season = { slots: ['S1', 'S2', 'D1', 'C1'].map((label) => ({ schid: label, label })) } as unknown as SeasonDocument;
const game = (tmid: string, schid: string, team: string, members: string[], finished = true): GameRow =>
  ({
    mid: `${tmid}_${schid}`,
    tmid,
    schid,
    scid: null,
    finished,
    sides: [
      { teamId: team, members: members.map((oid) => ({ oid, opid: null, name: oid.toUpperCase() })) },
      { teamId: 'OTHER', members: [{ oid: 'z', opid: null, name: 'Z' }] },
    ],
  }) as unknown as GameRow;

describe('slot usage (起用傾向)', () => {
  it('counts, per player, the cards in which they played each game, from the finished games only', () => {
    const usage = slotUsage(
      season,
      [
        game('c1', 'S1', 'T', ['a']),
        game('c1', 'D1', 'T', ['a', 'b']),
        game('c2', 'S1', 'T', ['a']),
        game('c2', 'S2', 'T', ['b']),
        game('c2', 'D1', 'T', ['b', 'c']),
        game('c3', 'S1', 'T', ['c'], false),
        game('c3', 'S1', 'U', ['x']),
      ],
      'T',
    );
    expect(usage.cards).toBe(2);
    // C1 was never played by T: left out of the columns.
    expect(usage.slots.map((slot) => slot.schid)).toEqual(['S1', 'S2', 'D1']);
    expect(usage.rows.map((row) => [row.name, row.counts])).toEqual([
      ['A', [2, 0, 1]],
      ['B', [0, 1, 2]],
      ['C', [0, 0, 1]],
    ]);
  });
});
