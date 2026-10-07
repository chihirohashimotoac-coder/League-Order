import type { GameAssignment, GameId, PairAffinity, PairSetting, PlayerId } from '../types';
import { buildPairLookup } from '../games/pairKey';
import type { ConfidenceLevel } from './confidence';
import { CONFIDENCE_LABELS, aggregateConfidence, minConfidence } from './confidence';
import type { OpponentContext } from './opponentContext';
import { expectedGameWin, expectedOpponentStrength } from './opponentContext';
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

export function predictGame(
  context: OpponentContext,
  gameId: GameId,
  playerIds: readonly PlayerId[],
  pairs: readonly PairSetting[] = [],
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
): MatchPrediction | null {
  const games = assignments
    .map((assignment) => predictGame(context, assignment.gameId, assignment.playerIds, pairs))
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
