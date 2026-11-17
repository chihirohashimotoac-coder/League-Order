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
  /** 「ダブルス1」: the part of the title that tells the sets apart, else 「第 N セット」. */
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

/** n01's order: the set position, then the start time, then the id (never the list's order). */
export function orderSets(rows: readonly GameRow[]): GameRow[] {
  return [...rows].sort((a, b) => {
    const pa = a.currentSet ?? null;
    const pb = b.currentSet ?? null;
    if (pa !== null && pb !== null && pa !== pb) return pa - pb;
    const sa = a.startTime ?? 0;
    const sb = b.startTime ?? 0;
    if (sa !== sb) return sa - sb;
    return a.mid < b.mid ? -1 : a.mid > b.mid ? 1 : 0;
  });
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
 * With one title only (the first set, before the next exists), nothing tells the set's own name
 * apart from the match's: n01 has no separate field for it (match/get carries no orgTitle; checked
 * 2026-11-17). The last word is taken when it ends in a number (「シングルス1」「Set3」), else none.
 */
function lastNumberedWord(title: string): string {
  const words = title.trim().split(/\s+/u);
  const last = words[words.length - 1] ?? '';
  return words.length > 1 && /\d$/u.test(last) ? last : '';
}

function winnerOf(legs: [number, number] | null, finished: boolean): 0 | 1 | -1 | null {
  if (!finished || !legs) return null;
  if (legs[0] === legs[1]) return -1;
  return legs[0] > legs[1] ? 0 : 1;
}

const legsOf = (row: GameRow): [number, number] | null =>
  row.sides[0].legsWon !== null && row.sides[1].legsWon !== null ? [row.sides[0].legsWon, row.sides[1].legsWon] : null;

export function matchSetsView(rows: readonly GameRow[], live: LiveState | null, fallbackTitle = ''): MatchSetsView {
  const ordered = orderSets(rows);
  const titles = [...ordered.map((row) => row.title), ...(live ? [live.title] : [])];
  const shared = sharedTitle(titles);
  const label = (title: string, position: number | null, index: number): string => {
    const own = shared && title.startsWith(shared) ? title.slice(shared.length).trim() : shared ? '' : lastNumberedWord(title);
    return own || `第 ${(position ?? index) + 1} セット`;
  };
  const sets: MatchSet[] = ordered.map((row, index) => {
    const isLive = live !== null && live.mid === row.mid;
    if (isLive) {
      const legs: [number, number] = [live.legs[0], live.legs[1]];
      return {
        mid: row.mid,
        position: live.currentSet ?? row.currentSet ?? null,
        label: label(live.title || row.title, live.currentSet ?? row.currentSet ?? null, index),
        title: live.title || row.title,
        names: [sideName(live.sides[0]), sideName(live.sides[1])],
        legs,
        winner: winnerOf(legs, live.gameEnded),
        finished: live.gameEnded,
        live: true,
        cricket: live.matchType === 'cricket',
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
  const word = lastNumberedWord(only);
  const matchTitle = shared.trim() || (word ? only.trim().slice(0, -word.length).trim() : only);
  let setsWon: [number, number] | null = null;
  if (live && live.showSets) setsWon = [live.sets[0], live.sets[1]];
  else {
    const last = ordered[ordered.length - 1];
    if (last && last.sides[0].setsWon !== null && last.sides[1].setsWon !== null) setsWon = [last.sides[0].setsWon, last.sides[1].setsWon];
  }
  return { sets, matchTitle, setsWon };
}
