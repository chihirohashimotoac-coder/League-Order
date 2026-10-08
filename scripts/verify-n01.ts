/**
 * Read-only live contract check against the n01 public API (`npm run verify:n01`).
 *
 * Not part of `npm run verify` or CI: it needs network access to n01, and n01's data
 * changes every week. It answers one question — does the live service still return
 * what `src/integrations/n01/validation.ts` expects? — for the three known leagues:
 *
 *   league/tournament/list → tournament/get → team/player/list → team/player/list (no
 *   tpid: every team) → tournament/stats → league/schedule/get → team/order/list
 *
 * Only GET requests are made; nothing is written anywhere. Exit code 0 = contract holds.
 */
import { N01Client, N01Error, createFetchTransport } from '../src/integrations/n01/client';
import { KNOWN_LEAGUES } from '../src/integrations/n01/leagueRegistry';
import { seasonPriorityGroups } from '../src/integrations/n01/seasonResolver';
import { effectiveSchedule, gamesFromSchedule, describeFormat, disciplineOf } from '../src/integrations/n01/formatResolver';
import { resolveDivision } from '../src/integrations/n01/divisionResolver';
import { sharedOpids } from '../src/domain/n01/identity';

interface Check {
  league: string;
  step: string;
  ok: boolean;
  detail: string;
}

async function verifyLeague(client: N01Client, leagueId: string, title: string): Promise<Check[]> {
  const checks: Check[] = [];
  const record = (step: string, ok: boolean, detail: string): void => {
    checks.push({ league: title, step, ok, detail });
  };
  const attempt = async <T>(step: string, run: () => Promise<T>, describe: (value: T) => string): Promise<T | null> => {
    try {
      const value = await run();
      record(step, true, describe(value));
      return value;
    } catch (error) {
      record(step, false, error instanceof N01Error ? `${error.kind}: ${error.message}` : String(error));
      return null;
    }
  };

  const list = await attempt('league/tournament/list', () => client.leagueTournaments(leagueId), (value) => `${value.tournaments.length} tournaments`);
  if (!list) return checks;
  const group = seasonPriorityGroups(list.tournaments)[0];
  if (!group) {
    record('season', false, 'no running / open / finished tournament');
    return checks;
  }
  const tournament = await attempt('tournament/get', () => client.tournament(group[0].tournamentId), (value) =>
    `${value.title}: ${value.entries.length} teams, ${value.divisions.length} divisions, ${value.schedule.length} games, softdarts=${String(value.softdarts)}`,
  );
  if (!tournament) return checks;
  const entry = tournament.entries[0];
  const division = entry ? resolveDivision(tournament, entry.teamId) : null;
  const games = gamesFromSchedule(tournament.tournamentId, effectiveSchedule(tournament, division?.index ?? null));
  record('format', games.length > 0, `${describeFormat(games)} (${disciplineOf(tournament)})`);
  if (!entry) return checks;
  await attempt('team/player/list', () => client.roster(tournament.tournamentId, entry.teamId), (value) =>
    `${entry.name}: ${value.length} players, ${value.filter((player) => player.opid).length} with opid`,
  );
  // The whole roster is what shows whether an `opid` names one person in the season: the
  // app asks for it once per season, so a response that is not every team would silently
  // prove too much.
  const everyone = await attempt('team/player/list (all)', () => client.fullRoster(tournament.tournamentId), (value) =>
    `${value.length} players on ${new Set(value.map((player) => player.teamId)).size} teams, ${sharedOpids(value).size} opid(s) under several oids or names`,
  );
  if (everyone) {
    const teams = new Set(everyone.map((player) => player.teamId)).size;
    const expected = Math.min(2, tournament.entries.length);
    record('whole roster', teams >= expected, `${teams} teams in the response (at least ${expected} expected when the tournament has ${tournament.entries.length})`);
  }
  await attempt('tournament/stats', () => client.stats(tournament.tournamentId), (value) => `${value.length} stat rows`);
  await attempt('league/schedule/get', () => client.schedule(tournament.tournamentId), (value) => `${value.length} fixtures`);
  await attempt('team/order/list', () => client.orders(tournament.tournamentId, entry.teamId), (value) => `${value.length} order rows`);
  return checks;
}

async function main(): Promise<void> {
  const client = new N01Client(createFetchTransport(), { timeoutMs: 20_000 });
  const checks: Check[] = [];
  for (const league of KNOWN_LEAGUES) {
    checks.push(...(await verifyLeague(client, league.leagueId, league.title)));
  }
  for (const check of checks) {
    console.log(`${check.ok ? 'PASS' : 'FAIL'}  ${check.league.padEnd(5)} ${check.step.padEnd(24)} ${check.detail}`);
  }
  const failed = checks.filter((check) => !check.ok).length;
  console.log(`\n${checks.length - failed} passed, ${failed} failed (${client.requestCount} requests)`);
  process.exitCode = failed > 0 ? 1 : 0;
}

void main();
