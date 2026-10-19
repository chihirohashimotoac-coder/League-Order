import type { GameKind, GameSlotDef, LeagueFormat, StructuralKind } from '../types';
import { GAME_KIND_LABELS, STRUCTURAL_KINDS } from '../types';

/**
 * Player count fixed by a structural kind. Singles, Doubles and Trios are defined by how
 * many people play them; Gallon, Team and a game with no structural kind take whatever
 * count the format says (n01 names 4+ player games Team, and a gallon can be any size).
 */
export const IMPLIED_PLAYER_COUNT: Partial<Record<GameKind, number>> = {
  SINGLES: 1,
  DOUBLES: 2,
  TRIOS: 3,
};

/** The structural ("how many players") kinds a game carries, in the canonical order. */
export function structuralKindsOf(game: Pick<GameSlotDef, 'kinds'>): StructuralKind[] {
  return STRUCTURAL_KINDS.filter((kind) => game.kinds.includes(kind));
}

/** The game kinds that are not structural: 01, Cricket, Custom. */
export function playKindsOf(game: Pick<GameSlotDef, 'kinds'>): GameKind[] {
  return game.kinds.filter((kind) => !(STRUCTURAL_KINDS as readonly GameKind[]).includes(kind));
}

/** The player count the kinds fix; `undefined` when unconstrained (or contradictory). */
export function impliedPlayerCount(kinds: readonly GameKind[]): number | undefined {
  const fixed = kinds.filter((kind) => IMPLIED_PLAYER_COUNT[kind] !== undefined);
  return fixed.length === 1 ? IMPLIED_PLAYER_COUNT[fixed[0]] : undefined;
}

export function gameKindLabel(game: GameSlotDef): string {
  return game.kinds.map((kind) => GAME_KIND_LABELS[kind]).join(' / ');
}

/** Games sorted by display order; ties broken by id so the result is deterministic. */
export function sortedGames(games: readonly GameSlotDef[]): GameSlotDef[] {
  return [...games].sort((a, b) => a.order - b.order || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** Total number of slots to be filled by a format. */
export function totalSlots(games: readonly Pick<GameSlotDef, 'playerCount'>[]): number {
  return games.reduce((acc, game) => acc + game.playerCount, 0);
}

/** Renumbers `order` to 1..n following the array order. */
export function renumber(games: readonly GameSlotDef[]): GameSlotDef[] {
  return games.map((game, index) => ({ ...game, order: index + 1 }));
}

export function formatLabel(format: LeagueFormat): string {
  return `${format.name} (${format.games.length}ゲーム / ${totalSlots(format.games)}枠)`;
}

export interface FormatIssue {
  gameId?: string;
  /**
   * `structure`: the game contradicts itself (two player-count kinds, or a Singles /
   * Doubles / Trios game whose head count is not 1 / 2 / 3). Such a game cannot be
   * generated or finalized; the format has to be corrected first.
   */
  code?: 'structure';
  message: string;
}

/**
 * Contradictions inside one game: more than one structural kind, or a head count that
 * differs from the one Singles / Doubles / Trios define. `01` and `Cricket` together are
 * not a contradiction (a soft-darts medley game carries both).
 */
export function gameStructureIssues(game: GameSlotDef): FormatIssue[] {
  const label = game.name || 'ゲーム';
  const structural = structuralKindsOf(game);
  if (structural.length > 1) {
    return [
      {
        gameId: game.id,
        code: 'structure',
        message: `${label}: 人数区分が複数選ばれています (${structural.map((kind) => GAME_KIND_LABELS[kind]).join(' / ')})。1 つにしてください。`,
      },
    ];
  }
  const implied = structural.length === 1 ? IMPLIED_PLAYER_COUNT[structural[0]] : undefined;
  if (implied !== undefined && game.playerCount !== implied) {
    return [
      {
        gameId: game.id,
        code: 'structure',
        message: `${label}: ${GAME_KIND_LABELS[structural[0]]} は ${implied} 名のゲームですが、必要人数が ${game.playerCount} 名になっています。`,
      },
    ];
  }
  return [];
}

/** Every structural contradiction in a format (see `gameStructureIssues`). */
export function formatStructureIssues(games: readonly GameSlotDef[]): FormatIssue[] {
  return games.flatMap(gameStructureIssues);
}

/** Structural validation of a format, independent of any player data. */
export function validateFormat(games: readonly GameSlotDef[]): FormatIssue[] {
  const issues: FormatIssue[] = [];
  if (games.length === 0) issues.push({ message: 'ゲームが 1 つも登録されていません。' });

  const seenOrders = new Set<number>();
  for (const game of games) {
    if (!game.name.trim()) {
      issues.push({ gameId: game.id, message: 'ゲーム名が空です。' });
    }
    if (game.kinds.length === 0) {
      issues.push({ gameId: game.id, message: `${game.name || 'ゲーム'}: ゲーム種別が未設定です。` });
    }
    if (!Number.isInteger(game.playerCount) || game.playerCount < 1) {
      issues.push({ gameId: game.id, message: `${game.name || 'ゲーム'}: 必要人数は 1 以上の整数にしてください。` });
    } else {
      issues.push(...gameStructureIssues(game));
    }
    if (seenOrders.has(game.order)) {
      issues.push({ gameId: game.id, message: `表示順 ${game.order} が重複しています。` });
    }
    seenOrders.add(game.order);
  }
  return issues;
}
