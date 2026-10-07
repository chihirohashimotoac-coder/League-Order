import type { GameAssignment, LeagueFormat, Player } from '../../domain/types';
import { DEFAULT_N01_SETTINGS } from '../../domain/types';
import { DEFAULT_OPTIMIZER_SETTINGS, DEFAULT_WEIGHTS } from '../../domain/orders/presets';
import { buildNextMatchOrder, eligiblePlayers, type NextMatchOrder } from '../../domain/n01/nextMatch';
import type { N01MatchIntelligenceSnapshot } from '../../domain/n01/intelligence';
import { N01Client } from '../../integrations/n01/client';
import { fetchTeamData, planN01Sync } from '../../integrations/n01/sync';
import { buildIntelligenceSnapshot, fetchIntelligence } from '../../integrations/n01/intelligence';
import { generateLeague, type FixtureLeagueSpec, type SimulatedGame } from './generator';
import { createFixtureTransport } from './transport';

/**
 * Time-travel replay of fixture matches (test-only, MASTER SPEC Phase 6 §1, §3).
 *
 * For a match played on day D, the league is regenerated with `today = D`: the generator
 * is seeded and plays rounds in date order, so every earlier result is identical and the
 * match itself (and everything after it) is simply not played yet. The real pipeline —
 * fetch, plan, intelligence, opponent context — then runs on that dataset with the clock
 * at D 12:00 JST, exactly as a captain would have run it that morning. Nothing from day
 * D or later can reach the order: it is not in the data.
 */

export interface ReplayedMatch {
  date: string;
  matchId: string;
  tournamentId: string;
  teamTpid: string;
  opponentTpid: string;
  format: LeagueFormat;
  players: Player[];
  intel: N01MatchIntelligenceSnapshot;
  order: NextMatchOrder;
  /** What the team actually fielded, as League Order assignments. */
  actual: GameAssignment[];
  /** Games the team actually won (ground truth of the simulation). */
  actualGamesWon: number;
}

export function jstNoon(date: string): number {
  return Date.parse(`${date}T03:00:00Z`);
}

/** Played matches of `tournamentId` on/after `from`, as (match, side) pairs. */
export function playedTeamMatches(
  games: readonly SimulatedGame[],
  tournamentId: string,
): { matchId: string; date: string; teamTpid: string; opponentTpid: string }[] {
  const seen = new Map<string, { matchId: string; date: string; teamTpid: string; opponentTpid: string }>();
  for (const game of games) {
    if (game.tournamentId !== tournamentId) continue;
    for (const [team, opponent] of [
      [game.homeTpid, game.awayTpid],
      [game.awayTpid, game.homeTpid],
    ]) {
      const key = `${game.matchId}:${team}`;
      if (!seen.has(key)) seen.set(key, { matchId: game.matchId, date: game.date, teamTpid: team, opponentTpid: opponent });
    }
  }
  return [...seen.values()].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.matchId < b.matchId ? -1 : 1));
}

export async function replayMatch(
  spec: FixtureLeagueSpec,
  fullGames: readonly SimulatedGame[],
  target: { matchId: string; date: string; teamTpid: string; opponentTpid: string },
  tournamentId: string,
  historyDepth = DEFAULT_N01_SETTINGS.historyDepth,
): Promise<ReplayedMatch> {
  const asOf = generateLeague({ ...spec, today: target.date });
  const now = jstNoon(target.date);
  const client = new N01Client(createFixtureTransport({ datasets: [asOf.dataset] }), { now: () => now });
  const data = await fetchTeamData(
    client,
    { leagueId: spec.leagueId, leagueTitle: spec.title, tournamentId, teamTpid: target.teamTpid },
    () => now,
  );
  let n = 0;
  const team = { id: `team_${target.teamTpid}`, name: target.teamTpid, createdAt: 0 };
  const plan = planN01Sync({ team, localPlayers: [], existingFormat: null, data, now, newId: (prefix) => `${prefix}_${++n}` });
  const fetched = await fetchIntelligence(client, data, { historyDepth, now: () => now });
  const intel = buildIntelligenceSnapshot({ teamId: team.id, data, format: plan.format, fetched, historyDepth, now });
  if (intel.nextMatch?.matchId !== target.matchId) {
    throw new Error(`replay ${target.matchId}: next match resolved to ${intel.nextMatch?.matchId ?? 'none'}`);
  }

  const matchGames = fullGames.filter((game) => game.matchId === target.matchId).sort((a, b) => a.gameIndex - b.gameIndex);
  const playerByOpid = new Map(plan.players.map((player) => [player.n01?.opid, player]));
  const gameBySchid = new Map(plan.format.games.map((game) => [game.n01?.schid, game]));
  const actual: GameAssignment[] = matchGames.map((game) => {
    const slot = gameBySchid.get(game.schid);
    if (!slot) throw new Error(`replay ${target.matchId}: no game for ${game.schid}`);
    const opids = game.homeTpid === target.teamTpid ? game.homeOpids : game.awayOpids;
    return { gameId: slot.id, playerIds: opids.map((opid) => playerByOpid.get(opid)!.id) };
  });
  const actualGamesWon = matchGames.filter((game) => game.homeWon === (game.homeTpid === target.teamTpid)).length;
  const fielded = new Set(actual.flatMap((assignment) => assignment.playerIds));

  const players = eligiblePlayers(plan.players);
  const order = buildNextMatchOrder({
    team: plan.team,
    players,
    format: plan.format,
    pairs: [],
    settings: { activeTeamId: team.id, optimizer: DEFAULT_OPTIMIZER_SETTINGS, lastPreset: 'BALANCED', customWeights: DEFAULT_WEIGHTS },
    intel,
    attending: fielded,
  });
  return {
    date: target.date,
    matchId: target.matchId,
    tournamentId,
    teamTpid: target.teamTpid,
    opponentTpid: target.opponentTpid,
    format: plan.format,
    players,
    intel,
    order,
    actual,
    actualGamesWon,
  };
}
