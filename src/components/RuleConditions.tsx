import { useState } from 'react';
import type { RuleResolution, AskableKind } from '../domain/orders/ruleResolution';
import { ASKABLE_LABELS, NO_CAP, YES_CAP, capText, questionText } from '../domain/orders/ruleResolution';
import { basisLabel } from '../domain/orders/ruleCatalog';
import { Sheet, Stepper } from './ui';
import { Icon } from './icons';

/**
 * Appearance-count conditions of the order being set up (出場条件).
 *
 * Two groups are kept visibly apart: the league's own rules (catalog — official regulations,
 * or a rule the owner stated for the league, which says so) and the conditions the captain
 * chose (format editor or an answer here). Only kinds with two or more games are listed.
 */
export function RuleConditionsCard({
  resolution,
  onEditAnswers,
}: {
  resolution: RuleResolution;
  onEditAnswers: () => void;
}): React.JSX.Element | null {
  const league = resolution.kinds.filter(
    (row) => row.state === 'decided' && (row.origin === 'official' || row.origin === 'requirement'),
  );
  const own = resolution.kinds.filter((row) => row.state === 'decided' && (row.origin === 'answer' || row.origin === 'format') && row.games >= 2);
  const answered = own.some((row) => row.state === 'decided' && row.origin === 'answer');
  const pending = resolution.pending;
  if (league.length === 0 && own.length === 0 && pending.length === 0) return null;
  return (
    <div className="rule-conditions" data-testid="rule-conditions">
      {league.length > 0 && resolution.catalog ? (
        <div className="strength-basis" data-testid="rule-conditions-league">
          <Icon name="info" size={18} />
          <span className="grow">
            <span className="basis-title">大会の規則: {basisLabel(resolution.catalog)}</span>
            <span className="basis-note">
              {league.map((row) => (row.state === 'decided' ? capText(row.kind, row.cap) : '')).join(' ・ ')}
            </span>
            <span className="basis-note">
              確認範囲: このオーダー (1 対戦カード) の中の出場回数です。同じ日に別の対戦カードがある場合、そちらの出場は含まれません。
            </span>
          </span>
        </div>
      ) : null}
      {own.length > 0 ? (
        <div className="strength-basis" data-testid="rule-conditions-own">
          <Icon name="player" size={18} />
          <span className="grow">
            <span className="basis-title">ユーザーが指定した出場条件</span>
            <span className="basis-note">
              {own.map((row) => (row.state === 'decided' ? capText(row.kind, row.cap) : '')).join(' ・ ')}
            </span>
          </span>
          {answered ? (
            <button type="button" className="btn small" onClick={onEditAnswers} data-testid="rule-conditions-edit">
              変更
            </button>
          ) : null}
        </div>
      ) : null}
      {pending.length > 0 ? (
        <div className="notice warn" role="status" data-testid="rule-conditions-pending">
          <Icon name="alert" size={18} />
          <span className="grow small-text">
            出場回数の規則が未確認です ({pending.map((kind) => ASKABLE_LABELS[kind]).join('・')})。生成の前に確認します。
          </span>
          <button type="button" className="btn small" onClick={onEditAnswers}>
            確認する
          </button>
        </div>
      ) : null}
    </div>
  );
}

type Choice = 'yes' | 'no' | 'custom';

function choiceOf(cap: number | undefined): Choice | null {
  if (cap === undefined) return null;
  if (cap === NO_CAP) return 'no';
  if (cap === YES_CAP) return 'yes';
  return 'custom';
}

/**
 * The one compact question screen. Every kind starts unanswered unless an earlier answer
 * exists; confirming is possible only once each kind has an answer — nothing is assumed.
 */
export function RuleQuestionSheet({
  kinds,
  initial,
  gamesOf,
  confirmLabel,
  onCancel,
  onConfirm,
}: {
  kinds: readonly AskableKind[];
  initial: Partial<Record<AskableKind, number>>;
  gamesOf: (kind: AskableKind) => number;
  confirmLabel: string;
  onCancel: () => void;
  onConfirm: (caps: Partial<Record<AskableKind, number>>) => void;
}): React.JSX.Element {
  const [caps, setCaps] = useState<Partial<Record<AskableKind, number>>>(() =>
    Object.fromEntries(kinds.filter((kind) => initial[kind] !== undefined).map((kind) => [kind, initial[kind]])),
  );
  const [custom, setCustom] = useState<Partial<Record<AskableKind, boolean>>>(() =>
    Object.fromEntries(kinds.map((kind) => [kind, choiceOf(initial[kind]) === 'custom'])),
  );
  const complete = kinds.every((kind) => caps[kind] !== undefined);
  const set = (kind: AskableKind, cap: number, isCustom = false): void => {
    setCaps((current) => ({ ...current, [kind]: cap }));
    setCustom((current) => ({ ...current, [kind]: isCustom }));
  };
  return (
    <Sheet
      title="出場回数の確認"
      onClose={onCancel}
      variant="modal"
      footer={
        <div className="row" style={{ gap: 8, justifyContent: 'flex-end' }}>
          <button type="button" className="btn ghost" onClick={onCancel}>
            キャンセル
          </button>
          <button
            type="button"
            className="btn primary"
            disabled={!complete}
            onClick={() => onConfirm(caps)}
            data-testid="rule-questions-confirm"
          >
            {confirmLabel}
          </button>
        </div>
      }
    >
      <p className="small-text muted" style={{ marginTop: 0 }}>
        このリーグの出場回数の規則が登録されていません。必要な項目だけ確認します (同じリーグ・フォーマットでは次回から再利用され、オーダー設定の「変更」で直せます)。
      </p>
      <div className="stack" style={{ gap: 14 }}>
        {kinds.map((kind) => {
          const choice = custom[kind] ? 'custom' : choiceOf(caps[kind]);
          const id = `rule-q-${kind}`;
          return (
            <fieldset key={kind} className="rule-question" data-testid={id} style={{ border: 0, padding: 0, margin: 0 }}>
              <legend className="basis-title" style={{ marginBottom: 6 }}>
                {questionText(kind)}
                <span className="muted small-text"> (このフォーマットに {gamesOf(kind)} ゲーム)</span>
              </legend>
              <div className="chip-row" role="radiogroup" aria-label={questionText(kind)}>
                <button type="button" className="chip" role="radio" aria-checked={choice === 'yes'} onClick={() => set(kind, YES_CAP)}>
                  はい
                </button>
                <button type="button" className="chip" role="radio" aria-checked={choice === 'no'} onClick={() => set(kind, NO_CAP)}>
                  いいえ
                </button>
                <button
                  type="button"
                  className="chip"
                  role="radio"
                  aria-checked={choice === 'custom'}
                  onClick={() => set(kind, Math.max(caps[kind] ?? 3, 3), true)}
                >
                  回数を指定
                </button>
              </div>
              <p className="small-text muted" style={{ margin: '4px 0 0' }}>
                {choice === 'yes'
                  ? '1人2回まで出場できます (3回以上は許可しません)。'
                  : choice === 'no'
                    ? '1人1回までです。'
                    : choice === 'custom'
                      ? '1人あたりの上限回数を指定します。'
                      : '未回答'}
              </p>
              {choice === 'custom' ? (
                <Stepper
                  label={`${ASKABLE_LABELS[kind]}の上限回数`}
                  value={caps[kind] ?? 3}
                  min={1}
                  max={Math.max(gamesOf(kind), 3)}
                  onChange={(next) => set(kind, next, true)}
                  format={(value) => `1人${value}回まで`}
                />
              ) : null}
            </fieldset>
          );
        })}
      </div>
    </Sheet>
  );
}
