import type { GameKind, GameSlotDef, Player, SkillLevel } from '../types';
import { mean } from '../../utils/math';

/** An unspecified aptitude is treated as level 3 (neutral), never as 0 (design D-07). */
export const NEUTRAL_SKILL_LEVEL: SkillLevel = 3;

/** Maps a 1..5 aptitude onto 0..1. */
export function skillToUnit(level: SkillLevel | undefined): number {
  const effective = level ?? NEUTRAL_SKILL_LEVEL;
  return (effective - 1) / 4;
}

/** A player's aptitude for a single kind, as a 0..1 value. */
export function playerSkillUnit(player: Player, kind: GameKind): number {
  return skillToUnit(player.skills[kind]);
}

/**
 * A player's aptitude for a game: the mean of the aptitudes for every kind the
 * game carries. A "Doubles 501" game therefore averages Doubles and 501 aptitude.
 */
export function playerGameFit(player: Player, game: GameSlotDef): number {
  const scored = game.kinds.filter((kind) => kind !== 'CUSTOM' && kind !== 'TEAM' && kind !== 'GALLON');
  const kinds = scored.length > 0 ? scored : game.kinds;
  if (kinds.length === 0) return 0.5;
  return mean(kinds.map((kind) => playerSkillUnit(player, kind)));
}

export function isSkillSpecified(player: Player): boolean {
  return Object.values(player.skills).some((level) => level !== undefined);
}
