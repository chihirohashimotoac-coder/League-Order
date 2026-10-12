import type {
  DartsDiscipline,
  GameAssignment,
  GameId,
  GameSlotDef,
  OrderInput,
  PairAffinity,
  PairSetting,
  Player,
  PlayerId,
} from '../types';
import { buildPairLookup } from '../games/pairKey';
import type { ConfidenceLevel } from './confidence';
import { CONFIDENCE_LABELS, aggregateConfidence, lowerConfidence, minConfidence } from './confidence';
import type { OpponentContext, OpponentGameContext } from './opponentContext';
import { expectedGameWin, expectedOpponentStrength } from './opponentContext';
import { estimateFinish, type FinishEstimate } from './finishing';
import {
  aptitudeDelta,
  describeRole,
  estimateRole,
  roleKeyOf,
  roleStructureOf,
  type RoleStrengthContext,
  type RoleStrengthEntry,
} from './roleStrength';
import { DEFAULT_START_SCORE, THROW_ORDER_MODEL_VERSION, orderedGameWin, type ThrowOrderModelVersion } from './throwOrder';
import { meanPairBonus, sideStrength } from './teamMatchup';
import type { MatchOutcomeModel } from './matchWinProbability';
import { independentGamesModel } from './matchWinProbability';

/**
 * Game and match predictions for a concrete order (MASTER SPEC Phase 3 §9–§12).
 *
 * Every number comes with its confidence and with the reasons behind it, in the words
 * the captain uses: the PPR difference, a First 9 or recent-form adjustment, and who
 * the opponent is likely to put in that slot. Nothing is presented as certain.
 */

export interface GamePrediction {
  gameId: GameId;
  /** 推定ゲーム勝率 */
  probability: number;
  confidence: ConfidenceLevel;
  /** Weighted observations of the opponent's slot. */
  samples: number;
  ourStrength: number;
  opponentStrength: number;
  reasons: string[];
  /**
   * Throw-order model only: what the order changes in the estimate (probability with this order
   * minus the same members with no order), and each member's role strength in throwing order.
   */
  orderEffect?: number;
  members?: { playerId: PlayerId; strength: number; roleDelta: number }[];
}

export interface MatchPrediction {
  /** 推定 Match 勝率 */
  win: number;
  draw: number;
  loss: number;
  expectedGames: number;
  need: number;
  gameCount: number;
  confidence: ConfidenceLevel;
  games: GamePrediction[];
  model: string;
  opponentName: string;
}

export const INDEPENDENCE_NOTE =
  '各ゲームを独立と近似して計算しています。同じ選手が複数ゲームに出るため、実際の結果は連動することがあります。';

function signed(value: number): string {
  const rounded = Math.round(value * 10) / 10;
  return `${rounded >= 0 ? '+' : ''}${rounded.toFixed(1)}`;
}

/**
 * How an order is predicted. Orders generated with the throw-order model carry its version and
 * the role evidence in their input; orders saved before it have neither and are predicted exactly
 * as they were (members' mean, no role, no order).
 */
export interface PredictionModelOptions {
  throwOrderModel?: ThrowOrderModelVersion;
  roleStrength?: RoleStrengthContext;
  /** The order's games (role and start score). */
  games?: readonly GameSlotDef[];
  /** The order's players (aptitude fallback). */
  players?: readonly Player[];
  discipline?: DartsDiscipline;
}

/** The prediction options an order input asks for. */
export function predictionOptionsOf(input: Pick<OrderInput, 'throwOrderModel' | 'roleStrength' | 'games' | 'players' | 'discipline'>): PredictionModelOptions {
  return input.throwOrderModel === THROW_ORDER_MODEL_VERSION
    ? {
        throwOrderModel: input.throwOrderModel,
        roleStrength: input.roleStrength,
        games: input.games,
        players: input.players,
        discipline: input.discipline,
      }
    : {};
}

export function usesThrowOrderModel(options: PredictionModelOptions | undefined): boolean {
  return options?.throwOrderModel === THROW_ORDER_MODEL_VERSION;
}

/** One member's strength in a game's role, and the finishing estimate on it. */
export interface MemberBasis {
  playerId: PlayerId;
  /** History-corrected strength (PPR points), as the order-free model uses it. */
  base: number;
  /** Strength in this game's role: base + role adjustment. */
  strength: number;
  role: RoleStrengthEntry;
  finish: FinishEstimate;
  /** The weaker of the player's data confidence and the role estimate's. */
  confidence: ConfidenceLevel;
}

export function memberBasis(
  context: OpponentContext,
  options: PredictionModelOptions,
  playerId: PlayerId,
  game: Pick<GameSlotDef, 'kinds' | 'playerCount'>,
  player?: Pick<Player, 'skills'>,
): MemberBasis {
  const ours = context.players[playerId];
  const base = ours?.strength ?? context.leagueMeanPpr;
  const baseConfidence = ours?.confidence ?? 'LOW';
  const aptitude = player ? aptitudeDelta(player, game) : null;
  const role = estimateRole(options.roleStrength?.players[playerId]?.evidence, roleKeyOf(game), aptitude, baseConfidence);
  const strength = base + role.delta;
  return {
    playerId,
    base,
    strength,
    role,
    finish: estimateFinish(strength, ours?.first9Excess ?? null, ours?.legs ?? 0, options.discipline ?? context.discipline ?? 'UNSPECIFIED'),
    confidence: minConfidence(baseConfidence, role.confidence),
  };
}

/** The start score the order model uses for a game, and whether n01 stated it. */
export function startScoreOf(
  game: Pick<GameSlotDef, 'kinds' | 'playerCount' | 'n01'>,
  context?: Pick<OpponentGameContext, 'startScore'>,
): { startScore: number; known: boolean } {
  const stated = context?.startScore ?? game.n01?.startScore ?? null;
  if (stated !== null && Number.isFinite(stated) && stated > 0) return { startScore: stated, known: true };
  return { startScore: DEFAULT_START_SCORE[roleStructureOf(game)], known: false };
}

function predictWithModel(
  context: OpponentContext,
  game: OpponentGameContext,
  def: GameSlotDef,
  playerIds: readonly PlayerId[],
  bonus: number,
  options: PredictionModelOptions,
): GamePrediction {
  const playerById = new Map((options.players ?? []).map((player) => [player.id, player]));
  const members = playerIds.map((id) => memberBasis(context, options, id, def, playerById.get(id)));
  const strengths = members.map((member) => member.strength);
  const { startScore, known } = startScoreOf(def, game);
  const discipline = options.discipline ?? context.discipline ?? 'UNSPECIFIED';
  const probability = orderedGameWin(
    { strengths, finish: members.map((member) => member.finish.rate), pairBonus: bonus },
    game,
    { startScore, discipline },
  );
  const our = sideStrength(strengths, bonus);
  const unordered = expectedGameWin(our, game);
  const theirs = expectedOpponentStrength(game);
  const confidence = minConfidence(game.confidence, ...members.map((member) => member.confidence));

  const reasons = [`PPR差 ${signed(our - theirs)} (自 ${our.toFixed(1)} / 相手予想 ${theirs.toFixed(1)})`];
  const roleNotes = members.filter((member) => Math.abs(member.role.delta) >= 0.3);
  if (roleNotes.length > 0) {
    const names = new Map((options.players ?? []).map((player) => [player.id, player.name]));
    reasons.push(
      `役割補正 (${describeRole(roleKeyOf(def))}): ${roleNotes.map((member) => `${names.get(member.playerId) ?? member.playerId} ${signed(member.role.delta)}`).join(' / ')}`,
    );
  }
  const effect = probability - unordered;
  if (playerIds.length >= 2 && !game.cricket && Math.abs(effect) >= 0.005) {
    reasons.push(`投順の効果 ${effect >= 0 ? '+' : '−'}${Math.abs(effect * 100).toFixed(1)}pt${known ? '' : ' (開始点数は推定)'}`);
  }
  if (playerIds.length >= 2 && game.order && !game.order.known) reasons.push('相手の投順は不明 (全順を同等と仮定)');
  const first9 = members.reduce((acc, member) => acc + (context.players[member.playerId]?.first9Adjustment ?? 0), 0) / members.length;
  if (Math.abs(first9) >= 0.3) reasons.push(`First9 補正 ${signed(first9)}`);
  const form = members.reduce((acc, member) => acc + (context.players[member.playerId]?.formAdjustment ?? 0), 0) / members.length;
  if (Math.abs(form) >= 0.3) reasons.push(`最近の調子 ${signed(form)}`);
  if (Math.abs(bonus) > 0 && playerIds.length >= 2) reasons.push(`ペア相性 ${signed(bonus)}`);
  if (game.likely.length > 0) {
    reasons.push(`相手の予想: ${game.likely.slice(0, 2).map((entry) => `${entry.name} ${Math.round(entry.probability * 100)}%`).join(' / ')}`);
  }
  if (playerIds.some((id) => !context.players[id] || context.players[id].imputed)) reasons.push('データの無い選手はリーグ平均で評価');
  if (game.cricket) reasons.push('Cricket は PPR との関連が弱いため信頼度を下げています');
  if (confidence === 'LOW') reasons.push('データが少ないため参考値');

  return {
    gameId: game.gameId,
    probability,
    confidence,
    samples: game.samples,
    ourStrength: our,
    opponentStrength: theirs,
    reasons,
    orderEffect: effect,
    members: members.map((member) => ({ playerId: member.playerId, strength: member.strength, roleDelta: member.role.delta })),
  };
}

/** Confidence of an order decision: the estimate's, one step lower when the start score is a guess. */
export function orderDecisionConfidence(confidence: ConfidenceLevel, startScoreKnown: boolean): ConfidenceLevel {
  return startScoreKnown ? confidence : lowerConfidence(confidence);
}

export function predictGame(
  context: OpponentContext,
  gameId: GameId,
  playerIds: readonly PlayerId[],
  pairs: readonly PairSetting[] = [],
  options: PredictionModelOptions = {},
): GamePrediction | null {
  const game = context.games[gameId];
  if (!game || playerIds.length === 0) return null;
  const lookup = buildPairLookup(pairs);
  const ours = playerIds.map((id) => context.players[id]);
  const strengths = ours.map((player) => player?.strength ?? context.leagueMeanPpr);
  const affinities: (Exclude<PairAffinity, 'FORBIDDEN'> | undefined)[] = [];
  for (let i = 0; i < playerIds.length; i += 1) {
    for (let j = i + 1; j < playerIds.length; j += 1) {
      const affinity = lookup.affinity(playerIds[i], playerIds[j]);
      affinities.push(affinity === 'FORBIDDEN' ? undefined : affinity);
    }
  }
  const bonus = meanPairBonus(affinities);
  const def = usesThrowOrderModel(options) ? options.games?.find((entry) => entry.id === gameId) : undefined;
  if (def) return predictWithModel(context, game, def, playerIds, bonus, options);
  const our = sideStrength(strengths, bonus);
  const probability = expectedGameWin(our, game);
  const theirs = expectedOpponentStrength(game);
  const confidence = minConfidence(game.confidence, ...ours.map((player) => player?.confidence ?? 'LOW'));

  const reasons = [`PPR差 ${signed(our - theirs)} (自 ${our.toFixed(1)} / 相手予想 ${theirs.toFixed(1)})`];
  const first9 = ours.reduce((acc, player) => acc + (player?.first9Adjustment ?? 0), 0) / ours.length;
  if (Math.abs(first9) >= 0.3) reasons.push(`First9 補正 ${signed(first9)}`);
  const form = ours.reduce((acc, player) => acc + (player?.formAdjustment ?? 0), 0) / ours.length;
  if (Math.abs(form) >= 0.3) reasons.push(`最近の調子 ${signed(form)}`);
  if (Math.abs(bonus) > 0 && playerIds.length >= 2) reasons.push(`ペア相性 ${signed(bonus)}`);
  if (game.likely.length > 0) {
    reasons.push(`相手の予想: ${game.likely.slice(0, 2).map((entry) => `${entry.name} ${Math.round(entry.probability * 100)}%`).join(' / ')}`);
  }
  if (ours.some((player) => !player || player.imputed)) reasons.push('データの無い選手はリーグ平均で評価');
  if (game.cricket) reasons.push('Cricket は PPR との関連が弱いため信頼度を下げています');
  if (confidence === 'LOW') reasons.push('データが少ないため参考値');

  return {
    gameId,
    probability,
    confidence,
    samples: game.samples,
    ourStrength: our,
    opponentStrength: theirs,
    reasons,
  };
}

/** Predicts every game of an order and the match; games without context are skipped. */
export function predictOrder(
  context: OpponentContext,
  assignments: readonly GameAssignment[],
  pairs: readonly PairSetting[] = [],
  model: MatchOutcomeModel = independentGamesModel,
  options: PredictionModelOptions = {},
): MatchPrediction | null {
  const games = assignments
    .map((assignment) => predictGame(context, assignment.gameId, assignment.playerIds, pairs, options))
    .filter((prediction): prediction is GamePrediction => prediction !== null);
  if (games.length === 0) return null;
  const outcome = model.outcome(games.map((game) => game.probability));
  return {
    win: outcome.win,
    draw: outcome.draw,
    loss: outcome.loss,
    expectedGames: outcome.expectedGames,
    need: outcome.need,
    gameCount: outcome.gameCount,
    confidence: aggregateConfidence(games.map((game) => game.confidence)),
    games,
    model: model.name,
    opponentName: context.opponentName,
  };
}

/** "58%" — whole percent only; precision beyond that would be false. */
export function formatProbability(probability: number): string {
  return `${Math.round(probability * 100)}%`;
}

export function confidenceText(level: ConfidenceLevel): string {
  return level === 'LOW' ? `信頼度 ${CONFIDENCE_LABELS[level]} (参考値)` : `信頼度 ${CONFIDENCE_LABELS[level]}`;
}
