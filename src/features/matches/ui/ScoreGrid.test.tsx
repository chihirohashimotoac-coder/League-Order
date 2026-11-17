import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { CricketGrid, ZeroOneGrid } from './ScoreGrid';
import type { LiveThrow } from '../parse';

afterEach(cleanup);

const visit = (side: 0 | 1, round: number, score: number, left: number, extra: Partial<Extract<LiveThrow, { kind: '01' }>> = {}): LiveThrow => ({
  kind: '01',
  side,
  round,
  score,
  left,
  darts: 3,
  finish: false,
  member: null,
  ...extra,
});

// Left (side 0) checks out 29 with the second dart in round 3; right is on 52.
const leg = {
  first: 0 as const,
  start: [301, 301] as [number, number],
  throws: [visit(0, 1, 140, 161), visit(1, 1, 100, 201), visit(0, 2, 132, 29), visit(1, 2, 149, 52), visit(0, 3, 29, 0, { finish: true, darts: 2 })],
};

const rows = (container: HTMLElement): string[][] =>
  [...container.querySelectorAll('tbody tr')].map((row) => [...row.querySelectorAll('td')].map((cell) => cell.textContent ?? ''));

describe('ZeroOneGrid (n01 score sheet)', () => {
  it('counts darts in the middle column (3, 6, 9 …) and starts from the start row', () => {
    const { container } = render(<ZeroOneGrid leg={leg} />);
    expect(rows(container).map((row) => row[2])).toEqual(['', '3', '6', '9']);
    expect(rows(container)[0]).toEqual(['', '301', '', '', '301']);
  });

  it('writes the finish as x1 / x2 / x3 in the Scored cell, never 0 in To Go, and does not circle it', () => {
    const { container } = render(<ZeroOneGrid leg={leg} />);
    const finish = rows(container)[3];
    expect(finish.slice(0, 2)).toEqual(['x2', '']);
    expect(container.querySelector('td.out')?.getAttribute('aria-label')).toBe('29 で上がり (2本目)');
    expect(container.querySelector('td.out')?.classList.contains('ton')).toBe(false);
    expect(container.textContent).not.toMatch(/(^|\D)0(\D|$)/);
  });

  it('circles every visit of 100 or more (n01 circleTon), and only those', () => {
    const { container } = render(<ZeroOneGrid leg={{ ...leg, throws: [...leg.throws, visit(1, 3, 99, 7)] }} />);
    const circled = [...container.querySelectorAll('td.ton')].map((cell) => cell.textContent);
    expect(circled).toEqual(['140', '100', '132', '149']);
  });

  it('keeps League Order’s own marking on top of the circle: 100+ bold, 140+ accent, 180 red', () => {
    const { container } = render(<ZeroOneGrid leg={{ ...leg, throws: [visit(0, 1, 180, 121), visit(1, 1, 140, 161), visit(0, 2, 100, 21), visit(1, 2, 99, 62)] }} />);
    const tone = (text: string): string[] => [...[...container.querySelectorAll('td.sc')].find((cell) => cell.textContent === text)!.classList].filter((name) => name !== 'sc').sort();
    expect(tone('180')).toEqual(['t180', 'ton']);
    expect(tone('140')).toEqual(['t140', 'ton']);
    expect(tone('100')).toEqual(['t100', 'ton']);
    expect(tone('99')).toEqual([]);
  });

  it('keeps the columns in card order and marks the first thrower', () => {
    const { container } = render(<ZeroOneGrid leg={leg} order={[1, 0]} names={['B', 'A']} />);
    expect([...container.querySelectorAll('tr.names th')].map((cell) => cell.textContent)).toEqual(['B', '', '* A']);
    expect(rows(container)[1]).toEqual(['100', '201', '3', '140', '161']);
    expect(rows(container)[3].slice(3)).toEqual(['x2', '']);
  });

  it('live: highlights the cell the next visit goes into and keeps a spare row', () => {
    const live = { ...leg, throws: leg.throws.slice(0, 3) };
    const { container } = render(<ZeroOneGrid leg={live} thrower={1} minRows={4} spare={1} />);
    expect(rows(container)).toHaveLength(5);
    const waiting = container.querySelector('td.waiting');
    expect(waiting?.closest('tr')?.querySelector('td.mid')?.textContent).toBe('6');
  });

  it('sorts the Scored into the three colour steps exactly at 100 / 140 / 180 (99, 139, 179 stay below)', () => {
    const scores = [99, 100, 139, 140, 179, 180];
    let left = 1001;
    const throws = scores.map((score, i) => visit(0, i + 1, score, (left -= score)));
    const { container } = render(<ZeroOneGrid leg={{ first: 0, start: [1001, 1001], throws }} />);
    const step = (text: string): string => {
      const cell = [...container.querySelectorAll('td.sc')].find((td) => td.textContent === text)!;
      return ['t100', 't140', 't180'].find((name) => cell.classList.contains(name)) ?? 'none';
    };
    expect(scores.map((score) => step(String(score)))).toEqual(['none', 't100', 't100', 't140', 't140', 't180']);
    // To Go には残り点に関係なく得点の段階を付けない。
    expect(container.querySelectorAll('td.tg.t100, td.tg.t140, td.tg.t180, td.mid.ton')).toHaveLength(0);
    // 段階の色は 01 の表だけに付く。
    expect(container.querySelector('table')?.classList.contains('zero-one')).toBe(true);
  });

  it('a finish of 100 or more keeps x1 / x2 / x3 and its reading, with no colour step or circle', () => {
    const { container } = render(<ZeroOneGrid leg={{ first: 0, start: [301, 301], throws: [visit(0, 1, 140, 161), visit(1, 1, 60, 241), visit(0, 2, 161, 0, { finish: true, darts: 3 })] }} />);
    const out = container.querySelector('td.out')!;
    expect(out.textContent).toBe('x3');
    expect(out.getAttribute('aria-label')).toBe('161 で上がり (3本目)');
    expect(['ton', 't100', 't140', 't180'].some((name) => out.classList.contains(name))).toBe(false);
  });

  it('history: the ended leg gets the history sheet, the leg in progress and the waiting cell keep the live one', () => {
    const ended = render(<ZeroOneGrid leg={leg} history />);
    expect(ended.container.querySelector('table')?.className).toBe('ns-table zero-one is-history');
    // 列と行は history なしと同じ。変わるのは見た目だけ。
    expect(rows(ended.container)).toEqual(rows(render(<ZeroOneGrid leg={leg} />).container));
    cleanup();
    const live = render(<ZeroOneGrid leg={{ ...leg, throws: leg.throws.slice(0, 3) }} thrower={1} minRows={4} spare={1} />);
    expect(live.container.querySelector('table')?.classList.contains('is-history')).toBe(false);
    expect(live.container.querySelector('td.waiting')?.className).toBe('sc waiting');
  });

  it('Cricket keeps its own sheet: no 01 colour steps, no history look', () => {
    const throws: LiveThrow[] = [{ kind: 'cricket', side: 0, round: 1, hits: [{ number: 20, mark: 3 }, { number: 20, mark: 2 }], marks: 5, points: 40, member: null }];
    const cricket = { first: 0 as const, throws };
    const { container } = render(<CricketGrid leg={cricket} />);
    const table = container.querySelector('table')!;
    expect(table.classList.contains('zero-one')).toBe(false);
    expect(table.classList.contains('is-history')).toBe(false);
    expect(container.querySelector('td.sc.t140')?.textContent).toBe('5M +40');
  });
});
