import type {
  GameSlotDef,
  LockEntry,
  OrderInput,
  ParticipantConfig,
  Player,
  PlayerId,
  ScoreWeights,
} from '../domain/types';
import { sortedGames, totalSlots } from '../domain/games/format';
import { buildPairLookup } from '../domain/games/pairKey';
import { PAIR_AFFINITY_VALUES } from '../domain/types';
import { playerGameFit } from '../domain/players/skills';
import { normaliseRating, resolveRatings, type ResolvedRatings } from '../domain/players/rating';
import {
  maxAppearancesFor,
  maxConsecutiveFor,
  minAppearancesFor,
} from '../domain/orders/participants';
import { checkEligibility } from './constraints/eligibility';

/**
 * Immutable, index-based view of an order input, built once per generation run.
 *
 * Everything the search touches is pre-resolved into dense arrays addressed by
 * `gameIndex` / `playerIndex`, so the hot loop performs no map lookups and no
 * string comparisons. The context is pure data — no React, no DOM, no clock.
 */
export interface PreparedContext {
  games: GameSlotDef[];
  gameCount: number;
  /** Player ids in the canonical (sorted) order used for every tie-break. */
  playerIds: PlayerId[];
  playerCount: number;
  playerIndex: Map<PlayerId, number>;
  players: Player[];
  configs: ParticipantConfig[];
  /** `eligible[gameIndex][playerIndex]`. */
  eligible: boolean[][];
  eligibleLists: number[][];
  ratings: ResolvedRatings;
  /** Normalised 0..1 rating per player index. */
  normRating: number[];
  /** `gameFit[gameIndex][playerIndex]`, 0..1. */
  gameFit: number[][];
  /** `pairValue[a][b]`, 0..1 soft affinity value. */
  pairValue: number[][];
  /** `pairForbidden[a][b]` — a hard constraint. */
  pairForbidden: boolean[][];
  /** `pairNovelty[a][b]` = 1 / (1 + pastTogetherCount). */
  pairNovelty: number[][];
  maxAppearances: number[];
  minAppearances: number[];
  maxConsecutive: number[];
  /** Season baselines used by the season-imbalance term (always season counts). */
  seasonBaseline: number[];
  /** Baselines used by the fairness term (zeros for `today`, season counts for `season`). */
  fairnessBaseline: number[];
  totalSlots: number;
  /** Number of games with 2+ players (the basis for pair terms). */
  multiPlayerGameCount: number;
  /** `locksByGame[gameIndex]` = slotIndex -> playerIndex. */
  locksByGame: (number | undefined)[][];
  /** Player indices that must appear in a given game because of locks. */
  requiredByGame: number[][];
  weights: ScoreWeights;
  /** Effective season weight (forced to 0 when fairness already uses season totals). */
  effectiveSeasonWeight: number;
  input: OrderInput;
  /** Locks that cannot be satisfied (player not eligible / unknown / duplicated). */
  invalidLocks: { lock: LockEntry; reason: string }[];
}

function buildMatrix<T>(rows: number, cols: number, value: T): T[][] {
  return Array.from({ length: rows }, () => new Array<T>(cols).fill(value));
}

export function prepare(input: OrderInput): PreparedContext {
  const games = sortedGames(input.games);
  const playerById = new Map(input.players.map((player) => [player.id, player]));

  // Only included participants that actually exist in the roster take part, sorted by
  // id so that every downstream tie-break is deterministic.
  const configs = input.participants
    .filter((config) => config.include && playerById.has(config.playerId))
    .sort((a, b) => (a.playerId < b.playerId ? -1 : a.playerId > b.playerId ? 1 : 0));

  const playerIds = configs.map((config) => config.playerId);
  const players = playerIds.map((id) => playerById.get(id)!);
  const playerIndex = new Map(playerIds.map((id, index) => [id, index]));
  const n = playerIds.length;
  const g = games.length;

  const ratings = resolveRatings(input.players, input.participants);
  const normRating = players.map((player) =>
    normaliseRating(ratings.effective.get(player.id) ?? null, ratings),
  );

  const eligible = buildMatrix(g, n, false);
  const eligibleLists: number[][] = [];
  for (let gi = 0; gi < g; gi += 1) {
    const list: number[] = [];
    for (let pi = 0; pi < n; pi += 1) {
      const ok = checkEligibility(configs[pi], games[gi]) === null;
      eligible[gi][pi] = ok;
      if (ok) list.push(pi);
    }
    eligibleLists.push(list);
  }

  const gameFit = buildMatrix(g, n, 0);
  for (let gi = 0; gi < g; gi += 1) {
    for (let pi = 0; pi < n; pi += 1) {
      gameFit[gi][pi] = playerGameFit(players[pi], games[gi]);
    }
  }

  const pairs = buildPairLookup(input.pairs);
  const pairValue = buildMatrix(n, n, PAIR_AFFINITY_VALUES.NEUTRAL);
  const pairForbidden = buildMatrix(n, n, false);
  const pairNovelty = buildMatrix(n, n, 1);
  for (let a = 0; a < n; a += 1) {
    for (let b = a + 1; b < n; b += 1) {
      const affinity = pairs.affinity(playerIds[a], playerIds[b]);
      const forbidden = affinity === 'FORBIDDEN';
      const value = forbidden ? 0 : PAIR_AFFINITY_VALUES[affinity];
      const novelty = 1 / (1 + pairs.pastTogether(playerIds[a], playerIds[b]));
      pairValue[a][b] = value;
      pairValue[b][a] = value;
      pairForbidden[a][b] = forbidden;
      pairForbidden[b][a] = forbidden;
      pairNovelty[a][b] = novelty;
      pairNovelty[b][a] = novelty;
    }
  }

  const maxAppearances = configs.map((config) => maxAppearancesFor(config, games));
  const minAppearances = configs.map((config) => minAppearancesFor(config));
  const maxConsecutive = configs.map((config) => maxConsecutiveFor(config, input.settings));
  const seasonBaseline = players.map((player) => player.seasonAppearances);
  const useSeasonFairness = input.settings.fairnessScope === 'season';
  const fairnessBaseline = useSeasonFairness ? [...seasonBaseline] : new Array<number>(n).fill(0);

  // Locks.
  const locksByGame: (number | undefined)[][] = games.map((game) =>
    new Array<number | undefined>(game.playerCount).fill(undefined),
  );
  const requiredByGame: number[][] = games.map(() => []);
  const invalidLocks: { lock: LockEntry; reason: string }[] = [];
  const gameIndexById = new Map(games.map((game, index) => [game.id, index]));

  for (const lock of input.locks) {
    const gi = gameIndexById.get(lock.gameId);
    if (gi === undefined) {
      invalidLocks.push({ lock, reason: 'ロック対象のゲームがフォーマットに存在しません' });
      continue;
    }
    const game = games[gi];
    if (lock.slotIndex < 0 || lock.slotIndex >= game.playerCount) {
      invalidLocks.push({ lock, reason: `${game.name}: スロット番号が必要人数の範囲外です` });
      continue;
    }
    const pi = playerIndex.get(lock.playerId);
    if (pi === undefined) {
      invalidLocks.push({
        lock,
        reason: `${game.name}: ロックされた選手が参加者に含まれていません`,
      });
      continue;
    }
    if (!eligible[gi][pi]) {
      const reason = checkEligibility(configs[pi], game)?.message ?? '出場できません';
      invalidLocks.push({ lock, reason: `${game.name}: ${players[pi].name} は${reason}` });
      continue;
    }
    if (locksByGame[gi][lock.slotIndex] !== undefined && locksByGame[gi][lock.slotIndex] !== pi) {
      invalidLocks.push({ lock, reason: `${game.name}: 同じスロットに複数のロックがあります` });
      continue;
    }
    if (requiredByGame[gi].includes(pi)) {
      invalidLocks.push({ lock, reason: `${game.name}: 同一選手が複数スロットにロックされています` });
      continue;
    }
    locksByGame[gi][lock.slotIndex] = pi;
    requiredByGame[gi].push(pi);
  }
  for (const list of requiredByGame) list.sort((a, b) => a - b);

  const multiPlayerGameCount = games.filter((game) => game.playerCount >= 2).length;

  return {
    games,
    gameCount: g,
    playerIds,
    playerCount: n,
    playerIndex,
    players,
    configs,
    eligible,
    eligibleLists,
    ratings,
    normRating,
    gameFit,
    pairValue,
    pairForbidden,
    pairNovelty,
    maxAppearances,
    minAppearances,
    maxConsecutive,
    seasonBaseline,
    fairnessBaseline,
    totalSlots: totalSlots(games),
    multiPlayerGameCount,
    locksByGame,
    requiredByGame,
    weights: input.weights,
    effectiveSeasonWeight: useSeasonFairness ? 0 : input.weights.season,
    input,
    invalidLocks,
  };
}
