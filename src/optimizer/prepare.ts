import type {
  DartsDiscipline,
  GameSlotDef,
  LockEntry,
  OrderInput,
  ParticipantConfig,
  Player,
  PlayerId,
  ScoreWeights,
  StrengthWeights,
} from '../domain/types';
import { sortedGames, totalSlots } from '../domain/games/format';
import { buildPairLookup } from '../domain/games/pairKey';
import { PAIR_AFFINITY_VALUES } from '../domain/types';
import { playerGameFit } from '../domain/players/skills';
import type { ResolvedRatings } from '../domain/players/rating';
import { resolveStrength, type ResolvedMetric, type StrengthModel } from '../domain/players/strength';
import { buildRoleGroups, type RoleGroup } from '../domain/orders/roleFairness';
import { normaliseOrderInput } from '../domain/normalise';
import {
  maxAppearancesFor,
  maxConsecutiveFor,
  minAppearancesFor,
} from '../domain/orders/participants';
import { checkEligibility } from './constraints/eligibility';
import type { SolutionMeta } from '../domain/types';
import type { OpponentContext, OpponentGameContext } from '../domain/prediction/opponentContext';
import { PAIR_AFFINITY_PPR_BONUS } from '../domain/prediction/teamMatchup';
import { CONFIDENCE_WEIGHT_FACTOR, PRESETS } from '../domain/orders/presets';

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
  pprs: ResolvedMetric;
  /** Normalised 0..1 rating per player index. */
  normRating: number[];
  /** Normalised 0..1 PPR per player index. */
  normPpr: number[];
  /**
   * Composite 0..1 strength per player index: the discipline's blend of `normRating`
   * and `normPpr` (see `domain/players/strength.ts`). This — not either raw metric —
   * is what the strength term scores.
   */
  strength: number[];
  /** The blend actually applied (after dropping metrics nobody has). */
  strengthWeights: StrengthWeights;
  discipline: DartsDiscipline;
  strengthModel: StrengthModel;
  /** Structural roles present in the format (Singles, Doubles, …), for role fairness. */
  roleGroups: RoleGroup[];
  /** `roleOfGame[gameIndex]` = index into `roleGroups`. */
  roleOfGame: number[];
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
  /** Opponent data of the order (docs/OPPONENT_OPTIMIZER.md), or `null`. */
  opponent: OpponentContext | null;
  /** `opponentGames[gameIndex]`: the opponent side's distribution, or `null` for that game. */
  opponentGames: (OpponentGameContext | null)[];
  /** Predicted strength (PPR points) per player index, used by the opponent term. */
  predictionStrength: number[];
  /** `pairBonusPpr[a][b]`: the pair-affinity bonus the prediction model applies. */
  pairBonusPpr: number[][];
  /** How the opponent weight was applied (set only when the weights ask for it). */
  opponentPlan: SolutionMeta['opponent'];
}

/**
 * The weights a run actually optimises (docs/OPPONENT_OPTIMIZER.md §3).
 *
 * With opponent data the opponent weight is scaled by the data's confidence and the rest
 * is handed to strength, so an uncertain prediction never steers the whole order. With no
 * usable opponent data the run is a plain 勝利優先 (win-first) run, and says so.
 */
export function opponentWeights(
  weights: ScoreWeights,
  opponent: OpponentContext | null,
  usableGames: number,
): { weights: ScoreWeights; plan: SolutionMeta['opponent'] } {
  const base = weights.opponentWin ?? 0;
  if (base <= 0) return { weights: { ...weights, opponentWin: 0 }, plan: undefined };
  if (!opponent || usableGames === 0) {
    return {
      weights: { ...PRESETS.WIN_FIRST.weights, opponentWin: 0 },
      plan: { mode: 'fallback', baseWeight: base, effectiveWeight: 0, confidence: null },
    };
  }
  const factor = CONFIDENCE_WEIGHT_FACTOR[opponent.confidence];
  const effective = base * factor;
  return {
    weights: { ...weights, opponentWin: effective, strength: weights.strength + (base - effective) },
    plan: { mode: factor < 1 ? 'reduced' : 'applied', baseWeight: base, effectiveWeight: effective, confidence: opponent.confidence },
  };
}

function buildMatrix<T>(rows: number, cols: number, value: T): T[][] {
  return Array.from({ length: rows }, () => new Array<T>(cols).fill(value));
}

export function prepare(rawInput: OrderInput): PreparedContext {
  // Inputs saved by older builds lack PPR, the discipline and the role weight; they are
  // read as Unknown / UNSPECIFIED / the preset's value rather than breaking the run.
  const input = normaliseOrderInput(rawInput);
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

  const strengthModel = resolveStrength(input.discipline, input.players, input.participants);
  const { ratings, pprs } = strengthModel;
  const normRating = players.map((player) => strengthModel.normRating.get(player.id) ?? 0.5);
  const normPpr = players.map((player) => strengthModel.normPpr.get(player.id) ?? 0.5);
  const strength = players.map((player) => strengthModel.strength.get(player.id) ?? 0.5);

  const roleGroups = buildRoleGroups(games, n);
  const roleOfGame = new Array<number>(g).fill(0);
  roleGroups.forEach((group, groupIndex) => {
    for (const gi of group.gameIndices) roleOfGame[gi] = groupIndex;
  });

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
  //
  // The slot array length is clamped to a usable integer. A format whose head count is
  // not a positive integer is rejected by `precheck` with an actionable diagnostic, but
  // `prepare` runs first, and `new Array(-1)` throws — so a malformed format must not be
  // able to turn a reportable configuration error into an exception.
  const locksByGame: (number | undefined)[][] = games.map((game) =>
    new Array<number | undefined>(Math.max(0, Math.floor(game.playerCount) || 0)).fill(undefined),
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

  // Opponent data: only games whose opponent slot has the same head count are usable.
  const opponent = input.opponent && input.opponent.version === 1 ? input.opponent : null;
  const opponentGames = games.map((game) => {
    const entry = opponent?.games[game.id];
    return entry && entry.numPart === game.playerCount && entry.sides.length > 0 ? entry : null;
  });
  const predictionStrength = players.map(
    (player) => opponent?.players[player.id]?.strength ?? opponent?.leagueMeanPpr ?? 0,
  );
  const pairBonusPpr = buildMatrix(n, n, 0);
  for (let a = 0; a < n; a += 1) {
    for (let b = a + 1; b < n; b += 1) {
      const affinity = pairs.affinity(playerIds[a], playerIds[b]);
      const bonus = affinity === 'FORBIDDEN' ? 0 : PAIR_AFFINITY_PPR_BONUS[affinity];
      pairBonusPpr[a][b] = bonus;
      pairBonusPpr[b][a] = bonus;
    }
  }
  const usable = opponentGames.filter((entry) => entry !== null).length;
  const { weights, plan: opponentPlan } = opponentWeights(input.weights, opponent, usable);

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
    pprs,
    normRating,
    normPpr,
    strength,
    strengthWeights: strengthModel.weights,
    discipline: input.discipline,
    strengthModel,
    roleGroups,
    roleOfGame,
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
    weights,
    effectiveSeasonWeight: useSeasonFairness ? 0 : weights.season,
    input,
    invalidLocks,
    opponent: usable > 0 ? opponent : null,
    opponentGames,
    predictionStrength,
    pairBonusPpr,
    opponentPlan,
  };
}
