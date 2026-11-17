import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { groupMatches } from '../competition';
import { parseGameRows } from '../parse';
import { BracketPath } from './CompetitionViews';

/**
 * 勝ち上がり on a match's page: it used to be shown only beside the rounds on a PC (the inline
 * pane, removed when every match opened on its own page); it now comes with the page itself.
 */

afterEach(cleanup);

const T = 't_Brkt_0001';
const row = (mid: string, stage: number, a: string, b: string, legs: [number, number], finished = true) => ({
  mid,
  tdid: T,
  tmid: `${T}_t_${stage}_${a}_${b}`,
  match_type: '01',
  title: 'Bracket Open',
  startTime: 1_800_000_000 + stage * 1000,
  endMatch: finished ? 1 : 0,
  statsData: [
    { name: `N${a}`, tpid: a, winLegs: legs[0] },
    { name: `N${b}`, tpid: b, winLegs: legs[1] },
  ],
});

const matches = groupMatches(
  parseGameRows({ result: 0, list: [row('m1', 0, 'p1', 'p2', [3, 1]), row('m2', 0, 'p3', 'p4', [0, 3]), row('m3', 1, 'p1', 'p4', [1, 1], false)] }).games,
  new Map(),
  T,
);
const labels = new Map(matches.map((match) => [match.key, match.key.includes('_t_0_') ? '1回戦' : '2回戦']));

describe('BracketPath', () => {
  it('lists the matches before and after a bracket match, and opens one on a tap', () => {
    const onOpen = vi.fn();
    render(<BracketPath matches={matches} labels={labels} mid="m3" onOpen={onOpen} />);
    const path = screen.getByTestId('bracket-path');
    expect(path.textContent).toContain('Np1 の前の試合');
    expect(path.textContent).toContain('Np4 の前の試合');
    expect(path.textContent).toContain('1回戦');
    fireEvent.click(screen.getAllByRole('button')[0]);
    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ key: `${T}_t_0_p1_p2` }));
  });

  it('a first-round winner links to its next match; nothing is shown where there is no link', () => {
    render(<BracketPath matches={matches} labels={labels} mid="m1" onOpen={() => undefined} />);
    expect(screen.getByTestId('bracket-path').textContent).toContain('勝者の次の試合');
    cleanup();
    const { container } = render(<BracketPath matches={matches} labels={labels} mid="other" onOpen={() => undefined} />);
    expect(container.textContent).toBe('');
  });
});
