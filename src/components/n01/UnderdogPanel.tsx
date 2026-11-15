import type { OrderSolution, UnderdogReason, UnderdogSuggestion } from '../../domain/types';
import { PRESET_LABELS } from '../../domain/types';
import { CONFIDENCE_LABELS, type ConfidenceLevel } from '../../domain/prediction/confidence';
import { UNDERDOG_MAX_WIN_PERCENT, UNDERDOG_MIN_GAIN, displayedPercent } from '../../optimizer/underdog';
import type { OrderSessionState } from '../../state/orderSession';
import { formatProbability } from '../../domain/prediction/predictOrder';
import { underdogGainText as gainText, underdogLossText as lossText } from '../../domain/orders/underdogText';
import { Icon } from '../icons';

/**
 * The one-tap underdog plan (格上対策案, docs/UNDERDOG_PLAN.md §5).
 *
 * Shown only when the engine offered a plan (standard plan ≤ 20% against a stronger opponent,
 * MEDIUM+ data, a meaningful gain). One button switches to it, one button switches back; the
 * standard plan is never replaced. Every number is an estimate and is called one.
 */

export function underdogGainText(suggestion: UnderdogSuggestion): string {
  return gainText(suggestion.objective, suggestion.standard, suggestion.plan);
}

export function underdogLossText(suggestion: UnderdogSuggestion): string {
  return lossText(suggestion.standard, suggestion.plan);
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

// ---------------------------------------------------------------------------
// Why no plan is shown, and where to check it (docs/UNDERDOG_PLAN.md §4.1)
// ---------------------------------------------------------------------------

/** The skip reasons the result screen explains; `no-opponent` / `not-underdog` add nothing. */
export type UnderdogSkipReason = Extract<UnderdogReason, 'low-confidence' | 'no-improvement' | 'not-stronger' | 'not-run'>;

const EXPLAINED: ReadonlySet<UnderdogReason> = new Set<UnderdogReason>(['low-confidence', 'no-improvement', 'not-stronger', 'not-run']);

export type UnderdogGuidance =
  /** The unedited standard plan is on screen, ≤ 20%, and the engine said why it offered nothing. */
  | { kind: 'skipped'; reason: UnderdogSkipReason; standard: OrderSolution; basis: OrderSessionState['underdogBasis'] }
  /** A comparison candidate is on screen while a plan was offered for the standard plan. */
  | { kind: 'standard-has-plan'; standardIndex: number; standard: OrderSolution }
  /** Generated under another preset: the candidate on screen is ≤ 20% against known opponent data. */
  | { kind: 'other-preset'; candidate: OrderSolution };

/**
 * What the result screen adds about the underdog plan, besides the plan's own panel. Only an
 * unedited generated candidate qualifies, and only from what the session holds: a reason is
 * named only when the engine returned one with these candidates (never for a saved order or
 * older data), and the 20% bound is the engine's own (`displayedPercent`, the standard plan's
 * win for an opponent-optimised run).
 */
export function underdogGuidance(
  state: Pick<OrderSessionState, 'input' | 'candidates' | 'selectedCandidate' | 'current' | 'edited' | 'showingUnderdog' | 'underdog' | 'underdogStatus' | 'underdogBasis'>,
  showPredictions: boolean,
  /** Whether オーダー設定 can offer 対戦相手最適化 now (opponent data for the next match). */
  opponentPresetAvailable = false,
): UnderdogGuidance | null {
  if (!showPredictions || state.edited || state.showingUnderdog || !state.current) return null;
  const selected = state.candidates[state.selectedCandidate];
  // The order on screen must be that candidate itself (not an edit, not another order).
  if (!selected || selected !== state.current) return null;
  const qualifies = (solution: OrderSolution): boolean =>
    solution.prediction !== undefined && displayedPercent(solution.prediction.win) <= UNDERDOG_MAX_WIN_PERCENT;

  const opponentRun = state.input.preset === 'OPPONENT_OPTIMIZED' || state.candidates.some((candidate) => candidate.meta.presetKey === 'OPPONENT_OPTIMIZED');
  // Pointing to 対戦相手最適化 only helps when SETUP can offer it: a saved order's opponent
  // snapshot alone does not make the preset selectable there.
  if (!opponentRun) return opponentPresetAvailable && qualifies(selected) ? { kind: 'other-preset', candidate: selected } : null;

  const standardIndex = state.candidates.findIndex((candidate) => candidate.meta.presetKey === 'OPPONENT_OPTIMIZED' && !candidate.meta.underdog);
  const standard = state.candidates[standardIndex];
  if (!standard || !qualifies(standard)) return null;
  if (state.selectedCandidate === standardIndex) {
    // A plan offered → its own panel. No status (saved order, older data) → nothing is inferred.
    if (state.underdog || !state.underdogStatus || state.underdogStatus.eligible) return null;
    const reason = state.underdogStatus.reason;
    return EXPLAINED.has(reason) ? { kind: 'skipped', reason: reason as UnderdogSkipReason, standard, basis: state.underdogBasis } : null;
  }
  return state.underdog ? { kind: 'standard-has-plan', standardIndex, standard } : null;
}

/** The skip reason in a few words (docs/UNDERDOG_PLAN.md §1, §4.1). */
export function underdogSkipText(
  reason: UnderdogSkipReason,
  basis: OrderSessionState['underdogBasis'],
  shownConfidence: ConfidenceLevel | undefined,
): string {
  switch (reason) {
    case 'low-confidence': {
      const levels = basis
        ? ` (相手のオーダー傾向 ${CONFIDENCE_LABELS[basis.orderConfidence]}・相手ゲーム ${CONFIDENCE_LABELS[basis.confidence]})`
        : '';
      const differs =
        shownConfidence && shownConfidence !== 'LOW'
          ? `上の「信頼度 ${CONFIDENCE_LABELS[shownConfidence]}」は推定 Match 勝率の信頼度で、判定に使う相手データとは材料が異なります。`
          : '';
      return `相手データの信頼度が低いため、出していません${levels}。${differs}`;
    }
    case 'no-improvement':
      return `対策案を作りましたが、標準案からの改善が基準 (${Math.round(UNDERDOG_MIN_GAIN * 100)}pt) に届かなかったため、出していません。`;
    case 'not-stronger':
      return 'モデル上の戦力差で相手が上回っていないため (格上の条件を満たさないため)、出していません。';
    case 'not-run':
      return '条件を満たす対策案を作れず、標準案と比較できなかったため、出していません。';
  }
}

export function UnderdogNote({
  guidance,
  onShowStandard,
  onOpenSetup,
}: {
  guidance: UnderdogGuidance;
  onShowStandard: (index: number) => void;
  /** Opens オーダー設定 with the current conditions (absent where there is no such screen). */
  onOpenSetup?: () => void;
}): React.JSX.Element {
  const win = (solution: OrderSolution): string => formatProbability(solution.prediction?.win ?? 0);
  return (
    <section className="underdog-panel quiet" aria-label="格上対策" data-testid="underdog-note" data-kind={guidance.kind}>
      <div className="underdog-head">
        <span className="kicker">格上対策</span>
        <strong>
          {guidance.kind === 'skipped'
            ? `標準案の推定 Match 勝率 ${win(guidance.standard)}`
            : guidance.kind === 'standard-has-plan'
              ? `${PRESET_LABELS.OPPONENT_OPTIMIZED}の標準案に格上対策案があります`
              : `格上対策は「${PRESET_LABELS.OPPONENT_OPTIMIZED}」で確認できます`}
        </strong>
      </div>
      <p className="underdog-reason">
        {guidance.kind === 'skipped'
          ? `格上対策案は${underdogSkipText(guidance.reason, guidance.basis, guidance.standard.prediction?.confidence)}`
          : guidance.kind === 'standard-has-plan'
            ? `標準案 (推定 Match 勝率 ${win(guidance.standard)}) を表示すると、格上対策案を試せます。`
            : `この候補の推定 Match 勝率は ${win(guidance.candidate)}。オーダー設定で「${PRESET_LABELS.OPPONENT_OPTIMIZED}」を選んで生成すると、その標準案で格上対策案を出すかを判定します。`}
      </p>
      {guidance.kind === 'standard-has-plan' ? (
        <div className="underdog-actions">
          <button type="button" className="btn small outline" onClick={() => onShowStandard(guidance.standardIndex)}>
            <Icon name="swap" size={16} />
            標準案を表示
          </button>
        </div>
      ) : guidance.kind === 'other-preset' && onOpenSetup ? (
        <div className="underdog-actions">
          <button type="button" className="btn small outline" onClick={onOpenSetup}>
            <Icon name="sliders" size={16} />
            オーダー設定を開く
          </button>
        </div>
      ) : null}
    </section>
  );
}
