import { describe, expect, it } from 'vitest';
import type { GameKind, GameSlotDef } from '../types';
import { formatStructureIssues, impliedPlayerCount, validateFormat } from './format';
import { gamesFromSchedule } from '../../integrations/n01/formatResolver';
import { FORMAT_TEMPLATES, buildSeed } from '../../storage/seed';
import type { N01ScheduleSlot } from '../../integrations/n01/types';

const game = (kinds: GameKind[], playerCount: number, name = 'Game'): GameSlotDef => ({
  id: `g_${kinds.join('_')}_${playerCount}`,
  order: 1,
  name,
  kinds,
  playerCount,
});

describe('validateFormat: player-count kinds and head counts agree', () => {
  it.each([
    [['SINGLES', 'G501'], 2, 'Singles は 1 名'],
    [['SINGLES', 'DOUBLES', 'G501'], 2, '人数区分が複数'],
    [['SINGLES', 'DOUBLES'], 1, '人数区分が複数'],
    [['DOUBLES', 'CRICKET'], 3, 'Doubles は 2 名'],
    [['TRIOS'], 2, 'Trios は 3 名'],
    [['GALLON', 'TEAM', 'G501'], 4, '人数区分が複数'],
  ] as [GameKind[], number, string][])('%j with %i players is a structural issue', (kinds, count, text) => {
    const issues = validateFormat([game(kinds, count)]);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ code: 'structure' });
    expect(issues[0].message).toContain(text);
  });

  it.each([
    [['SINGLES', 'G501'], 1],
    [['DOUBLES', 'CRICKET'], 2],
    [['TRIOS'], 3],
    [['GALLON', 'G501'], 4],
    [['GALLON', 'G501'], 2],
    [['TEAM', 'G501'], 4],
    [['G501'], 2],
    [['CUSTOM'], 5],
    // A soft-darts medley game carries both 01 and Cricket: not a contradiction.
    [['SINGLES', 'G501', 'CRICKET'], 1],
    [['DOUBLES', 'G501', 'CRICKET'], 2],
  ] as [GameKind[], number][])('%j with %i players is fine', (kinds, count) => {
    expect(validateFormat([game(kinds, count)])).toEqual([]);
  });

  it('every starter template and the sample are consistent', () => {
    for (const template of FORMAT_TEMPLATES) {
      expect(validateFormat(template.games.map((entry, index) => ({ ...entry, id: `t${index}`, order: index + 1 })))).toEqual([]);
    }
    for (const format of buildSeed().formats) expect(validateFormat(format.games)).toEqual([]);
  });

  it('n01-managed formats (Singles / Doubles / Trios / Team / Gallon) are consistent', () => {
    const slot = (schid: string, numPart: number, matchType: string, subtitle: string | null = null): N01ScheduleSlot => ({
      schid,
      numPart,
      matchType,
      subtitle,
      startScore: matchType === '01' ? 501 : null,
      limitLegCount: 1,
      group: null,
    });
    const games = gamesFromSchedule('t1', [
      slot('a', 1, '01'),
      slot('b', 1, 'cricket'),
      slot('c', 2, '01'),
      slot('d', 2, 'cricket'),
      slot('e', 3, '01'),
      slot('f', 4, '01', 'Team'),
      slot('g', 4, '01', 'Gallon'),
      slot('h', 2, 'count up'),
    ]);
    expect(formatStructureIssues(games)).toEqual([]);
    expect(validateFormat(games)).toEqual([]);
  });
});

describe('impliedPlayerCount', () => {
  it('is the count of the single fixed-size kind, and undefined when there is none or several', () => {
    expect(impliedPlayerCount(['DOUBLES', 'G501'])).toBe(2);
    expect(impliedPlayerCount(['G501', 'CRICKET'])).toBeUndefined();
    expect(impliedPlayerCount(['GALLON'])).toBeUndefined();
    expect(impliedPlayerCount(['SINGLES', 'DOUBLES'])).toBeUndefined();
  });
});
