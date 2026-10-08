import type {
  AppearanceRecord,
  GameKind,
  OrderVersion,
  Player,
  PlayerId,
  SeasonCommit,
  SeasonCommitStatus,
} from '../types';

/**
 * Season commit ledger (追加要件 §11–§13).
 *
 * ## Why a ledger rather than a flag or a dialog
 *
 * "Have these appearances already been counted?" cannot be answered by a boolean once an
 * order can be re-finalized: v1 may be counted, then v2 changes who played. The ledger
 * records *exactly what was added*, so re-committing is a matter of arithmetic rather
 * than of the captain remembering.
 *
 * ## Delta, not rollback-then-apply (追加要件 §13, option B)
 *
 * Committing applies `new − alreadyCommitted` per player. This is numerically identical
 * to rolling v1 back and applying v2, but:
 *
 * - it is a single write, so season totals are never transiently wrong;
 * - it is idempotent by construction — committing the same version twice yields a delta
 *   of zero, so no dialog is load-bearing;
 * - a player dropped between versions simply gets a negative delta, with no special case.
 *
 * The resulting invariant, which the tests assert directly: committing v1 and then v2
 * leaves exactly the totals that committing v2 alone would have produced
 * (`base + v1 + (v2 − v1) = base + v2`).
 */

export interface AppearanceDelta {
  playerId: PlayerId;
  count: number;
  byKind: Partial<Record<GameKind, number>>;
}

function indexAppearances(
  records: readonly AppearanceRecord[],
): Map<PlayerId, AppearanceRecord> {
  return new Map(records.map((record) => [record.playerId, record]));
}

/**
 * `next − previous`, per player and per game kind. Players present in only one side are
 * included with the appropriate sign; entries that cancel out entirely are dropped.
 */
export function appearanceDelta(
  previous: readonly AppearanceRecord[],
  next: readonly AppearanceRecord[],
): AppearanceDelta[] {
  const before = indexAppearances(previous);
  const after = indexAppearances(next);
  const playerIds = [...new Set([...before.keys(), ...after.keys()])].sort();

  const deltas: AppearanceDelta[] = [];
  for (const playerId of playerIds) {
    const from = before.get(playerId);
    const to = after.get(playerId);
    const count = (to?.count ?? 0) - (from?.count ?? 0);

    const kinds = new Set<GameKind>([
      ...(Object.keys(from?.byKind ?? {}) as GameKind[]),
      ...(Object.keys(to?.byKind ?? {}) as GameKind[]),
    ]);
    const byKind: Partial<Record<GameKind, number>> = {};
    for (const kind of kinds) {
      const diff = (to?.byKind[kind] ?? 0) - (from?.byKind[kind] ?? 0);
      if (diff !== 0) byKind[kind] = diff;
    }

    if (count !== 0 || Object.keys(byKind).length > 0) {
      deltas.push({ playerId, count, byKind });
    }
  }
  return deltas;
}

export interface SeasonApplication {
  /** Players whose season totals change. Already-correct players are not touched. */
  updatedPlayers: Player[];
  deltas: AppearanceDelta[];
  /** The ledger entry to store, or `null` when the commit is being withdrawn. */
  commit: SeasonCommit | null;
  /** True when nothing at all needed to change. */
  noop: boolean;
  /**
   * Players whose stored total was lower than the amount being withdrawn, which can only
   * happen if the totals were edited by hand. Their total is clamped at 0 and reported.
   */
  clamped: PlayerId[];
}

function applyDeltas(
  players: readonly Player[],
  deltas: readonly AppearanceDelta[],
): { updatedPlayers: Player[]; clamped: PlayerId[] } {
  const byId = new Map(players.map((player) => [player.id, player]));
  const updatedPlayers: Player[] = [];
  const clamped: PlayerId[] = [];

  for (const delta of deltas) {
    const player = byId.get(delta.playerId);
    // A player deleted from the roster cannot have their totals adjusted; the ledger
    // still drops their contribution so the remaining numbers stay consistent.
    if (!player) continue;

    const nextTotal = player.seasonAppearances + delta.count;
    if (nextTotal < 0) clamped.push(player.id);

    const byKind = { ...player.seasonAppearancesByKind };
    for (const [kind, amount] of Object.entries(delta.byKind)) {
      if (amount === undefined) continue;
      const key = kind as GameKind;
      const next = Math.max(0, (byKind[key] ?? 0) + amount);
      // Drop keys that fall to zero, so the breakdown is canonical: committing v1 then
      // v2 must leave byte-identical data to committing v2 alone, not a residue of
      // zero-valued kinds from versions that have since been superseded.
      if (next === 0) delete byKind[key];
      else byKind[key] = next;
    }

    updatedPlayers.push({
      ...player,
      seasonAppearances: Math.max(0, nextTotal),
      seasonAppearancesByKind: byKind,
    });
  }

  return { updatedPlayers, clamped };
}

/**
 * Computes the effect of committing `version` for an order, given what the ledger says
 * is already counted. Calling it twice with the same version produces a no-op.
 */
export function planSeasonCommit(
  orderId: string,
  teamId: string,
  version: OrderVersion,
  existing: SeasonCommit | null,
  players: readonly Player[],
  committedAt: number,
): SeasonApplication {
  // The ledger records exactly what was added to the roster's season totals. A guest
  // (今回限りの助っ人) is nobody's total: counting them here would leave a ghost entry that
  // no re-commit or withdrawal could ever settle against a player.
  const guestIds = new Set(version.players.filter((player) => player.guest === true).map((player) => player.id));
  const counted = version.appearances.filter((record) => !guestIds.has(record.playerId));
  const deltas = appearanceDelta(existing?.appearances ?? [], counted);
  const { updatedPlayers, clamped } = applyDeltas(players, deltas);

  const commit: SeasonCommit = {
    id: orderId,
    teamId,
    committedVersion: version.version,
    committedAt,
    appearances: counted.map((record) => ({
      ...record,
      byKind: { ...record.byKind },
    })),
  };

  return {
    updatedPlayers,
    deltas,
    commit,
    noop: deltas.length === 0 && existing?.committedVersion === version.version,
    clamped,
  };
}

/** Withdraws an order's contribution entirely, restoring the totals it had before. */
export function planSeasonWithdrawal(
  existing: SeasonCommit,
  players: readonly Player[],
): SeasonApplication {
  const deltas = appearanceDelta(existing.appearances, []);
  const { updatedPlayers, clamped } = applyDeltas(players, deltas);
  return { updatedPlayers, deltas, commit: null, noop: deltas.length === 0, clamped };
}

export function seasonCommitStatus(
  commit: SeasonCommit | null,
  latestVersionNumber: number | null,
): SeasonCommitStatus {
  if (!commit) return 'none';
  if (latestVersionNumber === null) return 'current';
  return commit.committedVersion === latestVersionNumber ? 'current' : 'outdated';
}

export const SEASON_STATUS_LABELS: Record<SeasonCommitStatus, string> = {
  none: 'シーズン未反映',
  current: 'シーズン反映済み',
  outdated: 'シーズン反映は旧版のまま',
};
