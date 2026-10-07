import { useMemo, useState } from 'react';
import type { Player, SkillLevel } from '../domain/types';
import { GAME_KIND_LABELS, SKILL_KINDS } from '../domain/types';
import { createId } from '../utils/id';
import { useAppStore } from '../state/appStore';
import {
  Card,
  ConfirmDialog,
  EmptyState,
  Field,
  Sheet,
  Stepper,
  formatStrengthLine,
  useToast,
} from '../components/ui';
import { formatPpr, parsePprInput, playerPpr } from '../domain/players/strength';
import {
  EFFECTIVE_PPR_ORIGIN_LABELS,
  effectivePpr,
  pprSourceOf,
  withEffectivePpr,
} from '../domain/n01/effectivePpr';
import { PPR_MAX } from '../domain/types';
import { Icon } from '../components/icons';

/**
 * PLAYERS screen (spec §3, §26).
 *
 * Rating and PPR are optional everywhere: an empty box stores `null`, which the
 * optimizer treats as Unknown — never as 0.
 */
export function PlayersPage(): React.JSX.Element {
  const store = useAppStore();
  const toast = useToast();
  const [editing, setEditing] = useState<Player | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<Player | null>(null);
  const [query, setQuery] = useState('');

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return store.teamPlayers;
    return store.teamPlayers.filter((player) => player.name.toLowerCase().includes(needle));
  }, [store.teamPlayers, query]);

  const startNew = (): void => {
    if (!store.activeTeamId) {
      toast.show('先にチームを作成してください', 'error');
      return;
    }
    setEditing({
      id: createId('pl'),
      teamId: store.activeTeamId,
      name: '',
      rating: null,
      ppr: null,
      skills: {},
      seasonAppearances: 0,
      seasonAppearancesByKind: {},
      archived: false,
      createdAt: Date.now(),
    });
  };

  return (
    <>
      <Card>
        <Field label="検索">
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="名前で絞り込み"
          />
        </Field>
        <p className="tiny muted" style={{ margin: 0 }}>
          {store.teamPlayers.length} 名登録 ・ Rating 未入力{' '}
          {store.teamPlayers.filter((player) => player.rating === null).length} 名 ・ PPR 未入力{' '}
          {store.teamPlayers.filter((player) => effectivePpr(player).value === null).length} 名
        </p>
      </Card>

      <Card flush>
        {filtered.length === 0 ? (
          <EmptyState kicker="NO PLAYERS" title="メンバーがまだいません" icon="users">
            下の「メンバーを追加」から登録してください。
          </EmptyState>
        ) : (
          <ul className="list">
            {filtered.map((player) => (
              <li key={player.id}>
                <button type="button" className="list-row" onClick={() => setEditing(player)}>
                  <span className="lead" aria-hidden="true">
                    {Array.from(player.name || '?')[0]}
                  </span>
                  <span className="grow">
                    <span className="title">
                      {player.name || '(名称未設定)'}
                      {player.n01 && !player.n01.rosterActive ? <span className="n01-tag muted-tag">登録外</span> : null}
                    </span>
                    <span
                      className={
                        player.rating === null && effectivePpr(player).value === null
                          ? 'strength-line unknown'
                          : 'strength-line'
                      }
                    >
                      {formatStrengthLine(withEffectivePpr(player))}
                      {player.n01 ? (
                        <span className="ppr-origin"> ・ PPR {EFFECTIVE_PPR_ORIGIN_LABELS[effectivePpr(player).origin]}</span>
                      ) : null}
                    </span>
                    <span className="meta">
                      シーズン {player.seasonAppearances} 回
                      {Object.keys(player.skills).length > 0 ? ' ・ 適性設定あり' : ''}
                      {player.archived ? ' ・ 休止中' : ''}
                    </span>
                  </span>
                  <Icon name="chevronRight" size={18} className="chevron" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <div className="action-bar">
        <button type="button" className="btn primary" onClick={startNew}>
          <Icon name="plus" size={20} strokeWidth={2.6} />
          メンバーを追加
        </button>
      </div>

      {editing ? (
        <PlayerEditor
          player={editing}
          onClose={() => setEditing(null)}
          onSave={(player) => {
            if (!player.name.trim()) {
              toast.show('名前を入力してください', 'error');
              return;
            }
            store.savePlayer(player);
            setEditing(null);
            toast.show(`${player.name} を保存しました`, 'ok');
          }}
          onDelete={() => {
            setConfirmDelete(editing);
            setEditing(null);
          }}
          isNew={!store.teamPlayers.some((candidate) => candidate.id === editing.id)}
        />
      ) : null}

      {confirmDelete ? (
        <ConfirmDialog
          title="メンバーを削除"
          message={`${confirmDelete.name} を削除します。このメンバーのペア相性設定も削除されます。過去のオーダー履歴は残ります。`}
          confirmLabel="削除する"
          destructive
          onCancel={() => setConfirmDelete(null)}
          onConfirm={() => {
            store.deletePlayer(confirmDelete.id);
            toast.show(`${confirmDelete.name} を削除しました`, 'ok');
            setConfirmDelete(null);
          }}
        />
      ) : null}
    </>
  );
}

function PlayerEditor({
  player,
  isNew,
  onClose,
  onSave,
  onDelete,
}: {
  player: Player;
  isNew: boolean;
  onClose: () => void;
  onSave: (player: Player) => void;
  onDelete: () => void;
}): React.JSX.Element {
  const [draft, setDraft] = useState<Player>(player);
  // Both strength fields are kept as text so an empty box can mean "Unknown" rather than 0.
  const [ratingText, setRatingText] = useState(player.rating === null ? '' : String(player.rating));
  const initialPpr = playerPpr(player);
  const [pprText, setPprText] = useState(initialPpr === null ? '' : String(initialPpr));
  const pprParsed = parsePprInput(pprText);
  const pprError = pprParsed.ok ? null : pprParsed.message;

  const save = (): void => {
    // An invalid PPR is never saved silently as Unknown: the captain sees why instead.
    if (!pprParsed.ok) return;
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

  return (
    <Sheet
      title={isNew ? 'メンバーを追加' : 'メンバーを編集'}
      onClose={onClose}
      footer={
        <>
          {!isNew ? (
            <button type="button" className="btn danger" onClick={onDelete}>
              削除
            </button>
          ) : null}
          <button type="button" className="btn primary grow" onClick={save} disabled={pprError !== null}>
            保存
          </button>
        </>
      }
    >
      <Field label="名前 (必須)">
        <input
          type="text"
          value={draft.name}
          onChange={(event) => setDraft({ ...draft, name: event.target.value })}
          placeholder="例: ちひろ"
          autoComplete="off"
        />
      </Field>

      {player.n01 ? (
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
    </Sheet>
  );
}
