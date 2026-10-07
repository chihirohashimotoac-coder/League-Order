import type { LeagueFormat } from '../../domain/types';
import type {
  IntelligenceGame,
  IntelligencePlayer,
  N01MatchIntelligenceSnapshot,
  OpponentSnapshot,
} from '../../domain/n01/intelligence';
import { intelligenceSnapshotId } from '../../domain/n01/intelligence';
import type { HistoricalPlayerStats, SeasonStatLine } from '../../domain/n01/history';
import { aggregatePlayer, leagueMeanPpr, playerKey } from '../../domain/n01/history';
import { buildPositionModel, type OrderObservation } from '../../domain/n01/positionModel';
import { RECENCY_WEIGHTS, recencyWeight } from '../../domain/n01/recency';
import { familyOf, formatSignatures, signaturesOf, structureOf, type MatchFamily } from '../../domain/n01/signature';
import { normalizeName } from '../../domain/n01/names';
import type { N01Client } from './client';
import { N01Error } from './client';
import type { N01Fixture, N01OrderEntry, N01PlayerStats, N01RosterPlayer, N01ScheduleSlot, N01Tournament, N01TournamentSummary } from './types';
import type { N01ProgressListener, N01TeamData } from './sync';
import { previousSeasons } from './seasonResolver';
import { resolveNextMatch, type NextMatchResolution } from './scheduleResolver';
import { resolveDivision } from './divisionResolver';
import { effectiveSchedule, matchKind, structuralKind } from './formatResolver';

/**
 * Opponent intelligence (MASTER SPEC Phase 2).
 *
 * Fetch: the schedule → the next match → the opponent's roster and past orders → the
 * previous seasons (at most `historyDepth`; their stats, and the opponent's orders when
 * the same team — by exact name — played that season).
 *
 * Build (pure): the snapshot the predictions read. A failed *historical* request only
 * thins the history (and is listed in `notes`); it never fails the sync, because the
 * current season is what matters most and is already in hand.
 */

export interface HistoricalSeasonData {
  summary: N01TournamentSummary;
  seasonIndex: number;
  tournament: N01Tournament;
  stats: N01PlayerStats[];
  opponentTeamId: string | null;
  opponentOrders: N01OrderEntry[];
}

export interface IntelligenceFetch {
  schedule: N01Fixture[];
  resolution: NextMatchResolution;
  opponentRoster: N01RosterPlayer[];
  opponentOrders: N01OrderEntry[];
  history: HistoricalSeasonData[];
  notes: string[];
}

export interface IntelligenceOptions {
  historyDepth: number;
  now: () => number;
  /** The captain's choice when the next match was ambiguous. */
  chosenMatchId?: string;
}

function soft<T>(promise: Promise<T>, fallback: T, notes: string[], note: string): Promise<T> {
  return promise.catch((error: unknown) => {
    if (error instanceof N01Error && error.kind === 'aborted') throw error;
    notes.push(note);
    return fallback;
  });
}

export async function fetchIntelligence(
  client: N01Client,
  data: N01TeamData,
  options: IntelligenceOptions,
  onProgress: N01ProgressListener = () => undefined,
): Promise<IntelligenceFetch> {
  const notes: string[] = [];
  const tournamentId = data.tournament.tournamentId;

  onProgress('opponent', 'running');
  const schedule = await soft(client.schedule(tournamentId), [] as N01Fixture[], notes, 'n01 の日程を取得できませんでした。');
  let resolution = resolveNextMatch(schedule, data.tournament, data.entry.teamId, options.now());
  if (resolution.kind === 'ambiguous' && options.chosenMatchId) {
    const chosen = resolution.options.find((option) => option.matchId === options.chosenMatchId);
    if (chosen) resolution = { kind: 'resolved', match: chosen };
  }
  let opponentRoster: N01RosterPlayer[] = [];
  let opponentOrders: N01OrderEntry[] = [];
  if (resolution.kind === 'resolved') {
    const opponent = resolution.match.opponentTeamId;
    [opponentRoster, opponentOrders] = await Promise.all([
      client.roster(tournamentId, opponent),
      soft(client.orders(tournamentId, opponent), [] as N01OrderEntry[], notes, '相手の過去オーダーを取得できませんでした。'),
    ]);
  }
  onProgress('opponent', resolution.kind === 'resolved' ? 'done' : 'skipped');

  onProgress('analysis', 'running');
  const opponentName = resolution.kind === 'resolved' ? normalizeName(resolution.match.opponentName) : null;
  const history: HistoricalSeasonData[] = [];
  const previous = previousSeasons(data.tournaments, tournamentId, options.historyDepth);
  for (const [index, summary] of previous.entries()) {
    try {
      const [tournament, stats] = await Promise.all([client.tournament(summary.tournamentId), client.stats(summary.tournamentId)]);
      const opponentEntry = opponentName
        ? tournament.entries.find((entry) => normalizeName(entry.name) === opponentName)
        : undefined;
      const orders = opponentEntry
        ? await soft(client.orders(summary.tournamentId, opponentEntry.teamId), [] as N01OrderEntry[], notes, `${summary.title}: 相手の過去オーダーを取得できませんでした。`)
        : [];
      history.push({
        summary,
        seasonIndex: index + 1,
        tournament,
        stats,
        opponentTeamId: opponentEntry?.teamId ?? null,
        opponentOrders: orders,
      });
    } catch (error) {
      if (error instanceof N01Error && error.kind === 'aborted') throw error;
      notes.push(`${summary.title}: 過去シーズンのデータを取得できませんでした。`);
    }
  }
  onProgress('analysis', 'done');

  return { schedule, resolution, opponentRoster, opponentOrders, history, notes };
}

// ---------------------------------------------------------------------------
// Build (pure)
// ---------------------------------------------------------------------------

interface SeasonSource {
  tournamentId: string;
  title: string;
  seasonIndex: number;
  tournament: N01Tournament;
  stats: N01PlayerStats[];
}

function familyOfSlot(slot: N01ScheduleSlot): MatchFamily {
  const kind = matchKind(slot.matchType);
  return kind === 'CRICKET' ? 'CRICKET' : kind === 'G501' ? '01' : 'OTHER';
}

/** `schid` → signature, for one season's format as a given team played it. */
function slotSignatures(tournament: N01Tournament, teamId: string | null): { bySchid: Map<string, string>; byPosition: string[] } {
  const division = teamId ? resolveDivision(tournament, teamId) : null;
  const schedule = effectiveSchedule(tournament, division?.index ?? null);
  const signatures = signaturesOf(schedule.map((slot) => ({ structure: structuralKind(slot), family: familyOfSlot(slot) })));
  return { bySchid: new Map(schedule.map((slot, index) => [slot.schid, signatures[index]])), byPosition: signatures };
}

function statLine(row: N01PlayerStats, season: SeasonSource): SeasonStatLine {
  return {
    tournamentId: season.tournamentId,
    seasonIndex: season.seasonIndex,
    teamTpid: row.teamId,
    score: row.score,
    darts: row.darts,
    legs: row.legs,
    matches: row.matches,
    legsWon: row.legsWon,
    first9Score: row.first9Score,
    first9Darts: row.first9Darts,
    highOut: row.highOut,
    bestLeg: row.bestLeg,
    ton: row.ton,
    ton40: row.ton40,
    ton70: row.ton70,
    ton80: row.ton80,
  };
}

/** A player's lines across seasons: by opid everywhere, by oid in the current season only. */
function historyOf(player: { opid: string | null; oid: string; name: string }, seasons: readonly SeasonSource[], currentId: string): HistoricalPlayerStats {
  const lines: SeasonStatLine[] = [];
  for (const season of seasons) {
    const row = player.opid
      ? season.stats.find((candidate) => candidate.opid === player.opid)
      : season.tournamentId === currentId
        ? season.stats.find((candidate) => candidate.oid === player.oid)
        : undefined;
    if (row) lines.push(statLine(row, season));
  }
  return { key: playerKey(player.opid, currentId, player.oid), opid: player.opid, name: player.name, seasons: lines };
}

function toPlayers(roster: readonly N01RosterPlayer[], tournamentId: string): IntelligencePlayer[] {
  const seen = new Set<string>();
  const players: IntelligencePlayer[] = [];
  for (const player of roster) {
    const key = playerKey(player.opid, tournamentId, player.oid);
    if (seen.has(key)) continue;
    seen.add(key);
    players.push({ key, opid: player.opid, oid: player.oid, name: player.name });
  }
  return players;
}

function observations(orders: readonly N01OrderEntry[], tournament: N01Tournament, teamId: string, seasonIndex: number): OrderObservation[] {
  const { bySchid, byPosition } = slotSignatures(tournament, teamId);
  const result: OrderObservation[] = [];
  orders.forEach((entry, index) => {
    const signature =
      bySchid.get(entry.schid) ?? (entry.position !== null ? byPosition[entry.position - 1] : undefined);
    if (!signature) return;
    result.push({
      seasonIndex,
      matchId: entry.matchId ?? `#${index}`,
      signature,
      playerKeys: entry.players.map((player) => playerKey(player.opid, tournament.tournamentId, player.oid)),
    });
  });
  return result;
}

export interface BuildIntelligenceInput {
  teamId: string;
  data: N01TeamData;
  /** The team's managed format (the games the next order will fill). */
  format: LeagueFormat;
  fetched: IntelligenceFetch;
  historyDepth: number;
  now: number;
  weights?: readonly number[];
}

export function buildIntelligenceSnapshot(input: BuildIntelligenceInput): N01MatchIntelligenceSnapshot {
  const { data, fetched } = input;
  const weights = input.weights ?? RECENCY_WEIGHTS;
  const currentId = data.tournament.tournamentId;
  const seasons: SeasonSource[] = [
    { tournamentId: currentId, title: data.tournament.title, seasonIndex: 0, tournament: data.tournament, stats: data.stats },
    ...fetched.history.map((season) => ({
      tournamentId: season.tournament.tournamentId,
      title: season.summary.title,
      seasonIndex: season.seasonIndex,
      tournament: season.tournament,
      stats: season.stats,
    })),
  ];

  const signatures = formatSignatures(input.format.games);
  const games: IntelligenceGame[] = [...input.format.games]
    .sort((a, b) => a.order - b.order)
    .map((game) => ({
      gameId: game.id,
      signature: signatures.get(game.id) ?? `${structureOf(game)}|${familyOf(game)}|1`,
      numPart: game.playerCount,
      cricket: game.kinds.includes('CRICKET'),
      limitLegCount: game.n01?.limitLegCount ?? null,
    }));

  const ourPlayers = toPlayers(data.roster, currentId);
  const ourStats = data.roster
    .filter((player, index, all) => all.findIndex((other) => other.oid === player.oid) === index)
    .map((player) => historyOf(player, seasons, currentId));

  let opponent: OpponentSnapshot | null = null;
  if (fetched.resolution.kind === 'resolved') {
    const match = fetched.resolution.match;
    const players = toPlayers(fetched.opponentRoster, currentId);
    const stats = fetched.opponentRoster
      .filter((player, index, all) => all.findIndex((other) => other.oid === player.oid) === index)
      .map((player) => historyOf(player, seasons, currentId));
    const observed = [
      ...observations(fetched.opponentOrders, data.tournament, match.opponentTeamId, 0),
      ...fetched.history.flatMap((season) =>
        season.opponentTeamId ? observations(season.opponentOrders, season.tournament, season.opponentTeamId, season.seasonIndex) : [],
      ),
    ];
    const strengthOf = new Map(stats.map((entry) => [entry.key, aggregatePlayer(entry, weights).ppr]));
    opponent = {
      teamId: match.opponentTeamId,
      name: match.opponentName,
      players,
      stats,
      positionModel: buildPositionModel({
        observations: observed,
        slots: games.map((game) => ({ gameId: game.gameId, signature: game.signature, numPart: game.numPart })),
        roster: players.map((player) => ({ key: player.key, strength: strengthOf.get(player.key) ?? null })),
        weights,
      }),
    };
  }

  const allLines = seasons.flatMap((season) =>
    season.stats.map((row) => ({ score: row.score, darts: row.darts, seasonIndex: season.seasonIndex })),
  );

  return {
    id: intelligenceSnapshotId(input.teamId),
    kind: 'intel',
    teamId: input.teamId,
    generatedAt: input.now,
    leagueId: data.league.leagueId,
    tournamentId: currentId,
    tournamentTitle: data.tournament.title,
    nextMatchStatus: fetched.resolution.kind === 'resolved' ? 'resolved' : fetched.resolution.kind,
    nextMatch: fetched.resolution.kind === 'resolved' ? fetched.resolution.match : null,
    nextMatchOptions: fetched.resolution.kind === 'ambiguous' ? fetched.resolution.options : [],
    games,
    ourPlayers,
    ourStats,
    opponent,
    leagueMeanPpr: leagueMeanPpr(allLines, weights),
    seasons: seasons.map((season) => ({
      tournamentId: season.tournamentId,
      title: season.title,
      seasonIndex: season.seasonIndex,
      weight: recencyWeight(season.seasonIndex, weights),
    })),
    historyDepth: input.historyDepth,
    orderConfidence: opponent?.positionModel.confidence ?? 'LOW',
  };
}
