/**
 * A made-up set-format n01 Live match (one `scid`, one `mid` per set), test- and preview-only:
 * four sets — シングルス1, ダブルス1, ダブルス2, シングルス2 — played one after another, outside any
 * competition (no `tdid`), the shape checked against n01 on 2026-11-16 (Light League: 11 sets of
 * one `scid`, the set's name at the end of the title, `currentSet` 0…10, `winSets` the running
 * total, `endSchedule` on the last set only).
 *
 * The match is driven by a phase number: phase 2k = set k in play (its last leg under way),
 * phase 2k + 1 = set k over and the next not started yet; the last odd phase is the end of the
 * match (`end_schedule` 1). Every reply is computed from the phase, so a test or the preview
 * moves the match on by moving the phase.
 *
 * Names and figures are fictional.
 */

export const SET_SCID = 'scid_Demo0Set_1800000000000';
/** The first four are the default match; `sets: 11` plays all (the length of the 2026-11-16 Light League card). */
const ALL_LABELS = ['シングルス1', 'ダブルス1', 'ダブルス2', 'シングルス2', 'トリオス1', 'シングルス3', 'ダブルス3', 'シングルス4', 'トリオス2', 'ダブルス4', 'ダブルス5'] as const;
export const SET_LABELS = ALL_LABELS.slice(0, 4);
const TITLE = '【デモリーグ】R3 Alpha Darts vs Bravo Arrows';
const TEAMS = ['Alpha Darts', 'Bravo Arrows'] as const;
/** Who won each leg of each set (the last leg is the one in play while the set is on). */
const WINNER_PATTERNS: (0 | 1)[][] = [
  [0, 0],
  [1, 0, 1],
  [0, 1, 0],
  [1, 1],
];
const LEG_WINNERS = (set: number): (0 | 1)[] => WINNER_PATTERNS[set % WINNER_PATTERNS.length];
const START_SEC = 1_800_000_000;
const SET_SECONDS = 600;

export const SET_COUNT = SET_LABELS.length;
export const LAST_PHASE = SET_COUNT * 2 - 1;
/** The last phase of a match of `count` sets. */
export const lastPhaseOf = (count: number): number => count * 2 - 1;

export const setMid = (set: number): string => `Dset${set}_${(START_SEC + set * SET_SECONDS) * 1000}`;
export const setTitle = (set: number): string => `${TITLE} ${ALL_LABELS[set]}`;

export interface SetMatchOptions {
  /** The list of sets (`match/list` by `scid`) is this many phases behind the live set. */
  listLag?: number;
  /** A `since` read that lands on a new set answers `changed: 0` with the new `mid` only. */
  omitDetailOnNewSet?: boolean;
  /** Every `match/list` by `scid` fails (n01 unreachable for the list only). */
  listFails?: boolean;
  /** Only the archive list by `scid` fails. */
  archiveFails?: boolean;
  /** Only the live list by `scid` (`live=1`) fails. */
  liveListFails?: boolean;
  /** How many sets the match has (default 4, at most 11). */
  sets?: number;
  /**
   * A set that is over also holds the next leg, never started (no throw, not ended), as n01 did
   * for the 2026-11-16 Light League ダブルス1 (Leg 2 with 0 throws after the set ended at Leg 1).
   */
  unstartedLegAfterEnd?: boolean;
}

type Throw = { p: 0 | 1; r: number; score: number; left: number; darts: number; finish?: number };

function legThrows(set: number, leg: number, winner: 0 | 1, ended: boolean): { throws: Throw[]; left: [number, number]; first: 0 | 1 } {
  const first = ((set + leg) % 2) as 0 | 1;
  const left: [number, number] = [501, 501];
  const throws: Throw[] = [];
  const visits = ended ? 99 : 5;
  for (let r = 1; r <= 12 && throws.length < visits; r += 1) {
    for (const p of first === 0 ? ([0, 1] as const) : ([1, 0] as const)) {
      if (throws.length >= visits) break;
      const score = Math.min(left[p], 60 + ((set * 17 + leg * 11 + r * 7 + p * 5) % 61));
      if (p === winner && left[p] - score <= 0) {
        throws.push({ p, r, score: left[p], left: 0, darts: 2, finish: 1 });
        left[p] = 0;
        return { throws, left, first };
      }
      if (p !== winner && left[p] - score <= 40) {
        throws.push({ p, r, score: 0, left: left[p], darts: 3 });
        continue;
      }
      left[p] -= score;
      throws.push({ p, r, score, left: left[p], darts: 3 });
    }
  }
  return { throws, left, first };
}

const setStateAt = (set: number, phase: number): 'future' | 'playing' | 'ended' => (phase < set * 2 ? 'future' : phase === set * 2 ? 'playing' : 'ended');
const updateTimeOf = (set: number, phase: number): number => (START_SEC + set * SET_SECONDS + (setStateAt(set, phase) === 'ended' ? SET_SECONDS - 30 : 240)) * 1000;
/** The set n01 says is the latest at a phase. */
export const latestSet = (phase: number, count = SET_COUNT): number => Math.min(count - 1, Math.floor(phase / 2));

function legsOf(set: number, phase: number): Record<string, unknown>[] {
  const state = setStateAt(set, phase);
  const winners = LEG_WINNERS(set);
  return winners.map((winner, leg) => {
    const ended = state === 'ended' || leg < winners.length - 1;
    const built = legThrows(set, leg, winner, ended);
    const darts: [number, number] = [0, 1].map((side) => built.throws.filter((t) => t.p === side).reduce((sum, t) => sum + t.darts, 0)) as [number, number];
    return {
      leg,
      first: built.first,
      end: ended ? 1 : 0,
      winner: ended ? winner : null,
      time: updateTimeOf(set, phase) - (winners.length - leg) * 1000,
      start: [501, 501],
      left: built.left,
      darts,
      throws: built.throws,
      ...(ended ? {} : { thrower: built.throws.length % 2 === 0 ? built.first : 1 - built.first, round: Math.floor(built.throws.length / 2) + 1 }),
    };
  });
}

const legsWon = (set: number, phase: number): [number, number] => {
  const legs = legsOf(set, phase).filter((leg) => leg.end === 1);
  return [legs.filter((leg) => leg.winner === 0).length, legs.filter((leg) => leg.winner === 1).length];
};

/** Sets won by each side once the sets before `set` (and `set` itself when it is over) are counted. */
function setsWon(upTo: number, phase: number): [number, number] {
  const won: [number, number] = [0, 0];
  for (let set = 0; set <= upTo; set += 1) {
    if (setStateAt(set, phase) !== 'ended') continue;
    const [a, b] = legsWon(set, phase);
    if (a > b) won[0] += 1;
    else if (b > a) won[1] += 1;
  }
  return won;
}

const players = (set: number): [string[], string[]] => {
  const count = ALL_LABELS[set].startsWith('ダブルス') ? 2 : ALL_LABELS[set].startsWith('トリオス') ? 3 : 1;
  return [Array.from({ length: count }, (_, k) => `Alpha 選手${set + 1}-${k + 1}`), Array.from({ length: count }, (_, k) => `Bravo 選手${set + 1}-${k + 1}`)];
};

/** `match/list` row of a set (as n01 Live sends it: no tdid, players' names as the entries). */
export function setRow(set: number, phase: number, count = SET_COUNT): Record<string, unknown> {
  const state = setStateAt(set, phase);
  const legs = legsWon(set, phase);
  const won = setsWon(set, phase);
  const last = state === 'ended' && set === count - 1;
  const names = players(set);
  return {
    mid: setMid(set),
    scid: SET_SCID,
    match_type: '01',
    title: setTitle(set),
    startTime: START_SEC + set * SET_SECONDS,
    updateTime: updateTimeOf(set, phase),
    endMatch: state === 'ended' ? 1 : 0,
    ...(last ? { endSchedule: 1 } : {}),
    currentSet: set,
    currentLeg: LEG_WINNERS(set).length - 1,
    statsData: [0, 1].map((side) => ({ name: names[side].join(' / '), winSets: won[side], winLegs: legs[side], allScore: 400, allDarts: 30 })),
  };
}

/** `match/live` of a set (by `mid`, or the latest set by `scid`). */
export function setLive(set: number, phase: number, count = SET_COUNT): Record<string, unknown> {
  const state = setStateAt(set, phase);
  const legs = legsOf(set, phase);
  const current = legs[legs.length - 1];
  const names = players(set);
  return {
    result: 0,
    changed: 1,
    mid: setMid(set),
    scid: SET_SCID,
    title: setTitle(set),
    match_type: '01',
    updateTime: updateTimeOf(set, phase),
    startTime: START_SEC + set * SET_SECONDS,
    end_match: state === 'ended' ? 1 : 0,
    end_schedule: state === 'ended' && set === count - 1 ? 1 : 0,
    format: { limit_leg: 2, limit_set: 0, draw_mode: 0, schedule: 0, start_score: 501 },
    show_sets: 1,
    sets: setsWon(set, phase),
    legs: legsWon(set, phase),
    current_set: set,
    current_leg: legs.length - 1,
    leg_count: legs.length,
    players: [0, 1].map((side) => ({ name: TEAMS[side], order: names[side].map((name, k) => ({ oid: `o${side}${set}${k}`, name })) })),
    stats: [
      { avg: 60.12, score: 400, darts: 20 },
      { avg: 55.34, score: 380, darts: 21 },
    ],
    leg: current,
  };
}

/** `match/throws` of a set. */
export function setThrows(set: number, phase: number, unstartedLegAfterEnd = false): Record<string, unknown> {
  const state = setStateAt(set, phase);
  const played = legsOf(set, phase);
  const legs = state === 'ended' && unstartedLegAfterEnd ? [...played, { leg: played.length, first: (played.length + set) % 2, end: 0, winner: null, start: [501, 501], left: [501, 501], darts: [0, 0], throws: [] }] : played;
  return { result: 0, changed: 1, mid: setMid(set), match_type: '01', updateTime: updateTimeOf(set, phase), end_match: state === 'ended' ? 1 : 0, current_leg: legs.length - 1, leg_count: legs.length, legs: legsWon(set, phase), leg_data: legs };
}

const setOfMid = (mid: string | undefined, count: number): number => (mid ? Array.from({ length: count }, (_, set) => set).find((set) => setMid(set) === mid) ?? -1 : -1);

/**
 * The reply to one n01 read at a phase, or `undefined` when the read is not about this match
 * (the caller answers it from elsewhere). Error replies are thrown as `Error('list down')`.
 */
export function setMatchReply(operation: string, params: Record<string, string>, phase: number, options: SetMatchOptions = {}): unknown | undefined {
  const count = Math.min(ALL_LABELS.length, options.sets ?? SET_COUNT);
  const latest = latestSet(phase, count);
  if (operation === 'match/list') {
    if (params.scid === SET_SCID) {
      if (options.listFails || (params.live === '1' ? options.liveListFails : options.archiveFails)) throw new Error('list down');
      const seen = Math.max(0, phase - (options.listLag ?? 0));
      const rows = Array.from({ length: count }, (_, set) => set).filter((set) => setStateAt(set, seen) !== 'future').map((set) => setRow(set, seen, count));
      // The archive holds a set once it is over; a set in play is in the live list only.
      return { result: 0, list: rows.filter((row) => (params.live === '1' ? row.endMatch === 0 : row.endMatch === 1)) };
    }
    if (params.mid) {
      const set = setOfMid(params.mid, count);
      if (set < 0) return undefined;
      const state = setStateAt(set, phase);
      if (state === 'future') return { result: 0, list: [] };
      const row = setRow(set, phase, count);
      return { result: 0, list: (params.live === '1') === (state === 'playing') ? [row] : [] };
    }
    if (params.live === '1' && !params.tdid) {
      return { result: 0, list: setStateAt(latest, phase) === 'playing' ? [setRow(latest, phase, count)] : [] };
    }
    return undefined;
  }
  if (operation === 'match/live') {
    const set = params.scid === SET_SCID ? latest : setOfMid(params.mid, count);
    if (set < 0 || (params.scid && params.scid !== SET_SCID)) return undefined;
    const body = setLive(set, phase, count);
    const since = params.since ? Number(params.since) : null;
    if (since !== null && since >= Number(body.updateTime)) return { result: 0, changed: 0, mid: body.mid, updateTime: body.updateTime };
    // n01 moving `scid` to the next set: a `since` read may name the new set and leave out the rest.
    if (since !== null && options.omitDetailOnNewSet && params.scid && since < (START_SEC + set * SET_SECONDS) * 1000) return { result: 0, changed: 0, mid: body.mid, updateTime: body.updateTime };
    return body;
  }
  if (operation === 'match/throws') {
    const set = setOfMid(params.mid, count);
    if (set < 0) return undefined;
    return setThrows(set, phase, options.unstartedLegAfterEnd);
  }
  return undefined;
}
