import { useState } from 'react';
import type { DartsDiscipline, GameKind, GameSlotDef, LeagueFormat, StructuralKind } from '../domain/types';
import {
  DARTS_DISCIPLINE_LABELS,
  FORMAT_KIND_CHIP_LABELS,
  GAME_KIND_LABELS,
  STRUCTURAL_KINDS,
  formatDiscipline,
} from '../domain/types';
import { DISCIPLINE_STRENGTH_WEIGHTS, describeStrengthWeights } from '../domain/players/strength';
import {
  IMPLIED_PLAYER_COUNT,
  formatStructureIssues,
  playKindsOf,
  renumber,
  structuralKindsOf,
  totalSlots,
  validateFormat,
} from '../domain/games/format';
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
  onRadioGroupKeyDown,
  rovingTabIndex,
  useToast,
} from '../components/ui';
import { Icon } from '../components/icons';
import { divisionLabel } from '../domain/n01/division';

/**
 * FORMAT screen (spec §4).
 *
 * A game carries one or more kinds, which is what lets "Doubles 501" score both the
 * Doubles and the 501 aptitude and be blocked by either exclusion.
 *
 * The format also says whether the league is soft or steel darts. That lives here, not
 * on the team, because one team can play in both kinds of league.
 */
export function FormatsPage({ initialEditId = null }: { initialEditId?: string | null } = {}): React.JSX.Element {
  const store = useAppStore();
  const toast = useToast();
  // Opened straight into the editor after the first-run "自分の構成を作る".
  const [editing, setEditing] = useState<LeagueFormat | null>(() =>
    initialEditId ? (store.teamFormats.find((format) => format.id === initialEditId && !format.source) ?? null) : null,
  );
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

  const [viewing, setViewing] = useState<LeagueFormat | null>(null);

  // A copy is always a manual format: the n01 source and game metadata stay with the
  // managed original, which keeps being rewritten by every sync.
  const duplicate = (format: LeagueFormat): void => {
    store.saveFormat({
      ...format,
      id: createId('fmt'),
      name: format.source ? `${format.name} (手動)` : `${format.name} のコピー`,
      games: format.games.map((game) => ({ ...game, id: createId('gm'), n01: undefined })),
      createdAt: Date.now(),
      source: undefined,
    });
    toast.show(format.source ? '手動フォーマットとしてコピーしました' : '複製しました', 'ok');
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
                  <button
                    type="button"
                    className="list-row grow"
                    onClick={() => (format.source ? setViewing(format) : setEditing(format))}
                  >
                    <span className="lead" aria-hidden="true">
                      <Icon name={format.source ? 'refresh' : 'format'} size={18} />
                    </span>
                    <span className="grow">
                      <span className="title">{format.name}</span>
                      <DisciplineBadge discipline={formatDiscipline(format)} />
                      {format.source ? <span className="n01-tag">n01 管理</span> : null}
                      {formatStructureIssues(format.games).length > 0 ? (
                        <span className="issue-tag" data-testid="format-issue-tag">
                          <Icon name="alert" size={14} />
                          要修正
                        </span>
                      ) : null}
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
                    aria-label={format.source ? `${format.name} を手動フォーマットとしてコピー` : `${format.name} を複製`}
                  >
                    {format.source ? 'コピー' : '複製'}
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

      {viewing ? (
        <ManagedFormatViewer
          format={viewing}
          onClose={() => setViewing(null)}
          onCopy={() => {
            duplicate(viewing);
            setViewing(null);
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

/**
 * An n01-managed format (MASTER SPEC Phase 1 §12): read-only, rewritten by each sync.
 * Editing starts from a manual copy, so the managed one keeps following n01.
 */
function ManagedFormatViewer({
  format,
  onClose,
  onCopy,
}: {
  format: LeagueFormat;
  onClose: () => void;
  onCopy: () => void;
}): React.JSX.Element {
  const source = format.source!;
  return (
    <Sheet
      title="n01 管理フォーマット"
      onClose={onClose}
      footer={
        <button type="button" className="btn primary grow" onClick={onCopy}>
          <Icon name="edit" size={18} />
          コピーして手動フォーマット
        </button>
      }
    >
      <div className="n01-source" data-testid="managed-format-source">
        <span className="kicker">SOURCE</span>
        <p className="body-text" style={{ margin: 0 }}>
          {source.leagueTitle}
          <br />
          {source.tournamentTitle}
          {source.divisionTitle ? (
            <>
              <br />
              {divisionLabel(source.divisionTitle)}
            </>
          ) : null}
        </p>
        <p className="tiny muted">n01 と同期するたびに更新されます。ここでは編集できません。</p>
      </div>
      <p className="small-text">
        <DisciplineBadge discipline={formatDiscipline(format)} /> {DARTS_DISCIPLINE_LABELS[formatDiscipline(format)]}
      </p>
      <ol className="lineup-preview">
        {format.games.map((game) => (
          <li key={game.id}>
            <span className="no">{String(game.order).padStart(2, '0')}</span>
            <span>{game.name}</span>
            <span className="badge">{game.playerCount}名</span>
          </li>
        ))}
      </ol>
    </Sheet>
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

  // How many play (one choice) and what is played (01 / Cricket / Custom, any of them) are
  // edited separately, so a game can no longer be "Singles and Doubles" or a two-player
  // Singles. A stored game that already is keeps its values until the captain picks.
  const setStructure = (index: number, structure: StructuralKind | null): void => {
    const game = draft.games[index];
    const implied = structure ? IMPLIED_PLAYER_COUNT[structure] : undefined;
    updateGame(index, {
      kinds: structure ? [structure, ...playKindsOf(game)] : playKindsOf(game),
      playerCount: implied ?? game.playerCount,
    });
  };

  const togglePlayKind = (index: number, kind: GameKind): void => {
    const game = draft.games[index];
    const kinds = game.kinds.includes(kind)
      ? game.kinds.filter((entry) => entry !== kind)
      : [...game.kinds, kind];
    updateGame(index, { kinds });
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
            <GameStructureEditor
              game={game}
              index={index}
              onStructure={(structure) => setStructure(index, structure)}
              onTogglePlayKind={(kind) => togglePlayKind(index, kind)}
              onPlayerCount={(next) => updateGame(index, { playerCount: next })}
            />
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

const PLAY_KINDS: readonly GameKind[] = ['G501', 'CRICKET', 'CUSTOM'];

const STRUCTURE_HINTS: Record<StructuralKind, string> = {
  SINGLES: '1名',
  DOUBLES: '2名',
  TRIOS: '3名',
  GALLON: '人数を指定',
  TEAM: '人数を指定',
};

/**
 * One game's structure: the player-count category (a single choice, so Singles and Doubles
 * cannot both be on), what is played (01 / Cricket / Custom, several allowed — a soft-darts
 * medley game carries both 01 and Cricket) and the head count, fixed for Singles / Doubles /
 * Trios and editable otherwise. A stored game that contradicts itself is shown as it is,
 * with what is wrong and how to fix it — never changed until the captain chooses.
 */
function GameStructureEditor({
  game,
  index,
  onStructure,
  onTogglePlayKind,
  onPlayerCount,
}: {
  game: GameSlotDef;
  index: number;
  onStructure: (structure: StructuralKind | null) => void;
  onTogglePlayKind: (kind: GameKind) => void;
  onPlayerCount: (next: number) => void;
}): React.JSX.Element {
  const structural = structuralKindsOf(game);
  const selected: StructuralKind | null | 'MIXED' = structural.length > 1 ? 'MIXED' : (structural[0] ?? null);
  const fixedCount = selected && selected !== 'MIXED' ? IMPLIED_PLAYER_COUNT[selected] : undefined;
  const issues = validateFormat([game]).filter((issue) => issue.code === 'structure');
  const choices: { key: StructuralKind | null; label: string; hint: string }[] = [
    ...STRUCTURAL_KINDS.map((kind) => ({ key: kind, label: GAME_KIND_LABELS[kind], hint: STRUCTURE_HINTS[kind] })),
    { key: null, label: '指定なし', hint: '人数を指定' },
  ];
  const medley = game.kinds.includes('G501') && game.kinds.includes('CRICKET');
  return (
    <div className="game-structure">
      <span className="structure-label" aria-hidden="true">
        人数区分
      </span>
      <div
        className="chip-row"
        role="radiogroup"
        aria-label={`ゲーム ${index + 1} の人数区分`}
        onKeyDown={onRadioGroupKeyDown}
      >
        {choices.map((choice, position) => {
          const checked = selected === choice.key;
          return (
            <button
              type="button"
              key={choice.key ?? 'none'}
              className="chip"
              role="radio"
              aria-checked={checked}
              tabIndex={rovingTabIndex(checked, position, selected !== 'MIXED')}
              onClick={() => onStructure(choice.key)}
            >
              {choice.label}
              <span className="chip-hint">{choice.hint}</span>
            </button>
          );
        })}
      </div>

      <span className="structure-label" id={`play-${game.id}`}>
        ゲーム種別 (複数可)
      </span>
      <div className="chip-row" role="group" aria-labelledby={`play-${game.id}`}>
        {PLAY_KINDS.map((kind) => (
          <button
            type="button"
            key={kind}
            className="chip"
            aria-pressed={game.kinds.includes(kind)}
            onClick={() => onTogglePlayKind(kind)}
            title={kind === 'G501' ? '01 ゲーム (301 / 501 / 701 など)' : undefined}
          >
            {FORMAT_KIND_CHIP_LABELS[kind]}
          </button>
        ))}
      </div>
      {medley ? (
        <p className="tiny muted structure-note" data-testid="medley-note">
          01 と Cricket の両方を付けたゲーム (メドレー) は、両方の適性の平均で評価します。どちらかを出場不可にした選手は出場しません。
          レグごとの担当や 01 / Cricket の順番は区別しません。
        </p>
      ) : null}

      <div className="row between structure-count">
        <span className="small-text secondary">必要人数</span>
        {fixedCount !== undefined && game.playerCount === fixedCount ? (
          <span className="badge" data-testid="fixed-player-count">
            {fixedCount}名 ({GAME_KIND_LABELS[selected as StructuralKind]})
          </span>
        ) : (
          <Stepper
            label={`ゲーム ${index + 1} の必要人数`}
            value={game.playerCount}
            min={1}
            max={8}
            onChange={onPlayerCount}
          />
        )}
      </div>

      {issues.length > 0 ? (
        <div className="notice warn structure-issue" role="alert" data-testid="structure-issue">
          <Icon name="alert" size={18} />
          <span className="grow small-text">
            {issues[0].message}
            {selected === 'MIXED'
              ? ' 上の人数区分から 1 つ選ぶと直ります。'
              : fixedCount !== undefined
                ? ` 「${GAME_KIND_LABELS[selected as StructuralKind]}」を選び直すか、人数区分を変更してください。`
                : ''}
          </span>
          {fixedCount !== undefined && game.playerCount !== fixedCount ? (
            <button type="button" className="btn small" onClick={() => onPlayerCount(fixedCount)}>
              {fixedCount}名にする
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
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
          ? `未設定 ・ Rating と PPR の両方がある場合、戦力評価は ${blend} で行います。ソフト / ハード (スティール) を選ぶと配分が変わります。`
          : `戦力評価 ${blend}`}
      </span>
    </div>
  );
}
