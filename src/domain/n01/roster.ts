import type { Player } from '../types';
import type { N01PlayerBinding, N01PprStats } from './types';
import { normalizeName } from './names';
import { isUsableOpid, sharedOpids } from './identity';
import { effectivePpr } from './effectivePpr';

/**
 * Roster sync (docs/N01_MASTER_DESIGN.md §4.2).
 *
 * | on n01  | locally | result                                                        |
 * |---------|---------|---------------------------------------------------------------|
 * | new     | —       | a player is added (Rating Unknown, PPR from n01)              |
 * | present | present | the n01 binding and the name are updated; local data is kept |
 * | gone    | present | `rosterActive = false`; the player is never deleted          |
 *
 * Matching, in order: an explicit choice made by the captain → `opid` → `oid` within
 * the same tournament → exact normalised name (only when unambiguous on both sides).
 * Nothing fuzzier. A player is never matched twice.
 *
 * The Rating, aptitudes, notes, season counts, archived flag and PPR source of an
 * existing player are carried over untouched: only `name` and `n01` are n01's.
 */

export interface RosterSourcePlayer {
  opid: string | null;
  oid: string;
  /** `tpid` of the team in this tournament. */
  teamId: string;
  name: string;
  stats: N01PprStats | null;
}

export interface RosterSyncInput {
  /** League Order team id the players belong to. */
  teamId: string;
  /** The team's current local players (linked or not). */
  localPlayers: readonly Player[];
  source: readonly RosterSourcePlayer[];
  tournamentId: string;
  now: number;
  newId: () => string;
  /**
   * Choices made by the captain when linking an existing team: source `oid` → local
   * player id, or `null` to add the n01 player as a new player.
   */
  explicit?: ReadonlyMap<string, string | null>;
  /**
   * n01's stats could not be read this sync: a matched player keeps the stats of the
   * local player it was matched with (by whichever rule above), instead of losing them.
   */
  retainStats?: boolean;
}

export interface RosterChange {
  playerId: string;
  name: string;
}

export interface RosterSyncResult {
  /** Every player record that changed or was created (to be upserted). */
  upserts: Player[];
  added: RosterChange[];
  /** Players that left the n01 roster this sync. */
  deactivated: RosterChange[];
  /** Players back on the roster after having left it. */
  reactivated: RosterChange[];
  renamed: { playerId: string; from: string; to: string }[];
  pprChanged: { playerId: string; name: string; from: number | null; to: number | null }[];
  /** n01 names that could not be matched automatically because they were ambiguous. */
  ambiguous: string[];
}

function bindingFor(source: RosterSourcePlayer, tournamentId: string, now: number): N01PlayerBinding {
  return {
    opid: source.opid,
    currentOid: source.oid,
    currentTpid: source.teamId,
    sourceName: source.name,
    rosterActive: true,
    lastSeenTournamentId: tournamentId,
    lastSeenAt: now,
    stats: source.stats,
  };
}

function countBy<T>(values: readonly T[]): Map<T, number> {
  const counts = new Map<T, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return counts;
}

/** The n01-side name a local player is known by (its n01 name when linked). */
function matchName(player: Player): string {
  return normalizeName(player.n01?.sourceName ?? player.name);
}

interface RosterMatch {
  /** Source `oid` → the local player it is matched with, or `null` for a new player. */
  matched: Map<string, Player | null>;
  used: Set<string>;
  ambiguous: string[];
}

function matchRoster(
  local: readonly Player[],
  source: readonly RosterSourcePlayer[],
  tournamentId: string,
  explicit: ReadonlyMap<string, string | null> | undefined,
): RosterMatch {
  const used = new Set<string>();
  const matched = new Map<string, Player | null>();
  const ambiguous: string[] = [];

  const sourceNameCounts = countBy(source.map((player) => normalizeName(player.name)));
  const localNameCounts = countBy(local.map(matchName));

  // 1. Explicit choices.
  for (const entry of source) {
    if (!explicit?.has(entry.oid)) continue;
    const target = explicit.get(entry.oid) ?? null;
    const player = target ? local.find((candidate) => candidate.id === target && !used.has(candidate.id)) : undefined;
    if (player) used.add(player.id);
    matched.set(entry.oid, player ?? null);
  }

  // 2. opid, 3. oid in the same tournament.
  //
  // An `opid` identifies a person only when it names one: shared by several people on the
  // n01 roster (or carried by several local players) it would hand one person's record to
  // whichever of them comes first. Those fall through to `oid`, then to the name.
  const sourceShared = sharedOpids(source);
  const localOpidCounts = countBy(local.flatMap((player) => (player.n01?.opid ? [player.n01.opid] : [])));
  for (const entry of source) {
    if (matched.has(entry.oid)) continue;
    const byOpid =
      isUsableOpid(entry.opid, sourceShared) && (localOpidCounts.get(entry.opid) ?? 0) === 1
        ? local.find((player) => !used.has(player.id) && player.n01?.opid === entry.opid)
        : undefined;
    const byOid =
      byOpid ??
      local.find(
        (player) =>
          !used.has(player.id) &&
          player.n01?.currentOid === entry.oid &&
          player.n01.lastSeenTournamentId === tournamentId,
      );
    if (byOid) {
      used.add(byOid.id);
      matched.set(entry.oid, byOid);
    }
  }

  // 4. Exact normalised name, only when unique on both sides.
  for (const entry of source) {
    if (matched.has(entry.oid)) continue;
    const key = normalizeName(entry.name);
    const candidates = local.filter(
      (player) =>
        !used.has(player.id) &&
        matchName(player) === key &&
        // A linked player with a different opid is a different person with the same name.
        !(entry.opid && player.n01?.opid && player.n01.opid !== entry.opid),
    );
    if (candidates.length === 1 && (sourceNameCounts.get(key) ?? 0) === 1 && (localNameCounts.get(key) ?? 0) === 1) {
      used.add(candidates[0].id);
      matched.set(entry.oid, candidates[0]);
    } else {
      if (candidates.length > 0) ambiguous.push(entry.name);
      matched.set(entry.oid, null);
    }
  }
  return { matched, used, ambiguous };
}

export function planRosterSync(input: RosterSyncInput): RosterSyncResult {
  const { tournamentId, now } = input;
  const local = input.localPlayers.filter((player) => player.teamId === input.teamId);
  const { matched, used, ambiguous } = matchRoster(local, input.source, tournamentId, input.explicit);

  const result: RosterSyncResult = {
    upserts: [],
    added: [],
    deactivated: [],
    reactivated: [],
    renamed: [],
    pprChanged: [],
    ambiguous,
  };

  let created = 0;
  for (const source of input.source) {
    const existing = matched.get(source.oid) ?? null;
    const binding = bindingFor(
      input.retainStats ? { ...source, stats: existing?.n01?.stats ?? null } : source,
      tournamentId,
      now,
    );
    if (!existing) {
      const player: Player = {
        id: input.newId(),
        teamId: input.teamId,
        name: source.name,
        rating: null,
        ppr: null,
        skills: {},
        seasonAppearances: 0,
        seasonAppearancesByKind: {},
        archived: false,
        createdAt: now + created,
        n01: binding,
      };
      created += 1;
      result.upserts.push(player);
      result.added.push({ playerId: player.id, name: player.name });
      continue;
    }

    const next: Player = { ...existing, name: source.name, n01: binding };
    if (existing.name !== source.name) {
      result.renamed.push({ playerId: existing.id, from: existing.name, to: source.name });
    }
    if (existing.n01 && !existing.n01.rosterActive) {
      result.reactivated.push({ playerId: existing.id, name: source.name });
    }
    // Compared on the effective value, so linking a hand-made player whose PPR now comes
    // from n01 is reported too.
    const before = effectivePpr(existing).value;
    const after = effectivePpr(next).value;
    if (before !== after) {
      result.pprChanged.push({ playerId: existing.id, name: source.name, from: before, to: after });
    }
    if (!sameBinding(existing.n01, binding) || existing.name !== source.name) {
      result.upserts.push(next);
    }
  }

  // Linked players no longer on the roster are kept, marked inactive.
  for (const player of local) {
    if (used.has(player.id) || !player.n01 || !player.n01.rosterActive) continue;
    const next: Player = { ...player, n01: { ...player.n01, rosterActive: false } };
    result.upserts.push(next);
    result.deactivated.push({ playerId: player.id, name: player.name });
  }

  return result;
}

/** Bindings equal apart from the "last seen" time (a no-op sync writes nothing). */
function sameBinding(a: N01PlayerBinding | undefined, b: N01PlayerBinding): boolean {
  if (!a) return false;
  return (
    a.opid === b.opid &&
    a.currentOid === b.currentOid &&
    a.currentTpid === b.currentTpid &&
    a.sourceName === b.sourceName &&
    a.rosterActive === b.rosterActive &&
    a.lastSeenTournamentId === b.lastSeenTournamentId &&
    sameStats(a.stats, b.stats)
  );
}

function sameStats(a: N01PprStats | null, b: N01PprStats | null): boolean {
  if (a === null || b === null) return a === b;
  return a.ppr === b.ppr && a.score === b.score && a.darts === b.darts && a.legs === b.legs && a.tournamentId === b.tournamentId;
}

/**
 * Suggested links for the "connect an existing team" screen: for each n01 player, the
 * local player it would be matched with automatically (opid on an already-linked
 * player, else a unique exact name), or `null` when the captain has to decide.
 */
export function suggestLinks(
  localPlayers: readonly Player[],
  source: readonly RosterSourcePlayer[],
): Map<string, string | null> {
  const { matched } = matchRoster(localPlayers, source, '', undefined);
  return new Map([...matched.entries()].map(([oid, player]) => [oid, player?.id ?? null]));
}
