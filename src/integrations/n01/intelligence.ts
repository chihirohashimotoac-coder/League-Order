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
import { isUsableOpid, rosterCoverage, sharedOpids, unprovenOpids, type IdentityRef } from '../../domain/n01/identity';
import type { N01Client } from './client';
import { N01Error } from './client';
import type { N01Fixture, N01GameRecord, N01OrderEntry, N01PlayerStats, N01RosterPlayer, N01ScheduleSlot, N01Tournament, N01TournamentSummary } from './types';
import {
  aggregateRoleEvidence,
  familyOfMatchType,
  jstDayStart,
  structureOfHeadCount,
  type RoleGameRecord,
} from '../../domain/n01/roleHistory';
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
 * could not be read, or came back without every registered team, is not *proven* for any
 * `opid`: nothing joins seasons through it.
 */

export interface HistoricalSeasonData {
  summary: N01TournamentSummary;
  seasonIndex: number;
  tournament: N01Tournament;
  stats: N01PlayerStats[];
  opponentTeamId: string | null;
  opponentOrders: N01OrderEntry[];
}

/** One team's played games in one season (`match/list`), for the role evidence. */
export interface RoleGamesFetch {
  tournamentId: string;
  seasonIndex: number;
  teamId: string;
  /** Whose games: our team's or the next opponent's. */
  team: 'ours' | 'opponent';
  games: N01GameRecord[];
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
  /** Our team's and the opponent's games per season (absent on fetches made before it). */
  roleGames?: RoleGamesFetch[];
  /** Requests for games that failed (the role evidence is thinner for them, never wrong). */
  roleGameFailures?: number;
  notes: string[];
}

export interface IntelligenceOptions {
  historyDepth: number;
  now: () => number;
  /** The captain's choice when the next match was ambiguous. */
  chosenMatchId?: string;
}

/** A note when a whole roster came back without every registered team (null when it is complete). */
function incompleteRosterNote(title: string, roster: readonly N01RosterPlayer[] | null, tournament: N01Tournament): string | null {
  if (!roster) return null;
  const coverage = rosterCoverage(roster, tournament.entries.map((entry) => entry.teamId));
  if (coverage.complete) return null;
  const registered = tournament.entries.length;
  return `${title}: 名簿 (全チーム) が不完全でした (登録 ${registered} チーム中 ${registered - coverage.missing.length} チーム分)。この季は選手 ID (opid) による結び付けを行いません。`;
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

  // Role history (docs/THROW_ORDER_MODEL.md §4): the games our team and the opponent played,
  // season by season. Optional — a failed request only thins the evidence, and the role
  // strengths fall back to the nearest roles, the aptitudes and the overall strength.
  const roleRequests: Promise<RoleGamesFetch | null>[] = [];
  let roleGameFailures = 0;
  const teamGames = (tournamentId: string, teamId: string, seasonIndex: number, team: RoleGamesFetch['team']): void => {
    const request = client
      .teamGames(tournamentId, teamId)
      .then((games): RoleGamesFetch => ({ tournamentId, seasonIndex, teamId, team, games }))
      .catch((error: unknown) => {
        if (error instanceof N01Error && error.kind === 'aborted') throw error;
        roleGameFailures += 1;
        return null;
      });
    // An abort rejects it; if something else throws first it must not go unhandled.
    request.catch(() => undefined);
    roleRequests.push(request);
  };
  teamGames(tournamentId, data.entry.teamId, 0, 'ours');
  if (resolution.kind === 'resolved') teamGames(tournamentId, resolution.match.opponentTeamId, 0, 'opponent');

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
      const incomplete = incompleteRosterNote(summary.title, roster, tournament);
      if (incomplete) notes.push(incomplete);
      const opponentEntry = opponentName
        ? tournament.entries.find((entry) => normalizeName(entry.name) === opponentName)
        : undefined;
      const orders = opponentEntry
        ? await soft(client.orders(summary.tournamentId, opponentEntry.teamId), [] as N01OrderEntry[], notes, `${summary.title}: 相手の過去オーダーを取得できませんでした。`)
        : [];
      const ourName = normalizeName(data.entry.name);
      const ourEntry = tournament.entries.find((entry) => normalizeName(entry.name) === ourName);
      if (ourEntry) teamGames(summary.tournamentId, ourEntry.teamId, index + 1, 'ours');
      if (opponentEntry) teamGames(summary.tournamentId, opponentEntry.teamId, index + 1, 'opponent');
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

  const current = await currentRoster;
  const incomplete = incompleteRosterNote(data.tournament.title, current, data.tournament);
  if (incomplete) notes.push(incomplete);
  const roleGames = (await Promise.all(roleRequests)).filter((entry): entry is RoleGamesFetch => entry !== null);
  if (roleGameFailures > 0) {
    notes.push(
      `ゲーム別の成績 (役割別の強さの根拠) を ${roleGameFailures} 件取得できませんでした。その分は近い役割・ゲーム適性・総合の強さで代用します。`,
    );
  }

  return { schedule, resolution, opponentRoster, opponentOrders, history, rosters: { current, byTournament }, roleGames, roleGameFailures, notes };
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
  // A season whose whole roster is missing, or is not every registered team's, has no proven
  // `opid` at all.
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
  const proven = (roster: readonly N01RosterPlayer[] | null | undefined, tournament: N01Tournament): boolean =>
    !!roster && rosterCoverage(roster, tournament.entries.map((entry) => entry.teamId)).complete;
  if (!proven(fetched.rosters.current, data.tournament)) unproven.add(currentId);
  for (const season of fetched.history) {
    const id = season.tournament.tournamentId;
    const roster = fetched.rosters.byTournament[id];
    if (!proven(roster, season.tournament)) unproven.add(id);
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
  const leagueMean = leagueMeanPpr(allLines, weights);

  // Role evidence (docs/THROW_ORDER_MODEL.md §4): each game credited to the people who played it,
  // keyed exactly as their history is (the current season by roster oid, earlier seasons only
  // through an opid that names one person), against their PPR that season.
  const fetchedGames = fetched.roleGames ?? [];
  let roleHistory: N01MatchIntelligenceSnapshot['roleHistory'];
  let ourRoleEvidence: N01MatchIntelligenceSnapshot['ourRoleEvidence'];
  if (fetchedGames.length > 0 || (fetched.roleGameFailures ?? 0) > 0) {
    const rosterKey = new Map<string, string>(ourPlayers.map((player) => [player.oid, player.key]));
    for (const player of opponent?.players ?? []) rosterKey.set(player.oid, player.key);
    const seasonById = new Map(seasons.map((season) => [season.tournamentId, season]));
    // A member's PPR that season: by their tournament-scoped oid, else by an opid that names one
    // person in that season (stats rows may carry either).
    const pprIn = new Map(
      seasons.map((season) => {
        const byOid = new Map<string, number>();
        const byOpid = new Map<string, number>();
        const shared = identity(season.tournamentId);
        for (const row of season.stats) {
          if (!(row.darts > 0)) continue;
          const ppr = (3 * row.score) / row.darts;
          if (row.oid) byOid.set(row.oid, ppr);
          if (isUsableOpid(row.opid, shared)) byOpid.set(row.opid as string, ppr);
        }
        return [
          season.tournamentId,
          (player: { oid: string | null; opid: string | null }): number | null =>
            (player.oid ? byOid.get(player.oid) : undefined) ?? (isUsableOpid(player.opid, shared) ? byOpid.get(player.opid as string) : undefined) ?? null,
        ] as const;
      }),
    );
    const keyOf = (tournamentId: string, player: { oid: string | null; opid: string | null }): string =>
      tournamentId === currentId
        ? ((player.oid ? rosterKey.get(player.oid) : undefined) ?? playerKey(player.opid, currentId, player.oid, currentShared))
        : isUsableOpid(player.opid, currentShared, identity(tournamentId))
          ? (player.opid as string)
          : `oid:${tournamentId}:${player.oid ?? '?'}`;
    const recordsOf = (team: RoleGamesFetch['team']): { records: RoleGameRecord[]; teamOf: Map<number, string> } => {
      const records: RoleGameRecord[] = [];
      const teamOf = new Map<number, string>();
      for (const entry of fetchedGames) {
        if (entry.team !== team || !seasonById.has(entry.tournamentId)) continue;
        teamOf.set(entry.seasonIndex, entry.teamId);
        const pprOf = pprIn.get(entry.tournamentId);
        for (const game of entry.games) {
          const numPart = game.sides[0].players.length;
          if (game.sides[1].players.length !== numPart) continue;
          records.push({
            gameId: game.gameId,
            seasonIndex: entry.seasonIndex,
            startTime: game.startTime,
            structure: structureOfHeadCount(numPart),
            family: familyOfMatchType(game.matchType),
            sides: game.sides.map((side) => ({
              teamId: side.teamId,
              members: side.players.map((player) => ({
                key: keyOf(entry.tournamentId, player),
                base: pprOf ? pprOf(player) : null,
              })),
              legsWon: side.legsWon,
              score: side.score,
              darts: side.darts,
            })) as RoleGameRecord['sides'],
          });
        }
      }
      return { records, teamOf };
    };
    const before = jstDayStart(fetched.resolution.kind === 'resolved' ? fetched.resolution.match.date : null) ?? Math.floor(input.now / 1000);
    const options = { before, leagueMean: leagueMean ?? 45, weights };
    const ourGames = recordsOf('ours');
    const ourResult = aggregateRoleEvidence(ourGames.records, (seasonIndex) => ourGames.teamOf.get(seasonIndex) ?? null, options);
    ourRoleEvidence = ourResult.evidence;
    let theirGames = 0;
    let theirDropped = 0;
    if (opponent) {
      const theirs = recordsOf('opponent');
      const theirResult = aggregateRoleEvidence(theirs.records, (seasonIndex) => theirs.teamOf.get(seasonIndex) ?? null, options);
      opponent = { ...opponent, roleEvidence: theirResult.evidence };
      theirGames = theirResult.games;
      theirDropped = theirResult.droppedFuture;
    }
    roleHistory = {
      games: ourResult.games + theirGames,
      droppedFuture: ourResult.droppedFuture + theirDropped,
      before: fetched.resolution.kind === 'resolved' ? fetched.resolution.match.date : null,
      failedSeasons: fetched.roleGameFailures ?? 0,
    };
  }

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
    leagueMeanPpr: leagueMean,
    seasons: seasons.map((season) => ({
      tournamentId: season.tournamentId,
      title: season.title,
      seasonIndex: season.seasonIndex,
      weight: recencyWeight(season.seasonIndex, weights),
    })),
    historyDepth: input.historyDepth,
    orderConfidence: opponent?.positionModel.confidence ?? 'LOW',
    ...(ourRoleEvidence ? { ourRoleEvidence } : {}),
    ...(roleHistory ? { roleHistory } : {}),
  };
}
