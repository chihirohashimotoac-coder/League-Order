import { useState } from 'react';
import type { Player, SkillLevel } from '../domain/types';
import { GAME_KIND_LABELS, PPR_MAX, SKILL_KINDS } from '../domain/types';
import { formatPpr, parsePprInput, playerPpr } from '../domain/players/strength';
import { pprSourceOf } from '../domain/n01/effectivePpr';
import { Field, Sheet, Stepper } from './ui';

/**
 * The form for one player's details, shared by every place a player is entered by hand
 * so that they all validate alike (F06, F07):
 *
 * - `edit`  — the PLAYERS screen: a roster member, new or existing.
 * - `member` — 「次回から参加するメンバーを追加」: a roster member added from the order flow.
 * - `guest` — 「今回だけ助っ人を追加」: a one-order helper, not kept anywhere else.
 *
 * Rating and PPR are optional: an empty box stores `null` (Unknown), never 0. A PPR that is
 * not a number in range, or a Rating that is not a number, is never saved as Unknown
 * silently — the field says why and saving waits.
 */
export type PlayerEditorMode = 'edit' | 'member' | 'guest';

const NOTICES: Partial<Record<PlayerEditorMode, string>> = {
  member:
    'チームのメンバーとして保存され、次回以降のオーダーでも候補になります。n01 に未登録でも今回の参加を選べます。後で n01 に登録されると、同じ名前などで同一人物として結び付けます (迷う場合は確認します)。',
  guest:
    '今回のオーダーだけに入ります。チームのメンバー・次回の候補・シーズン累計には残りません。Rating・PPR・適性は空欄でも構いません (不明として扱います)。n01 での出場資格を保証するものではありません。',
};

function ratingProblem(text: string): string | null {
  const trimmed = text.trim();
  if (trimmed === '') return null;
  return Number.isFinite(Number(trimmed)) ? null : 'Rating は数値で入力してください。';
}

export function PlayerEditor({
  player,
  isNew,
  mode = 'edit',
  title,
  saveLabel,
  existingNames = [],
  onClose,
  onSave,
  onDelete,
}: {
  player: Player;
  isNew: boolean;
  mode?: PlayerEditorMode;
  title?: string;
  saveLabel?: string;
  /** Names already in play, to flag a duplicate (it is allowed, only pointed out). */
  existingNames?: readonly string[];
  onClose: () => void;
  onSave: (player: Player) => void;
  onDelete?: () => void;
}): React.JSX.Element {
  const [draft, setDraft] = useState<Player>(player);
  // Both strength fields are kept as text so an empty box can mean "Unknown" rather than 0.
  const [ratingText, setRatingText] = useState(player.rating === null ? '' : String(player.rating));
  const initialPpr = playerPpr(player);
  const [pprText, setPprText] = useState(initialPpr === null ? '' : String(initialPpr));
  const pprParsed = parsePprInput(pprText);
  const pprError = pprParsed.ok ? null : pprParsed.message;
  const ratingError = ratingProblem(ratingText);
  const nameMissing = draft.name.trim() === '';
  const duplicate =
    mode !== 'edit' && !nameMissing && existingNames.some((name) => name.trim().toLowerCase() === draft.name.trim().toLowerCase());
  const blocked = pprError !== null || ratingError !== null || (mode !== 'edit' && nameMissing);

  const save = (): void => {
    // An invalid value is never saved silently as Unknown: the captain sees why instead.
    if (!pprParsed.ok || ratingError !== null) return;
    onSave({ ...draft, ppr: pprParsed.value });
  };

  const commitRating = (text: string): void => {
    setRatingText(text);
    const trimmed = text.trim();
    if (trimmed === '') {
      setDraft((current) => ({ ...current, rating: null }));
      return;
    }
    const parsed = Number(trimmed);
    setDraft((current) => ({
      ...current,
      rating: Number.isFinite(parsed) ? parsed : current.rating,
    }));
  };

  const full = mode === 'edit';

  return (
    <Sheet
      title={title ?? (isNew ? 'メンバーを追加' : 'メンバーを編集')}
      onClose={onClose}
      footer={
        <>
          {!isNew && onDelete ? (
            <button type="button" className="btn danger" onClick={onDelete}>
              削除
            </button>
          ) : null}
          <button type="button" className="btn primary grow" onClick={save} disabled={blocked}>
            {saveLabel ?? '保存'}
          </button>
        </>
      }
    >
      {NOTICES[mode] ? (
        <p className="notice info small-text" data-testid={`player-editor-notice-${mode}`}>
          {NOTICES[mode]}
        </p>
      ) : null}

      <Field label="名前 (必須)">
        <input
          type="text"
          value={draft.name}
          onChange={(event) => setDraft({ ...draft, name: event.target.value })}
          placeholder="例: ちひろ"
          autoComplete="off"
          aria-invalid={mode !== 'edit' && nameMissing}
        />
      </Field>
      {duplicate ? (
        <p className="hint" role="status">
          同じ名前の人がすでにいます。別人であればこのまま追加できます。
        </p>
      ) : null}

      {full && player.n01 ? (
        <div className="sheet-section n01-player" data-testid="n01-player">
          <span className="kicker">n01</span>
          <p className="small-text" style={{ margin: '0 0 6px' }}>
            {player.n01.sourceName}
            {player.n01.rosterActive ? '' : ' ・ 現在の登録メンバーではありません'}
          </p>
          <p className="small-text secondary" style={{ margin: '0 0 10px' }}>
            {player.n01.stats?.ppr != null
              ? `${formatPpr(player.n01.stats.ppr)} (${player.n01.stats.score} 点 / ${player.n01.stats.darts} ダーツ${
                  player.n01.stats.legs !== null ? ` / ${player.n01.stats.legs} レッグ` : ''
                })`
              : 'n01 に PPR のデータがありません'}
          </p>
          <div className="segmented" role="radiogroup" aria-label="使用する PPR">
            {(['n01', 'manual'] as const).map((source) => (
              <button
                type="button"
                key={source}
                role="radio"
                aria-checked={pprSourceOf(draft) === source}
                onClick={() => setDraft({ ...draft, pprSource: source })}
              >
                {source === 'n01' ? 'n01 の PPR' : '手動の PPR'}
              </button>
            ))}
          </div>
          <p className="hint">名前と n01 の PPR は同期のたびに n01 から更新されます。Rating・適性・メモはこのアプリだけの設定です。</p>
        </div>
      ) : null}

      <div className="field-pair">
        <Field label="Rating (任意)">
          <input
            type="number"
            inputMode="decimal"
            step="0.01"
            value={ratingText}
            onChange={(event) => commitRating(event.target.value)}
            placeholder="例: 14"
            aria-invalid={ratingError !== null}
          />
        </Field>
        <label className="field">
          <span>{player.n01 ? '手動 PPR (任意)' : 'PPR Average (任意)'}</span>
          <input
            type="number"
            inputMode="decimal"
            step="0.01"
            min={0}
            max={PPR_MAX}
            value={pprText}
            onChange={(event) => setPprText(event.target.value)}
            placeholder="例: 72.45"
            aria-invalid={pprError !== null}
            aria-describedby={pprError ? 'ppr-error' : undefined}
          />
        </label>
      </div>
      {ratingError ? (
        <p className="field-error" role="alert">
          {ratingError}
        </p>
      ) : null}
      {pprError ? (
        <p className="field-error" id="ppr-error" role="alert">
          {pprError}
        </p>
      ) : null}
      <p className="hint field-pair-hint">
        どちらも空欄で構いません。未入力は 0 ではなく「不明」として扱い、参加者の中央値で評価します。
        PPR は 0〜{PPR_MAX} (小数可)。
      </p>

      <div className="field">
        <span>ゲーム適性 (任意・1〜5)</span>
        {SKILL_KINDS.map((kind) => (
          <div className="skill-row" key={kind}>
            <span className="skill-name">{GAME_KIND_LABELS[kind]}</span>
            <span className="levels">
              {([1, 2, 3, 4, 5] as SkillLevel[]).map((level) => (
                <button
                  type="button"
                  key={level}
                  aria-pressed={draft.skills[kind] === level}
                  aria-label={`${GAME_KIND_LABELS[kind]} 適性 ${level}`}
                  onClick={() =>
                    setDraft({
                      ...draft,
                      skills:
                        draft.skills[kind] === level
                          ? { ...draft.skills, [kind]: undefined }
                          : { ...draft.skills, [kind]: level },
                    })
                  }
                >
                  {level}
                </button>
              ))}
            </span>
          </div>
        ))}
        <span className="hint">未設定は「普通 (3) 相当」として中立に扱います。Rating とは別の概念です。</span>
      </div>

      {full ? (
        <>
          <div className="field">
            <span>シーズン累計出場回数</span>
            <Stepper
              label="シーズン累計出場回数"
              value={draft.seasonAppearances}
              min={0}
              max={400}
              onChange={(next) => setDraft({ ...draft, seasonAppearances: next })}
            />
          </div>

          <Field label="メモ (任意)">
            <textarea
              value={draft.note ?? ''}
              onChange={(event) => setDraft({ ...draft, note: event.target.value })}
              placeholder="得意なゲーム、当日の体調など"
            />
          </Field>

          <label className="check-row">
            <input
              type="checkbox"
              checked={draft.archived}
              onChange={(event) => setDraft({ ...draft, archived: event.target.checked })}
            />
            <span className="small-text">休止中 (既定で参加者に含めない)</span>
          </label>
        </>
      ) : null}
    </Sheet>
  );
}
