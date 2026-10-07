import type {
  N01Division,
  N01Entry,
  N01Fixture,
  N01GameResult,
  N01GameSetting,
  N01LeagueSummary,
  N01LeagueTournaments,
  N01MatchResult,
  N01OrderEntry,
  N01PlayerStats,
  N01RosterPlayer,
  N01ScheduleSlot,
  N01Tournament,
  N01TournamentSummary,
} from './types';
import { N01_STATUS } from './types';

/**
 * Raw n01 response → normalised types (docs/N01_DATA_MODEL.md §2).
 *
 * The rule is *tolerant extraction, explicit failure*:
 *
 * - a field may arrive as a number or a numeric string, and a list may arrive bare or
 *   inside a `list` / `data` wrapper — both are accepted;
 * - an individual entry missing its id is skipped (one bad row must not hide the rest);
 * - but a response whose container is missing, or where *every* entry is unusable, is a
 *   schema change and raises {@link N01SchemaError}. Silently returning an empty roster
 *   or empty stats would look exactly like real data, and the app would act on it.
 *
 * Missing numbers are `null`, never 0.
 */

export class N01SchemaError extends Error {
  constructor(
    readonly operation: string,
    message: string,
  ) {
    super(`${operation}: ${message}`);
    this.name = 'N01SchemaError';
  }
}

type Rec = Record<string, unknown>;

function isRec(value: unknown): value is Rec {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Strips a `{ data: … }` / `{ result: … }` envelope when the payload is inside it. */
function unwrap(raw: unknown): unknown {
  if (isRec(raw)) {
    if (typeof raw.error === 'string' && raw.error !== '') {
      throw new N01SchemaError('response', `n01 がエラーを返しました: ${raw.error}`);
    }
    for (const key of ['data', 'result']) {
      const inner = raw[key];
      if (isRec(inner) || Array.isArray(inner)) return inner;
    }
  }
  return raw;
}

function text(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return null;
}

function nonEmpty(value: unknown): string | null {
  const t = text(value);
  return t !== null && t.trim() !== '' ? t.trim() : null;
}

function num(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function first(record: Rec, keys: readonly string[]): unknown {
  for (const key of keys) {
    if (record[key] !== undefined && record[key] !== null) return record[key];
  }
  return undefined;
}

/**
 * The list a response carries: the response itself when it is an array, otherwise the
 * first array found under one of `keys`. `null` when there is none.
 */
function listIn(raw: unknown, keys: readonly string[]): unknown[] | null {
  const body = unwrap(raw);
  if (Array.isArray(body)) return body;
  if (!isRec(body)) return null;
  for (const key of keys) {
    const value = body[key];
    if (Array.isArray(value)) return value;
    // Some lists arrive as an object keyed by id.
    if (isRec(value)) return Object.entries(value).map(([id, row]) => (isRec(row) ? { __key: id, ...row } : row));
  }
  return null;
}

function requireList(operation: string, raw: unknown, keys: readonly string[]): unknown[] {
  const list = listIn(raw, keys);
  if (list === null) {
    throw new N01SchemaError(operation, `一覧 (${keys.join(' / ')}) が見つかりません。n01 の応答形式が変わった可能性があります。`);
  }
  return list;
}

function mapRows<T>(operation: string, rows: unknown[], parse: (row: Rec, index: number) => T | null): T[] {
  const parsed: T[] = [];
  rows.forEach((row, index) => {
    if (!isRec(row)) return;
    const value = parse(row, index);
    if (value !== null) parsed.push(value);
  });
  if (rows.length > 0 && parsed.length === 0) {
    throw new N01SchemaError(operation, '有効な行が 1 件もありません。n01 の応答形式が変わった可能性があります。');
  }
  return parsed;
}

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

function validDate(year: number, month: number, day: number): string | null {
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return `${year}-${pad(month)}-${pad(day)}`;
}

/**
 * A calendar date in `text`, as `YYYY-MM-DD`, or `null`.
 *
 * Accepts `2026-10-08`, `2026/10/08`, `2026年10月8日` and a bare `10/8` / `10月8日`. A bare
 * month/day takes the year that puts it closest to `now` (a fixture list straddles at
 * most one new year), which is the only way to read it without inventing information.
 */
export function parseDateText(textValue: string | null, now: number): string | null {
  if (!textValue) return null;
  const full = /(\d{4})\s*[-/年.]\s*(\d{1,2})\s*[-/月.]\s*(\d{1,2})/u.exec(textValue);
  if (full) return validDate(Number(full[1]), Number(full[2]), Number(full[3]));
  const short = /(?:^|[^\d])(\d{1,2})\s*[/月]\s*(\d{1,2})(?:日|[^\d]|$)/u.exec(textValue);
  if (!short) return null;
  const month = Number(short[1]);
  const day = Number(short[2]);
  const current = new Date(now);
  const year = current.getUTCFullYear();
  let best: { iso: string; distance: number } | null = null;
  for (const candidate of [year - 1, year, year + 1]) {
    const iso = validDate(candidate, month, day);
    if (!iso) continue;
    const distance = Math.abs(Date.parse(`${iso}T00:00:00Z`) - now);
    if (!best || distance < best.distance) best = { iso, distance };
  }
  return best?.iso ?? null;
}

function epochOf(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    // Seconds or milliseconds.
    return value < 1e12 ? value * 1000 : value;
  }
  const t = nonEmpty(value);
  if (!t) return null;
  const iso = parseDateText(t, 0);
  if (!iso) return null;
  return Date.parse(`${iso}T00:00:00Z`);
}

// ---------------------------------------------------------------------------
// league/search, league/tournament/list
// ---------------------------------------------------------------------------

export function parseLeagueSearch(raw: unknown): N01LeagueSummary[] {
  const rows = requireList('league/search', raw, ['list', 'leagues', 'league_list']);
  return mapRows('league/search', rows, (row) => {
    const leagueId = nonEmpty(first(row, ['lgid', 'id', '__key']));
    if (!leagueId) return null;
    return { leagueId, title: nonEmpty(first(row, ['title', 'lg_title', 'name'])) ?? leagueId };
  });
}

export function parseLeagueTournaments(raw: unknown, leagueId: string): N01LeagueTournaments {
  const body = unwrap(raw);
  const rows = requireList('league/tournament/list', body, ['list', 'tournament_list', 'tournaments']);
  const tournaments = mapRows<N01TournamentSummary>('league/tournament/list', rows, (row, index) => {
    const tournamentId = nonEmpty(first(row, ['tdid', 'id', '__key']));
    if (!tournamentId) return null;
    return {
      tournamentId,
      title: nonEmpty(first(row, ['title', 't_title', 'name'])) ?? tournamentId,
      status: num(row.status),
      startedAt: epochOf(first(row, ['start_date', 'startdate', 'date', 'start_time', 'created'])),
      listIndex: index,
    };
  });
  const title = isRec(body) ? nonEmpty(first(body, ['title', 'lg_title', 'name'])) : null;
  return { league: { leagueId, title: title ?? '' }, tournaments };
}

// ---------------------------------------------------------------------------
// tournament/get
// ---------------------------------------------------------------------------

function parseScheduleSlots(operation: string, value: unknown): N01ScheduleSlot[] {
  const rows = Array.isArray(value) ? value : isRec(value) ? Object.values(value) : [];
  return mapRows(operation, rows, (row, index) => {
    const numPart = num(first(row, ['num_part', 'numpart', 'num']));
    if (numPart === null || numPart < 1 || !Number.isInteger(numPart)) return null;
    const startScore = num(first(row, ['start_score', 'startscore', 'score']));
    return {
      schid: nonEmpty(first(row, ['schid', 'id', '__key'])) ?? `idx${index}`,
      numPart,
      subtitle: nonEmpty(first(row, ['subtitle', 'sub_title', 'title'])),
      matchType: (nonEmpty(first(row, ['match_type', 'matchtype', 'type'])) ?? '01').toLowerCase(),
      startScore,
      limitLegCount: num(first(row, ['limit_leg_count', 'limitlegcount', 'leg_count', 'legs'])),
      group: nonEmpty(row.group),
    };
  });
}

function parseDivisions(value: unknown): N01Division[] {
  const rows = Array.isArray(value) ? value : isRec(value) ? Object.values(value) : [];
  const divisions: N01Division[] = [];
  rows.forEach((row, index) => {
    if (!isRec(row)) return;
    const teamRows = first(row, ['list', 'teams', 'table', 'tp_list']);
    const teamIds: string[] = [];
    const items = Array.isArray(teamRows) ? teamRows : isRec(teamRows) ? Object.values(teamRows) : [];
    for (const item of items) {
      const id = isRec(item) ? nonEmpty(first(item, ['tpid', 'id'])) : nonEmpty(item);
      if (id) teamIds.push(id);
    }
    divisions.push({
      index,
      title: nonEmpty(first(row, ['lg_title', 'title', 'name'])) ?? `Division ${index + 1}`,
      teamIds,
    });
  });
  return divisions;
}

function parseResults(value: unknown): Map<string, N01MatchResult> {
  const results = new Map<string, N01MatchResult>();
  const rows = Array.isArray(value)
    ? value
    : isRec(value)
      ? Object.entries(value).map(([id, row]) => (isRec(row) ? { __key: id, ...row } : { __key: id, value: row }))
      : [];
  for (const row of rows) {
    if (!isRec(row)) continue;
    const matchId = nonEmpty(first(row, ['lsid', 'id', '__key']));
    if (!matchId) continue;
    const explicit = row.finished ?? row.end;
    const status = num(row.status);
    // An lg_result entry records a played match unless it explicitly says otherwise.
    const finished =
      explicit === false || explicit === 0 || explicit === '0'
        ? false
        : status !== null && status < N01_STATUS.FINISHED && explicit === undefined
          ? false
          : true;
    const gameRows = first(row, ['games', 'result', 'detail']);
    const games: N01GameResult[] = [];
    if (Array.isArray(gameRows)) {
      for (const game of gameRows) {
        if (!isRec(game)) continue;
        const schid = nonEmpty(first(game, ['schid', 'id']));
        if (!schid) continue;
        games.push({ schid, winnerTeamId: nonEmpty(first(game, ['win_tpid', 'winner', 'winner_tpid'])) });
      }
    }
    results.set(matchId, { matchId, finished, games });
  }
  return results;
}

export function parseTournament(raw: unknown, tournamentId: string): N01Tournament {
  const body = unwrap(raw);
  if (!isRec(body)) throw new N01SchemaError('tournament/get', '応答がオブジェクトではありません。');
  const entryRows = requireList('tournament/get', body, ['entry_list', 'entries']);
  const entries = mapRows<N01Entry>('tournament/get', entryRows, (row) => {
    const teamId = nonEmpty(first(row, ['tpid', 'id', '__key']));
    const name = nonEmpty(first(row, ['name', 'tname', 'team_name', 'title', 'oname']));
    if (!teamId || !name) return null;
    return { teamId, name };
  });

  const setting = isRec(body.lg_setting) ? body.lg_setting : {};
  const schedule = parseScheduleSlots('tournament/get lg_setting.schedule', setting.schedule);
  const gameSettings: N01GameSetting[] = [];
  const overrides = Array.isArray(setting.game_setting)
    ? setting.game_setting
    : isRec(setting.game_setting)
      ? Object.values(setting.game_setting)
      : [];
  for (const row of overrides) {
    if (!isRec(row)) continue;
    const round = num(row.round);
    if (round === null) continue;
    const slots = parseScheduleSlots('tournament/get lg_setting.game_setting', row.schedule);
    if (slots.length > 0) gameSettings.push({ round, schedule: slots });
  }

  const soft = num(body.softdarts);
  return {
    tournamentId,
    title: nonEmpty(first(body, ['title', 't_title'])) ?? tournamentId,
    leagueId: nonEmpty(body.lgid),
    status: num(body.status),
    softdarts: soft === 1 ? true : soft === 0 ? false : null,
    entries,
    divisions: parseDivisions(body.lg_table),
    schedule,
    gameSettings,
    results: parseResults(body.lg_result),
  };
}

// ---------------------------------------------------------------------------
// team/player/list, tournament/stats
// ---------------------------------------------------------------------------

export function parseRoster(raw: unknown, teamId: string): N01RosterPlayer[] {
  const rows = requireList('team/player/list', raw, ['list', 'player_list', 'players']);
  return mapRows('team/player/list', rows, (row) => {
    const oid = nonEmpty(first(row, ['oid', 'id', '__key']));
    const name = nonEmpty(first(row, ['oname', 'name']));
    if (!oid || !name) return null;
    return {
      opid: nonEmpty(row.opid),
      oid,
      teamId: nonEmpty(row.tpid) ?? teamId,
      name,
    };
  });
}

export function parseStats(raw: unknown): N01PlayerStats[] {
  const rows = requireList('tournament/stats', raw, ['player_stats_list', 'list', 'stats']);
  return mapRows('tournament/stats', rows, (row) => {
    const opid = nonEmpty(row.opid);
    const oid = nonEmpty(first(row, ['oid', '__key']));
    const score = num(first(row, ['score', 'total_score']));
    const darts = num(first(row, ['darts', 'total_darts']));
    if ((!opid && !oid) || score === null || darts === null) return null;
    return {
      opid,
      oid,
      teamId: nonEmpty(row.tpid),
      name: nonEmpty(first(row, ['oname', 'name'])),
      score,
      darts,
      legs: num(first(row, ['legs', 'leg', 'leg_count'])),
      matches: num(first(row, ['matches', 'games', 'match_count'])),
      legsWon: num(first(row, ['win_legs', 'legs_won', 'win_leg'])),
      first9Score: num(first(row, ['first9_score', 'f9_score'])),
      first9Darts: num(first(row, ['first9_darts', 'f9_darts'])),
      highOut: num(first(row, ['high_out', 'highout'])),
      bestLeg: num(first(row, ['best_leg', 'bestleg'])),
      ton: num(first(row, ['ton', 't100'])),
      ton40: num(first(row, ['ton40', 't140'])),
      ton70: num(first(row, ['ton70', 't170'])),
      ton80: num(first(row, ['ton80', 't180'])),
    };
  });
}

// ---------------------------------------------------------------------------
// league/schedule/get, team/order/list
// ---------------------------------------------------------------------------

const BYE_MARKERS = new Set(['', 'bye', 'BYE', '-', '0']);

export function parseSchedule(raw: unknown, now: number): N01Fixture[] {
  const rows = requireList('league/schedule/get', raw, ['list', 'schedule', 'match_list']);
  return mapRows('league/schedule/get', rows, (row, index) => {
    const matchId = nonEmpty(first(row, ['lsid', 'id', '__key']));
    if (!matchId) return null;
    let sides: (string | null)[] = [];
    const teams = first(row, ['teams', 'tp_list']);
    if (Array.isArray(teams)) {
      sides = teams.map((side) => (isRec(side) ? nonEmpty(first(side, ['tpid', 'id'])) : nonEmpty(side)));
    } else {
      sides = [
        nonEmpty(first(row, ['tpid1', 'home_tpid', 'tpid_a', 'tpid'])),
        nonEmpty(first(row, ['tpid2', 'away_tpid', 'tpid_b'])),
      ];
    }
    const real = sides.filter((side): side is string => side !== null && !BYE_MARKERS.has(side));
    if (real.length === 0) return null;
    const title = nonEmpty(first(row, ['title', 'name'])) ?? '';
    const dateText = nonEmpty(first(row, ['date', 'match_date', 'day']));
    return {
      matchId,
      title,
      homeTeamId: real[0],
      awayTeamId: real[1] ?? null,
      date: parseDateText(dateText, now) ?? parseDateText(title, now),
      listIndex: index,
    };
  });
}

export function parseOrders(raw: unknown): N01OrderEntry[] {
  const rows = requireList('team/order/list', raw, ['list', 'order_list', 'orders']);
  return mapRows('team/order/list', rows, (row) => {
    const schid = nonEmpty(first(row, ['schid', 'sch_id']));
    const playerRows = first(row, ['players', 'player_list', 'oids']);
    if (!schid || !Array.isArray(playerRows)) return null;
    const players = playerRows
      .map((entry) =>
        isRec(entry)
          ? { oid: nonEmpty(entry.oid), opid: nonEmpty(entry.opid), name: nonEmpty(first(entry, ['oname', 'name'])) }
          : { oid: nonEmpty(entry), opid: null, name: null },
      )
      .filter((entry) => entry.oid !== null || entry.opid !== null);
    if (players.length === 0) return null;
    return {
      matchId: nonEmpty(first(row, ['lsid', 'match_id'])),
      schid,
      position: num(row.position),
      players,
    };
  });
}
