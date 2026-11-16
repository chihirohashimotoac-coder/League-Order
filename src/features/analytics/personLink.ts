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

/**
 * What a row's member id says in its season: `unique` (one row, roster read), `shared` (two rows of
 * the season), `unproven` (an explicit id in a season whose roster could not be read), `guest` (a
 * shared label or none, roster read), `guest-unproven` (the same, roster not read).
 */
export type IdKind = 'unique' | 'shared' | 'unproven' | 'guest' | 'guest-unproven';

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
/**
 * Words a league is seen to put in the member id column for guests, besides the shared labels of
 * {@link isSharedLabel} (ATDO: 「助」「申請」). Analytics only, and only where several rows of one
 * season carry the word; order generation and sync keep their own rules. Compared normalised.
 */
const LABEL_WORDS: ReadonlySet<string> = new Set(['助', '申請'].map(normalizeName));

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

  // What a row's member id can tell. Only a shared label or no id at all enters the name-based pass
  // (rule 2); an explicit id that its season cannot prove (roster not read) or that two rows of its
  // season share is never treated as a shared label.
  const kindOf = new Map<string, IdKind>();
  const rosterRead = (season: SeasonData): boolean => season.coverage?.complete === true;
  for (const row of rows) {
    const season = seasonOf.get(row.seasonIndex)!;
    const guestLike = !row.opid || isSharedLabel(row.opid);
    kindOf.set(row.key, guestLike ? (rosterRead(season) ? 'guest' : 'guest-unproven') : usableId(row, season) ? 'unique' : rosterRead(season) ? 'shared' : 'unproven');
  }

  // 1. Same member id, oldest season first.
  const byId = new Map<string, PersonRow[]>();
  const loose: PersonRow[] = [];
  for (const row of rows) {
    const kind = kindOf.get(row.key)!;
    if (kind === 'unique') byId.set(row.opid!, [...(byId.get(row.opid!) ?? []), row]);
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
  const LOOSE_REASON: Record<Exclude<IdKind, 'unique'>, (row: PersonRow) => string> = {
    guest: (row) => (row.opid ? `共用の会員ID「${row.opid}」` : '会員IDなし'),
    'guest-unproven': (row) => `${row.opid ? `共用の会員ID「${row.opid}」` : '会員IDなし'}（この季の名簿を取得できず、該当者が1人と確認できない）`,
    shared: (row) => `会員ID ${row.opid}（この季で複数の行が同じIDを持つ）`,
    unproven: (row) => `会員ID ${row.opid}（この季の名簿を取得できず、1人を指すと確認できない）`,
  };
  for (const row of loose) {
    const kind = kindOf.get(row.key) as Exclude<IdKind, 'unique'>;
    single(row, kind === 'guest' || kind === 'guest-unproven' ? 'guest' : 'id', LOOSE_REASON[kind](row));
  }

  // 2. Rows without a usable id (or a spelling variant of one): same team, same full name, the next
  //    or previous season, one candidate only. Repeated so that a chain of seasons follows on.
  const looseKeys = new Set(loose.map((r) => r.key));
  /** Rows whose season cannot prove who they are (roster not read) or whose id two rows share. */
  const unprovable = (p: Person): boolean => p.rows.some((r) => { const k = kindOf.get(r.key); return k === 'guest-unproven' || k === 'unproven'; });
  /** Rows with no proven id of their own: a shared label, none, or an id two rows of the season share. */
  const noOwnId = (r: PersonRow): boolean => { const k = kindOf.get(r.key); return k === 'guest' || k === 'shared'; };
  const guestOnly = (p: Person): boolean => p.rows.every(noOwnId);
  /** The id spellings a person's rows carry (shared ids included), for the compatibility check. */
  // A word known to be used for guests (「助」「申請」, see LABEL_WORDS) that several rows of a season
  // share is a label like 助っ人. Anything else is an id, whatever its letters (ＡＢＣ１２３, MEMBER-ALPHA):
  // compared in its normalised spelling and kept apart from other ids.
  const labelLike = (r: PersonRow): boolean => !r.opid || isSharedLabel(r.opid) || (kindOf.get(r.key) === 'shared' && LABEL_WORDS.has(normalizeName(r.opid)));
  const spellings = (p: Person): Set<string> => new Set(p.rows.filter((r) => !labelLike(r)).map((r) => idSpelling(r.opid!)));
  const idOf = (p: Person): string | null => {
    const ids = new Set(p.rows.filter((r) => !looseKeys.has(r.key) && r.opid).map((r) => idSpelling(r.opid!)));
    return ids.size === 1 ? [...ids][0] : null;
  };
  // Holds made so far are final ones (same id, names that cannot be told apart; roster not read): no
  // automatic join goes into or out of them. The holds of this pass are provisional until it settles —
  // two 助っ人 rows of consecutive seasons first join each other, and then have one candidate.
  const finalHeld = new Set(held.keys());
  type Verdict = { join: Person } | { hold: Person[]; reason: string } | null;
  const evaluate = (unit: Person): Verdict => {
    const mineRows = unit.rows;
    if (mineRows.some((r) => unlinked.has(r.key) || finalHeld.has(r.key))) return null;
    // A row its season cannot prove (roster not read) joins nobody automatically: held when a candidate
    // with a compatible id is there.
    if (unprovable(unit)) {
      if (mineRows.length !== 1) return null;
      const m = mineRows[0];
      const kind = kindOf.get(m.key);
      const compatible = people.filter(
        (p) =>
          p !== unit &&
          !unprovable(p) &&
          !p.rows.some((r) => unlinked.has(r.key) || r.seasonIndex === m.seasonIndex) &&
          p.rows.some((r) => adjacent(r, m) && r.teamKey === m.teamKey && fullName(r.name) === fullName(m.name)) &&
          (kind === 'guest-unproven' || (m.opid !== null && idOf(p) === idSpelling(m.opid))),
      );
      return compatible.length > 0 ? { hold: compatible, reason: 'この季の名簿を取得できず、該当者が1人と確認できないため保留' } : null;
    }
    // A person of rows without an own id may join anyone whose ids are compatible; a person with a
    // proven id only someone whose id is the same id in another spelling.
    const unitId = guestOnly(unit) ? null : idOf(unit);
    if (unitId === null && !guestOnly(unit)) return null;
    const open = (p: Person): boolean => {
      if (p === unit) return false;
      // A row undone by hand, a final hold, or a person whose rows cannot be proven: never joined into.
      if (p.rows.some((r) => unlinked.has(r.key) || finalHeld.has(r.key))) return false;
      if (unprovable(p)) return false;
      const theirs = seasonsOf(p);
      return !mineRows.some((r) => theirs.has(r.seasonIndex));
    };
    const eligible = (p: Person): boolean => {
      if (!open(p)) return false;
      if (unitId !== null) return idOf(p) === unitId;
      // Rows without an own id carrying an explicit (shared) id join only someone whose ids are that id
      // in some spelling, or who has none: never a person under another member id.
      const mine = spellings(unit);
      if (mine.size === 0) return true;
      const theirsIds = spellings(p);
      return theirsIds.size === 0 || [...theirsIds].every((x) => mine.has(x));
    };
    const matches = (p: Person, near: (a: PersonRow, b: PersonRow) => boolean): boolean => mineRows.some((m) => p.rows.some((r) => near(r, m) && r.teamKey === m.teamKey && fullName(r.name) === fullName(m.name)));
    const candidates = people.filter((p) => eligible(p) && matches(p, adjacent));
    // Someone with the same name and team in the next season but another member id is a rival, not
    // nobody: with a rival the row is held (confirmable), never joined to the other candidate.
    const rivals = unitId === null ? people.filter((p) => open(p) && !eligible(p) && matches(p, adjacent)) : [];
    if (rivals.length > 0) return { hold: [...candidates, ...rivals], reason: '同じ氏名・チームで隣接する季に、会員IDの異なる候補がいるため保留' };
    if (candidates.length === 0) {
      // Only across a season that could not be read: not enough to say they follow on. Two people with
      // an id hold only the older one (the newer keeps its figures).
      const gap = people.filter((p) => eligible(p) && matches(p, acrossGap) && (unitId === null || newest(p).seasonIndex < newest(unit).seasonIndex));
      return gap.length > 0 ? { hold: gap, reason: '間の季を取得できず、隣接する季で確認できないため保留' } : null;
    }
    // Two people with an id: the older one joins the newer (the newest spelling names the person).
    if (unitId !== null && candidates.length === 1 && newest(candidates[0]).seasonIndex > newest(unit).seasonIndex) return null;
    // Nobody else answers to that name, in the row's season nor in the season of the row it follows on
    // (two 田中 健 next season — under other ids or teams — leave the match open).
    const sameName = (season: number, name: string, except: ReadonlySet<string>): boolean => rows.some((r) => r.seasonIndex === season && !except.has(r.key) && fullName(r.name) === fullName(name));
    const target = candidates.length === 1 ? candidates[0] : null;
    const theirRows = new Set(target?.rows.map((r) => r.key) ?? []);
    const crowded =
      mineRows.some((m) => sameName(m.seasonIndex, m.name, new Set([m.key]))) ||
      (!!target && mineRows.some((m) => target.rows.some((r) => adjacent(r, m) && r.teamKey === m.teamKey && fullName(r.name) === fullName(m.name) && sameName(r.seasonIndex, r.name, theirRows))));
    if (candidates.length > 1 || crowded) return { hold: candidates, reason: candidates.length > 1 ? '同じ氏名・チームで隣接する季の候補が複数あるため保留' : '同じ季（本人の季または結合先の季）に同じ氏名の行が複数あるため保留' };
    return { join: candidates[0] };
  };
  for (let changed = true; changed; ) {
    changed = false;
    for (const unit of [...people]) {
      if (!people.includes(unit)) continue;
      const verdict = evaluate(unit);
      if (!verdict || !('join' in verdict)) continue;
      const unitId = guestOnly(unit) ? null : idOf(unit);
      for (const m of unit.rows) {
        const basis: LinkBasis = unitId !== null ? 'id-variant' : 'guest';
        const label = !m.opid ? '会員IDなし' : labelLike(m) ? `共用の会員ID「${m.opid}」` : `会員ID ${m.opid}（この季で複数の行が共有）`;
        const reason = basis === 'id-variant' ? `会員IDの表記ゆれ（${m.opid}）・同じチーム・同じ氏名・隣接する季` : `${label}・同じチーム・同じ氏名・隣接する季で該当者が1人`;
        join(verdict.join, m, basis, reason, true);
      }
      people.splice(people.indexOf(unit), 1);
      changed = true;
    }
  }
  // What is still undecided once nothing more joins: held, with its candidates.
  for (const unit of people) {
    const verdict = evaluate(unit);
    if (!verdict || !('hold' in verdict)) continue;
    for (const m of unit.rows) if (!held.has(m.key)) held.set(m.key, { row: m, candidates: verdict.hold.map((c) => c.rows[0].key), reason: verdict.reason });
  }

  // Joins confirmed by hand.
  // The whole person of the confirmed row joins (several seasons held together come back together),
  // and every hold between the two is settled.
  for (const [rowKey, targetKey] of Object.entries(decisions.confirms)) {
    const from = personOf.get(rowKey);
    const to = personOf.get(targetKey);
    if (!from || !to || from === to) continue;
    const theirs = seasonsOf(to);
    if (from.rows.some((r) => theirs.has(r.seasonIndex))) continue;
    for (const r of from.rows) {
      join(to, r, 'confirmed', '内訳で本人と確認', true);
      held.delete(r.key);
    }
    for (const r of to.rows) held.delete(r.key);
    people.splice(people.indexOf(from), 1);
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
