/**
 * Read-only live contract check for the analytics screens (`npm run verify:analytics-n01`).
 *
 * `verify:n01` checks what the order optimizer reads. PLAYER / TEAM ANALYTICS read two more
 * operations it never touches — `tournament/stats?kind=stats_list` and
 * `tournament/standings` — and depend on facts only the live service can confirm: `r_g`
 * counts divisions from 1 while `standings` / `lg_table` count from 0, and a registered team
 * may have no stats row yet. This script asks the live API those questions for the three
 * known leagues (ATDO, TDO, TDA), for the season it resolves from `league/tournament/list`:
 *
 *   league/tournament/list → tournament/get → stats_list → player_stats_list
 *   → standings → team/player/list (every team)
 *
 * Properties, in the order they matter:
 *  - Only anonymous GETs. No credential is read or sent, no write operation exists here.
 *  - Every request carries `Origin: https://chihirohashimotoac-coder.github.io`; the answer's
 *    `Access-Control-Allow-Origin` is checked, because a browser enforces it and Node does not.
 *  - A registered team without a stats row is reported as 未計測 (not measured). It is never a
 *    failure and never a zero.
 *  - Duplicate / shared `opid`s are reported, not failed: the app is built to hold them out.
 *  - Exit code 0 = contract holds, 1 = contract broken, 2 = n01 could not be reached from
 *    here. Not part of `npm run verify`, CI's publish gate or the unit tests (they are
 *    fixture-based); it runs from the `Verify n01 live contract` workflow or by hand.
 */
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { sharedOpids, rosterCoverage } from '../src/domain/n01/identity';
import { AnalyticsSchemaError, parsePlayerStats, parseStandings, parseTeamStats } from '../src/features/analytics/api/parse';
import { classifySeason } from '../src/features/analytics/seasons';
import { N01_API_BASE_URL, buildUrl } from '../src/integrations/n01/endpoints';
import type { N01Operation } from '../src/integrations/n01/endpoints';
import { KNOWN_LEAGUES } from '../src/integrations/n01/leagueRegistry';
import type { KnownLeague } from '../src/integrations/n01/leagueRegistry';
import { seasonPriorityGroups } from '../src/integrations/n01/seasonResolver';
import type { N01Tournament } from '../src/integrations/n01/types';
import { N01SchemaError, parseLeagueTournaments, parseRoster, parseTournament } from '../src/integrations/n01/validation';

/** The origin the published app is served from (GitHub Pages). */
export const PAGES_ORIGIN = 'https://chihirohashimotoac-coder.github.io';

export type CheckStatus = 'pass' | 'fail' | 'note';

export interface AnalyticsCheck {
  league: string;
  step: string;
  status: CheckStatus;
  detail: string;
}

export interface RequestRecord {
  league: string;
  /** `operation?sorted=params`, the path the browser would request. */
  path: string;
  /** `null` when the request never got an HTTP answer. */
  httpStatus: number | null;
  allowOrigin: string | null;
  jsonOk: boolean;
}

/** Thrown when n01 gives no HTTP answer at all: the environment cannot reach it. */
export class N01UnreachableError extends Error {
  constructor(
    readonly path: string,
    readonly reason: string,
  ) {
    super(`${path}: ${reason}`);
    this.name = 'N01UnreachableError';
  }
}

export interface ReaderOptions {
  fetchImpl?: typeof fetch;
  baseUrl?: string;
  origin?: string;
  timeoutMs?: number;
  /** Pause before retrying a 429, in ms; tests pass a no-op. */
  sleep?: (ms: number) => Promise<void>;
}

type Fetched = { ok: true; json: unknown } | { ok: false; reason: string };

/** One league's GET requests, with the evidence (status, CORS header) of each kept. */
export class Reader {
  readonly records: RequestRecord[] = [];
  league = '';
  requestCount = 0;
  private readonly fetchImpl: typeof fetch;
  private readonly baseUrl: string;
  private readonly origin: string;
  private readonly timeoutMs: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(options: ReaderOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.baseUrl = options.baseUrl ?? N01_API_BASE_URL;
    this.origin = options.origin ?? PAGES_ORIGIN;
    this.timeoutMs = options.timeoutMs ?? 20_000;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  async get(operation: string, params: Record<string, string>): Promise<Fetched> {
    const url = buildUrl(this.baseUrl, { operation: operation as N01Operation, params });
    const path = `${operation}?${new URL(url).searchParams.toString()}`;
    let response: Response | null = null;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      this.requestCount += 1;
      try {
        response = await this.fetchImpl(url, {
          method: 'GET',
          credentials: 'omit',
          cache: 'no-store',
          redirect: 'error',
          headers: { Accept: 'application/json', Origin: this.origin },
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch (error) {
        const cause = error instanceof Error && error.cause instanceof Error ? ` (${error.cause.message})` : '';
        throw new N01UnreachableError(path, `${error instanceof Error ? error.message : String(error)}${cause}`);
      }
      if (response.status !== 429 || attempt === 1) break;
      const wait = Math.min(Number(response.headers.get('retry-after')) || 2, 10);
      await this.sleep(wait * 1000);
    }
    const res = response!;
    const record: RequestRecord = {
      league: this.league,
      path,
      httpStatus: res.status,
      allowOrigin: res.headers.get('access-control-allow-origin'),
      jsonOk: false,
    };
    this.records.push(record);
    if (res.status < 200 || res.status >= 300) return { ok: false, reason: `HTTP ${res.status}` };
    let json: unknown;
    try {
      json = JSON.parse(await res.text());
    } catch {
      return { ok: false, reason: `HTTP ${res.status} but the body is not JSON` };
    }
    record.jsonOk = true;
    return { ok: true, json };
  }
}

type Rec = Record<string, unknown>;
const isRec = (value: unknown): value is Rec => typeof value === 'object' && value !== null && !Array.isArray(value);

/** The key under which a stats container is found, in the order the app's parser looks. */
function containerKey(raw: unknown, keys: readonly string[]): string | null {
  if (!isRec(raw)) return null;
  return keys.find((key) => Array.isArray(raw[key]) || isRec(raw[key])) ?? null;
}

/** Raw rows of a stats container (object keyed by id, or array); `key` is the id when keyed. */
function rawRows(raw: unknown, keys: readonly string[]): { key: string | null; row: Rec }[] {
  const key = containerKey(raw, keys);
  if (!isRec(raw) || key === null) return [];
  const container = raw[key];
  if (Array.isArray(container)) return container.filter(isRec).map((row) => ({ key: null, row }));
  return Object.entries(container as Rec)
    .filter((entry): entry is [string, Rec] => isRec(entry[1]))
    .map(([id, row]) => ({ key: id, row }));
}

const numberOf = (value: unknown): number | null => {
  const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : Number.NaN;
  return Number.isFinite(n) ? n : null;
};

function describeError(error: unknown): string {
  if (error instanceof N01SchemaError || error instanceof AnalyticsSchemaError) return `schema: ${error.message}`;
  return error instanceof Error ? error.message : String(error);
}

const list = (items: readonly string[], max = 6): string =>
  items.length <= max ? items.join(', ') : `${items.slice(0, max).join(', ')} … (+${items.length - max})`;

interface DivisionTally {
  agree: number;
  disagree: number;
  /** On a registered team, but n01 reports no division (`r_g` absent or 0). */
  unknown: number;
  /** Not on a registered team (or no team id at all): nothing to compare with. */
  unplaced: number;
  /** Rows whose `r_g` equals the 0-based `lg_table` index instead of index + 1. */
  zeroBasedLooking: number;
}

/**
 * Compares each stats row's raw `r_g` (counted from 1) with the `lg_table` division of its team.
 * The team id is the row's `tpid`, or — as in the live `stats_list`, keyed by `tpid` — the
 * container key, the same fallback the app's parser uses.
 */
function tallyDivisions(rows: readonly { key: string | null; row: Rec }[], divisionOfTeam: ReadonlyMap<string, number>): DivisionTally {
  const tally: DivisionTally = { agree: 0, disagree: 0, unknown: 0, unplaced: 0, zeroBasedLooking: 0 };
  for (const { key, row } of rows) {
    const teamId = typeof row.tpid === 'string' && row.tpid !== '' ? row.tpid : key;
    const expected = teamId === null ? undefined : divisionOfTeam.get(teamId);
    if (expected === undefined) {
      tally.unplaced += 1;
      continue;
    }
    const rg = numberOf(row.r_g);
    if (rg === null || rg < 1) {
      // n01 reports no division (0 / absent): nothing to compare.
      tally.unknown += 1;
      continue;
    }
    if (rg - 1 === expected) tally.agree += 1;
    else {
      tally.disagree += 1;
      if (rg === expected) tally.zeroBasedLooking += 1;
    }
  }
  return tally;
}

/** The standings group index that holds a team, for each team in the league groups. */
function standingsIndexOfTeam(groups: readonly { divisionIndex: number; rows: readonly { teamId: string }[] }[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const group of groups) for (const row of group.rows) out.set(row.teamId, group.divisionIndex);
  return out;
}

export async function verifyAnalyticsLeague(reader: Reader, league: Pick<KnownLeague, 'leagueId' | 'title'>): Promise<AnalyticsCheck[]> {
  const checks: AnalyticsCheck[] = [];
  const title = league.title;
  reader.league = title;
  const record = (step: string, status: CheckStatus, detail: string): void => {
    checks.push({ league: title, step, status, detail });
  };

  // 1. league/tournament/list ------------------------------------------------------------
  const listed = await reader.get('league/tournament/list', { lgid: league.leagueId });
  if (!listed.ok) return record('league/tournament/list', 'fail', listed.reason), checks;
  let tournaments;
  try {
    tournaments = parseLeagueTournaments(listed.json, league.leagueId).tournaments;
  } catch (error) {
    return record('league/tournament/list', 'fail', describeError(error)), checks;
  }
  record('league/tournament/list', 'pass', `HTTP 200 JSON, ${tournaments.length} tournaments`);

  // 2. Resolve the season: priority order (running → … → latest finished), first regular league season.
  const candidates = seasonPriorityGroups(tournaments).flat().slice(0, 4);
  let tournament: N01Tournament | null = null;
  const passedOver: string[] = [];
  for (const summary of candidates) {
    const got = await reader.get('tournament/get', { tdid: summary.tournamentId });
    if (!got.ok) {
      record('tournament/get', 'fail', `${summary.tournamentId}: ${got.reason}`);
      return checks;
    }
    let parsed: N01Tournament;
    try {
      parsed = parseTournament(got.json, summary.tournamentId);
    } catch (error) {
      record('tournament/get', 'fail', `${summary.tournamentId}: ${describeError(error)}`);
      return checks;
    }
    const classification = classifySeason(summary, parsed);
    if (classification.kind === 'league') {
      tournament = parsed;
      break;
    }
    passedOver.push(`${summary.tournamentId} (${classification.reason})`);
  }
  if (!tournament) {
    record('season', 'fail', `no regular league season among ${candidates.length} candidate(s)${passedOver.length ? `: ${list(passedOver)}` : ''}`);
    return checks;
  }
  const tdid = tournament.tournamentId;
  record('season', 'pass', `${tdid} "${tournament.title}" status=${tournament.status ?? '?'}${passedOver.length ? `; passed over: ${list(passedOver)}` : ''}`);
  const registered = new Map(tournament.entries.map((entry) => [entry.teamId, entry.name]));
  const divisionOfTeam = new Map<string, number>();
  for (const division of tournament.divisions) for (const teamId of division.teamIds) divisionOfTeam.set(teamId, division.index);
  const containersOk = tournament.entries.length > 0 && tournament.divisions.length > 0;
  record(
    'tournament/get',
    containersOk ? 'pass' : 'fail',
    `entry_list ${tournament.entries.length} teams, lg_table ${tournament.divisions.length} divisions (${tournament.divisions.map((d) => d.teamIds.length).join('/')} teams)`,
  );
  const unplaced = [...registered.keys()].filter((teamId) => !divisionOfTeam.has(teamId));
  if (unplaced.length > 0) record('lg_table coverage', 'note', `${unplaced.length} registered team(s) are in no lg_table division: ${list(unplaced)}`);

  // 3. stats_list ----------------------------------------------------------------------------
  const teamRaw = await reader.get('tournament/stats', { tdid, kind: 'stats_list' });
  let teamRows: { key: string | null; row: Rec }[] = [];
  if (!teamRaw.ok) record('stats_list', 'fail', teamRaw.reason);
  else {
    try {
      const parsed = parseTeamStats(teamRaw.json);
      const key = containerKey(teamRaw.json, ['stats', 'stats_list', 'list']);
      teamRows = rawRows(teamRaw.json, ['stats', 'stats_list', 'list']);
      const measured = new Set(parsed.map((row) => row.teamId));
      const unmeasured = [...registered].filter(([teamId]) => !measured.has(teamId));
      const stray = parsed.filter((row) => !registered.has(row.teamId)).length;
      record('stats_list', 'pass', `HTTP 200 JSON, container "${key}", ${parsed.length} rows for ${registered.size} registered teams`);
      record(
        'stats_list coverage',
        'note',
        unmeasured.length === 0
          ? `all ${registered.size} registered teams have a stats row`
          : `${unmeasured.length} registered team(s) have no stats row — 未計測 (not 0, not a failure): ${list(unmeasured.map(([id, name]) => `${name}[${id}]`))}`,
      );
      if (stray > 0) record('stats_list extra rows', 'note', `${stray} row(s) belong to teams that are not registered (the app drops them)`);
    } catch (error) {
      record('stats_list', 'fail', describeError(error));
    }
  }

  // 4. player_stats_list -------------------------------------------------------------------------
  const playerRaw = await reader.get('tournament/stats', { tdid, kind: 'player_stats_list' });
  let playerRows: { key: string | null; row: Rec }[] = [];
  let playerParsed: ReturnType<typeof parsePlayerStats> = [];
  if (!playerRaw.ok) record('player_stats_list', 'fail', playerRaw.reason);
  else {
    try {
      playerParsed = parsePlayerStats(playerRaw.json);
      const key = containerKey(playerRaw.json, ['stats', 'player_stats_list', 'list']);
      playerRows = rawRows(playerRaw.json, ['stats', 'player_stats_list', 'list']);
      const onRegistered = playerParsed.filter((row) => row.teamId !== null && registered.has(row.teamId)).length;
      record('player_stats_list', 'pass', `HTTP 200 JSON, container "${key}", ${playerParsed.length} rows (${onRegistered} on registered teams)`);
      const seen = new Map<string, Set<string>>();
      const repeated = new Set<string>();
      for (const row of playerParsed) {
        if (seen.has(row.oid)) repeated.add(row.oid);
        seen.set(row.oid, (seen.get(row.oid) ?? new Set<string>()).add(row.teamId ?? ''));
      }
      const onSeveralTeams = [...seen].filter(([, teams]) => teams.size > 1).map(([oid]) => oid);
      if (repeated.size > 0 || onSeveralTeams.length > 0) {
        record(
          'duplicate oid',
          'note',
          `${repeated.size} oid(s) listed more than once${repeated.size ? ` (${list([...repeated])})` : ''}, ${onSeveralTeams.length} oid(s) on several teams${onSeveralTeams.length ? ` (${list(onSeveralTeams)})` : ''}; the app keeps one row, and holds a multi-team oid out of every figure`,
        );
      } else record('duplicate oid', 'note', 'none: every oid appears once, on one team');
    } catch (error) {
      record('player_stats_list', 'fail', describeError(error));
    }
  }

  // 5. standings -----------------------------------------------------------------------------------
  const standingsRaw = await reader.get('tournament/standings', { tdid });
  let standingsIndex = new Map<string, number>();
  if (!standingsRaw.ok) record('standings', 'fail', standingsRaw.reason);
  else {
    try {
      const groups = parseStandings(standingsRaw.json);
      standingsIndex = standingsIndexOfTeam(groups);
      const rowCount = groups.reduce((total, group) => total + group.rows.length, 0);
      record('standings', 'pass', `HTTP 200 JSON, ${groups.length} league group(s) indexed ${list(groups.map((g) => String(g.divisionIndex)))}, ${rowCount} rows`);
      const divisionIndexes = tournament.divisions.map((d) => d.index);
      const groupIndexes = groups.map((g) => g.divisionIndex);
      const sameIndexes = divisionIndexes.length === groupIndexes.length && divisionIndexes.every((index) => groupIndexes.includes(index));
      const misplaced = [...standingsIndex].filter(([teamId, index]) => divisionOfTeam.has(teamId) && divisionOfTeam.get(teamId) !== index).map(([teamId]) => teamId);
      const absent = [...registered.keys()].filter((teamId) => !standingsIndex.has(teamId));
      record(
        'standings index ↔ lg_table',
        sameIndexes && misplaced.length === 0 ? 'pass' : 'fail',
        `group indexes [${groupIndexes.join(',')}] vs lg_table indexes [${divisionIndexes.join(',')}] (both 0-based); ${misplaced.length} team(s) in a different division than lg_table${misplaced.length ? `: ${list(misplaced)}` : ''}`,
      );
      if (absent.length > 0) record('standings coverage', 'note', `${absent.length} registered team(s) are in no standings row: ${list(absent)}`);
    } catch (error) {
      record('standings', 'fail', describeError(error));
    }
  }

  // 6. r_g (counted from 1) ↔ lg_table / standings (counted from 0) -----------------------------------
  if (teamRaw.ok || playerRaw.ok) {
    const sources: [string, DivisionTally][] = [];
    if (teamRaw.ok) sources.push(['stats_list', tallyDivisions(teamRows, divisionOfTeam)]);
    if (playerRaw.ok) sources.push(['player_stats_list', tallyDivisions(playerRows, divisionOfTeam)]);
    const disagree = sources.reduce((total, [, tally]) => total + tally.disagree, 0);
    const zeroBased = sources.reduce((total, [, tally]) => total + tally.zeroBasedLooking, 0);
    // The same comparison against the standings group index, for the teams n01 ranks.
    const rgOfTeam = new Map<string, number>();
    for (const { key, row } of teamRows) {
      const teamId = typeof row.tpid === 'string' && row.tpid !== '' ? row.tpid : key;
      const rg = numberOf(row.r_g);
      if (teamId !== null && rg !== null && rg >= 1) rgOfTeam.set(teamId, rg);
    }
    const viaStandings = [...standingsIndex].filter(([teamId, index]) => rgOfTeam.has(teamId) && rgOfTeam.get(teamId)! - 1 !== index);
    // Rows exist but none could be placed in a division: the check would be vacuous, which must not read as a pass.
    const vacuous = teamRows.length + playerRows.length > 0 && sources.every(([, t]) => t.agree + t.disagree + t.unknown === 0);
    const detail = sources.map(([name, t]) => `${name}: ${t.agree} agree, ${t.disagree} disagree, ${t.unknown} without r_g, ${t.unplaced} not on a registered team`).join('; ');
    record(
      'r_g ↔ index',
      disagree === 0 && viaStandings.length === 0 && !vacuous ? 'pass' : 'fail',
      `r_g − 1 = lg_table index; ${detail}; vs standings index: ${viaStandings.length} of ${rgOfTeam.size} team(s) disagree${vacuous ? '; NOTHING WAS COMPARED (no stats row maps to a registered team)' : ''}${zeroBased > 0 ? `; ${zeroBased} row(s) have r_g equal to the 0-based index (looks 0-based, not 1-based)` : ''}`,
    );
  }

  // 7. team/player/list, every team ------------------------------------------------------------------------
  const rosterRaw = await reader.get('team/player/list', { tdid });
  if (!rosterRaw.ok) record('team/player/list (all)', 'fail', rosterRaw.reason);
  else {
    try {
      const roster = parseRoster(rosterRaw.json, '');
      const coverage = rosterCoverage(roster, registered.keys());
      record(
        'team/player/list (all)',
        coverage.complete ? 'pass' : 'fail',
        coverage.complete
          ? `HTTP 200 JSON, ${roster.length} players on all ${registered.size} registered teams${coverage.extra.length ? ` (+ ${coverage.extra.length} team id(s) not registered)` : ''}`
          : `only ${registered.size - coverage.missing.length} of ${registered.size} registered teams (missing: ${list(coverage.missing) || 'the tournament lists no team'})`,
      );
      const rosterOids = new Set(roster.map((player) => player.oid));
      const notOnRoster = playerParsed.filter((row) => !rosterOids.has(row.oid)).length;
      record('roster ↔ player stats', 'note', `${notOnRoster} of ${playerParsed.length} stats row(s) have an oid that is not on the roster`);
      const shared = sharedOpids([
        ...roster.map((p) => ({ opid: p.opid, oid: p.oid, name: p.name })),
        ...playerParsed.map((p) => ({ opid: p.opid, oid: p.oid, name: p.name })),
      ]);
      record(
        'shared opid',
        'note',
        shared.size === 0 ? 'none: every opid names one person in this season' : `${shared.size} opid(s) shared or duplicated in this season: ${list([...shared])} — not linked across seasons by the app`,
      );
    } catch (error) {
      record('team/player/list (all)', 'fail', describeError(error));
    }
  }

  // 8. CORS ---------------------------------------------------------------------------------------------------
  const mine = reader.records.filter((r) => r.league === title);
  const blocked = mine.filter((r) => r.allowOrigin !== PAGES_ORIGIN && r.allowOrigin !== '*');
  record(
    'CORS',
    blocked.length === 0 ? 'pass' : 'fail',
    blocked.length === 0
      ? `${mine.length} of ${mine.length} responses allow Origin ${PAGES_ORIGIN} (Access-Control-Allow-Origin: ${list([...new Set(mine.map((r) => r.allowOrigin ?? ''))])})`
      : `${blocked.length} of ${mine.length} responses do not allow Origin ${PAGES_ORIGIN}: ${list(blocked.map((r) => `${r.path} → ${r.allowOrigin ?? '(no header)'}`), 3)}`,
  );
  return checks;
}

export interface Report {
  checks: AnalyticsCheck[];
  records: RequestRecord[];
  /** Set when n01 could not be reached at all. */
  unreachable: string | null;
  requestCount: number;
}

export async function verifyAll(options: ReaderOptions = {}, leagues: readonly Pick<KnownLeague, 'leagueId' | 'title'>[] = KNOWN_LEAGUES): Promise<Report> {
  const reader = new Reader(options);
  const checks: AnalyticsCheck[] = [];
  try {
    for (const league of leagues) checks.push(...(await verifyAnalyticsLeague(reader, league)));
    return { checks, records: reader.records, unreachable: null, requestCount: reader.requestCount };
  } catch (error) {
    if (error instanceof N01UnreachableError) {
      return { checks, records: reader.records, unreachable: error.message, requestCount: reader.requestCount };
    }
    throw error;
  }
}

export function formatReport(report: Report): { text: string; exitCode: 0 | 1 | 2 } {
  const lines: string[] = [];
  if (report.unreachable) {
    for (const check of report.checks) lines.push(`${check.status.toUpperCase().padEnd(4)}  ${check.league.padEnd(5)} ${check.step.padEnd(26)} ${check.detail}`);
    lines.push(
      `UNREACHABLE  n01 (${N01_API_BASE_URL}) gave no HTTP answer, so the live contract could not be checked: ${report.unreachable}`,
      'This environment cannot reach n01 (offline, blocked by a proxy/firewall, or n01 is down). It says nothing about the contract:',
      'run this where n01 is reachable, e.g. the "Verify n01 live contract" workflow. Unit tests and fixtures are unaffected.',
    );
    return { text: lines.join('\n'), exitCode: 2 };
  }
  for (const check of report.checks) lines.push(`${check.status.toUpperCase().padEnd(4)}  ${check.league.padEnd(5)} ${check.step.padEnd(26)} ${check.detail}`);
  lines.push('', 'Requests (GET only, Origin: ' + PAGES_ORIGIN + '):');
  for (const record of report.records) {
    lines.push(`  ${record.league.padEnd(5)} GET /api/v1/${record.path}  → HTTP ${record.httpStatus ?? '-'}  json=${record.jsonOk ? 'yes' : 'no'}  ACAO=${record.allowOrigin ?? '(none)'}`);
  }
  const count = (status: CheckStatus): number => report.checks.filter((check) => check.status === status).length;
  lines.push('', `${count('pass')} passed, ${count('fail')} failed, ${count('note')} notes (${report.requestCount} requests)`);
  return { text: lines.join('\n'), exitCode: count('fail') > 0 ? 1 : 0 };
}

async function main(): Promise<void> {
  const report = await verifyAll();
  const { text, exitCode } = formatReport(report);
  console.log(text);
  process.exitCode = exitCode;
}

// Run only as a script: the tests import the functions above and must not start a live check.
const invokedDirectly = process.argv[1] !== undefined && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
if (invokedDirectly) void main();
