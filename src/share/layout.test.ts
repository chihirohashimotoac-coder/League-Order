import { describe, expect, it } from 'vitest';
import {
  buildGameRows,
  buildPlayerSchedules,
  buildShareLayout,
  formatMatchDate,
  formatMatchDateShort,
  matchupLine,
  paginate,
  tokenize,
  wrapText,
} from './layout';
import { generateOrder } from '../optimizer/generateOrder';
import { games, orderInput, player, sampleFormatGames, sampleRoster } from '../test/factories';
import type { GameSlotDef, MatchInfo, OrderSolution, Player } from '../domain/types';
import { createMatchInfo } from '../domain/types';

function solutionFor(roster: Player[], gameDefs: GameSlotDef[]): OrderSolution {
  const result = generateOrder(orderInput(roster, gameDefs));
  if (!result.ok) throw new Error('fixture should be satisfiable');
  return result.candidates[0];
}

const match = (overrides: Partial<MatchInfo> = {}): MatchInfo => ({
  ...createMatchInfo('kalavinka', ''),
  ...overrides,
});

/** Fake measurement: 10px per CJK char, 6px per other char. Deterministic and portable. */
const fakeMeasure = (text: string): number => {
  let width = 0;
  for (const char of text) {
    width += new RegExp('[\\u3000-\\u30FF\\u4E00-\\u9FFF\\uFF00-\\uFFEF]').test(char) ? 10 : 6;
  }
  return width;
};

describe('date and matchup formatting', () => {
  it('formats a full and a short date', () => {
    expect(formatMatchDate('2026-10-08')).toBe('2026/10/08');
    expect(formatMatchDateShort('2026-10-08')).toBe('10/8');
  });

  it('returns an empty string for an unset or malformed date', () => {
    expect(formatMatchDate('')).toBe('');
    expect(formatMatchDate('nope')).toBe('');
    expect(formatMatchDateShort('')).toBe('');
  });

  it('builds the matchup line, and omits the opponent when there is none', () => {
    expect(matchupLine(match({ opponentName: 'Team B' }))).toBe('kalavinka vs Team B');
    expect(matchupLine(match())).toBe('kalavinka');
    expect(matchupLine(match({ teamName: '', opponentName: '' }))).toBe('');
  });
});

describe('buildGameRows', () => {
  it('numbers games by display order and joins the players', () => {
    const roster = sampleRoster();
    const gameDefs = sampleFormatGames();
    const rows = buildGameRows(gameDefs, roster, solutionFor(roster, gameDefs));

    expect(rows).toHaveLength(6);
    expect(rows.map((row) => row.no)).toEqual(['G1', 'G2', 'G3', 'G4', 'G5', 'G6']);
    expect(rows[0].gameName).toBe('Singles 501');
    // Singles: exactly one name, no separator.
    expect(rows[0].players).not.toContain('/');
    // Doubles and Trios: separated names.
    expect(rows[2].players.split(' / ')).toHaveLength(2);
    expect(rows[4].players.split(' / ')).toHaveLength(3);
  });

  it('marks an empty slot instead of rendering a blank', () => {
    const roster = sampleRoster();
    const gameDefs = sampleFormatGames();
    const solution = solutionFor(roster, gameDefs);
    const broken: OrderSolution = {
      ...solution,
      assignments: solution.assignments.map((assignment, index) =>
        index === 0 ? { ...assignment, playerIds: [''] } : assignment,
      ),
    };
    expect(buildGameRows(gameDefs, roster, broken)[0].players).toBe('(空席)');
  });
});

describe('buildShareLayout', () => {
  const roster = sampleRoster();
  const gameDefs = sampleFormatGames();
  const solution = solutionFor(roster, gameDefs);

  it('uses the league name as the title when one is set', () => {
    const layout = buildShareLayout(gameDefs, roster, solution, match({ leagueName: '秋季リーグ' }), 'compact');
    expect(layout.header.title).toBe('秋季リーグ');
  });

  it('falls back to a generic title when no league is set', () => {
    const layout = buildShareLayout(gameDefs, roster, solution, match(), 'compact');
    expect(layout.header.title).toBe('DARTS LEAGUE');
  });

  it('omits tally, order type and notes in the compact variant', () => {
    const layout = buildShareLayout(gameDefs, roster, solution, match(), 'compact');
    expect(layout.tally).toEqual([]);
    expect(layout.orderTypeLabel).toBe('');
    expect(layout.notes).toEqual([]);
    expect(layout.games).toHaveLength(6);
  });

  it('includes appearances, rating and order type in the detail variant', () => {
    const layout = buildShareLayout(gameDefs, roster, solution, match(), 'detail');
    expect(layout.tally).toHaveLength(5);
    expect(layout.tally[0].rating).toMatch(/^R/);
    expect(layout.tally[0].count).toBeGreaterThan(0);
    expect(layout.orderTypeLabel).toBe(solution.meta.label);
  });

  it('never carries optimisation scores into the shared layout (要件 §4)', () => {
    const layout = buildShareLayout(gameDefs, roster, solution, match(), 'detail');
    const serialised = JSON.stringify(layout);
    for (const forbidden of ['総合', '戦力', '公平性', 'Score', 'score', 'strength', 'fairness', 'pairFit']) {
      expect(serialised).not.toContain(forbidden);
    }
    expect(serialised).not.toContain(String(solution.score.display));
  });

  it('marks an imputed rating and notes it, rather than showing 0', () => {
    const withUnknown = sampleRoster();
    withUnknown[2] = player({ id: 'p3', name: '千葉', rating: null });
    const unknownSolution = solutionFor(withUnknown, gameDefs);
    const layout = buildShareLayout(gameDefs, withUnknown, unknownSolution, match(), 'detail');

    const row = layout.tally.find((entry) => entry.name === '千葉')!;
    expect(row.rating).toMatch(/\*$/);
    expect(row.rating).not.toBe('Rt.0');
    expect(layout.notes.join(' ')).toContain('中央値');
  });

  it('shows Rt.— for every player when no rating is registered at all', () => {
    const unrated = sampleRoster().map((entry) => player({ id: entry.id, name: entry.name }));
    const layout = buildShareLayout(gameDefs, unrated, solutionFor(unrated, gameDefs), match(), 'detail');
    expect(layout.tally.every((row) => row.rating === 'Rt.—')).toBe(true);
  });
});

describe('buildPlayerSchedules (要件 §5)', () => {
  it('lists each player’s games with their partners', () => {
    const roster = sampleRoster();
    const gameDefs = sampleFormatGames();
    const solution = solutionFor(roster, gameDefs);
    const schedules = buildPlayerSchedules(gameDefs, roster, solution);

    expect(schedules).toHaveLength(5);
    for (const schedule of schedules) {
      const expected = solution.tallies.find((entry) => entry.playerId === schedule.playerId)!.count;
      expect(schedule.entries).toHaveLength(expected);
      for (const entry of schedule.entries) {
        const game = gameDefs.find((candidate) => entry.no === `Game ${candidate.order}`)!;
        expect(entry.partners).toHaveLength(game.playerCount - 1);
        expect(entry.partners).not.toContain(schedule.name);
      }
    }
  });

  it('keeps a player with no appearances in the list', () => {
    const roster = sampleRoster();
    const gameDefs = games([
      { id: 'g1', name: 'S1', kinds: ['SINGLES', 'G501'], playerCount: 1 },
      { id: 'g2', name: 'S2', kinds: ['SINGLES', 'G501'], playerCount: 1 },
    ]);
    const solution = solutionFor(roster, gameDefs);
    const schedules = buildPlayerSchedules(gameDefs, roster, solution);
    expect(schedules).toHaveLength(5);
    expect(schedules.filter((schedule) => schedule.entries.length === 0).length).toBe(3);
  });
});

describe('tokenize and wrapText', () => {
  it('keeps Latin words whole and breaks between CJK characters', () => {
    expect(tokenize('abc漢字 de')).toEqual(['abc', '漢', '字', ' ', 'de']);
  });

  it('returns the text unchanged when it already fits', () => {
    expect(wrapText('ちひろ', 500, fakeMeasure)).toEqual(['ちひろ']);
  });

  it('wraps a long Japanese name list without losing characters', () => {
    const text = 'シンタロー / おたぬ / ちひろ';
    const lines = wrapText(text, 120, fakeMeasure);
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) expect(fakeMeasure(line)).toBeLessThanOrEqual(120);
    // No character is dropped (ignoring the whitespace introduced at the breaks).
    expect(lines.join('').replace(/\s/g, '')).toBe(text.replace(/\s/g, ''));
  });

  it('hard-breaks a single token that is wider than the line', () => {
    const lines = wrapText('AAAAAAAAAAAAAAAAAAAAAAAA', 60, fakeMeasure);
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) expect(fakeMeasure(line)).toBeLessThanOrEqual(60);
    expect(lines.join('')).toBe('AAAAAAAAAAAAAAAAAAAAAAAA');
  });

  it('handles an empty string', () => {
    expect(wrapText('', 100, fakeMeasure)).toEqual(['']);
  });
});

describe('paginate (要件 §10)', () => {
  it('keeps everything on one page when it fits', () => {
    expect(paginate([100, 100, 100], 400)).toEqual([[0, 1, 2]]);
  });

  it('splits rather than shrinking when the content is too tall', () => {
    expect(paginate([100, 100, 100, 100], 250)).toEqual([
      [0, 1],
      [2, 3],
    ]);
  });

  it('gives a block taller than a whole page its own page instead of dropping it', () => {
    const pages = paginate([100, 900, 100], 300);
    expect(pages).toEqual([[0], [1], [2]]);
    expect(pages.flat()).toHaveLength(3);
  });

  it('never loses a block', () => {
    const heights = Array.from({ length: 37 }, (_, index) => 40 + (index % 5) * 12);
    const pages = paginate(heights, 300);
    expect(pages.flat().sort((a, b) => a - b)).toEqual(heights.map((_, index) => index));
  });

  it('returns a single empty page for no content', () => {
    expect(paginate([], 300)).toEqual([[]]);
  });
});
