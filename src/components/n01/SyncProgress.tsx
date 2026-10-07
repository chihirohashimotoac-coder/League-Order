import type { N01StepStatus, N01SyncStep } from '../../integrations/n01/sync';
import { N01_SYNC_STEP_LABELS } from '../../integrations/n01/sync';
import { Icon } from '../icons';

/**
 * "n01を確認しています ✓ Season ✓ Team …" (MASTER SPEC Phase 5 §4).
 *
 * Each step shows an icon and a word, never colour alone. The list is a live region so a
 * screen reader hears steps complete.
 */
export type SyncProgressState = Partial<Record<N01SyncStep, N01StepStatus>>;

const STATUS_TEXT: Record<N01StepStatus, string> = {
  pending: '待機',
  running: '確認中',
  done: '完了',
  skipped: '省略',
  error: 'エラー',
};

export function SyncProgress({
  steps,
  state,
  title = 'n01を確認しています',
}: {
  steps: readonly N01SyncStep[];
  state: SyncProgressState;
  title?: string;
}): React.JSX.Element {
  return (
    <div className="sync-progress" data-testid="sync-progress">
      <p className="sync-progress-title">{title}</p>
      <ul aria-live="polite">
        {steps.map((step) => {
          const status = state[step] ?? 'pending';
          return (
            <li key={step} className={`sync-step is-${status}`}>
              <span className="sync-step-icon" aria-hidden="true">
                {status === 'done' ? (
                  <Icon name="check" size={16} strokeWidth={3} />
                ) : status === 'running' ? (
                  <span className="spinner small" />
                ) : status === 'error' ? (
                  <Icon name="alert" size={16} />
                ) : (
                  <span className="sync-dot" />
                )}
              </span>
              <span className="sync-step-label">{N01_SYNC_STEP_LABELS[step]}</span>
              <span className="sync-step-status">{STATUS_TEXT[status]}</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
