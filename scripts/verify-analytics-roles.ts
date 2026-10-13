/**
 * Read-only live check of the role analytics against n01 (`npm run verify:analytics-roles`).
 *
 * For each season (default: the three ATDO regression seasons) it asks the live API the
 * questions the design rests on, and prints the evidence:
 *
 *  1. Kind of game: every slot's verdict (`match_type` as written, start score, override).
 *  2. Per team: Σ score / darts of its recorded 01 games against n01's `stats_list` — equal
 *     when n01's season counters are 01-only — and the legs / sets difference (the Cricket
 *     games entered without a record, in a mixed season).
 *  3. Per player (a sample within the request budget): the leg-by-leg reconstruction of all
 *     their 01 games against n01's `player_stats_list` (score, darts, First 9, ton, High
 *     Finish; Break in all-01 seasons).
 *
 * Only anonymous GETs through the app's own analytics adapter. Exit code 0 = every checked
 * equality held, 1 = a mismatch where equality is expected, 2 = n01 could not be reached.
 * Not part of CI (the unit tests use fixtures captured from these responses).
 */
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describeN01Error, N01Error } from '../src/integrations/n01/client';
import { AnalyticsApi } from '../src/features/analytics/api/readApi';
import type { RawGame } from '../src/features/analytics/api/parse';
import { seasonComposition, slotFamily } from '../src/features/analytics/gameKind';
import { checkPlayerSeason, safeReconstruct } from '../src/features/analytics/reconstruct';
import type { GameReconstruction } from '../src/features/analytics/reconstruct';
import { classifyGames, isLeagueGame, linesFromGames, tallyGames } from '../src/features/analytics/roleGames';
import { buildSeasonData } from '../src/features/analytics/seasonData';
import { GAME_LIST_PAGE } from '../src/features/analytics/api/readApi';

export const DEFAULT_SEASONS = ['t_ABvC_5234', 't_yyGi_9918', 't_kY1n_6823'];

export interface RoleCheckLine {
  season: string;
  status: 'pass' | 'fail' | 'note';
  text: string;
}

export interface RoleReport {
  lines: RoleCheckLine[];
  requests: number;
  unreachable: boolean;
}

async function allGames(api: AnalyticsApi, tdid: string): Promise<{ games: RawGame[]; complete: boolean }> {
  const games = new Map<string, RawGame>();
  for (let page = 0; page < 20; page += 1) {
    const result = await api.gamesPage(tdid, page);
    for (const g of result.games) if (g.finished && isLeagueGame(g.matchId)) games.set(g.gameId, g);
    if (result.rows < GAME_LIST_PAGE) return { games: [...games.values()], complete: true };
  }
  return { games: [...games.values()], complete: false };
}

/** Checks one season; `playerSample` players are reconstructed (fewest multi-thrower games first). */
export async function verifySeasonRoles(api: AnalyticsApi, tdid: string, playerSample = 4): Promise<RoleCheckLine[]> {
  const out: RoleCheckLine[] = [];
  const say = (status: RoleCheckLine['status'], text: string): void => void out.push({ season: tdid, status, text });
  const tournament = await api.tournament(tdid);
  const [slots, teamStats, playerStats] = [await api.slotEvidence(tdid), await api.teamStats(tdid), await api.playerStats(tdid)];
  let roster = null;
  try {
    roster = await api.fullRoster(tdid);
  } catch {
    say('note', '名簿を取得できません（選手の季跨ぎ結合は検証対象外）');
  }
  const season = buildSeasonData({ tournament, teamStats, playerStats, standings: [], roster, slots });
  const composition = seasonComposition(slots, tournament.divisions.map((d) => d.index));
  say('note', `${tournament.title}: 構成 ${composition.composition}（slot ${slots.length}件 / override ${new Set(slots.filter((s) => s.division !== null).map((s) => s.division)).size}ディビジョン）`);
  for (const s of slots) {
    const v = slotFamily(s);
    say('note', `  slot ${s.schid}${s.division !== null ? `@div${s.division}` : ''} ${s.subtitle ?? ''} num_part=${s.numPart} start=${s.startScore} legs=${s.limitLegCount} match_type=${s.matchType ?? '(なし)'} → ${v.family} (${v.basis})`);
  }
  const { games: raw, complete } = await allGames(api, tdid);
  if (!complete) say('fail', 'ゲーム一覧を最後まで取得できませんでした');
  const games = classifyGames(season, raw);
  const tally = tallyGames(games);
  say('note', `ゲーム ${games.length}件: 01=${tally.byFamily['01']} cricket=${tally.byFamily.cricket} unknown=${tally.byFamily.unknown} / singles=${tally.byRole.singles} doubles=${tally.byRole.doubles} trios=${tally.byRole.trios} gallon=${tally.byRole.gallon} team=${tally.byRole.team} 分類不能=${tally.byRole.unknown}`);

  const lines = linesFromGames(games, 'all01');
  for (const team of season.teams) {
    const mine = lines.teams.get(team.teamId);
    if (!team.line || !mine) continue;
    const scoreOk = team.line.score === mine.score && team.line.darts === mine.darts;
    const legDiff = (team.line.leg ?? 0) - (mine.leg ?? 0);
    const setDiff = (team.line.set ?? 0) - (mine.set ?? 0);
    say(scoreOk ? 'pass' : composition.composition === 'unknown' ? 'note' : 'fail', `team ${team.name}: 01ゲーム ${mine.score}/${mine.darts} vs 公式 ${team.line.score}/${team.line.darts}${legDiff || setDiff ? ` ・ 公式との差 Leg ${legDiff} / Set ${setDiff}` : ''}`);
  }

  const multiCount = (oid: string): number => games.filter((g) => g.sides.some((s) => s.players.length > 1 && s.players.some((p) => p.oid === oid))).length;
  const sample = [...season.players].filter((p) => multiCount(p.oid) > 0).sort((a, b) => multiCount(a.oid) - multiCount(b.oid)).slice(0, playerSample);
  const rebuilt = new Map<string, GameReconstruction>();
  for (const player of sample) {
    const mine = games.filter((g) => g.family.family === '01' && g.sides.some((s) => s.players.some((p) => p.oid === player.oid)));
    for (const g of mine) {
      if (rebuilt.has(g.gameId)) continue;
      try {
        rebuilt.set(g.gameId, safeReconstruct(await api.gameDetail(g.gameId)));
      } catch (error) {
        say('note', `match/get ${g.gameId}: ${describeN01Error(error)}`);
      }
    }
    const check = checkPlayerSeason(tdid, player.oid, player.line, games, rebuilt, composition.composition === 'pure01');
    const v = check.verified;
    say(
      check.verified.score ? 'pass' : check.state === 'incomplete' ? 'note' : 'fail',
      `player ${player.name} (${check.games}ゲーム): ${check.state} 3DA=${v.score} F9=${v.f9} ton=${v.tons} HighOut=${v.highOut} Break=${v.break}${check.compared ? ` ・ 復元 ${check.compared.score[0]}/${check.compared.darts[0]} 公式 ${check.compared.score[1]}/${check.compared.darts[1]}` : ''}`,
    );
  }
  return out;
}

export async function verifyRoles(seasons: readonly string[] = DEFAULT_SEASONS, playerSample = 4): Promise<RoleReport> {
  const api = new AnalyticsApi({ maxRequests: 600 });
  const lines: RoleCheckLine[] = [];
  for (const tdid of seasons) {
    try {
      lines.push(...(await verifySeasonRoles(api, tdid, playerSample)));
    } catch (error) {
      if (error instanceof N01Error && (error.kind === 'network' || error.kind === 'timeout')) return { lines, requests: api.requestCount, unreachable: true };
      lines.push({ season: tdid, status: 'fail', text: describeN01Error(error) });
    }
  }
  return { lines, requests: api.requestCount, unreachable: false };
}

export function formatRoleReport(report: RoleReport): { text: string; exitCode: 0 | 1 | 2 } {
  const mark = { pass: 'OK  ', fail: 'NG  ', note: '    ' } as const;
  const text = [...report.lines.map((l) => `${mark[l.status]}[${l.season}] ${l.text}`), `requests: ${report.requests}`].join('\n');
  if (report.unreachable) return { text: `${text}\nn01 に接続できませんでした。`, exitCode: 2 };
  return { text, exitCode: report.lines.some((l) => l.status === 'fail') ? 1 : 0 };
}

function isMain(): boolean {
  try {
    return process.argv[1] !== undefined && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMain()) {
  const seasons = process.argv.slice(2).filter((a) => a.startsWith('t_'));
  void verifyRoles(seasons.length > 0 ? seasons : DEFAULT_SEASONS).then((report) => {
    const { text, exitCode } = formatRoleReport(report);
    console.log(text);
    process.exit(exitCode);
  });
}
