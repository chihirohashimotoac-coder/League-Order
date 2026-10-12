import type {
  UnderdogObjective,
  UnderdogPlanMetrics,
  UnderdogStatus,
} from '../domain/types';
import { minConfidence, type ConfidenceLevel } from '../domain/prediction/confidence';
import type { OpponentContext } from '../domain/prediction/opponentContext';
import type { MatchPrediction } from '../domain/prediction/predictOrder';
import { mean } from '../utils/math';

/**
 * The underdog plan (格上対策案, docs/UNDERDOG_PLAN.md).
 *
 * When the standard plan — the order that maximises the estimated match win — still leaves the
 * match at 20% or less against a clearly stronger opponent, the captain may prefer an order that
 * makes the night less one-sided. Two such orders are built internally:
 *
 *   A  maximise P(W ≥ 1) = 1 − Π (1 − p_g)          (take at least one game)
 *   B  maximise E[W] = Σ p_g                          (win as many games as possible)
 *
 * and exactly one is offered, chosen on a common scale. Both objectives are expectations of a
 * payoff between 0 and 1 for the match — 1{W ≥ 1} and W / n — so their improvements over the
 * standard plan are differences of probabilities and can be compared directly:
 *
 *   gain_A = P_A(W ≥ 1) − P_std(W ≥ 1)
 *   gain_B = (E_B[W] − E_std[W]) / n
 *
 * A plan counts only when its gain is at least UNDERDOG_MIN_GAIN (2 points, the throw-order
 * threshold); the larger gain wins; on a tie (within 1e-9) the plan giving up less estimated
 * match win, then A. Nothing is applied automatically: the plan is a one-tap suggestion.
 */

/** Offered only when the standard plan's estimated match win, as shown (whole %), is at most this. */
export const UNDERDOG_MAX_WIN_PERCENT = 20;
/** A plan must improve its objective by at least this much on the 0..1 scale. */
export const UNDERDOG_MIN_GAIN = 0.02;
export const UNDERDOG_TIE = 1e-9;

/** The match win as the screen shows it (whole percent, rounded half up like `formatProbability`). */
export function displayedPercent(probability: number): number {
  return Math.round(probability * 100);
}

export function planMetrics(prediction: MatchPrediction): UnderdogPlanMetrics {
  const probabilities = prediction.games.map((game) => game.probability);
  return {
    win: prediction.win,
    draw: prediction.draw,
    atLeastOne: 1 - probabilities.reduce((acc, p) => acc * (1 - p), 1),
    expectedGames: prediction.expectedGames,
    gameCount: prediction.gameCount,
  };
}

/** The confidence of the opponent data as a whole: its games and its order model. */
export function opponentDataConfidence(context: Pick<OpponentContext, 'confidence' | 'orderConfidence'>): ConfidenceLevel {
  return minConfidence(context.confidence, context.orderConfidence);
}

/**
 * Whether the standard plan qualifies for an underdog plan at all (before any plan is built):
 * opponent data, ≤ 20% shown, MEDIUM+ opponent data, and an opponent stronger than us.
 */
export function underdogEligibility(prediction: MatchPrediction | undefined, context: OpponentContext | null | undefined): UnderdogStatus {
  if (!prediction || !context || prediction.games.length === 0) return { eligible: false, reason: 'no-opponent' };
  if (displayedPercent(prediction.win) > UNDERDOG_MAX_WIN_PERCENT) return { eligible: false, reason: 'not-underdog' };
  if (opponentDataConfidence(context) === 'LOW') return { eligible: false, reason: 'low-confidence' };
  // 格上: on average over the games, the opponent's expected side is stronger than ours.
  const gap = mean(prediction.games.map((game) => game.opponentStrength - game.ourStrength));
  if (!(gap > 0)) return { eligible: false, reason: 'not-stronger' };
  return { eligible: true };
}

export interface UnderdogChoice {
  objective: UnderdogObjective;
  improvement: number;
  compared: Record<UnderdogObjective, number | null>;
}

/** The improvement of each plan on the common scale (module comment). */
export function underdogGains(
  standard: UnderdogPlanMetrics,
  plans: Partial<Record<UnderdogObjective, UnderdogPlanMetrics>>,
): Record<UnderdogObjective, number | null> {
  return {
    atLeastOne: plans.atLeastOne ? plans.atLeastOne.atLeastOne - standard.atLeastOne : null,
    expectedWins: plans.expectedWins && standard.gameCount > 0 ? (plans.expectedWins.expectedGames - standard.expectedGames) / standard.gameCount : null,
  };
}

/** The one plan to offer, or `null` when neither improves meaningfully. */
export function chooseUnderdogPlan(
  standard: UnderdogPlanMetrics,
  plans: Partial<Record<UnderdogObjective, UnderdogPlanMetrics>>,
): UnderdogChoice | null {
  const compared = underdogGains(standard, plans);
  const order: UnderdogObjective[] = ['atLeastOne', 'expectedWins'];
  let best: { objective: UnderdogObjective; gain: number; loss: number } | null = null;
  for (const objective of order) {
    const gain = compared[objective];
    const plan = plans[objective];
    if (gain === null || !plan || gain < UNDERDOG_MIN_GAIN - UNDERDOG_TIE) continue;
    const loss = standard.win - plan.win;
    if (
      !best ||
      gain > best.gain + UNDERDOG_TIE ||
      (Math.abs(gain - best.gain) <= UNDERDOG_TIE && loss < best.loss - UNDERDOG_TIE)
    ) {
      best = { objective, gain, loss };
    }
  }
  return best ? { objective: best.objective, improvement: best.gain, compared } : null;
}
