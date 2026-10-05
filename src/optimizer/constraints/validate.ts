import type {
  GameAssignment,
  GameId,
  OrderInput,
  PlayerId,
} from '../../domain/types';
import { buildPairLookup, pairKey } from '../../domain/games/pairKey';
import {
  maxAppearancesFor,
  maxConsecutiveFor,
  minAppearancesFor,
} from '../../domain/orders/participants';
import { sortedGames } from '../../domain/games/format';
import { buildAppearanceIndices, consecutiveExcess } from '../../domain/orders/consecutive';
import { checkEligibility } from './eligibility';

/**
 * Independent re-verification of every hard constraint on a finished assignment.
 *
 * The search already makes most violations structurally impossible; this validator
 * exists as a second, independent safety net. It is called before a solution is
 * returned, after every manual edit, and directly from the test suite.
 */
export type HardViolationCode =
  | 'UNKNOWN_GAME'
  | 'MISSING_GAME'
  | 'DUPLICATE_GAME'
  | 'PLAYER_COUNT_MISMATCH'
  | 'DUPLICATE_PLAYER_IN_GAME'
  | 'EMPTY_SLOT'
  | 'UNKNOWN_PLAYER'
  | 'NOT_ELIGIBLE'
  | 'MAX_APPEARANCES_EXCEEDED'
  | 'MIN_APPEARANCES_UNMET'
  | 'LOCK_BROKEN'
  | 'FORBIDDEN_PAIR'
  | 'CONSECUTIVE_EXCEEDED';

export interface HardViolation {
  code: HardViolationCode;
  message: string;
  gameId?: GameId;
  playerId?: PlayerId;
}

export function validateHardConstraints(
  input: OrderInput,
  assignments: readonly GameAssignment[],
): HardViolation[] {
  const violations: HardViolation[] = [];
  const games = sortedGames(input.games);
  const gameById = new Map(games.map((game) => [game.id, game]));
  const playerById = new Map(input.players.map((player) => [player.id, player]));
  const configById = new Map(input.participants.map((config) => [config.playerId, config]));
  const pairs = buildPairLookup(input.pairs);

  const seenGames = new Set<GameId>();
  const counts = new Map<PlayerId, number>();

  for (const assignment of assignments) {
    const game = gameById.get(assignment.gameId);
    if (!game) {
      violations.push({
        code: 'UNKNOWN_GAME',
        gameId: assignment.gameId,
        message: `フォーマットに存在しないゲーム (${assignment.gameId}) が含まれています。`,
      });
      continue;
    }
    if (seenGames.has(game.id)) {
      violations.push({ code: 'DUPLICATE_GAME', gameId: game.id, message: `${game.name} が重複しています。` });
    }
    seenGames.add(game.id);

    if (assignment.playerIds.length !== game.playerCount) {
      violations.push({
        code: 'PLAYER_COUNT_MISMATCH',
        gameId: game.id,
        message: `${game.name}: 必要人数 ${game.playerCount} に対し ${assignment.playerIds.length} 名が配置されています。`,
      });
    }

    const seenInGame = new Set<PlayerId>();
    for (const playerId of assignment.playerIds) {
      if (!playerId) {
        violations.push({ code: 'EMPTY_SLOT', gameId: game.id, message: `${game.name}: 空席があります。` });
        continue;
      }
      if (seenInGame.has(playerId)) {
        violations.push({
          code: 'DUPLICATE_PLAYER_IN_GAME',
          gameId: game.id,
          playerId,
          message: `${game.name}: 同一選手が重複して配置されています。`,
        });
      }
      seenInGame.add(playerId);
      counts.set(playerId, (counts.get(playerId) ?? 0) + 1);

      const player = playerById.get(playerId);
      const config = configById.get(playerId);
      if (!player || !config) {
        violations.push({
          code: 'UNKNOWN_PLAYER',
          gameId: game.id,
          playerId,
          message: `${game.name}: 参加者リストに無い選手が配置されています。`,
        });
        continue;
      }
      const ineligible = checkEligibility(config, game);
      if (ineligible) {
        violations.push({
          code: 'NOT_ELIGIBLE',
          gameId: game.id,
          playerId,
          message: `${game.name}: ${player.name} は${ineligible.message}。`,
        });
      }
    }

    // Forbidden pairs inside a single game.
    const ids = [...seenInGame];
    for (let i = 0; i < ids.length; i += 1) {
      for (let j = i + 1; j < ids.length; j += 1) {
        if (pairs.isForbidden(ids[i], ids[j])) {
          violations.push({
            code: 'FORBIDDEN_PAIR',
            gameId: game.id,
            message: `${game.name}: 禁止ペア (${playerById.get(ids[i])?.name ?? ids[i]} / ${playerById.get(ids[j])?.name ?? ids[j]}) が配置されています。`,
          });
        }
      }
    }
  }

  for (const game of games) {
    if (!seenGames.has(game.id)) {
      violations.push({ code: 'MISSING_GAME', gameId: game.id, message: `${game.name} が未配置です。` });
    }
  }

  // Appearance bounds.
  for (const config of input.participants) {
    const player = playerById.get(config.playerId);
    const used = counts.get(config.playerId) ?? 0;
    const max = maxAppearancesFor(config, games);
    if (used > max) {
      violations.push({
        code: 'MAX_APPEARANCES_EXCEEDED',
        playerId: config.playerId,
        message: `${player?.name ?? config.playerId}: 最大出場回数 ${max} を超えて ${used} 回配置されています。`,
      });
    }
    if (input.settings.minAppearanceMode === 'hard') {
      const min = minAppearancesFor(config);
      if (config.include && used < min) {
        violations.push({
          code: 'MIN_APPEARANCES_UNMET',
          playerId: config.playerId,
          message: `${player?.name ?? config.playerId}: 最小出場回数 ${min} に対し ${used} 回しか配置されていません。`,
        });
      }
    }
  }

  // Locks.
  const assignmentByGame = new Map(assignments.map((a) => [a.gameId, a]));
  for (const lock of input.locks) {
    const assignment = assignmentByGame.get(lock.gameId);
    const game = gameById.get(lock.gameId);
    if (!game) continue;
    const actual = assignment?.playerIds[lock.slotIndex];
    if (actual !== lock.playerId) {
      violations.push({
        code: 'LOCK_BROKEN',
        gameId: lock.gameId,
        playerId: lock.playerId,
        message: `${game.name}: ロックされた配置 (${playerById.get(lock.playerId)?.name ?? lock.playerId}) が保持されていません。`,
      });
    }
  }

  // Consecutive appearances, only when configured as a hard constraint.
  if (input.settings.consecutiveMode === 'hard') {
    const indices = buildAppearanceIndices(games, assignments);
    for (const config of input.participants) {
      const limit = maxConsecutiveFor(config, input.settings);
      if (!Number.isFinite(limit)) continue;
      const excess = consecutiveExcess(indices.get(config.playerId) ?? [], limit);
      if (excess > 0) {
        violations.push({
          code: 'CONSECUTIVE_EXCEEDED',
          playerId: config.playerId,
          message: `${playerById.get(config.playerId)?.name ?? config.playerId}: 最大連続出場 ${limit} を超えています。`,
        });
      }
    }
  }

  return violations;
}

/** Convenience: are there no hard-constraint violations at all? */
export function isHardFeasible(
  input: OrderInput,
  assignments: readonly GameAssignment[],
): boolean {
  return validateHardConstraints(input, assignments).length === 0;
}

/** Exposed for the UI: the canonical pair key used in lookups. */
export { pairKey };
