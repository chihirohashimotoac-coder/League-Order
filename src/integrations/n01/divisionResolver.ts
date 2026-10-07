import type { N01Division, N01Tournament } from './types';

/**
 * Division resolution (MASTER SPEC Phase 1 §9): the `lg_table` entry that lists the
 * team's `tpid`, with its `lg_title`. Re-run on every sync — teams move between
 * divisions from one season to the next.
 */
export function resolveDivision(tournament: Pick<N01Tournament, 'divisions'>, teamId: string): N01Division | null {
  return tournament.divisions.find((division) => division.teamIds.includes(teamId)) ?? null;
}
