import type { RosterSourcePlayer } from '../../domain/n01/roster';
import type { N01PlayerStats, N01RosterPlayer } from './types';
import { indexStats, statsFor, toPprStats } from './statsResolver';

/**
 * Roster resolution (MASTER SPEC Phase 1 §6–§8): n01's `team/player/list` joined with
 * the tournament's `player_stats_list`, in the shape the domain roster planner reads.
 *
 * Duplicate rows for the same `oid` are collapsed (first wins) so one person can never
 * be added twice by a repeated row.
 */
export function rosterSource(
  roster: readonly N01RosterPlayer[],
  stats: readonly N01PlayerStats[],
  tournamentId: string,
  now: number,
): RosterSourcePlayer[] {
  // The roster is part of the evidence: it shows an `opid` is shared even when only one of
  // the people who carry it has a stats row.
  const index = indexStats(stats, roster);
  const seen = new Set<string>();
  const result: RosterSourcePlayer[] = [];
  for (const player of roster) {
    if (seen.has(player.oid)) continue;
    seen.add(player.oid);
    const row = statsFor(index, player);
    result.push({
      opid: player.opid,
      oid: player.oid,
      teamId: player.teamId,
      name: player.name,
      stats: row ? toPprStats(row, tournamentId, now) : null,
    });
  }
  return result;
}
