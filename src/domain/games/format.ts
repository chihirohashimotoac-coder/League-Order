import type { GameKind, GameSlotDef, LeagueFormat } from '../types';
import { GAME_KIND_LABELS } from '../types';

/** Player count implied by a structural kind, when there is one. */
const IMPLIED_PLAYER_COUNT: Partial<Record<GameKind, number>> = {
  SINGLES: 1,
  DOUBLES: 2,
  TRIOS: 3,
};

/** Suggests a player count from the kinds; returns `undefined` when unconstrained. */
export function impliedPlayerCount(kinds: readonly GameKind[]): number | undefined {
  for (const kind of kinds) {
    const implied = IMPLIED_PLAYER_COUNT[kind];
    if (implied !== undefined) return implied;
  }
  return undefined;
}

export function gameKindLabel(game: GameSlotDef): string {
  return game.kinds.map((kind) => GAME_KIND_LABELS[kind]).join(' / ');
}

/** Games sorted by display order; ties broken by id so the result is deterministic. */
export function sortedGames(games: readonly GameSlotDef[]): GameSlotDef[] {
  return [...games].sort((a, b) => a.order - b.order || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** Total number of slots to be filled by a format. */
export function totalSlots(games: readonly GameSlotDef[]): number {
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
  message: string;
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
    }
    if (seenOrders.has(game.order)) {
      issues.push({ gameId: game.id, message: `表示順 ${game.order} が重複しています。` });
    }
    seenOrders.add(game.order);
  }
  return issues;
}
