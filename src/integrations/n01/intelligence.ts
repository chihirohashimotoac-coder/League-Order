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
import { isUsableOpid, sharedOpids, unprovenOpids, type IdentityRef } from '../../domain/n01/identity';
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
 * Whole rosters: for the current season and for each past season referenced, every team's
 * members are read once (`team/player/list` without a team). They are what shows whether an
 * `opid` names one person in that season (`domain/n01/identity.ts`): stats and line-ups only
 * name the people who played.
 *
 * Build (pure): the snapshot the predictions read. A failed *historical* request only
 * thins the history (and is listed in `notes`); it never fails the sync, because the
 * current season is what matters most and is already in hand. A season whose whole roster
 * could not be read is not *proven* for any `opid`: nothing joins seasons through it.
 */

export interface HistoricalSeasonData {
  summary: N01TournamentSummary;
  seasonIndex: number;
  tournament: N01Tournament;
  stats: N01PlayerStats[];
  opponentTeamId: string | null;
  opponentOrders: N01OrderEntry[];
}

/** Every team's members, per season; `null` = the request failed (nothing is proven there). */
export interface SeasonRosters {
  current: N01RosterPlayer[] | null;
  byTournament: Record<string, N01RosterPlayer[] | null>;
}

export interface IntelligenceFetch {
  schedule: N01Fixture[];
  resolution: NextMatchResolution;
  opponentRoster: N01RosterPlayer[];
  opponentOrders: N01OrderEntry[];
  history: HistoricalSeasonData[];
  rosters: SeasonRosters;
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

  // The current season's whole roster, asked once and alongside everything else.
  const currentRoster = soft(
    client.fullRoster(tournamentId),
    null as N01RosterPlayer[] | null,
    notes,
    '今季の名簿 (全チーム) を取得できなかったため、選手 ID (opid) による過去シーズンとの結び付けは行いません。',
  );
  // An abort rejects it; if something else throws first it must not go unhandled.
  currentRoster.catch(() => undefined);

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
  const byTournament: Record<string, N01RosterPlayer[] | null> = {};
  const previous = previousSeasons(data.tournaments, tournamentId, options.historyDepth);
  for (const [index, summary] of previous.entries()) {
    try {
      const [tournament, stats, roster] = await Promise.all([
        client.tournament(summary.tournamentId),
        client.stats(summary.tournamentId),
        soft(
          client.fullRoster(summary.tournamentId),
          null as N01RosterPlayer[] | null,
          notes,
          `${summary.title}: 名簿 (全チーム) を取得できなかったため、この季は選手 ID (opid) による結び付けを行いません。`,
        ),
      ]);
      byTournament[summary.tournamentId] = roster;
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

  return { schedule, resolution, opponentRoster, opponentOrders, history, rosters: { current: await currentRoster, byTournament }, notes };
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

/** The `opid`s that name several people in a season (judged from that season's rows only). */
type SeasonIdentity = (tournamentId: string) => ReadonlySet<string>;

/**
 * A player's lines across seasons (see `domain/n01/identity.ts`).
 *
 * In the current season the player's own `oid` is authoritative; their `opid` is only a
 * fallback, and only when it names one person. Earlier seasons are reached through the
 * `opid` alone, and only when it names one person in the current season *and* in that
 * season — otherwise the person simply has no line there (Unknown, never a namesake's).
 */
function historyOf(
  player: { opid: string | null; oid: string; name: string },
  seasons: readonly SeasonSource[],
  currentId: string,
  identity: SeasonIdentity,
): HistoricalPlayerStats {
  const currentShared = identity(currentId);
  const lines: SeasonStatLine[] = [];
  for (const season of seasons) {
    let row: N01PlayerStats | undefined;
    if (season.tournamentId === currentId) {
      row =
        season.stats.find((candidate) => candidate.oid === player.oid) ??
        (isUsableOpid(player.opid, currentShared) ? season.stats.find((candidate) => candidate.opid === player.opid) : undefined);
    } else if (isUsableOpid(player.opid, currentShared, identity(season.tournamentId))) {
      row = season.stats.find((candidate) => candidate.opid === player.opid);
    }
    if (row) lines.push(statLine(row, season));
  }
  return { key: playerKey(player.opid, currentId, player.oid, currentShared), opid: player.opid, name: player.name, seasons: lines };
}

function toPlayers(roster: readonly N01RosterPlayer[], tournamentId: string, shared: ReadonlySet<string>): IntelligencePlayer[] {
  const seen = new Set<string>();
  const players: IntelligencePlayer[] = [];
  for (const player of roster) {
    const key = playerKey(player.opid, tournamentId, player.oid, shared);
    if (seen.has(key)) continue;
    seen.add(key);
    players.push({ key, opid: player.opid, oid: player.oid, name: player.name });
  }
  return players;
}

/**
 * A team's past line-ups as observations of people.
 *
 * Current-season orders name people by `oid`, which is matched to the roster directly.
 * Earlier seasons can only be attributed through an `opid` that names one person in both
 * that season and the current one; anything else is recorded under a key no current
 * player has, so it is dropped rather than credited to the wrong person.
 */
function observations(
  orders: readonly N01OrderEntry[],
  tournament: N01Tournament,
  teamId: string,
  seasonIndex: number,
  keyOf: (player: { opid: string | null; oid: string | null }) => string,
): OrderObservation[] {
  const { bySchid, byPosition } = slotSignatures(tournament, teamId);
  const result: OrderObservation[] = [];
  orders.forEach((entry, index) => {
    const signature =
      (entry.schid !== null ? bySchid.get(entry.schid) : undefined) ??
      (entry.position !== null ? byPosition[entry.position - 1] : undefined);
    if (!signature) return;
    result.push({
      seasonIndex,
      matchId: entry.matchId ?? `#${index}`,
      signature,
      playerKeys: entry.players.map(keyOf),
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

  // Which `opid`s name several people, judged season by season from that season's own rows:
  // the whole roster first (it shows the people who did not play too), then stats and orders.
  // A season whose whole roster is missing has no proven `opid` at all.
  const identityRows = new Map<string, IdentityRef[]>([
    [
      currentId,
      [
        ...(fetched.rosters.current ?? []),
        ...data.stats,
        ...data.roster,
        ...fetched.opponentRoster,
        ...fetched.opponentOrders.flatMap((entry) => entry.players),
      ],
    ],
  ]);
  const unproven = new Set<string>();
  if (!fetched.rosters.current) unproven.add(currentId);
  for (const season of fetched.history) {
    const id = season.tournament.tournamentId;
    const roster = fetched.rosters.byTournament[id];
    if (!roster) unproven.add(id);
    identityRows.set(id, [...(roster ?? []), ...season.stats, ...season.opponentOrders.flatMap((entry) => entry.players)]);
  }
  const sharedBySeason = new Map([...identityRows].map(([id, rows]) => [id, sharedOpids(rows)]));
  const identity: SeasonIdentity = (tournamentId) =>
    unproven.has(tournamentId) ? unprovenOpids() : (sharedBySeason.get(tournamentId) ?? new Set<string>());
  const currentShared = identity(currentId);

  const ourPlayers = toPlayers(data.roster, currentId, currentShared);
  const ourStats = data.roster
    .filter((player, index, all) => all.findIndex((other) => other.oid === player.oid) === index)
    .map((player) => historyOf(player, seasons, currentId, identity));

  let opponent: OpponentSnapshot | null = null;
  if (fetched.resolution.kind === 'resolved') {
    const match = fetched.resolution.match;
    const players = toPlayers(fetched.opponentRoster, currentId, currentShared);
    const stats = fetched.opponentRoster
      .filter((player, index, all) => all.findIndex((other) => other.oid === player.oid) === index)
      .map((player) => historyOf(player, seasons, currentId, identity));
    const rosterKeyByOid = new Map(players.flatMap((player) => (player.oid ? [[player.oid, player.key] as const] : [])));
    // This season's orders name people by oid; earlier seasons only through an opid that
    // names one person in both seasons. Anything else gets a key no current player has.
    const currentKey = (player: { opid: string | null; oid: string | null }): string =>
      (player.oid ? rosterKeyByOid.get(player.oid) : undefined) ?? playerKey(player.opid, currentId, player.oid, currentShared);
    const pastKey = (seasonId: string) => (player: { opid: string | null; oid: string | null }): string =>
      isUsableOpid(player.opid, currentShared, identity(seasonId))
        ? player.opid
        : `oid:${seasonId}:${player.oid ?? '?'}`;
    const observed = [
      ...observations(fetched.opponentOrders, data.tournament, match.opponentTeamId, 0, currentKey),
      ...fetched.history.flatMap((season) =>
        season.opponentTeamId
          ? observations(season.opponentOrders, season.tournament, season.opponentTeamId, season.seasonIndex, pastKey(season.tournament.tournamentId))
          : [],
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
