import type { N01NextMatch } from '../../domain/n01/intelligence';
import type { N01Fixture, N01Tournament } from './types';
import { resolveDivision } from './divisionResolver';
import { entryById } from './teamResolver';

/**
 * Next match (MASTER SPEC Phase 2 §1).
 *
 * The team's fixtures in its current division that are not finished (`lg_result`) and
 * are not byes, earliest first. Two candidates on the same earliest date cannot be told
 * apart automatically and are returned for the captain to choose.
 *
 * A fixture dated before today with no result is usually a match whose result has not
 * been entered yet, so upcoming fixtures are preferred; an overdue one is only used when
 * nothing is upcoming. Dates are compared in JST (n01 is a Japanese service).
 */
export type NextMatchResolution =
  | { kind: 'resolved'; match: N01NextMatch }
  | { kind: 'ambiguous'; options: N01NextMatch[] }
  | { kind: 'none' };

const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

export function jstToday(now: number): string {
  return new Date(now + JST_OFFSET_MS).toISOString().slice(0, 10);
}

function compareFixtures(a: N01Fixture, b: N01Fixture): number {
  const da = a.date ?? '9999-99-99';
  const db = b.date ?? '9999-99-99';
  return da < db ? -1 : da > db ? 1 : a.listIndex - b.listIndex;
}

export function resolveNextMatch(
  schedule: readonly N01Fixture[],
  tournament: Pick<N01Tournament, 'divisions' | 'results' | 'entries'>,
  ourTeamId: string,
  now: number,
): NextMatchResolution {
  const division = resolveDivision(tournament, ourTeamId);
  const inDivision = (teamId: string): boolean => !division || division.teamIds.includes(teamId);
  const today = jstToday(now);

  const open = schedule.filter((fixture) => {
    if (fixture.awayTeamId === null) return false; // bye
    if (fixture.homeTeamId !== ourTeamId && fixture.awayTeamId !== ourTeamId) return false;
    if (!inDivision(fixture.homeTeamId) || !inDivision(fixture.awayTeamId)) return false;
    return !tournament.results.get(fixture.matchId)?.finished;
  });
  const upcoming = open.filter((fixture) => fixture.date === null || fixture.date >= today).sort(compareFixtures);
  const overdue = open.filter((fixture) => fixture.date !== null && fixture.date < today).sort(compareFixtures).reverse();
  const pool = upcoming.length > 0 ? upcoming : overdue;
  if (pool.length === 0) return { kind: 'none' };

  const toMatch = (fixture: N01Fixture): N01NextMatch => {
    const opponentTeamId = fixture.homeTeamId === ourTeamId ? (fixture.awayTeamId as string) : fixture.homeTeamId;
    return {
      matchId: fixture.matchId,
      title: fixture.title,
      date: fixture.date,
      ourTeamId,
      opponentTeamId,
      opponentName: entryById(tournament, opponentTeamId)?.name ?? opponentTeamId,
    };
  };

  const first = pool[0];
  const tied = first.date === null ? [first] : pool.filter((fixture) => fixture.date === first.date);
  if (tied.length > 1) return { kind: 'ambiguous', options: tied.map(toMatch) };
  return { kind: 'resolved', match: toMatch(first) };
}
