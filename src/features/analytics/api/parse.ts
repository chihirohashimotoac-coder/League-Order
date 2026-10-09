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
