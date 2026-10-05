import type { GameSlotDef, OptimizerSettings, ParticipantConfig, Player, PlayerId } from '../types';

/** A fresh participant row with no restrictions. */
export function createParticipantConfig(playerId: PlayerId, include = true): ParticipantConfig {
  return { playerId, include, excludedGameIds: [], excludedKinds: [] };
}

/**
 * Reconciles a participant list with the current roster: keeps existing rows, adds
 * missing players and drops rows whose player no longer exists.
 */
export function syncParticipants(
  participants: readonly ParticipantConfig[],
  players: readonly Player[],
): ParticipantConfig[] {
  const byId = new Map(participants.map((c) => [c.playerId, c]));
  return players.map((player) => byId.get(player.id) ?? createParticipantConfig(player.id, !player.archived));
}

export function includedParticipants(
  participants: readonly ParticipantConfig[],
): ParticipantConfig[] {
  return participants.filter((c) => c.include);
}

/** The consecutive-appearance limit that applies to a participant. */
export function maxConsecutiveFor(
  config: ParticipantConfig,
  settings: OptimizerSettings,
): number {
  const value = config.maxConsecutive ?? settings.defaultMaxConsecutive;
  return value > 0 ? value : Number.POSITIVE_INFINITY;
}

/** The hard upper bound on appearances for a participant (games count caps it too). */
export function maxAppearancesFor(config: ParticipantConfig, games: readonly GameSlotDef[]): number {
  const limit = config.maxAppearances;
  if (limit === undefined || !Number.isFinite(limit) || limit < 0) return games.length;
  return Math.min(limit, games.length);
}

export function minAppearancesFor(config: ParticipantConfig): number {
  const limit = config.minAppearances;
  return limit === undefined || !Number.isFinite(limit) || limit < 0 ? 0 : limit;
}

/** True when the game's display order falls inside the participant's window. */
export function windowAllows(config: ParticipantConfig, game: GameSlotDef): boolean {
  const window = config.window;
  if (!window) return true;
  if (window.fromOrder !== undefined && game.order < window.fromOrder) return false;
  if (window.toOrder !== undefined && game.order > window.toOrder) return false;
  return true;
}
