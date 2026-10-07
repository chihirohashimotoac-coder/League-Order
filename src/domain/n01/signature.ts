import type { GameKind, GameSlotDef } from '../types';
import { STRUCTURAL_KINDS } from '../types';

/**
 * Logical game signatures (MASTER SPEC Phase 2 §8).
 *
 * `schid` changes every season, so it cannot say "this is the same slot as last season".
 * A signature describes a game by what it *is* and where it falls among games of the
 * same kind:
 *
 *     SINGLES|01|1   the first Singles 01 game of the match
 *     SINGLES|01|2   the second one
 *     DOUBLES|01|1
 *     DOUBLES|CRICKET|1
 *     TEAM|01|1
 *
 * The subtitle is not part of it (it is free text). The same function is applied to the
 * current format and to every past season's format, so slots line up across seasons.
 */

export type MatchFamily = '01' | 'CRICKET' | 'OTHER';

export interface SignatureInput {
  /** Structural kind of the game. */
  structure: GameKind;
  family: MatchFamily;
}

/** The structural kind of a game (the first structural kind it carries, else by head count). */
export function structureOf(game: Pick<GameSlotDef, 'kinds' | 'playerCount'>): GameKind {
  for (const kind of STRUCTURAL_KINDS) if (game.kinds.includes(kind)) return kind;
  if (game.playerCount <= 1) return 'SINGLES';
  if (game.playerCount === 2) return 'DOUBLES';
  if (game.playerCount === 3) return 'TRIOS';
  return 'TEAM';
}

export function familyOf(game: Pick<GameSlotDef, 'kinds'>): MatchFamily {
  if (game.kinds.includes('CRICKET')) return 'CRICKET';
  if (game.kinds.includes('G501')) return '01';
  return 'OTHER';
}

/** Signatures of a sequence of games, in the given (match) order. */
export function signaturesOf(games: readonly SignatureInput[]): string[] {
  const counts = new Map<string, number>();
  return games.map((game) => {
    const base = `${game.structure}|${game.family}`;
    const ordinal = (counts.get(base) ?? 0) + 1;
    counts.set(base, ordinal);
    return `${base}|${ordinal}`;
  });
}

/** Signatures of a League Order format's games, ordered by `order`. */
export function formatSignatures(games: readonly GameSlotDef[]): Map<string, string> {
  const ordered = [...games].sort((a, b) => a.order - b.order);
  const signatures = signaturesOf(ordered.map((game) => ({ structure: structureOf(game), family: familyOf(game) })));
  return new Map(ordered.map((game, index) => [game.id, signatures[index]]));
}

/** "Singles 01 #2" — a readable form of a signature. */
export function describeSignature(signature: string): string {
  const [structure, family, ordinal] = signature.split('|');
  const label = structure.charAt(0) + structure.slice(1).toLowerCase();
  return `${label} ${family === 'CRICKET' ? 'Cricket' : family} #${ordinal}`;
}
