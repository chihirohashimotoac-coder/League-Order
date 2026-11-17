import { describe, expect, it } from 'vitest';
import { buildCards, cardScore, cardWithLive } from './cards';
import { parseFixtures, parseGameRows, parseLive, parseSeasonDocument } from './parse';
import type { LiveState } from './parse';
import { TDID, fixtures, gameRow, list, liveBody, side, tournamentDoc } from './testFixtures';

/**
 * 日程・結果 → a card in progress, followed to its end while the season's game list stays as it
 * was (Singles 1 in progress, Singles 2 not there yet).
 */
const listed = () => {
  const rows = [
    gameRow('c003', 'AAAA', 'CCCC', 'tm01', [side('AAAA', [['a1', 'A1']], 1, 1001, 60), side('CCCC', [['c1', 'C1']], 0, 900, 60)]),
    gameRow('c003', 'AAAA', 'CCCC', 'sg01', [side('AAAA', [['a1', 'A1']], 1, 400, 30), side('CCCC', [['c1', 'C1']], 1, 300, 30)], { finished: false, start: 1_800_000_900 }),
  ];
  const cards = buildCards(parseSeasonDocument(tournamentDoc(), TDID), parseFixtures(fixtures()), parseGameRows(list(rows)).games);
  return cards.find((card) => card.lsid === 'c003')!;
};
const live = (overrides: Record<string, unknown>): LiveState => parseLive(liveBody(overrides)) as LiveState;
const sg01 = live({ mid: 'c003_sg01', schid: 'sg01', legs: [2, 1], sets: [2, 0], end_match: 1, updateTime: 1_800_000_950_000 });
// Corks listed first by n01: the card's sides are the other way round.
const sg02 = (ended: boolean) =>
  live({ mid: 'c003_sg02', schid: 'sg02', legs: [2, 1], sets: [2, 2], end_match: ended ? 1 : 0, end_schedule: ended ? 1 : 0, updateTime: 1_800_001_000_000, players: [{ name: 'Corks', tpid: 'CCCC', order: [{ oid: 'c2', name: 'C2' }] }, { name: 'Arrows', tpid: 'AAAA', order: [{ oid: 'a2', name: 'A2' }] }] });

describe('a card in progress, as its live states say it is now', () => {
  it('the next game begun: the earlier game is over, the next one is in progress and can be opened', () => {
    const card = cardWithLive(listed(), new Map([['sg01', sg01], ['sg02', sg02(false)]]), sg02(false));
    const bySlot = new Map(card.games.map((game) => [game.slot.schid, game]));
    expect(bySlot.get('sg01')).toMatchObject({ state: 'finished', winner: 0, legs: [2, 1] });
    expect(bySlot.get('sg02')).toMatchObject({ state: 'live', winner: null, legs: [1, 2], members: [['A2'], ['C2']], flip: true });
    expect(bySlot.get('sg02')?.game?.mid).toBe('c003_sg02');
    expect(card.state).toBe('live');
  });

  it('the card over: the last game finished with its winner, the card no longer in progress, n01’s count of games won', () => {
    const card = cardWithLive(listed(), new Map([['sg01', sg01], ['sg02', sg02(true)]]), sg02(true));
    const bySlot = new Map(card.games.map((game) => [game.slot.schid, game]));
    expect(bySlot.get('sg02')).toMatchObject({ state: 'finished', winner: 1, legs: [1, 2] });
    expect(bySlot.get('sg02')?.game?.finished).toBe(true);
    expect(card.games.some((game) => game.state === 'live')).toBe(false);
    expect(card.state).toBe('unrecorded');
    expect(cardScore(card)).toEqual({ score: [2, 2], source: 'counted' });
  });

  it('a game ended is not the card ended; a game the list has further on than the live state keeps the list', () => {
    const between = live({ mid: 'c003_sg01', schid: 'sg01', legs: [2, 1], end_match: 1, end_schedule: 0, updateTime: 1_800_000_950_000 });
    expect(cardWithLive(listed(), new Map([['sg01', between]]), between).state).toBe('live');
    const old = live({ mid: 'c003_tm01', schid: 'tm01', legs: [0, 0], updateTime: 1 });
    const card = cardWithLive(listed(), new Map([['tm01', old]]), sg01);
    expect(card.games.find((game) => game.slot.schid === 'tm01')).toMatchObject({ state: 'finished', winner: 0, legs: [1, 0] });
  });

  it('a game the list still has in progress is over once the card moved on, down to its row (its details open as a finished game)', () => {
    const card = cardWithLive(listed(), new Map([['sg02', sg02(false)]]), sg02(false));
    const singles1 = card.games.find((game) => game.slot.schid === 'sg01')!;
    expect(singles1.state).toBe('finished');
    expect(singles1.game?.finished).toBe(true);
  });

  it('the list newer than a live state kept: a replay of the slot, or the same game further on, is not taken back', () => {
    const base = listed();
    const old = live({ mid: 'c003_sg01_old', schid: 'sg01', legs: [0, 1], updateTime: 1_799_000_000_000 });
    const replay = cardWithLive(base, new Map([['sg01', old]]), old);
    expect(replay.games.find((game) => game.slot.schid === 'sg01')?.game?.mid).toBe('c003_sg01');
    const behind = live({ mid: 'c003_sg01', schid: 'sg01', legs: [0, 0], updateTime: 1_800_000_000_000 });
    const same = cardWithLive(base, new Map([['sg01', behind]]), behind);
    expect(same.games.find((game) => game.slot.schid === 'sg01')).toMatchObject({ state: 'live', legs: [1, 1] });
  });
});
