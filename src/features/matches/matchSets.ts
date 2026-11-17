import type { GameRow, LiveState } from './parse';

/**
 * The sets of one set-format match (`scid`, n01 manual §2/§4.1: 1 set = 1 match data, grouped
 * by the same `scid`), as the full-page 観戦 shows them: in n01's order, each with its own name,
 * players, legs and result — and the sets won so far, kept apart from any one set's result.
 *
 * Two sources, never mixed within one set:
 * - `match/list` by `scid` (the published sets; refreshed less often, may lag behind);
 * - `match/live` by `scid` (the latest set, refreshed every 1.5 s).
 * The latest set's figures come from the live state whenever it is about that set; a set the
 * list does not hold yet is shown from the live state alone.
 */

export interface MatchSet {
  mid: string;
  /** n01's set position (0-based `currentSet`), `null` when n01 gave none. */
  position: number | null;
  /** 「ダブルス1」: the part of the title that tells the sets apart, else 「第Nセット」 (n01's set order). */
  label: string;
  title: string;
  /** Players of this set, left and right. */
  names: [string, string];
  /** Legs won in this set (not sets). */
  legs: [number, number] | null;
  /** This set's winner (0 / 1), -1 for a drawn set, `null` while it is played or unknown. */
  winner: 0 | 1 | -1 | null;
  finished: boolean;
  /** The set the live poller is on. */
  live: boolean;
  cricket: boolean;
  /** Read from the live state only (the list does not hold it yet). */
  fromLive: boolean;
}

export interface MatchSetsView {
  sets: MatchSet[];
  /** The title shared by the sets (the match), without the set's own name. */
  matchTitle: string;
  /** Sets won so far over the whole match (left, right), `null` when n01 says nothing. */
  setsWon: [number, number] | null;
}

const sideName = (side: { name: string; members: string[] }): string => side.members.join(' / ') || side.name;

/**
 * n01's order: the set position, then the start time, then the id (never the list's order). Each
 * row gets its place up front, so the order is the same whatever order the rows come in: a set
 * with no position goes just after the last set with one that started no later than it, and a
 * set with neither (known from the live state only) after every set that has a start time.
 */
export function orderSets(rows: readonly GameRow[]): GameRow[] {
  const anchors = rows.filter((row) => row.currentSet != null && row.startTime != null);
  const place = (row: GameRow): number => {
    if (row.currentSet != null) return row.currentSet;
    if (row.startTime == null) return Number.POSITIVE_INFINITY;
    const before = anchors.filter((anchor) => anchor.startTime! <= row.startTime!).map((anchor) => anchor.currentSet!);
    return (before.length ? Math.max(...before) : -1) + 0.5;
  };
  const start = (row: GameRow): number => row.startTime ?? Number.POSITIVE_INFINITY;
  const keyed = rows.map((row) => ({ row, place: place(row), start: start(row) }));
  keyed.sort((a, b) => {
    if (a.place !== b.place) return a.place < b.place ? -1 : 1;
    if (a.start !== b.start) return a.start < b.start ? -1 : 1;
    return a.row.mid < b.row.mid ? -1 : a.row.mid > b.row.mid ? 1 : 0;
  });
  return keyed.map((entry) => entry.row);
}

/** The longest start shared by every title, cut back to a word boundary. */
export function sharedTitle(titles: readonly string[]): string {
  const distinct = [...new Set(titles.filter(Boolean))];
  if (distinct.length < 2) return '';
  let prefix = distinct[0];
  for (const title of distinct.slice(1)) {
    let i = 0;
    while (i < prefix.length && i < title.length && prefix[i] === title[i]) i += 1;
    prefix = prefix.slice(0, i);
  }
  // Only whole words: 「… ダブルス1」 / 「… ダブルス2」 share 「… 」, not 「… ダブルス」.
  const cut = prefix.search(/\s\S*$/u);
  return cut >= 0 ? prefix.slice(0, cut + 1) : '';
}

/**
 * A word that names a game of a set-format match (「シングルス1」「ダブルス 2」「トリオス1」「Set 3」):
 * a known kind of game, optionally numbered. Only such a word is taken off the end of a title
 * when nothing else tells the set's name apart (one title only: n01 has no separate field for
 * it — match/get carries no orgTitle, checked 2026-11-17). A team name that ends in a number
 * (「Team2」) is not one: the title is then kept whole.
 */
const SET_NAME = /^(?:シングルス|ダブルス|トリオス|トリプルス|クアトロ|カルテット|クリケット|ゼロワン|セット|Singles?|Doubles?|Trios?|Triples?|Set)\s*\d*$/iu;

/** The set's name at the end of a title, or `''` when there is no evidence of one. */
export function setNameAtEnd(title: string): string {
  const trimmed = title.trim();
  const match = /(?:^|\s)(\S+(?:\s\d+)?)$/u.exec(trimmed);
  if (!match) return '';
  const word = match[1];
  return word !== trimmed && SET_NAME.test(word) ? word : '';
}

function winnerOf(legs: [number, number] | null, finished: boolean): 0 | 1 | -1 | null {
  if (!finished || !legs) return null;
  if (legs[0] === legs[1]) return -1;
  return legs[0] > legs[1] ? 0 : 1;
}

const legsOf = (row: GameRow): [number, number] | null =>
  row.sides[0].legsWon !== null && row.sides[1].legsWon !== null ? [row.sides[0].legsWon, row.sides[1].legsWon] : null;

/**
 * `held`: the last live state seen of each earlier set (the poller moved on from it). Until the
 * list holds a set as far on as that state, the set is shown from it — a set seen ending never
 * goes back to the list's older 「未終了」.
 */
export function matchSetsView(rows: readonly GameRow[], live: LiveState | null, fallbackTitle = '', held: ReadonlyMap<string, LiveState> = new Map()): MatchSetsView {
  // A row read without `currentSet` (`match/list` by `mid`) takes the position the live state of
  // the same set gave, before the sets are ordered (n01's position first, the start time only
  // when neither has one).
  const positionOf = (mid: string): number | null => (live?.mid === mid ? live.currentSet : null) ?? held.get(mid)?.currentSet ?? null;
  const ordered = orderSets(rows.map((row) => (row.currentSet == null && positionOf(row.mid) !== null ? { ...row, currentSet: positionOf(row.mid) } : row)));
  const titles = [...ordered.map((row) => row.title), ...(live ? [live.title] : [])];
  const shared = sharedTitle(titles);
  const label = (title: string, position: number | null, index: number): string => {
    const own = shared && title.startsWith(shared) ? title.slice(shared.length).trim() : shared ? '' : setNameAtEnd(title);
    return own || `第${(position ?? index) + 1}セット`;
  };
  const sets: MatchSet[] = ordered.map((row, index) => {
    const isLive = live !== null && live.mid === row.mid;
    const seen = held.get(row.mid);
    // An earlier set's last live state, while the list is behind it (older, or not over yet).
    const kept = !isLive && seen && (!row.finished || row.updateTime === null || seen.updateTime > row.updateTime) ? seen : null;
    const state = isLive ? live : kept;
    if (state) {
      const legs: [number, number] = [state.legs[0], state.legs[1]];
      return {
        mid: row.mid,
        position: state.currentSet ?? row.currentSet ?? null,
        label: label(state.title || row.title, state.currentSet ?? row.currentSet ?? null, index),
        title: state.title || row.title,
        names: [sideName(state.sides[0]), sideName(state.sides[1])],
        legs,
        winner: winnerOf(legs, state.gameEnded),
        finished: state.gameEnded,
        live: isLive,
        cricket: state.matchType === 'cricket',
        fromLive: false,
      };
    }
    const legs = legsOf(row);
    const position = row.currentSet ?? null;
    return {
      mid: row.mid,
      position,
      label: label(row.title, position, index),
      title: row.title,
      names: [row.sides[0].members.map((m) => m.name).join(' / ') || row.sides[0].name, row.sides[1].members.map((m) => m.name).join(' / ') || row.sides[1].name],
      legs,
      winner: winnerOf(legs, row.finished),
      finished: row.finished,
      live: false,
      cricket: row.matchType === 'cricket',
      fromLive: false,
    };
  });
  if (live && !sets.some((set) => set.mid === live.mid)) {
    const legs: [number, number] = [live.legs[0], live.legs[1]];
    const entry: MatchSet = {
      mid: live.mid,
      position: live.currentSet,
      label: label(live.title, live.currentSet, sets.length),
      title: live.title,
      names: [sideName(live.sides[0]), sideName(live.sides[1])],
      legs,
      winner: winnerOf(legs, live.gameEnded),
      finished: live.gameEnded,
      live: true,
      cricket: live.matchType === 'cricket',
      fromLive: true,
    };
    // In n01's order: before the first listed set with a later position, else last.
    const at = live.currentSet === null ? -1 : sets.findIndex((set) => set.position !== null && set.position > live.currentSet!);
    if (at < 0) sets.push(entry);
    else sets.splice(at, 0, entry);
  }
  const only = live?.title || ordered[ordered.length - 1]?.title || fallbackTitle;
  const word = setNameAtEnd(only);
  const matchTitle = shared.trim() || (word ? only.trim().slice(0, -word.length).trim() : only);
  let setsWon: [number, number] | null = null;
  if (live && live.showSets) setsWon = [live.sets[0], live.sets[1]];
  else {
    const last = ordered[ordered.length - 1];
    if (last && last.sides[0].setsWon !== null && last.sides[1].setsWon !== null) setsWon = [last.sides[0].setsWon, last.sides[1].setsWon];
  }
  return { sets, matchTitle, setsWon };
}
