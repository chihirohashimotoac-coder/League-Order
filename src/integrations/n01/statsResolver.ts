import type { N01PprStats } from '../../domain/n01/types';
import { pprFromStats } from '../../domain/n01/effectivePpr';
import { isUsableOpid, sharedOpids, type IdentityRef } from '../../domain/n01/identity';
import type { N01PlayerStats } from './types';

/**
 * Stats lookup (docs/N01_MASTER_DESIGN.md §2, MASTER SPEC Phase 1 §8).
 *
 * The rows and the people being looked up belong to ONE tournament. Inside it a player's
 * row is found by `oid` first (unique to the person in that tournament), then by `opid` —
 * but only an `opid` that names one person there (see `domain/n01/identity.ts`). A shared
 * `opid` finds nothing rather than a namesake's numbers.
 *
 * PPR is `score / darts * 3`; no darts → `null`; no row → no stats at all. Neither is
 * ever turned into a 0.
 */
export interface StatsIndex {
  byOpid: Map<string, N01PlayerStats>;
  byOid: Map<string, N01PlayerStats>;
  /** `opid`s shared by several people in this tournament's rows (and roster, when given). */
  shared: ReadonlySet<string>;
}

/**
 * `identities` are the other rows of the same tournament that carry an `opid` (the
 * roster being resolved): a roster can reveal that an `opid` is shared even when only one
 * of its owners has a stats row.
 */
export function indexStats(stats: readonly N01PlayerStats[], identities: readonly IdentityRef[] = []): StatsIndex {
  const byOpid = new Map<string, N01PlayerStats>();
  const byOid = new Map<string, N01PlayerStats>();
  for (const row of stats) {
    if (row.opid && !byOpid.has(row.opid)) byOpid.set(row.opid, row);
    if (row.oid && !byOid.has(row.oid)) byOid.set(row.oid, row);
  }
  return { byOpid, byOid, shared: sharedOpids([...stats, ...identities]) };
}

export function statsFor(index: StatsIndex, player: { opid: string | null; oid: string | null }): N01PlayerStats | null {
  if (player.oid) {
    const row = index.byOid.get(player.oid);
    if (row) return row;
  }
  if (isUsableOpid(player.opid, index.shared)) return index.byOpid.get(player.opid) ?? null;
  return null;
}

export function toPprStats(row: N01PlayerStats, tournamentId: string, syncedAt: number): N01PprStats {
  return {
    ppr: pprFromStats(row.score, row.darts),
    score: row.score,
    darts: row.darts,
    legs: row.legs,
    tournamentId,
    syncedAt,
  };
}
