/**
 * n01 payloads → MATCH RESULTS / LIVE MATCH shapes (n01 外部連携API マニュアル §2, §4).
 *
 * Every reader keeps "absent" apart from 0: a missing average is `null`, a game n01 has not
 * started is absent, and a payload that cannot be read raises `MatchSchemaError` instead of
 * being turned into empty data. Nothing here touches the network.
 */

export class MatchSchemaError extends Error {
  constructor(readonly operation: string, message: string) {
    super(message);
    this.name = 'MatchSchemaError';
  }
}

type Rec = Record<string, unknown>;
const isRec = (value: unknown): value is Rec => typeof value === 'object' && value !== null && !Array.isArray(value);
const str = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : typeof value === 'number' ? String(value) : null);
const num = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);

function ok(operation: string, raw: unknown): Rec {
  if (!isRec(raw)) throw new MatchSchemaError(operation, `${operation}: 応答が JSON オブジェクトではありません。`);
  if (typeof raw.result === 'number' && raw.result < 0) {
    throw new MatchSchemaError(operation, `${operation}: n01 がエラーを返しました (${String(raw.error ?? raw.result)})。`);
  }
  return raw;
}

// ---------------------------------------------------------------------------
// tournament/get — the season document
// ---------------------------------------------------------------------------

export interface SeasonSlot {
  schid: string;
  /** n01 subtitle (`シングルス1`), or a generated label. */
  label: string;
  numPart: number;
  matchType: '01' | 'cricket' | string;
  startScore: number | null;
  /** Points n01 adds for winning this game (`pt`), 0 when none. */
  pt: number;
  order: number;
}

export interface SeasonDivision {
  index: number;
  title: string;
  teamIds: string[];
}

export interface CardResultSide {
  /** Games (or legs, for a one-game schedule) won, as n01 recorded the result. */
  r: number;
  /** n01's average for the card, `null` when absent. */
  avg: number | null;
}

/** How n01 turns card results into points (`lg_setting`), read as written. */
export interface PointRule {
  win: number | null;
  draw: number | null;
  loss: number | null;
  /** `include_set`: games won are added to the points. */
  includeGames: boolean;
  /** `include_leg`: legs won are added (League Order cannot reproduce it from card results). */
  includeLegs: boolean;
  /** Anything else n01 may add that is not in the card results. */
  extras: { manualPoints: boolean; gamePoints: boolean; ptSetting: boolean };
}

export interface SeasonDocument {
  tournamentId: string;
  leagueId: string | null;
  title: string;
  status: number | null;
  /** The page participants and spectators open (from n01, never built from the id). */
  url: string | null;
  teamGames: boolean;
  teams: Map<string, string>;
  divisions: SeasonDivision[];
  /** The base schedule (`lg_setting.schedule`). Use `slotsFor` for a division's games. */
  slots: SeasonSlot[];
  /**
   * Divisions with their own schedule (`lg_setting.game_setting[]`, keyed by `round` = the
   * division's index in `lg_table`; ATDO's A division plays a different set of games).
   */
  divisionSlots: Map<number, SeasonSlot[]>;
  /** `"<div>_<lsid>"` → tpid → result. */
  results: Map<string, Map<string, CardResultSide>>;
  pointRule: PointRule;
  updateTime: number | null;
}

function slotsOf(schedule: unknown): SeasonSlot[] {
  if (!Array.isArray(schedule)) return [];
  const slots: SeasonSlot[] = [];
  schedule.forEach((row, index) => {
    if (!isRec(row)) return;
    const schid = str(row.schid);
    const numPart = num(row.num_part);
    if (!schid || numPart === null) return;
    const type = (str(row.match_type) ?? '01').toLowerCase();
    slots.push({
      schid,
      label: str(row.subTitle) ?? `Game ${index + 1}`,
      numPart,
      matchType: type,
      startScore: num(row.startScore),
      pt: num(row.pt) ?? 0,
      order: index + 1,
    });
  });
  return slots;
}

/** The games a division plays: its own schedule when it has one, else the base schedule. */
export function slotsFor(season: Pick<SeasonDocument, 'slots' | 'divisionSlots'>, division: number | null): SeasonSlot[] {
  return (division !== null ? season.divisionSlots?.get(division) : undefined) ?? season.slots;
}

/** Every slot of the season, base schedule first. */
export function allSlots(season: Pick<SeasonDocument, 'slots' | 'divisionSlots'>): SeasonSlot[] {
  return [...season.slots, ...[...(season.divisionSlots?.values() ?? [])].flat()];
}

/** The slot a game id names, in the division's own schedule first. */
export function slotOf(season: Pick<SeasonDocument, 'slots' | 'divisionSlots'>, schid: string | null, division: number | null = null): SeasonSlot | null {
  if (!schid) return null;
  return slotsFor(season, division).find((slot) => slot.schid === schid) ?? allSlots(season).find((slot) => slot.schid === schid) ?? null;
}

/** The division a team plays in this season, or `null`. */
export function teamDivision(season: Pick<SeasonDocument, 'divisions'>, teamId: string): number | null {
  return season.divisions?.find((division) => division.teamIds.includes(teamId))?.index ?? null;
}

export function parseSeasonDocument(raw: unknown, tournamentId: string): SeasonDocument {
  const body = ok('tournament/get', raw);
  const t = isRec(body.tournament) ? body.tournament : null;
  if (!t) throw new MatchSchemaError('tournament/get', 'tournament/get: トーナメント (tournament) がありません。');
  const teams = new Map<string, string>();
  if (Array.isArray(t.entry_list)) {
    for (const entry of t.entry_list) {
      if (isRec(entry) && str(entry.tpid)) teams.set(str(entry.tpid)!, str(entry.name) ?? str(entry.tpid)!);
    }
  }
  const titles = Array.isArray(t.lg_title) ? t.lg_title : [];
  const tables = Array.isArray(t.lg_table) ? t.lg_table : [];
  const divisions: SeasonDivision[] = tables.map((table, index) => ({
    index,
    title: str(titles[index]) ?? `Division ${index + 1}`,
    teamIds: Array.isArray(table) ? table.map(str).filter((id): id is string => !!id && id !== 'empty') : [],
  }));
  const setting = isRec(t.lg_setting) ? t.lg_setting : {};
  const results = new Map<string, Map<string, CardResultSide>>();
  if (isRec(t.lg_result)) {
    for (const [key, card] of Object.entries(t.lg_result)) {
      if (!isRec(card)) continue;
      const sides = new Map<string, CardResultSide>();
      for (const [tpid, versus] of Object.entries(card)) {
        if (!isRec(versus)) continue;
        const first = Object.values(versus).find(isRec);
        const r = first ? num(first.r) : null;
        if (r === null) continue;
        sides.set(tpid, { r, avg: num(first!.a) });
      }
      if (sides.size === 2) results.set(key, sides);
    }
  }
  const slots = slotsOf(setting.schedule);
  const divisionSlots = new Map<number, SeasonSlot[]>();
  if (Array.isArray(setting.game_setting)) {
    for (const override of setting.game_setting) {
      if (!isRec(override)) continue;
      const division = num(override.round);
      const own = slotsOf(override.schedule);
      if (division !== null && own.length > 0) divisionSlots.set(division, own);
    }
  }
  const manualPoints = Array.isArray(t.lg_pts) ? t.lg_pts.length > 0 : isRec(t.lg_pts) ? Object.keys(t.lg_pts).length > 0 : false;
  return {
    tournamentId: str(t.tdid) ?? tournamentId,
    leagueId: str(t.lgid),
    title: str(t.title) ?? tournamentId,
    status: num(t.status),
    url: typeof body.url === 'string' && body.url.startsWith('https://n01darts.com/') ? body.url : null,
    teamGames: num(t.team_games) === 1,
    teams,
    divisions,
    slots,
    divisionSlots,
    results,
    pointRule: {
      win: num(setting.point_w),
      draw: num(setting.point_d),
      loss: num(setting.point_l),
      includeGames: num(setting.include_set) === 1,
      includeLegs: num(setting.include_leg) === 1 || num(setting.include_set_leg) === 1,
      extras: {
        manualPoints,
        gamePoints: slots.some((slot) => slot.pt !== 0),
        ptSetting: Array.isArray(setting.pt_setting) ? setting.pt_setting.length > 0 : isRec(setting.pt_setting),
      },
    },
    updateTime: num(t.updateTime),
  };
}

// ---------------------------------------------------------------------------
// league/schedule/get — fixtures
// ---------------------------------------------------------------------------

export interface Fixture {
  divisionIndex: number;
  lsid: string;
  teamIds: [string, string];
  title: string;
  round: number | null;
  /** Position in n01's list (its round order). */
  index: number;
}

export function parseFixtures(raw: unknown): Fixture[] {
  const body = ok('league/schedule/get', raw);
  if (!Array.isArray(body.schedule)) throw new MatchSchemaError('league/schedule/get', 'league/schedule/get: 対戦カード (schedule) がありません。');
  const fixtures: Fixture[] = [];
  body.schedule.forEach((division, divisionIndex) => {
    if (!Array.isArray(division)) return;
    division.forEach((row, index) => {
      if (!isRec(row) || !Array.isArray(row.p) || row.p.length !== 2) return;
      const lsid = str(row.lsid);
      const a = str(row.p[0]);
      const b = str(row.p[1]);
      // "" is an unset slot and "empty" a bye: neither is a match to show.
      if (!lsid || !a || !b || a === 'empty' || b === 'empty') return;
      fixtures.push({ divisionIndex, lsid, teamIds: [a, b], title: str(row.t) ?? '', round: num(row.r), index });
    });
  });
  return fixtures;
}

// ---------------------------------------------------------------------------
// match/list — one row per game (one `mid`)
// ---------------------------------------------------------------------------

export interface GameMember {
  oid: string | null;
  opid: string | null;
  name: string;
}

export interface GameSide {
  teamId: string;
  /** Entry name on n01 (the team in a team event). */
  name: string;
  members: GameMember[];
  legsWon: number | null;
  setsWon: number | null;
  score: number | null;
  darts: number | null;
  marks: number | null;
}

export interface GameRow {
  mid: string;
  tmid: string | null;
  schid: string | null;
  scid: string | null;
  matchType: '01' | 'cricket';
  title: string;
  startTime: number | null;
  updateTime: number | null;
  finished: boolean;
  cardFinished: boolean;
  sides: [GameSide, GameSide];
}

function membersOf(value: unknown): GameMember[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter(isRec)
    .map((entry) => ({ oid: str(entry.oid), opid: str(entry.opid), name: str(entry.oname) ?? str(entry.name) ?? '' }))
    .filter((member) => member.name !== '' || member.oid !== null);
}

function gameSide(value: unknown): GameSide | null {
  if (!isRec(value)) return null;
  // Games outside any competition (n01 Online / Live) have no entry id: the player's name stands in.
  const teamId = str(value.tpid) ?? '';
  if (!teamId && !str(value.name)) return null;
  const darts = num(value.allDarts);
  return {
    teamId,
    name: str(value.name) ?? teamId,
    members: membersOf(value.order),
    legsWon: num(value.winLegs),
    setsWon: num(value.winSets),
    score: num(value.allScore),
    darts: darts !== null && darts > 0 ? darts : null,
    marks: num(value.allMarks),
  };
}

export function parseGameRows(raw: unknown): { games: GameRow[]; rows: number; unreadable: number } {
  const body = ok('match/list', raw);
  if (!Array.isArray(body.list)) throw new MatchSchemaError('match/list', 'match/list: 試合一覧 (list) がありません。');
  const games: GameRow[] = [];
  let unreadable = 0;
  for (const row of body.list) {
    const mid = isRec(row) ? str(row.mid) : null;
    const sides = isRec(row) && Array.isArray(row.statsData) && row.statsData.length === 2 ? row.statsData.map(gameSide) : null;
    if (!isRec(row) || !mid || !sides || sides.some((side) => side === null)) {
      unreadable += 1;
      continue;
    }
    const start = num(row.startTime);
    games.push({
      mid,
      tmid: str(row.tmid),
      schid: str(row.schid),
      scid: str(row.scid),
      matchType: str(row.match_type)?.toLowerCase() === 'cricket' ? 'cricket' : '01',
      title: str(row.title) ?? '',
      startTime: start !== null && start > 0 ? start : null,
      updateTime: num(row.updateTime),
      finished: num(row.endMatch) === 1,
      cardFinished: num(row.endSchedule) === 1,
      sides: sides as [GameSide, GameSide],
    });
  }
  return { games, rows: body.list.length, unreadable };
}

/** `<tdid>_lg_<div>_<lsid>_<tpid>_<tpid>` → its parts; `null` for anything else. */
export function parseLeagueTmid(tmid: string | null, tournamentId: string): { divisionIndex: number; lsid: string; teamIds: [string, string] } | null {
  if (!tmid || !tmid.startsWith(`${tournamentId}_lg_`)) return null;
  const parts = tmid.slice(tournamentId.length + 4).split('_');
  if (parts.length !== 4) return null;
  const divisionIndex = Number(parts[0]);
  if (!Number.isInteger(divisionIndex) || divisionIndex < 0) return null;
  return { divisionIndex, lsid: parts[1], teamIds: [parts[2], parts[3]] };
}

// ---------------------------------------------------------------------------
// match/get — the legs of one game
// ---------------------------------------------------------------------------

export interface LegSummary {
  index: number;
  first: 0 | 1 | null;
  winner: 0 | 1 | null;
  ended: boolean;
  /** Decided by the bull (middle for diddle): its darts and points are not counted. */
  bull: boolean;
  darts: [number | null, number | null];
  /** 01: points scored; Cricket: marks. */
  scored: [number | null, number | null];
  /** 01: points left at the end of the leg. */
  left: [number | null, number | null];
  /** 01: points of the first three visits (First 9). */
  first9: [number | null, number | null];
}

export interface GameDetail {
  mid: string;
  matchType: '01' | 'cricket';
  startScore: number | null;
  finished: boolean;
  legs: LegSummary[];
}

function visitDarts(score: number): number {
  return score < 0 ? -score : 3;
}

function zeroOneSide(rows: unknown): { darts: number; scored: number; left: number | null; first9: number | null } | null {
  if (!Array.isArray(rows) || rows.length === 0) return null;
  let darts = 0;
  let scored = 0;
  let left: number | null = null;
  let first9 = 0;
  let visits = 0;
  for (const [index, entry] of rows.entries()) {
    if (!isRec(entry)) return null;
    const score = num(entry.score);
    const rest = num(entry.left);
    if (score === null || rest === null) return null;
    left = rest;
    if (index === 0) continue; // the starting row
    darts += visitDarts(score);
    // A checkout is written as minus the darts used; its points are what was left before it.
    const points = score < 0 ? (num((rows[index - 1] as Rec).left) ?? 0) : score;
    scored += points;
    if (visits < 3) first9 += points;
    visits += 1;
  }
  return { darts, scored, left, first9: visits >= 3 ? first9 : null };
}

export function parseGameDetail(raw: unknown): GameDetail {
  const body = ok('match/get', raw);
  const match = isRec(body.match) ? body.match : null;
  const mid = match ? str(match.mid) : null;
  if (!match || !mid || !Array.isArray(match.legData)) throw new MatchSchemaError('match/get', 'match/get: Leg の明細 (legData) を読めません。');
  const cricket = str(match.match_type)?.toLowerCase() === 'cricket';
  const startScore = num(match.startScore);
  const legs: LegSummary[] = match.legData.filter(isRec).map((leg, index) => {
    const first = num(leg.first);
    const winner = num(leg.winner);
    const base: LegSummary = {
      index,
      first: first === 0 || first === 1 ? first : null,
      winner: winner === 0 || winner === 1 ? winner : null,
      ended: num(leg.endFlag) === 1,
      bull: num(leg.middleForDiddle) === 1,
      darts: [null, null],
      scored: [null, null],
      left: [null, null],
      first9: [null, null],
    };
    if (!cricket && Array.isArray(leg.playerData) && leg.playerData.length === 2) {
      for (const side of [0, 1] as const) {
        const read = zeroOneSide(leg.playerData[side]);
        if (!read) continue;
        base.darts[side] = read.darts;
        base.scored[side] = read.scored;
        base.left[side] = read.left;
        base.first9[side] = read.first9;
      }
    } else if (cricket && Array.isArray(leg.turns)) {
      const marks: [number, number] = [0, 0];
      const turns: [number, number] = [0, 0];
      for (const turn of leg.turns) {
        if (!isRec(turn) || (turn.p !== 0 && turn.p !== 1)) continue;
        turns[turn.p] += 1;
        if (Array.isArray(turn.h)) for (const hit of turn.h) if (Array.isArray(hit)) marks[turn.p] += num(hit[1]) ?? 0;
      }
      base.scored = [marks[0], marks[1]];
      base.darts = [turns[0] * 3, turns[1] * 3];
    }
    return base;
  });
  return { mid, matchType: cricket ? 'cricket' : '01', startScore, finished: num(match.endMatch) === 1, legs };
}

// ---------------------------------------------------------------------------
// match/live — the current state of one game (or of the card, by tmid / scid)
// ---------------------------------------------------------------------------

export interface LiveThrow01 {
  kind: '01';
  side: 0 | 1;
  round: number;
  score: number;
  left: number;
  darts: number;
  finish: boolean;
  member: string | null;
  /** The thrower's team member id (`member.oid`), team events only. */
  memberId?: string | null;
}

export interface LiveThrowCricket {
  kind: 'cricket';
  side: 0 | 1;
  round: number;
  hits: { number: number; mark: number }[];
  marks: number;
  points: number;
  member: string | null;
  memberId?: string | null;
}

export type LiveThrow = LiveThrow01 | LiveThrowCricket;

export interface LiveLeg {
  index: number;
  first: 0 | 1 | null;
  ended: boolean;
  winner: 0 | 1 | -1 | null;
  /** Next to throw (unfinished legs only). */
  thrower: 0 | 1 | null;
  round: number | null;
  member: string | null;
  /** 01 */
  left: [number, number] | null;
  start: [number, number] | null;
  /** Cricket */
  numbers: number[] | null;
  marks: [number[], number[]] | null;
  points: [number, number] | null;
  throws: LiveThrow[];
  /**
   * Decided by the bull (middle for diddle, `middle_for_diddle` 1): n01 does not count its darts
   * and points (manual: Leg の形式, shared by `match/live` and `match/throws`).
   */
  bull: boolean;
  /** Darts thrown per side in the leg, as n01 counts them (`darts`). */
  dartsTotal: [number, number] | null;
}

export interface LiveSide {
  name: string;
  teamId: string | null;
  members: string[];
  /** 01: 3-dart average; Cricket: MPR — n01's figure for the set so far. */
  rate: number | null;
}

export interface LiveState {
  changed: true;
  mid: string;
  scid: string | null;
  tdid: string | null;
  tmid: string | null;
  schid: string | null;
  title: string;
  matchType: '01' | 'cricket';
  updateTime: number;
  gameEnded: boolean;
  cardEnded: boolean;
  isSchedule: boolean;
  /** Team schedule: games won in the card; otherwise sets won. */
  sets: [number, number];
  showSets: boolean;
  legs: [number, number];
  limitLeg: number | null;
  limitSet: number | null;
  /** `format.draw_mode` (1 = a game may end drawn), `null` when absent. */
  drawMode: number | null;
  startScore: number | null;
  currentLeg: number | null;
  currentSet: number | null;
  legCount: number | null;
  sides: [LiveSide, LiveSide];
  leg: LiveLeg | null;
}

export type LiveResponse = LiveState | { changed: false; mid: string | null; updateTime: number | null };

const pair = (value: unknown): [number, number] | null =>
  Array.isArray(value) && value.length === 2 && num(value[0]) !== null && num(value[1]) !== null ? [value[0] as number, value[1] as number] : null;

function liveThrow(value: unknown, cricket: boolean): LiveThrow | null {
  if (!isRec(value) || (value.p !== 0 && value.p !== 1)) return null;
  const member = isRec(value.member) ? str(value.member.name) : null;
  const memberId = isRec(value.member) ? str(value.member.oid) : null;
  const round = num(value.r) ?? 0;
  if (cricket) {
    const hits = Array.isArray(value.darts)
      ? value.darts.filter(isRec).map((dart) => ({ number: num(dart.number) ?? 0, mark: num(dart.mark) ?? 0 }))
      : [];
    return { kind: 'cricket', side: value.p, round, hits, marks: num(value.marks) ?? 0, points: num(value.points) ?? 0, member, memberId };
  }
  const score = num(value.score);
  const left = num(value.left);
  if (score === null || left === null) return null;
  return { kind: '01', side: value.p, round, score, left, darts: num(value.darts) ?? 3, finish: num(value.finish) === 1, member, memberId };
}

export function parseLiveLeg(value: unknown, cricket: boolean): LiveLeg | null {
  if (!isRec(value)) return null;
  const first = num(value.first);
  const winner = num(value.winner);
  const thrower = num(value.thrower);
  const marksRaw = Array.isArray(value.marks) && value.marks.length === 2 && value.marks.every(Array.isArray) ? (value.marks as number[][]) : null;
  return {
    index: num(value.leg) ?? 0,
    first: first === 0 || first === 1 ? first : null,
    ended: num(value.end) === 1,
    winner: winner === 0 || winner === 1 || winner === -1 ? winner : null,
    thrower: thrower === 0 || thrower === 1 ? thrower : null,
    round: num(value.round),
    member: isRec(value.member) ? str(value.member.name) : null,
    left: pair(value.left),
    start: pair(value.start),
    numbers: Array.isArray(value.numbers) ? value.numbers.map((n) => num(n) ?? 0) : null,
    marks: marksRaw ? [marksRaw[0].map((n) => num(n) ?? 0), marksRaw[1].map((n) => num(n) ?? 0)] : null,
    points: pair(value.score),
    throws: Array.isArray(value.throws) ? value.throws.map((t) => liveThrow(t, cricket)).filter((t): t is LiveThrow => t !== null) : [],
    bull: num(value.middle_for_diddle) === 1,
    dartsTotal: pair(value.darts),
  };
}

export function parseLive(raw: unknown): LiveResponse {
  const body = ok('match/live', raw);
  if (num(body.changed) === 0) return { changed: false, mid: str(body.mid), updateTime: num(body.updateTime) };
  const mid = str(body.mid);
  const updateTime = num(body.updateTime);
  if (!mid || updateTime === null) throw new MatchSchemaError('match/live', 'match/live: mid / updateTime がありません。');
  const cricket = str(body.match_type)?.toLowerCase() === 'cricket';
  const format = isRec(body.format) ? body.format : {};
  const players = Array.isArray(body.players) ? body.players : [];
  const stats = Array.isArray(body.stats) ? body.stats : [];
  const side = (index: 0 | 1): LiveSide => {
    const p = isRec(players[index]) ? players[index] : {};
    const s = isRec(stats[index]) ? stats[index] : {};
    return {
      name: str(p.name) ?? (index === 0 ? '左' : '右'),
      teamId: str(p.tpid),
      members: Array.isArray(p.order) ? p.order.filter(isRec).map((m) => str(m.name) ?? '').filter(Boolean) : [],
      rate: cricket ? num(s.mpr) : num(s.avg),
    };
  };
  return {
    changed: true,
    mid,
    scid: str(body.scid),
    tdid: str(body.tdid),
    tmid: str(body.tmid),
    schid: str(body.schid),
    title: str(body.title) ?? '',
    matchType: cricket ? 'cricket' : '01',
    updateTime,
    gameEnded: num(body.end_match) === 1,
    cardEnded: num(body.end_schedule) === 1,
    isSchedule: num(format.schedule) === 1,
    sets: pair(body.sets) ?? [0, 0],
    showSets: num(body.show_sets) === 1,
    legs: pair(body.legs) ?? [0, 0],
    limitLeg: num(format.limit_leg),
    limitSet: num(format.limit_set),
    drawMode: num(format.draw_mode),
    startScore: num(format.start_score),
    currentLeg: num(body.current_leg),
    currentSet: num(body.current_set),
    legCount: num(body.leg_count),
    sides: [side(0), side(1)],
    leg: parseLiveLeg(body.leg, cricket),
  };
}

// ---------------------------------------------------------------------------
// match/throws — every leg of a game, throw by throw (since = only legs changed after it)
// ---------------------------------------------------------------------------

/** A leg of `match/throws`: the same format as the live leg (bull and darts included). */
export type ThrowLeg = LiveLeg;

export interface ThrowsResponse {
  changed: boolean;
  mid: string | null;
  updateTime: number | null;
  matchType: '01' | 'cricket';
  gameEnded: boolean;
  legs: ThrowLeg[];
}

export function parseThrowLeg(value: unknown, cricket: boolean): ThrowLeg | null {
  return parseLiveLeg(value, cricket);
}

export function parseThrows(raw: unknown): ThrowsResponse {
  const body = ok('match/throws', raw);
  const cricket = str(body.match_type)?.toLowerCase() === 'cricket';
  if (num(body.changed) === 0) {
    return { changed: false, mid: str(body.mid), updateTime: num(body.updateTime), matchType: cricket ? 'cricket' : '01', gameEnded: num(body.end_match) === 1, legs: [] };
  }
  const legs = Array.isArray(body.leg_data) ? body.leg_data.map((leg) => parseThrowLeg(leg, cricket)).filter((leg): leg is ThrowLeg => leg !== null) : [];
  return { changed: true, mid: str(body.mid), updateTime: num(body.updateTime), matchType: cricket ? 'cricket' : '01', gameEnded: num(body.end_match) === 1, legs };
}

/**
 * The legs held with the live poller's current leg laid over them. The live leg is the newest
 * state of that leg (a corrected visit included), so it replaces the held one whole — with its
 * own bull flag and darts count, read from the same leg format (never forced to "not bull").
 */
export function withLiveLeg(held: readonly ThrowLeg[], live: LiveLeg | null | undefined): ThrowLeg[] {
  return live ? mergeLegs(held, [live]) : [...held];
}

/** Merges a `since` reply into the legs held: a returned leg replaces the one held, whole. */
export function mergeLegs(held: readonly ThrowLeg[], fresh: readonly ThrowLeg[]): ThrowLeg[] {
  const byIndex = new Map(held.map((leg) => [leg.index, leg]));
  for (const leg of fresh) byIndex.set(leg.index, leg);
  return [...byIndex.values()].sort((a, b) => a.index - b.index);
}

// ---------------------------------------------------------------------------
// team/order/list — who plays which game of a card
// ---------------------------------------------------------------------------

export interface CardOrder {
  teamId: string;
  schid: string;
  fixed: boolean;
  members: string[];
}

export function parseOrders(raw: unknown): CardOrder[] {
  const body = ok('team/order/list', raw);
  const list = Array.isArray(body.list) ? body.list : Array.isArray(body.order_list) ? body.order_list : [];
  const orders: CardOrder[] = [];
  for (const row of list) {
    if (!isRec(row)) continue;
    const teamId = str(row.tpid);
    const schid = str(row.schid);
    if (!teamId || !schid) continue;
    const members = Array.isArray(row.order)
      ? row.order.map((entry) => (isRec(entry) ? str(entry.oname) ?? '' : '')).filter((name) => name !== '')
      : [];
    orders.push({ teamId, schid, fixed: num(row.fix) === 1, members });
  }
  return orders;
}

/** A fixture title's date (`第1戦 10月1日 木曜日`, `2026-09-10`), as `M/D`, or `null`. */
export function fixtureDate(title: string): { month: number; day: number } | null {
  const iso = /(\d{4})-(\d{1,2})-(\d{1,2})/u.exec(title);
  if (iso) return { month: Number(iso[2]), day: Number(iso[3]) };
  const ja = /(\d{1,2})月(\d{1,2})日/u.exec(title);
  if (ja) return { month: Number(ja[1]), day: Number(ja[2]) };
  const slash = /(?:^|\s)(\d{1,2})\/(\d{1,2})(?:\s|$)/u.exec(title);
  return slash ? { month: Number(slash[1]), day: Number(slash[2]) } : null;
}
