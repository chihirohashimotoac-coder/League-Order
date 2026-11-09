import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import type { LiveThrow } from '../parse';
import { FinishChances, RaceChart } from './LegCharts';

afterEach(cleanup);

const v = (side: 0 | 1, round: number, score: number, left: number, finish = false, darts = 3): LiveThrow => ({ kind: '01', side, round, score, left, darts, finish, member: null });

const leg = {
  index: 0,
  first: 0 as const,
  ended: true,
  winner: 1 as const,
  start: [301, 301] as [number, number],
  throws: [v(0, 1, 100, 201), v(1, 1, 140, 161), v(0, 2, 140, 61), v(1, 2, 121, 40), v(0, 3, 21, 40), v(1, 3, 40, 0, true, 2)],
};

describe('RaceChart', () => {
  it('draws both sides in column order and says who finished in how many darts', () => {
    const { container } = render(<RaceChart leg={leg} startScore={301} order={[1, 0]} names={['B', 'A']} />);
    const lines = [...container.querySelectorAll('polyline')].map((line) => line.getAttribute('points')!.split(' ').length);
    // The start plus one point per visit: three visits each.
    expect(lines).toEqual([4, 4]);
    expect(container.querySelector('figcaption')?.textContent).toContain('B が 8 本で上がり');
  });

  it('in a leg in progress, reports the lead at the last round both have thrown', () => {
    const { container } = render(<RaceChart leg={{ ...leg, ended: false, winner: null, throws: leg.throws.slice(0, 5) }} startScore={301} names={['A', 'B']} />);
    expect(container.querySelector('figcaption')?.textContent).toContain('2 ラウンド (6 本) 時点で B が 21 点先行');
  });
});

describe('FinishChances', () => {
  it('shows ○ / × per visit started on a finish and the ratio per side', () => {
    const { container } = render(<FinishChances legs={[leg]} names={['A', 'B']} />);
    const rows = [...container.querySelectorAll('.fc-row')].map((row) => [row.querySelector('.fc-pips')?.textContent, row.querySelector('.fc-rate')?.textContent]);
    // A started on 301, 201 (not finishable) and 61 (missed); B on 161 (missed) and 40 (finished).
    expect(rows).toEqual([
      ['×', '0/1 (0%)'],
      ['×○', '1/2 (50%)'],
    ]);
  });
});
