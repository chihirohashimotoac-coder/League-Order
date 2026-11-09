import { describe, expect, it } from 'vitest';
import type { OfficialStandingGroup } from '../analytics/types';
import type { MatchCard } from './cards';
import type { PointRule } from './parse';
import { roundMovement } from './standings';

const rule = { win: 2, draw: 1, loss: 0, includeGames: false, includeLegs: false, extras: {} } as unknown as PointRule;
const card = (title: string, a: string, b: string, official: [number, number] | null): MatchCard =>
  ({ title, divisionTitle: 'A', teams: [{ id: a, name: a }, { id: b, name: b }], official }) as unknown as MatchCard;
const group = { divisionIndex: 0, title: 'A', rows: ['T1', 'T2', 'T3', 'T4'].map((teamId, i) => ({ teamId, name: teamId, rank: i + 1, played: 0, won: 0, drawn: 0, lost: 0, points: 0 })) } as unknown as OfficialStandingGroup;

describe('movement since the previous round (前節比)', () => {
  it('compares positions by points with and without the latest round, and gives the gap to the leader', () => {
    const cards = [
      card('第1節', 'T1', 'T2', [6, 4]),
      card('第1節', 'T3', 'T4', [7, 3]),
      card('第2節', 'T4', 'T1', [6, 4]),
      card('第2節', 'T2', 'T3', [5, 5]),
      card('第3節', 'T1', 'T3', null),
    ];
    const move = roundMovement(rule, group, cards)!;
    expect(move.round).toBe('第2節');
    // After 第1節: T1 2, T3 2 (both 1st), T2 0, T4 0 (both 3rd). After 第2節: T3 3, T1 2, T4 2, T2 1.
    expect(Object.fromEntries([...move.rows].map(([id, row]) => [id, [row.previous, row.position, row.change, row.behind]]))).toEqual({
      T1: [1, 2, -1, 1],
      T2: [3, 4, -1, 2],
      T3: [1, 1, 0, 0],
      T4: [3, 2, 1, 1],
    });
  });

  it('needs an earlier round to compare with', () => {
    expect(roundMovement(rule, group, [card('第1節', 'T1', 'T2', [6, 4])])).toBeNull();
    expect(roundMovement(rule, group, [card('第1節', 'T1', 'T2', null)])).toBeNull();
  });
});
