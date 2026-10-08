import { useState } from 'react';
import type { PendingLink } from '../../domain/n01/roster';
import { formatPpr } from '../../domain/players/strength';
import { Icon } from '../icons';

/**
 * 「本人確認」: n01 players who might be members the captain added by hand (F07).
 *
 * League Order joins an n01 player to a member on its own only when that is certain (a
 * stable id, or an exact name that is unique on both sides). Everything else comes here,
 * with the candidates, and nothing is chosen for the captain: no row starts selected. An
 * answer joins the n01 player to the chosen member — keeping that member's id, Rating,
 * aptitudes and season totals — or says they are somebody new. A row left unanswered stays
 * pending and is asked again at the next sync; nothing is added twice in the meantime.
 */
export function PendingLinks({
  pending,
  busy = false,
  onApply,
  onSkip,
}: {
  pending: readonly PendingLink[];
  busy?: boolean;
  /** `oid` → the member's id, or `null` for "somebody new". Only answered rows are included. */
  onApply: (answers: Map<string, string | null>) => void;
  onSkip: () => void;
}): React.JSX.Element {
  const [answers, setAnswers] = useState<Map<string, string | null>>(new Map());
  const names = pending.map((entry) => `「${entry.source.name}」`).join('、');
  const taken = new Set([...answers.values()].filter((value): value is string => value !== null));

  return (
    <div className="flow-block pending-links" data-testid="pending-links">
      <p className="body-text">
        <strong>n01 のメンバーと、手動で追加したメンバーが同じ人か確認してください</strong>
      </p>
      <p className="small-text secondary">
        名前などが少し違うため、自動では結び付けていません。同じ人を選ぶと、手動で入力した Rating・適性・シーズン累計を引き継いだまま n01 と連携します。
        別の人かもしれないので、確認するまで n01 の成績はどのメンバーにも使いません。
      </p>
      <p className="small-text secondary" id="pending-links-later" data-testid="pending-links-later">
        「あとで確認する」を選ぶと: 手動で追加済みのメンバーは、これまでどおり今回の参加候補に残ります (n01 未連携のまま、n01 の成績は使いません)。
        n01 の{names}は、新しいメンバーとして追加も、既存メンバーとの結び付けもしません (今回の参加候補にも出ません)。次回の同期で再確認します。
      </p>
      <ul className="link-list">
        {pending.map((entry) => {
          const answer = answers.get(entry.source.oid);
          const name = `link-${entry.source.oid}`;
          return (
            <li key={entry.source.oid} className="link-row">
              <fieldset aria-describedby="pending-links-later">
                <legend>
                  n01 の「{entry.source.name}」
                  {entry.source.stats?.ppr != null ? <span className="small-text secondary"> ・ {formatPpr(entry.source.stats.ppr)}</span> : null}
                </legend>
                {entry.candidates.map((candidate) => (
                  <label key={candidate.playerId} className="check-row">
                    <input
                      type="radio"
                      name={name}
                      checked={answer === candidate.playerId}
                      disabled={taken.has(candidate.playerId) && answer !== candidate.playerId}
                      onChange={() => setAnswers(new Map(answers).set(entry.source.oid, candidate.playerId))}
                    />
                    <span className="small-text">
                      既存メンバー「{candidate.name}」と同じ人
                      {candidate.likely ? <span className="n01-tag"> 名前がほぼ同じ</span> : null}
                    </span>
                  </label>
                ))}
                <label className="check-row">
                  <input
                    type="radio"
                    name={name}
                    checked={answer === null}
                    onChange={() => setAnswers(new Map(answers).set(entry.source.oid, null))}
                  />
                  <span className="small-text">別の人 (新しいメンバーとして追加)</span>
                </label>
              </fieldset>
            </li>
          );
        })}
      </ul>
      <div className="flow-actions">
        <button type="button" className="btn" onClick={onSkip} disabled={busy}>
          あとで確認する
        </button>
        <button
          type="button"
          className="btn primary grow"
          onClick={() => onApply(answers)}
          disabled={busy || answers.size === 0}
        >
          <Icon name="check" size={18} />
          選んだ内容で確定
        </button>
      </div>
    </div>
  );
}
