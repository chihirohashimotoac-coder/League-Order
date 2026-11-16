import { isSharedLabel, isUsableOpid } from '../../domain/n01/identity';
import { normalizeName } from '../../domain/n01/names';
import type { SeasonData } from './seasonData';
import { teamKeys } from './seasonData';

/**
 * Who is the same person across the seasons of one league (⑨, 2026-11-18). Analytics only: the
 * order screens and the n01 sync keep `domain/n01/identity.ts` as it is.
 *
 * Rows are a season's stats rows and its registered roster rows (a member registered without a
 * stats row is still somebody to find). A season whose whole roster could not be read proves no id
 * (`sharedOpidSet` is "every id"): its rows stay on their own, as before.
 *
 * 1. **Same member id (`opid`)** in the league, in seasons where the id names one row: joined when
 *    the names agree (full name after `normalizeName`, spaces ignored). Surname and given name both
 *    different: two people (a member id passed on — ATDO `02-0035`: 藤崎 修 in 2024 3rd–2025 1st,
 *    橋本千尋 from 2026 2nd). Surname only changed: joined when the given name, the team and the
 *    seasons follow on (adjacent seasons, same team) and no other person of the id competes; otherwise
 *    held. A name whose surname / given-name split is not known (no space in any spelling of it in the
 *    league) is never split by guess: held.
 * 2. **No usable member id** (a shared label such as 助っ人, none, or a spelling variant of the same
 *    id, e.g. `02-065` / `02-0065`): a row joins a person only when, in the next or previous season,
 *    that person played for the same team under the same full name, nobody else in the row's season
 *    has that name, the person has no row in that season, and exactly one person qualifies. Several
 *    candidates or too little evidence: held (listed, confirmable by hand).
 *
 * Every automatic join of rule 2 and every surname change can be undone (`decisions.unlinks`), and a
 * held row can be joined by hand (`decisions.confirms`). An undone row is never joined again by the
 * automatic rules. Matching a person's figures with n01's totals (`reconstruct.ts`) is a separate step.
 */

export type LinkBasis = 'id' | 'rename' | 'guest' | 'id-variant' | 'confirmed';

export interface PersonRow {
  /** `<tdid>:<oid>` */
  key: string;
  tournamentId: string;
  title: string;
  seasonIndex: number;
  /**
   * The season's position in the period's window (failed seasons keep theirs): what "the next / the
   * previous season" is measured on. Equal to {@link seasonIndex} when no window is given.
   */
  position: number;
  oid: string;
  opid: string | null;
  name: string;
  teamId: string;
  teamKey: string;
  hasStats: boolean;
}

export interface LinkEntry {
  row: PersonRow;
  basis: LinkBasis;
  /** Why the row belongs to the person (shown in 本人照合). */
  reason: string;
  /** An automatic join that can be undone. */
  undoable: boolean;
}

export interface HeldRow {
  row: PersonRow;
  /** The people the row may belong to (person keys). */
  candidates: string[];
  reason: string;
}

export interface IdentityDecisions {
  /** Row keys a person undid: never joined automatically again. */
  unlinks: readonly string[];
  /** Held row key → a row key of the person it was confirmed to be. */
  confirms: Readonly<Record<string, string>>;
}

export const NO_DECISIONS: IdentityDecisions = { unlinks: [], confirms: {} };

export interface PeriodLinks {
  /** Row key → person key. */
  keyOf: Map<string, string>;
  /** Person key → its rows with the basis of each (newest season first). */
  people: Map<string, LinkEntry[]>;
  held: HeldRow[];
}

/** A name without spaces and case: 「橋本 千尋」 and 「橋本千尋」 are one spelling. */
export const fullName = (name: string): string => normalizeName(name).replace(/ /gu, '');

function splitOf(name: string): [string, string] | null {
  const parts = normalizeName(name).split(' ');
  return parts.length === 2 && parts[0] && parts[1] ? [parts[0], parts[1]] : null;
}

/** A member id's spelling without leading zeros in its numbers (`02-065` and `02-0065` are one id). */
export function idSpelling(opid: string): string {
  return normalizeName(opid).replace(/\d+/gu, (digits) => String(Number(digits)));
}

type Relation = 'same' | 'different' | 'surname-change' | 'unknown';

export function nameRelation(a: string, b: string, splits: ReadonlyMap<string, [string, string] | null>): Relation {
  if (fullName(a) === fullName(b)) return 'same';
  const sa = splitOf(a) ?? splits.get(fullName(a)) ?? null;
  const sb = splitOf(b) ?? splits.get(fullName(b)) ?? null;
  if (!sa || !sb) return 'unknown';
  if (sa[0] !== sb[0] && sa[1] !== sb[1]) return 'different';
  if (sa[0] !== sb[0] && sa[1] === sb[1]) return 'surname-change';
  return 'unknown';
}

interface Person {
  rows: PersonRow[];
  basis: Map<string, { basis: LinkBasis; reason: string; undoable: boolean }>;
}

const seasonsOf = (p: Person): Set<number> => new Set(p.rows.map((r) => r.seasonIndex));
const newest = (p: Person): PersonRow => p.rows.reduce((a, b) => (b.seasonIndex < a.seasonIndex ? b : a));
const usableId = (row: PersonRow, season: SeasonData): boolean => isUsableOpid(row.opid, season.sharedOpidSet);

/** The rows of the period: stats rows and registered roster rows, one per `(season, oid)`. */
export function periodRows(seasons: readonly SeasonData[], positions?: ReadonlyMap<string, number>): PersonRow[] {
  const teams = teamKeys(seasons);
  const rows: PersonRow[] = [];
  seasons.forEach((season, seasonIndex) => {
    const seen = new Set<string>();
    const add = (oid: string, opid: string | null, name: string, teamId: string, hasStats: boolean): void => {
      if (seen.has(oid)) return;
      seen.add(oid);
      rows.push({ key: `${season.tournamentId}:${oid}`, tournamentId: season.tournamentId, title: season.title, seasonIndex, position: positions?.get(season.tournamentId) ?? seasonIndex, oid, opid, name, teamId, teamKey: teams.get(`${season.tournamentId}:${teamId}`) ?? `team:${season.tournamentId}:${teamId}`, hasStats });
    };
    for (const p of season.players) add(p.oid, p.opid, p.name, p.teamId, true);
    for (const r of season.roster ?? []) add(r.oid, r.opid, r.name, r.teamId, false);
  });
  return rows;
}

/**
 * Links the rows of a period's seasons (newest first, one league) into people. Seasons whose roster
 * does not prove ids keep each row on its own.
 */
export function linkPeople(seasons: readonly SeasonData[], decisions: IdentityDecisions = NO_DECISIONS, positions?: ReadonlyMap<string, number>): PeriodLinks {
  const rows = periodRows(seasons, positions);
  const loadedPositions = new Set(rows.map((r) => r.position));
  /** Next / previous season; a season between them that could not be read makes them not adjacent. */
  const adjacent = (a: PersonRow, b: PersonRow): boolean => Math.abs(a.position - b.position) === 1;
  const acrossGap = (a: PersonRow, b: PersonRow): boolean => Math.abs(a.position - b.position) === 2 && !loadedPositions.has(Math.min(a.position, b.position) + 1);
  const seasonOf = new Map(seasons.map((s, i) => [i, s]));
  const unlinked = new Set(decisions.unlinks);
  // Splits known anywhere in the league's rows: 「橋本 千尋」 tells how to read 「橋本千尋」.
  const splits = new Map<string, [string, string] | null>();
  for (const row of rows) {
    const split = splitOf(row.name);
    if (!split) continue;
    const full = fullName(row.name);
    const known = splits.get(full);
    if (known === undefined) splits.set(full, split);
    else if (known && (known[0] !== split[0] || known[1] !== split[1])) splits.set(full, null); // two splits: none
  }

  const people: Person[] = [];
  const personOf = new Map<string, Person>();
  const held = new Map<string, HeldRow>();
  const single = (row: PersonRow, basis: LinkBasis = 'id', reason = 'この季の行'): Person => {
    const p: Person = { rows: [row], basis: new Map([[row.key, { basis, reason, undoable: false }]]) };
    people.push(p);
    personOf.set(row.key, p);
    return p;
  };
  const join = (p: Person, row: PersonRow, basis: LinkBasis, reason: string, undoable: boolean): void => {
    p.rows.push(row);
    p.basis.set(row.key, { basis, reason, undoable });
    personOf.set(row.key, p);
  };

  // 1. Same member id, oldest season first.
  const byId = new Map<string, PersonRow[]>();
  const loose: PersonRow[] = [];
  for (const row of rows) {
    const season = seasonOf.get(row.seasonIndex)!;
    if (usableId(row, season)) byId.set(row.opid!, [...(byId.get(row.opid!) ?? []), row]);
    else loose.push(row);
  }
  for (const [opid, group] of byId) {
    const inGroup: Person[] = [];
    for (const row of [...group].sort((a, b) => b.seasonIndex - a.seasonIndex)) {
      if (unlinked.has(row.key)) {
        inGroup.push(single(row, 'id', '本人照合を解除した行'));
        continue;
      }
      // An undone row stays alone: nobody joins it automatically either.
      const open = inGroup.filter((p) => !seasonsOf(p).has(row.seasonIndex) && !(p.rows.length === 1 && unlinked.has(p.rows[0].key)));
      const verdicts = open.map((p) => {
        const last = p.rows.reduce((a, b) => (b.seasonIndex < a.seasonIndex ? b : a));
        return { p, last, relation: nameRelation(last.name, row.name, splits) };
      });
      const same = verdicts.filter((v) => v.relation === 'same');
      if (same.length === 1) {
        join(same[0].p, row, 'id', `会員ID ${opid}・氏名が一致`, false);
        continue;
      }
      const renames = verdicts.filter((v) => v.relation === 'surname-change');
      const follows = (v: (typeof verdicts)[number]): boolean => adjacent(v.last, row) && v.last.teamKey === row.teamKey;
      if (same.length === 0 && renames.length === 1 && follows(renames[0]) && verdicts.every((v) => v === renames[0] || v.relation === 'different')) {
        join(renames[0].p, row, 'rename', `会員ID ${opid}・名「${(splitOf(row.name) ?? splits.get(fullName(row.name)))![1]}」が一致し、隣接する季に同じチーム（姓の変更）`, true);
        continue;
      }
      const unsure = verdicts.filter((v) => v.relation !== 'different');
      const own = single(row, 'id', `会員ID ${opid}`);
      inGroup.push(own);
      if (unsure.length > 0) {
        held.set(row.key, {
          row,
          candidates: unsure.map((v) => v.p.rows[0].key),
          reason:
            unsure.some((v) => v.relation === 'unknown')
              ? `同じ会員ID ${opid} の行と氏名が異なり、姓と名の区切りを確認できないため保留`
              : `同じ会員ID ${opid} の行と姓が異なり、所属・時系列の連続性を確認できないため保留`,
        });
      }
    }
  }
  for (const row of loose) single(row, isSharedLabel(row.opid) || !row.opid ? 'guest' : 'id', row.opid ? `会員ID ${row.opid}（この季では1人と確認できない）` : '会員IDなし');

  // 2. Rows without a usable id (or a spelling variant of one): same team, same full name, the next
  //    or previous season, one candidate only. Repeated so that a chain of seasons follows on.
  const looseKeys = new Set(loose.map((r) => r.key));
  const idOf = (p: Person): string | null => {
    const ids = new Set(p.rows.filter((r) => !looseKeys.has(r.key) && r.opid).map((r) => idSpelling(r.opid!)));
    return ids.size === 1 ? [...ids][0] : null;
  };
  for (let changed = true; changed; ) {
    changed = false;
    for (const unit of [...people]) {
      if (!people.includes(unit)) continue;
      const mineRows = unit.rows;
      if (mineRows.some((r) => unlinked.has(r.key))) continue;
      // A person of loose rows (no usable id) may join anyone; a person with an id only someone whose
      // id is the same id in another spelling.
      const unitId = mineRows.every((r) => looseKeys.has(r.key)) ? null : idOf(unit);
      if (unitId === null && !mineRows.every((r) => looseKeys.has(r.key))) continue;
      const eligible = (p: Person): boolean => {
        if (p === unit) return false;
        // A row undone by hand is never joined into, nor joined.
        if (p.rows.some((r) => unlinked.has(r.key))) return false;
        const theirs = seasonsOf(p);
        if (mineRows.some((r) => theirs.has(r.seasonIndex))) return false;
        return unitId === null || idOf(p) === unitId;
      };
      const matches = (p: Person, near: (a: PersonRow, b: PersonRow) => boolean): boolean => mineRows.some((m) => p.rows.some((r) => near(r, m) && r.teamKey === m.teamKey && fullName(r.name) === fullName(m.name)));
      const candidates = people.filter((p) => eligible(p) && matches(p, adjacent));
      if (candidates.length === 0) {
        // Only across a season that could not be read: not enough to say they follow on.
        const gap = people.filter((p) => eligible(p) && matches(p, acrossGap));
        if (gap.length > 0) for (const m of mineRows) if (!held.has(m.key)) held.set(m.key, { row: m, candidates: gap.map((c) => c.rows[0].key), reason: '間の季を取得できず、隣接する季で確認できないため保留' });
        continue;
      }
      // Two people with an id: the older one joins the newer (the newest spelling names the person).
      if (unitId !== null && candidates.length === 1 && newest(candidates[0]).seasonIndex > newest(unit).seasonIndex) continue;
      // Nobody else in the row's season answers to that name.
      const crowded = mineRows.some((m) => rows.some((r) => r.seasonIndex === m.seasonIndex && r.key !== m.key && fullName(r.name) === fullName(m.name)));
      if (candidates.length > 1 || crowded) {
        for (const m of mineRows) if (!held.has(m.key)) held.set(m.key, { row: m, candidates: candidates.map((c) => c.rows[0].key), reason: candidates.length > 1 ? '同じ氏名・チームで隣接する季の候補が複数あるため保留' : '同じ季に同じ氏名の行が複数あるため保留' });
        continue;
      }
      const target = candidates[0];
      for (const m of mineRows) {
        const basis: LinkBasis = unitId !== null ? 'id-variant' : 'guest';
        const reason = basis === 'id-variant' ? `会員IDの表記ゆれ（${m.opid}）・同じチーム・同じ氏名・隣接する季` : `${m.opid ? `共用の会員ID「${m.opid}」` : '会員IDなし'}・同じチーム・同じ氏名・隣接する季で該当者が1人`;
        join(target, m, basis, reason, true);
        held.delete(m.key);
      }
      people.splice(people.indexOf(unit), 1);
      changed = true;
    }
  }

  // Joins confirmed by hand.
  for (const [rowKey, targetKey] of Object.entries(decisions.confirms)) {
    const from = personOf.get(rowKey);
    const to = personOf.get(targetKey);
    if (!from || !to || from === to || from.rows.length !== 1) continue;
    if (seasonsOf(to).has(from.rows[0].seasonIndex)) continue;
    join(to, from.rows[0], 'confirmed', '内訳で本人と確認', true);
    people.splice(people.indexOf(from), 1);
    held.delete(rowKey);
  }

  // Person keys: a member id's newest person keeps `opid:<id>` (as before); everyone else is named by
  // their newest row.
  const keyOf = new Map<string, string>();
  const out = new Map<string, LinkEntry[]>();
  const takenIds = new Set<string>();
  const ordered = [...people].sort((a, b) => newest(a).seasonIndex - newest(b).seasonIndex);
  for (const p of ordered) {
    const top = newest(p);
    const id = [...p.rows].sort((a, b) => a.seasonIndex - b.seasonIndex).find((r) => !looseKeys.has(r.key) && r.opid)?.opid ?? null;
    let key: string;
    if (id && !takenIds.has(id)) {
      key = `opid:${id}`;
      takenIds.add(id);
    } else key = id ? `opid:${id}@${top.key}` : `oid:${top.tournamentId}:${top.oid}`;
    for (const r of p.rows) keyOf.set(r.key, key);
    out.set(
      key,
      [...p.rows].sort((a, b) => a.seasonIndex - b.seasonIndex).map((row) => ({ row, ...p.basis.get(row.key)! })),
    );
  }
  const heldOut = [...held.values()].map((h) => ({ ...h, candidates: [...new Set(h.candidates.map((k) => keyOf.get(k)!).filter(Boolean))] }));
  return { keyOf, people: out, held: heldOut };
}

/**
 * The period's seasons with each player's `personKey` from {@link linkPeople} (and `linkable` when the
 * person has rows in more than one season). Held rows leave `players` for `heldPlayers`.
 */
export function applyLinks(seasons: readonly SeasonData[], links: PeriodLinks): SeasonData[] {
  const held = new Set(links.held.map((h) => h.row.key));
  return seasons.map((season) => {
    const mine = (p: SeasonData['players'][number]) => held.has(`${season.tournamentId}:${p.oid}`);
    return {
      ...season,
      // A held row is out of every figure (rankings, averages, the player's own) until it is confirmed;
      // it stays listed in 本人照合.
      players: season.players.filter((p) => !mine(p)).map((p) => {
        const key = links.keyOf.get(`${season.tournamentId}:${p.oid}`) ?? p.personKey;
        const entries = links.people.get(key) ?? [];
        return { ...p, personKey: key, linkable: new Set(entries.map((e) => e.row.tournamentId)).size > 1 };
      }),
      heldPlayers: season.players.filter(mine),
    };
  });
}
