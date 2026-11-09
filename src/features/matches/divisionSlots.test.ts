import { describe, expect, it } from 'vitest';
import { buildCards } from './cards';
import { teamProfile } from './insights';
import { parseFixtures, parseGameRows, parseSeasonDocument, slotOf, slotsFor, teamDivision } from './parse';
import { TDID, fixtures, gameRow, list, side, tournamentDoc } from './testFixtures';

/**
 * ATDO (2026 3rd, checked on n01 2026-11-09): the A division plays its own games
 * (`lg_setting.game_setting[{ round: 0, schedule }]`, schids qtrl … k39v) while B and C play the
 * base schedule (kwcg … gsbe). `round` is the division's index in `lg_table`.
 */
function seasonWithOwnSchedule() {
  const doc = tournamentDoc() as { tournament: { lg_setting: Record<string, unknown> } };
  doc.tournament.lg_setting.game_setting = [
    {
      round: 0,
      limit: 3,
      schedule: [
        { subTitle: 'チーム', startScore: 1001, match_type: '01', num_part: 4, schid: 'a_tm' },
        { subTitle: 'シングルス1', startScore: 501, match_type: '01', num_part: 1, schid: 'a_s1' },
      ],
    },
    { round: 5, schedule: [] },
  ];
  return parseSeasonDocument(doc, TDID);
}

describe('division schedules (game_setting)', () => {
  it('reads a division’s own games and falls back to the base schedule elsewhere', () => {
    const season = seasonWithOwnSchedule();
    expect(slotsFor(season, 0).map((slot) => slot.schid)).toEqual(['a_tm', 'a_s1']);
    expect(slotsFor(season, 1).map((slot) => slot.schid)).toEqual(['tm01', 'db01', 'db02', 'sg01', 'sg02']);
    expect(slotsFor(season, null)).toBe(season.slots);
    expect(slotOf(season, 'a_s1')?.label).toBe('シングルス1');
    expect(teamDivision(season, 'AAAA')).toBe(0);
  });

  it('builds the cards and the win rates by kind from the division’s own games', () => {
    const season = seasonWithOwnSchedule();
    const rows = parseGameRows(list([gameRow('c001', 'AAAA', 'BBBB', 'a_s1', [side('AAAA', [['a1', 'A1']], 2, 501, 30), side('BBBB', [['b1', 'B1']], 1, 400, 33)])])).games;
    const card = buildCards(season, parseFixtures(fixtures()), rows).find((entry) => entry.lsid === 'c001')!;
    expect(card.games.map((game) => game.slot.schid)).toEqual(['a_tm', 'a_s1']);
    expect(card.games[1]).toMatchObject({ state: 'finished', winner: 0 });
    expect(teamProfile(season, [card], rows, 'AAAA').byStructure).toEqual({ SINGLES: { games: 1, wins: 1 } });
  });
});
