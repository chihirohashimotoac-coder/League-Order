import type { N01TournamentSummary } from './types';
import { N01_STATUS } from './types';

/**
 * Season (tournament) resolution (docs/N01_MASTER_DESIGN.md §3.2).
 *
 * Re-run on every sync, because the "current season" is a moving target:
 *
 *   1. tournaments in progress (status 30),
 *   2. otherwise tournaments building their bracket (status 25),
 *   3. otherwise tournaments open for entry (status 20),
 *   4. otherwise the latest finished tournament (status 40).
 *
 * A status 25 / 20 tournament counts only when it is newer than the latest finished
 * one: n01 keeps stale ones around (e.g. an organiser's test tournament left at 25), and
 * those must not hide the latest finished season.
 *
 * The title is never parsed ("2026 3rd" says nothing reliable). When a priority group
 * holds more than one tournament, the caller narrows it by team membership, and only if
 * that still leaves several does the captain choose.
 */

/** Newest first: by `startedAt` (`t_date` → start date → `createTime`), otherwise by list order. */
export function newestFirst(list: readonly N01TournamentSummary[]): N01TournamentSummary[] {
  return [...list].sort((a, b) => {
    if (a.startedAt !== null && b.startedAt !== null && a.startedAt !== b.startedAt) {
      return b.startedAt - a.startedAt;
    }
    if (a.startedAt !== null && b.startedAt === null) return -1;
    if (a.startedAt === null && b.startedAt !== null) return 1;
    // Undated: n01's list order is all there is.
    return a.listIndex - b.listIndex;
  });
}

/**
 * Candidate groups in priority order; empty groups are omitted. The finished group holds
 * only the latest finished tournament.
 */
export function seasonPriorityGroups(list: readonly N01TournamentSummary[]): N01TournamentSummary[][] {
  const ordered = newestFirst(list);
  const finished = ordered.filter((t) => t.status === N01_STATUS.FINISHED).slice(0, 1);
  const latestFinished = finished[0];
  // Upcoming = newer than the latest finished season. Undated on either side cannot be
  // shown to be stale, so it stays a candidate.
  const upcoming = (t: N01TournamentSummary): boolean =>
    !latestFinished || t.startedAt === null || latestFinished.startedAt === null || t.startedAt > latestFinished.startedAt;
  const running = ordered.filter((t) => t.status === N01_STATUS.RUNNING);
  const bracket = ordered.filter((t) => t.status === N01_STATUS.BRACKET && upcoming(t));
  const open = ordered.filter((t) => t.status === N01_STATUS.OPEN && upcoming(t));
  return [running, bracket, open, finished].filter((group) => group.length > 0);
}

/**
 * Seasons before `current` in the same league, newest first, at most `depth`.
 * Only finished or running tournaments count as history.
 */
export function previousSeasons(
  list: readonly N01TournamentSummary[],
  currentId: string,
  depth: number,
): N01TournamentSummary[] {
  if (depth <= 0) return [];
  const ordered = newestFirst(list);
  const index = ordered.findIndex((t) => t.tournamentId === currentId);
  const older = index >= 0 ? ordered.slice(index + 1) : ordered.filter((t) => t.tournamentId !== currentId);
  return older
    .filter((t) => t.status === N01_STATUS.FINISHED || t.status === N01_STATUS.RUNNING)
    .slice(0, depth);
}

export type SeasonPick =
  | { kind: 'resolved'; tournamentId: string }
  | { kind: 'ambiguous'; tournamentIds: string[] }
  | { kind: 'notFound' };

/**
 * Walks the priority groups and returns the first group's tournaments that contain the
 * team. `contains` is answered by the caller from each tournament's entry list.
 */
export function pickSeasonByMembership(
  groups: readonly N01TournamentSummary[][],
  contains: (tournamentId: string) => boolean,
): SeasonPick {
  for (const group of groups) {
    const matching = group.filter((t) => contains(t.tournamentId)).map((t) => t.tournamentId);
    if (matching.length === 1) return { kind: 'resolved', tournamentId: matching[0] };
    if (matching.length > 1) return { kind: 'ambiguous', tournamentIds: matching };
  }
  return { kind: 'notFound' };
}
