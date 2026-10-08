import { normalizeName } from './names';

/**
 * Who is "the same person" in n01 data (docs/N01_MASTER_DESIGN.md §3.3).
 *
 * `opid` is n01's stable player id, and League Order follows a person across seasons by
 * it. It is not always one person's id: the real ATDO 2026 3rd roster lists two different
 * people under `02-0111`, and leagues reuse a single label (助っ人) for every guest. Two
 * rules keep that from mixing people up:
 *
 * 1. **Inside one season, `oid` is authoritative.** It is unique to the person in that
 *    tournament, so an exact `oid` match beats any `opid` match.
 * 2. **An `opid` links seasons only when it names one person in every season involved.**
 *    "One person" is judged inside a single season's rows (stats, rosters, orders): the
 *    same `opid` on rows with different normalised names is shared. The same `opid` with
 *    different names in *different* seasons is a rename, and is followed.
 *
 * Nothing here guesses. A shared `opid` is never resolved to a person; the people who
 * carry it are told apart by `oid` in their own season and have no history beyond it.
 */

export interface IdentityRef {
  opid: string | null;
  oid: string | null;
  name: string | null;
}

/** Strings leagues put in the opid column to mean "a guest", not a person. Compared normalised. */
const SHARED_LABELS: readonly string[] = ['助っ人', '助人', 'ゲスト', 'guest', 'helper', '代打'];
const SHARED_LABEL_SET: ReadonlySet<string> = new Set(SHARED_LABELS.map(normalizeName));

/** True for a label shared by many guests rather than one person's id. */
export function isSharedLabel(opid: string | null | undefined): boolean {
  return !!opid && SHARED_LABEL_SET.has(normalizeName(opid));
}

/**
 * The `opid`s that name more than one person among these rows (one season's worth):
 * the same `opid` on rows whose names differ after normalisation. A row without a name
 * cannot tell people apart and is ignored.
 */
export function sharedOpids(rows: Iterable<IdentityRef>): Set<string> {
  const peopleByOpid = new Map<string, Set<string>>();
  for (const row of rows) {
    if (!row.opid) continue;
    const people = peopleByOpid.get(row.opid) ?? new Set<string>();
    const name = row.name ? normalizeName(row.name) : '';
    if (name) people.add(name);
    peopleByOpid.set(row.opid, people);
  }
  const shared = new Set<string>();
  for (const [opid, people] of peopleByOpid) {
    if (people.size > 1 || isSharedLabel(opid)) shared.add(opid);
  }
  return shared;
}

/** True when `opid` can be used to recognise a person: it is present and not shared. */
export function isUsableOpid(opid: string | null | undefined, ...shared: (ReadonlySet<string> | undefined)[]): opid is string {
  if (!opid || isSharedLabel(opid)) return false;
  return shared.every((set) => !set?.has(opid));
}

export function unionOf(...sets: (ReadonlySet<string> | undefined)[]): Set<string> {
  const result = new Set<string>();
  for (const set of sets) for (const value of set ?? []) result.add(value);
  return result;
}
