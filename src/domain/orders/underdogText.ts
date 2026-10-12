import type { UnderdogObjective, UnderdogPlanMetrics } from '../types';
import { UNDERDOG_OBJECTIVE_LABELS } from '../types';
import { formatProbability } from '../prediction/predictOrder';

/**
 * Words for the underdog plan (docs/UNDERDOG_PLAN.md §4). One wording, read by the plan's
 * explanation and by the result screen's panel, so the two never disagree. Every number is an
 * estimate; nothing is promised.
 */

const points = (value: number): string => `${value >= 0 ? '+' : '−'}${Math.abs(value * 100).toFixed(1)}pt`;

/** "1ゲーム以上取る確率を +6.0pt 改善 (61% → 67%)" / "期待勝ちゲーム数を 0.12 改善 (0.95 → 1.07 / 5)". */
export function underdogGainText(objective: UnderdogObjective, standard: UnderdogPlanMetrics, plan: UnderdogPlanMetrics): string {
  return objective === 'atLeastOne'
    ? `${UNDERDOG_OBJECTIVE_LABELS.atLeastOne}を ${points(plan.atLeastOne - standard.atLeastOne)} 改善 (${formatProbability(standard.atLeastOne)} → ${formatProbability(plan.atLeastOne)})`
    : `${UNDERDOG_OBJECTIVE_LABELS.expectedWins}を ${(plan.expectedGames - standard.expectedGames).toFixed(2)} 改善 (${standard.expectedGames.toFixed(2)} → ${plan.expectedGames.toFixed(2)} / ${standard.gameCount})`;
}

/** The estimated match win the plan gives up (or gains) against the standard plan. */
export function underdogLossText(standard: Pick<UnderdogPlanMetrics, 'win'>, plan: Pick<UnderdogPlanMetrics, 'win'>): string {
  const loss = standard.win - plan.win;
  return loss >= 0
    ? `標準案から失われる推定 Match 勝率 ${points(-loss)} (${formatProbability(standard.win)} → ${formatProbability(plan.win)})`
    : `推定 Match 勝率は標準案より ${points(-loss)} (${formatProbability(standard.win)} → ${formatProbability(plan.win)})`;
}
