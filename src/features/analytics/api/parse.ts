import type { SlotEvidence } from '../gameKind';
import type { OfficialStandingGroup, OfficialStandingRow, PlayerStatsRow, StatLine, TeamStatsRow } from '../types';

/**
 * Raw n01 analytics responses → the analytics types (design §2, "指標と計算の契約").
 *
 * Tolerant extraction, explicit failure: a row missing its id is skipped, but a response
 * whose container is missing (the API changed shape) throws {@link AnalyticsSchemaError},
 * because an empty list would look exactly like "nobody played". An *empty* container is a
 * legitimate "no stats yet" and returns `[]`.
 */

export class AnalyticsSchemaError extends Error {
  constructor(
    readonly operation: string,
    message: string,
  ) {
    super(`${operation}: ${message}`);
    this.name = 'AnalyticsSchemaError';
  }
}

type Rec = Record<string, unknown>;

function isRec(value: unknown): value is Rec {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function num(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function str(value: unknown): string | null {
  if (typeof value === 'string') return value.trim() === '' ? null : value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return null;
}

/** Fails loudly on an n01 error body (`{ result: <negative>, error }`). */
function assertOk(operation: string, raw: unknown): Rec {
  if (!isRec(raw)) throw new AnalyticsSchemaError(operation, '応答がオブジェクトではありません。');
  const result = num(raw.result);
  if ((result !== null && result < 0) || (typeof raw.error === 'string' && raw.error !== '')) {
    throw new AnalyticsSchemaError(operation, `n01 がエラーを返しました: ${String(raw.error ?? result)}`);
  }
  return raw;
}

/** Rows of a stats container: an object keyed by id (the live shape) or an array. */
function statRows(operation: string, raw: unknown, keys: readonly string[]): { key: string | null; row: Rec }[] {
  const body = assertOk(operation, raw);
  for (const name of keys) {
    const container = body[name];
    if (Array.isArray(container)) return container.filter(isRec).map((row) => ({ key: null, row }));
    if (isRec(container)) {
      return Object.entries(container)
        .filter((entry): entry is [string, Rec] => isRec(entry[1]))
        .map(([key, row]) => ({ key, row }));
    }
  }
  throw new AnalyticsSchemaError(operation, `統計 (${keys.join(' / ')}) が見つかりません。n01 の応答形式が変わった可能性があります。`);
}

function positive(value: number | null): number | null {
  return value !== null && value > 0 ? value : null;
}

/** One stats row → counters. 0 for High Finish / Best Leg means "no record" (design §2). */
/**
 * `r_g` is the division number counted from 1 (real ATDO 2026 3rd: the six teams of the A
 * division all carry `r_g: 1` while `standings` calls that group index 0). The league table
 * (`lg_table`) stays the authority for who is in which division; this is only a fallback, so
 * it is converted to the same 0-based index and 0 / missing mean "unknown".
 */
function divisionOf(value: unknown): number | null {
  const n = num(value);
  return n !== null && n >= 1 ? n - 1 : null;
}

export function parseStatLine(row: Rec): StatLine {
  return {
    score: num(row.score),
    darts: num(row.darts),
    f9Score: num(row.f9Score),
    f9Darts: num(row.f9Darts),
    leg: num(row.leg),
    winLeg: num(row.winLeg),
    set: num(row.set),
    winSet: num(row.winSet),
    breakLegs: num(row.a_b),
    breakWins: num(row.w_b),
    match: num(row.match),
    winMatch: num(row.winMatch),
    ton00: num(row.ton00),
    ton40: num(row.ton40),
    ton70: num(row.ton70),
    ton80: num(row.ton80),
    highOut: positive(num(row.highOut)),
    bestLeg: positive(num(row.best)),
  };
}

/** `tournament/stats?kind=stats_list`: one row per team, keyed by `tpid`. */
export function parseTeamStats(raw: unknown): TeamStatsRow[] {
  const rows: TeamStatsRow[] = [];
  for (const { key, row } of statRows('tournament/stats(stats_list)', raw, ['stats', 'stats_list', 'list'])) {
    const teamId = str(row.tpid) ?? key;
    if (!teamId) continue;
    rows.push({ teamId, divisionIndex: divisionOf(row.r_g), line: parseStatLine(row) });
  }
  return rows;
}

/** `tournament/stats?kind=player_stats_list`: one row per player, keyed by `oid`. */
export function parsePlayerStats(raw: unknown): PlayerStatsRow[] {
  const rows: PlayerStatsRow[] = [];
  for (const { key, row } of statRows('tournament/stats(player_stats_list)', raw, ['stats', 'player_stats_list', 'list'])) {
    const oid = str(row.oid) ?? key;
    if (!oid) continue;
    rows.push({
      oid,
      opid: str(row.opid),
      teamId: str(row.tpid),
      name: str(row.oname) ?? str(row.name),
      divisionIndex: divisionOf(row.r_g),
      line: parseStatLine(row),
    });
  }
  return rows;
}

/** `tournament/standings`: the league (`kind: lg`) groups, one per division. Other kinds are ignored. */
export function parseStandings(raw: unknown): OfficialStandingGroup[] {
  const body = assertOk('tournament/standings', raw);
  if (!Array.isArray(body.groups)) {
    throw new AnalyticsSchemaError('tournament/standings', '順位表 (groups) が見つかりません。n01 の応答形式が変わった可能性があります。');
  }
  const groups: OfficialStandingGroup[] = [];
  for (const group of body.groups) {
    if (!isRec(group) || group.kind !== 'lg') continue;
    const divisionIndex = num(group.index);
    if (divisionIndex === null) continue;
    const players = Array.isArray(group.players) ? group.players : [];
    const rows: OfficialStandingRow[] = [];
    for (const player of players) {
      if (!isRec(player)) continue;
      const teamId = str(player.tpid);
      const played = num(player.p);
      const won = num(player.w);
      const drawn = num(player.d);
      const lost = num(player.l);
      if (!teamId || played === null || won === null || drawn === null || lost === null) continue;
      rows.push({
        teamId,
        name: str(player.name) ?? teamId,
        rank: num(player.rank) ?? 0,
        played,
        won,
        drawn,
        lost,
        points: num(player.pts) ?? 0,
      });
    }
    groups.push({ divisionIndex, title: str(group.title) ?? `Division ${divisionIndex + 1}`, rows });
  }
  return groups;
}

// ---- schedule evidence & played games (role analytics) ------------------------------------

function firstOf(row: Rec, keys: readonly string[]): unknown {
  for (const key of keys) if (row[key] !== undefined && row[key] !== null) return row[key];
  return undefined;
}

function rowsOf(value: unknown): Rec[] {
  return (Array.isArray(value) ? value : isRec(value) ? Object.values(value) : []).filter(isRec);
}

function slotsOf(value: unknown, division: number | null, settingMatchType: string | null): SlotEvidence[] {
  const slots: SlotEvidence[] = [];
  rowsOf(value).forEach((row, index) => {
    const numPart = num(firstOf(row, ['num_part', 'numpart', 'num']));
    slots.push({
      schid: str(firstOf(row, ['schid', 'id'])) ?? `idx${index}`,
      division,
      numPart: numPart !== null && Number.isInteger(numPart) && numPart >= 1 ? numPart : null,
      subtitle: str(firstOf(row, ['subTitle', 'subtitle', 'sub_title', 'title'])),
      startScore: num(firstOf(row, ['startScore', 'start_score', 'startscore'])),
      limitLegCount: num(firstOf(row, ['limit_leg_count', 'limitlegcount'])),
      // Kept as written: an absent match_type stays null here (the shared parser fills in 01).
      matchType: str(firstOf(row, ['match_type', 'matchType', 'matchtype'])),
      settingMatchType,
    });
  });
  return slots;
}

/**
 * `tournament/get` → every schedule slot as n01 wrote it: the base schedule and each
 * division override (`game_setting[].round`). Unlike the shared parser this does **not**
 * default a missing `match_type` to 01 — that absence is evidence.
 */
export function parseSlotEvidence(raw: unknown): SlotEvidence[] {
  if (!isRec(raw)) return [];
  const body = isRec(raw.tournament) ? raw.tournament : isRec(raw.data) ? raw.data : raw;
  const setting = isRec(body.lg_setting) ? body.lg_setting : null;
  if (!setting) return [];
  const slots = slotsOf(setting.schedule, null, str(setting.match_type));
  for (const override of rowsOf(setting.game_setting)) {
    const round = num(override.round);
    if (round === null || !Number.isInteger(round) || round < 0) continue;
    slots.push(...slotsOf(override.schedule, round, str(override.match_type) ?? str(setting.match_type)));
  }
  return slots;
}

export interface RawGamePlayer {
  oid: string | null;
  opid: string | null;
  name: string | null;
}

export interface RawGameSide {
  teamId: string;
  /** In n01's `order[]` order: the registered throwing order. */
  players: RawGamePlayer[];
  legsWon: number;
  /** `allScore` / `allDarts`: `null` when absent (never 0). */
  score: number | null;
  darts: number | null;
}

/** One played game of `match/list`, with the absence of `match_type` preserved. */
export interface RawGame {
  gameId: string;
  /** `tmid`: `<tdid>_lg_<division>_<lsid>_<tpid>_<tpid>` for league games. */
  matchId: string | null;
  schid: string | null;
  matchType: string | null;
  /** `endMatch === 1`. Unfinished games are never counted. */
  finished: boolean;
  startTime: number | null;
  sides: [RawGameSide, RawGameSide];
}

function playersOf(value: unknown): RawGamePlayer[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => (isRec(entry) ? { oid: str(entry.oid), opid: str(entry.opid), name: str(firstOf(entry, ['oname', 'name'])) } : { oid: str(entry), opid: null, name: null }))
    .filter((p) => p.oid !== null || p.opid !== null);
}

function sideOf(value: unknown): RawGameSide | null {
  if (!isRec(value)) return null;
  const teamId = str(firstOf(value, ['tpid', 'team']));
  const legsWon = num(firstOf(value, ['winLegs', 'win_legs']));
  const players = playersOf(firstOf(value, ['order', 'players']));
  if (!teamId || legsWon === null || players.length === 0) return null;
  return { teamId, players, legsWon, score: num(firstOf(value, ['allScore', 'all_score'])), darts: num(firstOf(value, ['allDarts', 'all_darts'])) };
}

/** `match/list`: one page. A row without two readable sides is counted, not guessed. */
export function parseGameList(raw: unknown): { games: RawGame[]; rows: number; unreadable: number } {
  const body = assertOk('match/list', raw);
  const list = firstOf(body, ['list', 'matches', 'match_list']);
  if (!Array.isArray(list)) throw new AnalyticsSchemaError('match/list', '試合一覧 (list) が見つかりません。n01 の応答形式が変わった可能性があります。');
  const games: RawGame[] = [];
  let unreadable = 0;
  for (const row of list) {
    if (!isRec(row)) {
      unreadable += 1;
      continue;
    }
    const gameId = str(firstOf(row, ['mid', 'id']));
    const sideRows = firstOf(row, ['statsData', 'stats_data']);
    const sides = Array.isArray(sideRows) && sideRows.length === 2 ? sideRows.map(sideOf) : null;
    if (!gameId || !sides || sides.some((s) => s === null)) {
      unreadable += 1;
      continue;
    }
    const startTime = num(row.startTime);
    games.push({
      gameId,
      matchId: str(row.tmid),
      schid: str(row.schid),
      matchType: str(firstOf(row, ['match_type', 'matchType'])),
      finished: num(row.endMatch) === 1,
      startTime: startTime !== null && startTime > 0 ? startTime : null,
      sides: sides as [RawGameSide, RawGameSide],
    });
  }
  return { games, rows: list.length, unreadable };
}

/** One visit of a leg as n01 stores it: `score >= 0` points, `score < 0` a checkout with |score| darts. */
export interface RawVisit {
  score: number;
  left: number;
}

export interface RawLeg {
  /** Side index (0/1) that threw first. */
  first: number | null;
  /** Side index of the winner, `null` when not decided. */
  winner: number | null;
  ended: boolean;
  /** Per side, the visits after the starting row. */
  visits: [RawVisit[], RawVisit[]];
}

export interface RawGameDetail {
  gameId: string;
  matchId: string | null;
  schid: string | null;
  matchType: string | null;
  startScore: number | null;
  finished: boolean;
  legs: RawLeg[];
  sides: [RawGameSide, RawGameSide];
}

function visitsOf(value: unknown): RawVisit[] | null {
  if (!Array.isArray(value)) return null;
  const visits: RawVisit[] = [];
  for (const entry of value.slice(1)) {
    if (!isRec(entry)) return null;
    const score = num(entry.score);
    const left = num(entry.left);
    if (score === null || left === null) return null;
    visits.push({ score, left });
  }
  return visits;
}

/** `match/get`: the per-leg visits. A leg that cannot be read makes the whole game unreadable. */
export function parseGameDetail(raw: unknown): RawGameDetail {
  const body = assertOk('match/get', raw);
  const match = isRec(body.match) ? body.match : null;
  if (!match) throw new AnalyticsSchemaError('match/get', '試合 (match) が見つかりません。');
  const gameId = str(match.mid);
  const sideRows = match.statsData;
  const sides = Array.isArray(sideRows) && sideRows.length === 2 ? sideRows.map(sideOf) : null;
  if (!gameId || !sides || sides.some((s) => s === null) || !Array.isArray(match.legData)) {
    throw new AnalyticsSchemaError('match/get', '試合の明細 (legData / statsData) を読めません。');
  }
  const legs: RawLeg[] = [];
  for (const leg of match.legData) {
    if (!isRec(leg) || !Array.isArray(leg.playerData) || leg.playerData.length !== 2) throw new AnalyticsSchemaError('match/get', 'Legの明細を読めません。');
    const a = visitsOf(leg.playerData[0]);
    const b = visitsOf(leg.playerData[1]);
    if (!a || !b) throw new AnalyticsSchemaError('match/get', 'Legの投てき記録を読めません。');
    const first = num(leg.first);
    const winner = num(leg.winner);
    legs.push({
      first: first === 0 || first === 1 ? first : null,
      winner: winner === 0 || winner === 1 ? winner : null,
      ended: num(leg.endFlag) === 1,
      visits: [a, b],
    });
  }
  return {
    gameId,
    matchId: str(match.tmid),
    schid: str(match.schid),
    matchType: str(firstOf(match, ['match_type', 'matchType'])),
    startScore: num(match.startScore),
    finished: num(match.endMatch) === 1,
    legs,
    sides: sides as [RawGameSide, RawGameSide],
  };
}
