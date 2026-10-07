import type { N01StableIdentity } from '../../domain/n01/types';
import { normalizeName } from '../../domain/n01/names';
import type { N01Division, N01Entry, N01Tournament } from './types';
import { resolveDivision } from './divisionResolver';

/**
 * Team resolution (docs/N01_MASTER_DESIGN.md §3.3).
 *
 * `tpid` changes every season, so a team is carried across seasons by its stable
 * identity — n01's own stable id when it gives one, otherwise the exact normalised name
 * inside the league. No fuzzy matching: a renamed team is not found, and the captain
 * picks it again.
 */

export function identityOfEntry(entry: N01Entry): N01StableIdentity {
  return { kind: 'name', value: normalizeName(entry.name) };
}

export function sameIdentity(a: N01StableIdentity, b: N01StableIdentity): boolean {
  return a.kind === b.kind && a.value === b.value;
}

/** Entries of the tournament that carry the identity (0, 1, or — for duplicate names — more). */
export function findTeamEntries(tournament: Pick<N01Tournament, 'entries'>, identity: N01StableIdentity): N01Entry[] {
  return tournament.entries.filter((entry) => sameIdentity(identityOfEntry(entry), identity));
}

export function entryById(tournament: Pick<N01Tournament, 'entries'>, teamId: string): N01Entry | undefined {
  return tournament.entries.find((entry) => entry.teamId === teamId);
}

/**
 * Teams offered in the team picker for a set of candidate seasons: one row per team
 * identity, listing the seasons it appears in, sorted by division then name.
 */
export interface TeamChoice {
  identity: N01StableIdentity;
  name: string;
  /** Seasons in which the team appears, with its tpid and division in each. */
  seasons: { tournamentId: string; tournamentTitle: string; teamId: string; division: N01Division | null }[];
}

export function teamChoices(tournaments: readonly N01Tournament[]): TeamChoice[] {
  const byKey = new Map<string, TeamChoice>();
  for (const tournament of tournaments) {
    for (const entry of tournament.entries) {
      const identity = identityOfEntry(entry);
      const key = `${identity.kind}:${identity.value}`;
      const choice = byKey.get(key) ?? { identity, name: entry.name, seasons: [] };
      choice.seasons.push({
        tournamentId: tournament.tournamentId,
        tournamentTitle: tournament.title,
        teamId: entry.teamId,
        division: resolveDivision(tournament, entry.teamId),
      });
      byKey.set(key, choice);
    }
  }
  return [...byKey.values()].sort((a, b) => {
    const da = a.seasons[0]?.division?.index ?? Number.MAX_SAFE_INTEGER;
    const db = b.seasons[0]?.division?.index ?? Number.MAX_SAFE_INTEGER;
    return da - db || a.name.localeCompare(b.name, 'ja');
  });
}
