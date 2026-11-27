import { describe, expect, it } from 'vitest';
import { TDID, gameRow, side, tournamentDoc } from './testFixtures';
import { parseFixtures, parseGameRows, parseSeasonDocument } from './parse';
import { buildCards } from './cards';
import { boardCards, pendingCards } from './ui/LiveTab';

// 2026-11-27 12:00 JST.
const NOW = Date.UTC(2026, 10, 27, 3);
const fixtures = (rows: { p: [string, string]; lsid: string; t: string }[]): ReturnType<typeof parseFixtures> => parseFixtures({ result: 0, schedule: [rows] });

describe('pendingCards (today’s cards before their first game, live tab)', () => {
  const season = parseSeasonDocument(tournamentDoc(), TDID);
  const fx = fixtures([
    { p: ['DDDD', 'BBBB'], lsid: 'c004', t: '第2戦 11月27日 金曜日' },
    { p: ['AAAA', 'CCCC'], lsid: 'c003', t: '第2戦 11月27日 金曜日' },
    { p: ['AAAA', 'BBBB'], lsid: 'c009', t: '第3戦 12月4日 金曜日' },
    { p: ['CCCC', 'DDDD'], lsid: 'c010', t: '第2戦' },
  ]);

  it('only today’s (JST) cards with no game: never next week’s, never a card without a date, never one already on the board', () => {
    const rows = parseGameRows({ result: 0, list: [gameRow('c003', 'AAAA', 'CCCC', 'tm01', [side('AAAA', [['a1', 'A1']], 1, 501, 18), side('CCCC', [['c1', 'C1']], 0, 400, 18)], { finished: false })] }).games;
    const cards = buildCards(season, fx, rows);
    const board = boardCards(season, rows);
    const pending = pendingCards(season, cards, board, NOW);
    expect(pending.map((card) => card.lsid)).toEqual(['c004']);
    expect(pending[0].pending).toBe(true);
    expect(pending[0].current).toBeNull();
    expect(pending[0].won).toEqual([0, 0]);
    // n01's tmid (team ids in code-unit order), and the teams in that order as the board shows them.
    expect(pending[0].tmid).toBe(`${TDID}_lg_0_c004_BBBB_DDDD`);
    expect(pending[0].teams.map((team) => team.id)).toEqual(['BBBB', 'DDDD']);
  });

  it('the day before or after (JST): none', () => {
    const cards = buildCards(season, fx, []);
    expect(pendingCards(season, cards, [], Date.UTC(2026, 10, 26, 14, 59))).toEqual([]);
    expect(pendingCards(season, cards, [], Date.UTC(2026, 10, 27, 15, 0))).toEqual([]);
  });

  it('a season over (status 40): none', () => {
    const over = parseSeasonDocument(tournamentDoc({}, { status: 40 }), TDID);
    expect(pendingCards(over, buildCards(over, fx, []), [], NOW)).toEqual([]);
  });

  it('a card with n01’s result is not before its start', () => {
    const done = parseSeasonDocument(tournamentDoc({ '0_c004': { DDDD: { BBBB: { r: 3 } }, BBBB: { DDDD: { r: 2 } } } }), TDID);
    expect(pendingCards(done, buildCards(done, fx, []), [], NOW).map((card) => card.lsid)).toEqual(['c003']);
  });
});
