import { describe, expect, it } from 'vitest';
import { playerGameFit, playerSkillUnit, skillToUnit } from './skills';
import { games, player } from '../../test/factories';

describe('skillToUnit (design D-07: unset aptitude is neutral, not 0)', () => {
  it('maps 1..5 onto 0..1', () => {
    expect(skillToUnit(1)).toBe(0);
    expect(skillToUnit(3)).toBe(0.5);
    expect(skillToUnit(5)).toBe(1);
  });

  it('treats an unset aptitude as the neutral middle', () => {
    expect(skillToUnit(undefined)).toBe(0.5);
    expect(playerSkillUnit(player({ id: 'a', name: 'A' }), 'DOUBLES')).toBe(0.5);
  });
});

describe('playerGameFit', () => {
  const [singles501, doublesCricket, trios, custom] = games([
    { id: 'g1', name: 'Singles 501', kinds: ['SINGLES', 'G501'], playerCount: 1 },
    { id: 'g2', name: 'Doubles Cricket', kinds: ['DOUBLES', 'CRICKET'], playerCount: 2 },
    { id: 'g3', name: 'Trios', kinds: ['TRIOS'], playerCount: 3 },
    { id: 'g4', name: 'Gallon', kinds: ['GALLON'], playerCount: 4 },
  ]);

  it('averages every aptitude the game draws on', () => {
    const p = player({ id: 'a', name: 'A', skills: { SINGLES: 5, G501: 1 } });
    expect(playerGameFit(p, singles501)).toBeCloseTo(0.5, 10);
  });

  it('combines the structural and discipline aptitudes of a compound game', () => {
    const p = player({ id: 'a', name: 'A', skills: { DOUBLES: 5, CRICKET: 5 } });
    expect(playerGameFit(p, doublesCricket)).toBe(1);
  });

  it('uses a single aptitude for a single-kind game', () => {
    const p = player({ id: 'a', name: 'A', skills: { TRIOS: 2 } });
    expect(playerGameFit(p, trios)).toBeCloseTo(0.25, 10);
  });

  it('is neutral for kinds that carry no aptitude dimension', () => {
    const p = player({ id: 'a', name: 'A', skills: { SINGLES: 5 } });
    expect(playerGameFit(p, custom)).toBe(0.5);
  });
});
