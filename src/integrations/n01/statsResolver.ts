import type { N01PprStats } from '../../domain/n01/types';
import { pprFromStats } from '../../domain/n01/effectivePpr';
import type { N01PlayerStats } from './types';

/**
 * Stats lookup (docs/N01_MASTER_DESIGN.md §2, MASTER SPEC Phase 1 §8).
 *
 * A player's row is found by `opid` first (stable), then by `oid` (this tournament).
 * PPR is `score / darts * 3`; no darts → `null`; no row → no stats at all. Neither is
 * ever turned into a 0.
 */
export interface StatsIndex {
  byOpid: Map<string, N01PlayerStats>;
  byOid: Map<string, N01PlayerStats>;
}

export function indexStats(stats: readonly N01PlayerStats[]): StatsIndex {
  const byOpid = new Map<string, N01PlayerStats>();
  const byOid = new Map<string, N01PlayerStats>();
  for (const row of stats) {
    if (row.opid && !byOpid.has(row.opid)) byOpid.set(row.opid, row);
    if (row.oid && !byOid.has(row.oid)) byOid.set(row.oid, row);
  }
  return { byOpid, byOid };
}

export function statsFor(index: StatsIndex, player: { opid: string | null; oid: string | null }): N01PlayerStats | null {
  if (player.opid) {
    const row = index.byOpid.get(player.opid);
    if (row) return row;
  }
  if (player.oid) return index.byOid.get(player.oid) ?? null;
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
