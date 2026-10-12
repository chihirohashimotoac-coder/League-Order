import type { OrderSolution, UnderdogSuggestion } from '../../domain/types';
import { UNDERDOG_OBJECTIVE_LABELS } from '../../domain/types';
import { CONFIDENCE_LABELS } from '../../domain/prediction/confidence';
import { formatProbability } from '../../domain/prediction/predictOrder';
import { Icon } from '../icons';

/**
 * The one-tap underdog plan (格上対策案, docs/UNDERDOG_PLAN.md §5).
 *
 * Shown only when the engine offered a plan (standard plan ≤ 20% against a stronger opponent,
 * MEDIUM+ data, a meaningful gain). One button switches to it, one button switches back; the
 * standard plan is never replaced. Every number is an estimate and is called one.
 */

const points = (value: number): string => `${value >= 0 ? '+' : '−'}${Math.abs(value * 100).toFixed(1)}pt`;

export function underdogGainText(suggestion: UnderdogSuggestion): string {
  const { standard, plan } = suggestion;
  return suggestion.objective === 'atLeastOne'
    ? `${UNDERDOG_OBJECTIVE_LABELS.atLeastOne}を ${points(plan.atLeastOne - standard.atLeastOne)} 改善 (${formatProbability(standard.atLeastOne)} → ${formatProbability(plan.atLeastOne)})`
    : `${UNDERDOG_OBJECTIVE_LABELS.expectedWins}を ${(plan.expectedGames - standard.expectedGames).toFixed(2)} 改善 (${standard.expectedGames.toFixed(2)} → ${plan.expectedGames.toFixed(2)} / ${standard.gameCount})`;
}

export function underdogLossText(suggestion: UnderdogSuggestion): string {
  const loss = suggestion.matchWinLoss;
  return loss >= 0
    ? `標準案から失われる推定 Match 勝率 ${points(-loss)} (${formatProbability(suggestion.standard.win)} → ${formatProbability(suggestion.plan.win)})`
    : `推定 Match 勝率は標準案より ${points(-loss)} (${formatProbability(suggestion.standard.win)} → ${formatProbability(suggestion.plan.win)})`;
}

function benched(solution: OrderSolution | null): number {
  if (!solution) return 0;
  return solution.metrics.totalSlots >= solution.metrics.participantCount ? solution.tallies.filter((tally) => tally.count === 0).length : 0;
}

export function UnderdogPanel({
  suggestion,
  showing,
  edited,
  standard,
  nameById,
  onApply,
  onRestore,
}: {
  suggestion: UnderdogSuggestion;
  showing: boolean;
  edited: boolean;
  standard: OrderSolution | null;
  nameById: Map<string, string>;
  onApply: () => void;
  onRestore: () => void;
}): React.JSX.Element {
  const plan = suggestion.solution;
  const spreadBefore = standard?.metrics.appearanceSpread;
  const spreadAfter = plan.metrics.appearanceSpread;
  const benchedAfter = benched(plan);
  const sittingOut = plan.tallies.filter((tally) => tally.count === 0).map((tally) => nameById.get(tally.playerId) ?? tally.playerId);
  return (
    <section className={showing ? 'underdog-panel showing' : 'underdog-panel'} aria-label="格上対策" data-testid="underdog-panel">
      <div className="underdog-head">
        <span className="kicker">格上対策</span>
        <strong>
          {showing
            ? `格上対策案を表示中${edited ? ' (手動で編集中)' : ''}`
            : `標準案の推定 Match 勝率 ${formatProbability(suggestion.standard.win)}`}
        </strong>
      </div>
      <p className="underdog-reason">
        {underdogGainText(suggestion)}。{underdogLossText(suggestion)}。
      </p>
      {spreadBefore !== undefined && (spreadAfter !== spreadBefore || benchedAfter > 0) ? (
        <p className="tiny underdog-fairness">
          出場回数の最大差 {spreadBefore} → {spreadAfter}
          {benchedAfter > 0 ? ` (出場なし: ${sittingOut.join('、')})` : ''}
        </p>
      ) : null}
      <div className="underdog-actions">
        {showing ? (
          <button type="button" className="btn small outline" onClick={onRestore}>
            <Icon name="undo" size={16} />
            標準案に戻す
          </button>
        ) : (
          <button type="button" className="btn small" onClick={onApply}>
            <Icon name="swap" size={16} />
            格上対策案を試す
          </button>
        )}
      </div>
      <p className="tiny muted underdog-note">
        <Icon name="info" size={13} /> 相手データの信頼度 {CONFIDENCE_LABELS[suggestion.confidence]}。推定値であり、結果を保証するものではありません。自動では適用せず、標準案にいつでも戻せます。
      </p>
    </section>
  );
}
