import { useState } from 'react';
import type { DartsDiscipline, GameKind, GameSlotDef, LeagueFormat } from '../domain/types';
import {
  DARTS_DISCIPLINE_LABELS,
  FORMAT_KIND_CHIP_LABELS,
  GAME_KINDS,
  formatDiscipline,
} from '../domain/types';
import { DISCIPLINE_STRENGTH_WEIGHTS, describeStrengthWeights } from '../domain/players/strength';
import { impliedPlayerCount, renumber, totalSlots, validateFormat } from '../domain/games/format';
import { createId } from '../utils/id';
import { useAppStore } from '../state/appStore';
import {
  Card,
  ConfirmDialog,
  DisciplineBadge,
  EmptyState,
  Field,
  Sheet,
  Stepper,
  useToast,
} from '../components/ui';
import { Icon } from '../components/icons';

/**
 * FORMAT screen (spec §4).
 *
 * A game carries one or more kinds, which is what lets "Doubles 501" score both the
 * Doubles and the 501 aptitude and be blocked by either exclusion.
 *
 * The format also says whether the league is soft or steel darts. That lives here, not
 * on the team, because one team can play in both kinds of league.
 */
export function FormatsPage(): React.JSX.Element {
  const store = useAppStore();
  const toast = useToast();
  const [editing, setEditing] = useState<LeagueFormat | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<LeagueFormat | null>(null);

  const startNew = (): void => {
    if (!store.activeTeamId) {
      toast.show('先にチームを作成してください', 'error');
      return;
    }
    setEditing({
      id: createId('fmt'),
      teamId: store.activeTeamId,
      name: '新しいフォーマット',
      discipline: 'UNSPECIFIED',
      games: [
        { id: createId('gm'), order: 1, name: 'Singles 501', kinds: ['SINGLES', 'G501'], playerCount: 1 },
      ],
      createdAt: Date.now(),
    });
  };

  const duplicate = (format: LeagueFormat): void => {
    store.saveFormat({
      ...format,
      id: createId('fmt'),
      name: `${format.name} のコピー`,
      games: format.games.map((game) => ({ ...game, id: createId('gm') })),
      createdAt: Date.now(),
    });
    toast.show('複製しました', 'ok');
  };

  return (
    <>
      <Card flush>
        {store.teamFormats.length === 0 ? (
          <EmptyState kicker="NO FORMATS" title="フォーマットがありません" icon="format">
            下のボタンから作成してください。
          </EmptyState>
        ) : (
          <ul className="list">
            {store.teamFormats.map((format) => (
              <li key={format.id}>
                <div className="row" style={{ paddingRight: 10 }}>
                  <button type="button" className="list-row grow" onClick={() => setEditing(format)}>
                    <span className="lead" aria-hidden="true">
                      <Icon name="format" size={18} />
                    </span>
                    <span className="grow">
                      <span className="title">{format.name}</span>
                      <DisciplineBadge discipline={formatDiscipline(format)} />
                      <span className="meta">
                        {format.games.length} ゲーム / 総枠 {totalSlots(format.games)}
                        {format.teamId === null ? ' ・ 共有' : ''}
                      </span>
                    </span>
                    <Icon name="chevronRight" size={18} className="chevron" />
                  </button>
                  <button
                    type="button"
                    className="btn small ghost"
                    onClick={() => duplicate(format)}
                    aria-label={`${format.name} を複製`}
                  >
                    複製
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <div className="action-bar">
        <button type="button" className="btn primary" onClick={startNew}>
          <Icon name="plus" size={20} strokeWidth={2.6} />
          フォーマットを作成
        </button>
      </div>

      {editing ? (
        <FormatEditor
          format={editing}
          isNew={!store.teamFormats.some((candidate) => candidate.id === editing.id)}
          onClose={() => setEditing(null)}
          onSave={(format) => {
            const issues = validateFormat(format.games);
            if (issues.length > 0) {
              toast.show(issues[0].message, 'error');
              return;
            }
            store.saveFormat({ ...format, games: renumber(format.games) });
            setEditing(null);
            toast.show('保存しました', 'ok');
          }}
          onDelete={() => {
            setConfirmDelete(editing);
            setEditing(null);
          }}
        />
      ) : null}

      {confirmDelete ? (
        <ConfirmDialog
          title="フォーマットを削除"
          message={`${confirmDelete.name} を削除します。過去のオーダー履歴は各自の記録を保持しているため影響しません。`}
          confirmLabel="削除する"
          destructive
          onCancel={() => setConfirmDelete(null)}
          onConfirm={() => {
            store.deleteFormat(confirmDelete.id);
            toast.show('削除しました', 'ok');
            setConfirmDelete(null);
          }}
        />
      ) : null}
    </>
  );
}

function FormatEditor({
  format,
  isNew,
  onClose,
  onSave,
  onDelete,
}: {
  format: LeagueFormat;
  isNew: boolean;
  onClose: () => void;
  onSave: (format: LeagueFormat) => void;
  onDelete: () => void;
}): React.JSX.Element {
  const [draft, setDraft] = useState<LeagueFormat>(format);

  const setGames = (games: GameSlotDef[]): void => setDraft({ ...draft, games: renumber(games) });

  const updateGame = (index: number, change: Partial<GameSlotDef>): void => {
    const games = [...draft.games];
    games[index] = { ...games[index], ...change };
    setGames(games);
  };

  const toggleKind = (index: number, kind: GameKind): void => {
    const game = draft.games[index];
    const kinds = game.kinds.includes(kind)
      ? game.kinds.filter((entry) => entry !== kind)
      : [...game.kinds, kind];
    const implied = impliedPlayerCount(kinds);
    updateGame(index, {
      kinds,
      // Adopt the implied head count when a structural kind is added, since that is
      // almost always what the user means; it stays editable afterwards.
      playerCount: implied !== undefined && !game.kinds.includes(kind) ? implied : game.playerCount,
    });
  };

  const move = (index: number, delta: number): void => {
    const target = index + delta;
    if (target < 0 || target >= draft.games.length) return;
    const games = [...draft.games];
    [games[index], games[target]] = [games[target], games[index]];
    setGames(games);
  };

  return (
    <Sheet
      title={isNew ? 'フォーマットを作成' : 'フォーマットを編集'}
      onClose={onClose}
      footer={
        <>
          {!isNew ? (
            <button type="button" className="btn danger" onClick={onDelete}>
              削除
            </button>
          ) : null}
          <button type="button" className="btn primary grow" onClick={() => onSave(draft)}>
            保存
          </button>
        </>
      }
    >
      <Field label="フォーマット名">
        <input
          type="text"
          value={draft.name}
          onChange={(event) => setDraft({ ...draft, name: event.target.value })}
        />
      </Field>

      <DisciplinePicker
        value={formatDiscipline(draft)}
        onChange={(discipline) => setDraft({ ...draft, discipline })}
      />

      <p className="tiny muted">
        総枠 {totalSlots(draft.games)} / {draft.games.length} ゲーム
      </p>

      {draft.games.map((game, index) => (
        <div className="order-game format-game" key={game.id} style={{ marginBottom: 10 }}>
          <div className="order-game-head">
            <span className="no" aria-hidden="true">
              <small>GAME</small>
              <b>{String(index + 1).padStart(2, '0')}</b>
            </span>
            <span className="head-text">
              <input
                type="text"
                value={game.name}
                onChange={(event) => updateGame(index, { name: event.target.value })}
                aria-label={`ゲーム ${index + 1} の名称`}
              />
            </span>
          </div>
          <div style={{ padding: '10px 12px' }}>
            <div className="chip-row" style={{ marginBottom: 10 }}>
              {GAME_KINDS.map((kind) => (
                <button
                  type="button"
                  key={kind}
                  className="chip"
                  aria-pressed={game.kinds.includes(kind)}
                  onClick={() => toggleKind(index, kind)}
                  title={kind === 'G501' ? '01 ゲーム (301 / 501 / 701 など)' : undefined}
                >
                  {FORMAT_KIND_CHIP_LABELS[kind]}
                </button>
              ))}
            </div>
            <div className="row between">
              <span className="small-text secondary">必要人数</span>
              <Stepper
                label={`ゲーム ${index + 1} の必要人数`}
                value={game.playerCount}
                min={1}
                max={8}
                onChange={(next) => updateGame(index, { playerCount: next })}
              />
            </div>
            <div className="row" style={{ marginTop: 10, gap: 6 }}>
              <button
                type="button"
                className="btn small"
                onClick={() => move(index, -1)}
                disabled={index === 0}
                aria-label="上へ移動"
              >
                ↑
              </button>
              <button
                type="button"
                className="btn small"
                onClick={() => move(index, 1)}
                disabled={index === draft.games.length - 1}
                aria-label="下へ移動"
              >
                ↓
              </button>
              <span className="grow" />
              <button
                type="button"
                className="btn small"
                onClick={() => {
                  const games = [...draft.games];
                  games.splice(index + 1, 0, { ...game, id: createId('gm') });
                  setGames(games);
                }}
              >
                直後に複製
              </button>
              <button
                type="button"
                className="btn small danger"
                onClick={() => setGames(draft.games.filter((_, i) => i !== index))}
                disabled={draft.games.length <= 1}
              >
                削除
              </button>
            </div>
          </div>
        </div>
      ))}

      <button
        type="button"
        className="btn"
        style={{ width: '100%' }}
        onClick={() =>
          setGames([
            ...draft.games,
            {
              id: createId('gm'),
              order: draft.games.length + 1,
              name: `Game ${draft.games.length + 1}`,
              kinds: ['SINGLES', 'G501'],
              playerCount: 1,
            },
          ])
        }
      >
        <Icon name="plus" size={18} />
        ゲームを追加
      </button>
    </Sheet>
  );
}

/**
 * Soft / steel selector. A format saved before the choice existed shows "未設定" until
 * the captain picks one; nothing is inferred from its name.
 */
function DisciplinePicker({
  value,
  onChange,
}: {
  value: DartsDiscipline;
  onChange: (next: DartsDiscipline) => void;
}): React.JSX.Element {
  const blend = describeStrengthWeights(DISCIPLINE_STRENGTH_WEIGHTS[value]);
  return (
    <div className="field">
      <span id="discipline-label">ダーツ種別</span>
      <div className="segmented discipline-picker" role="group" aria-labelledby="discipline-label">
        {(['SOFT', 'STEEL'] as const).map((key) => (
          <button type="button" key={key} aria-pressed={value === key} onClick={() => onChange(key)}>
            {value === key ? <Icon name="check" size={16} strokeWidth={3} /> : null}
            {DARTS_DISCIPLINE_LABELS[key]}
          </button>
        ))}
      </div>
      <span className="hint">
        {value === 'UNSPECIFIED'
          ? `未設定 ・ 戦力評価は ${blend} で行います。Soft / Steel を選ぶと配分が変わります。`
          : `戦力評価 ${blend}`}
      </span>
    </div>
  );
}
