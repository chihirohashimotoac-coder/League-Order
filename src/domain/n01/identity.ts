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
 * 2. **An `opid` links seasons only when it provably names one person in every season
 *    involved.** "One person" is judged inside a single season's rows (the season's whole
 *    roster first, then stats and orders — stats and orders only show who played): the
 *    same `opid` on rows with different normalised names, or with different
 *    `oid`s, is shared. The same `opid` with different names in *different* seasons is a
 *    rename, and is followed (every season has its own `oid`s, so those never count).
 *
 * A season whose whole roster could not be read proves nothing ({@link unprovenOpids}).
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
 * The `opid`s that do not provably name one person among these rows (one season's worth):
 *
 * - the same `opid` on rows whose names differ after normalisation (a row without a name
 *   cannot tell people apart and is ignored); or
 * - the same `opid` on rows with different `oid`s, **even under one name**. Two people can
 *   share a name and be handed one `opid`, and the rows cannot show whether the second `oid`
 *   is a namesake or the same person (the real ATDO 2026 3rd roster has two rows named
 *   西俣 太陽 under `02-0109`, `alpp` and `gm3v`, with stats for `gm3v` only; whether they are
 *   one person is not established). Joining them would risk lending one person's numbers to
 *   another, so they are not joined; each `oid` keeps its own row of the season and nothing
 *   is followed across seasons through the `opid`. If they were one person, the cost is that
 *   the other `oid` gets no stats or history. A row without an `oid` cannot show a second
 *   one and is ignored.
 */
export function sharedOpids(rows: Iterable<IdentityRef>): Set<string> {
  const peopleByOpid = new Map<string, { names: Set<string>; oids: Set<string> }>();
  for (const row of rows) {
    if (!row.opid) continue;
    const seen = peopleByOpid.get(row.opid) ?? { names: new Set<string>(), oids: new Set<string>() };
    const name = row.name ? normalizeName(row.name) : '';
    if (name) seen.names.add(name);
    if (row.oid) seen.oids.add(row.oid);
    peopleByOpid.set(row.opid, seen);
  }
  const shared = new Set<string>();
  for (const [opid, seen] of peopleByOpid) {
    if (seen.names.size > 1 || seen.oids.size > 1 || isSharedLabel(opid)) shared.add(opid);
  }
  return shared;
}

/** True when `opid` can be used to recognise a person: it is present and not shared. */
export function isUsableOpid(opid: string | null | undefined, ...shared: (ReadonlySet<string> | undefined)[]): opid is string {
  if (!opid || isSharedLabel(opid)) return false;
  return shared.every((set) => !set?.has(opid));
}

/** Stands for "every `opid`": {@link unprovenOpids}. */
class EveryOpid extends Set<string> {
  override has(): boolean {
    return true;
  }
}

/**
 * The shared set of a season whose whole roster could not be read. With nothing to show
 * that an `opid` names one person there, no `opid` is trusted in that season: it joins
 * nothing across seasons. The season's own `oid`s still match inside it, and people with
 * no history are left to the low-confidence fallback — never to a namesake's numbers.
 */
export function unprovenOpids(): ReadonlySet<string> {
  return new EveryOpid();
}

export function unionOf(...sets: (ReadonlySet<string> | undefined)[]): Set<string> {
  const result = new Set<string>();
  for (const set of sets) for (const value of set ?? []) result.add(value);
  return result;
}
