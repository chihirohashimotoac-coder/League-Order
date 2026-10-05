import type { GameSlotDef, ParticipantConfig } from '../../domain/types';
import { GAME_KIND_LABELS } from '../../domain/types';
import { windowAllows } from '../../domain/orders/participants';

/**
 * Hard eligibility (docs/DESIGN.md §3.1, H3/H4/H5/H9).
 *
 * These checks are applied once up front to build the eligibility matrix, so that a
 * forbidden assignment is not merely penalised — it is unrepresentable in the search.
 */
export type IneligibilityReason =
  | 'notIncluded'
  | 'excludedGame'
  | 'excludedKind'
  | 'outsideWindow';

export interface Ineligibility {
  reason: IneligibilityReason;
  /** The offending kind, when `reason === 'excludedKind'`. */
  kindLabel?: string;
  message: string;
}

/** Returns `null` when the participant may play the game, otherwise the reason. */
export function checkEligibility(
  config: ParticipantConfig,
  game: GameSlotDef,
): Ineligibility | null {
  if (!config.include) {
    return { reason: 'notIncluded', message: '参加者に含まれていません' };
  }
  if (config.excludedGameIds.includes(game.id)) {
    return { reason: 'excludedGame', message: `${game.name} が出場不可に設定されています` };
  }
  const blockedKind = game.kinds.find((kind) => config.excludedKinds.includes(kind));
  if (blockedKind) {
    return {
      reason: 'excludedKind',
      kindLabel: GAME_KIND_LABELS[blockedKind],
      message: `${GAME_KIND_LABELS[blockedKind]} が出場不可に設定されています`,
    };
  }
  if (!windowAllows(config, game)) {
    const from = config.window?.fromOrder;
    const to = config.window?.toOrder;
    const range = `${from ?? 1}〜${to ?? '最終'}`;
    return { reason: 'outsideWindow', message: `出場可能範囲 (Game ${range}) の外です` };
  }
  return null;
}

export function isEligible(config: ParticipantConfig, game: GameSlotDef): boolean {
  return checkEligibility(config, game) === null;
}
