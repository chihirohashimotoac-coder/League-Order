import type { Player } from '../types';
import type { PprSource } from './types';
import { playerPpr } from '../players/strength';

/**
 * Effective PPR rule (docs/N01_MASTER_DESIGN.md §2).
 *
 * 1. A player set to `manual` uses the PPR typed into League Order.
 * 2. Otherwise a player linked to n01 uses the PPR from n01 stats (`score / darts * 3`).
 * 3. When n01 has no PPR for them (no stats, or no darts), the manual value is used if
 *    there is one — reported as a fallback so the screen never pretends it came from n01.
 * 4. Nothing known is `null` (Unknown), never 0.
 *
 * The optimizer is not taught any of this: the order input carries a copy of each player
 * whose `ppr` is the effective value (see {@link withEffectivePpr}), so the engine keeps
 * reading one field and a saved order keeps the value it was generated with.
 */

export type EffectivePprOrigin = 'n01' | 'manual' | 'manual-fallback' | 'none';

export interface EffectivePpr {
  value: number | null;
  origin: EffectivePprOrigin;
}

/** The configured source, defaulting to n01 for linked players and manual otherwise. */
export function pprSourceOf(player: Pick<Player, 'n01' | 'pprSource'>): PprSource {
  if (player.pprSource === 'manual' || player.pprSource === 'n01') {
    return player.pprSource === 'n01' && !player.n01 ? 'manual' : player.pprSource;
  }
  return player.n01 ? 'n01' : 'manual';
}

export function effectivePpr(player: Player): EffectivePpr {
  const manual = playerPpr(player);
  if (pprSourceOf(player) === 'manual') {
    return { value: manual, origin: manual === null ? 'none' : 'manual' };
  }
  const fromN01 = player.n01?.stats?.ppr;
  if (typeof fromN01 === 'number' && Number.isFinite(fromN01)) {
    return { value: fromN01, origin: 'n01' };
  }
  return manual === null ? { value: null, origin: 'none' } : { value: manual, origin: 'manual-fallback' };
}

/** A copy of the player whose `ppr` is the effective value (for optimizer input). */
export function withEffectivePpr(player: Player): Player {
  const { value } = effectivePpr(player);
  return value === player.ppr ? player : { ...player, ppr: value };
}

/** PPR as n01 defines it: `score / darts * 3`, or `null` when there are no darts. */
export function pprFromStats(score: number, darts: number): number | null {
  if (!Number.isFinite(score) || !Number.isFinite(darts) || darts <= 0 || score < 0) return null;
  return Math.round((score / darts) * 3 * 100) / 100;
}

export const EFFECTIVE_PPR_ORIGIN_LABELS: Record<EffectivePprOrigin, string> = {
  n01: 'n01',
  manual: '手動',
  'manual-fallback': '手動 (n01 データなし)',
  none: '未設定',
};
