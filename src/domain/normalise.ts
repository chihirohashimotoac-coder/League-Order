import type {
  LeagueFormat,
  OrderInput,
  OrderVersion,
  Player,
  PresetKey,
  SavedOrder,
  ScoreWeights,
} from './types';
import { asDiscipline } from './types';
import { DEFAULT_WEIGHTS, PRESETS } from './orders/presets';
import { asPpr } from './players/strength';
import { mergeDefined } from '../utils/merge';

/**
 * Read-side upgrades for records written by older builds.
 *
 * Every field added after the first release is filled in here with the value that
 * means "nothing was said": an Unknown PPR, an unspecified discipline, the preset's own
 * role-fairness weight. Nothing is guessed, nothing that *was* stored is changed, and
 * the stored record itself is never rewritten — the upgrade happens on every read, so
 * an older build opening the same database still sees exactly what it wrote.
 */

/** A player stored before PPR existed reads back with an Unknown PPR (never 0). */
export function normalisePlayer(player: Player): Player {
  const ppr = asPpr((player as { ppr?: unknown }).ppr);
  return player.ppr === ppr ? player : { ...player, ppr };
}

/** A format stored before disciplines existed reads back as `UNSPECIFIED`. */
export function normaliseFormat(format: LeagueFormat): LeagueFormat {
  const discipline = asDiscipline((format as { discipline?: unknown }).discipline);
  return format.discipline === discipline ? format : { ...format, discipline };
}

/**
 * Completes a weight set: keys an older build did not know about take the value of the
 * preset the weights belong to (or the default set for CUSTOM). Stored keys win.
 */
export function normaliseWeights(preset: PresetKey, weights: Partial<ScoreWeights> | undefined): ScoreWeights {
  const base = preset !== 'CUSTOM' && PRESETS[preset] ? PRESETS[preset].weights : DEFAULT_WEIGHTS;
  return mergeDefined(base, weights);
}

/** Upgrades an order input snapshot (saved orders, failed attempts, the engine's input). */
export function normaliseOrderInput(input: OrderInput): OrderInput {
  const discipline = asDiscipline((input as { discipline?: unknown }).discipline);
  const weights = normaliseWeights(input.preset, input.weights);
  const players = input.players.map(normalisePlayer);
  const unchanged =
    input.discipline === discipline &&
    weights.roleFairness === input.weights?.roleFairness &&
    players.every((player, index) => player === input.players[index]);
  return unchanged ? input : { ...input, discipline, weights, players };
}

function normaliseVersion(version: OrderVersion): OrderVersion {
  const players = version.players.map(normalisePlayer);
  return players.every((player, index) => player === version.players[index])
    ? version
    : { ...version, players };
}

/**
 * Upgrades a saved order. The solution is left exactly as it was produced: its numbers
 * are a record of what the optimizer reported then, and fabricating a role-fairness
 * score for it would be inventing history.
 */
export function normaliseSavedOrder(order: SavedOrder): SavedOrder {
  const versions = (order.versions ?? []).map(normaliseVersion);
  return { ...order, input: normaliseOrderInput(order.input), versions };
}
