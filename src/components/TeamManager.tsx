import { useState } from 'react';
import type { Team } from '../domain/types';
import { divisionLabel } from '../domain/n01/division';
import { createId } from '../utils/id';
import { useAppStore } from '../state/appStore';
import { ConfirmDialog, Field, Sheet, StatusBadge, useToast } from './ui';
import { Icon } from './icons';
import { N01TeamWizard, type N01WizardMode } from './n01/N01TeamWizard';

/**
 * チーム管理 (切替・編集・追加・n01 からの作成と接続・削除)。
 *
 * HOME の「ACTIVE TEAM」カードと、アプリのヘッダーの「チーム切替 / 管理」は、どちらも
 * この 1 つのシートを開く (App が開閉を持つ)。入口が増えても処理は二重化しない。
 *
 * 未保存のオーダーがあるときの切替は、どの入口からでも同じ確認を通る
 * (使用中のチームを変えると作業中のオーダーは破棄されるため)。確認でキャンセルすれば
 * チームも作業内容も変わらない。切替後の作業状態の分離 (生成中の結果の破棄を含む) は
 * App が使用中チームの変化を見て行う。
 */
export function TeamManager({
  hasUnsavedWork,
  onClose,
}: {
  /** 作業中のオーダーに、まだ保存されていない変更があるか。 */
  hasUnsavedWork: boolean;
  onClose: () => void;
}): React.JSX.Element {
  const store = useAppStore();
  const toast = useToast();
  const [editingTeam, setEditingTeam] = useState<Team | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<Team | null>(null);
  const [confirmSwitch, setConfirmSwitch] = useState<Team | null>(null);
  const [wizard, setWizard] = useState<N01WizardMode | null>(null);

  // Switching teams detaches the working order (it belongs to the old team), so unsaved
  // work there is confirmed first, exactly like starting a new order.
  const switchTeam = (target: Team): void => {
    store.setActiveTeam(target.id);
    onClose();
    toast.show(`${target.name} に切り替えました`, 'ok');
  };

  return (
    <>
      <Sheet
        title="チーム"
        onClose={onClose}
        footer={
          <>
            <button type="button" className="btn grow" onClick={() => setWizard({ kind: 'create' })}>
              <Icon name="refresh" size={18} />
              n01から新規作成
            </button>
            <button
              type="button"
              className="btn primary grow"
              onClick={() =>
                setEditingTeam({ id: createId('team'), name: '', createdAt: Date.now() })
              }
            >
              <Icon name="plus" size={18} />
              チームを追加
            </button>
          </>
        }
      >
        <p className="tiny muted" style={{ marginTop: 0 }}>
          「チームを追加」は手入力 (ソフト・ハード) で新しいチームを作ります。今あるチームを n01 League と接続するときは、そのチームの「編集」から「n01と接続」を選びます。
        </p>
        <ul className="list">
          {store.teams.map((entry) => (
            <li key={entry.id}>
              <div className="row" style={{ gap: 8 }}>
                <button
                  type="button"
                  className="list-row grow"
                  onClick={() => {
                    if (entry.id === store.activeTeamId) {
                      onClose();
                      return;
                    }
                    if (hasUnsavedWork) {
                      setConfirmSwitch(entry);
                      return;
                    }
                    switchTeam(entry);
                  }}
                >
                  <span className="grow">
                    <span className="title">
                      {entry.name}{' '}
                      {entry.id === store.activeTeamId ? (
                        <StatusBadge tone="accent" icon="check">
                          使用中
                        </StatusBadge>
                      ) : null}{' '}
                      {entry.demo ? <span className="demo-badge">DEMO</span> : null}
                    </span>
                    <span className="meta">
                      {store.players.filter((player) => player.teamId === entry.id).length} 名
                    </span>
                  </span>
                </button>
                <button type="button" className="btn small" onClick={() => setEditingTeam(entry)}>
                  編集
                </button>
              </div>
            </li>
          ))}
        </ul>
      </Sheet>
      {editingTeam ? (
        <TeamEditor
          team={editingTeam}
          canDelete={store.teams.length > 1 && store.teams.some((entry) => entry.id === editingTeam.id)}
          onClose={() => setEditingTeam(null)}
          onSave={(next) => {
            if (!next.name.trim()) {
              toast.show('チーム名を入力してください', 'error');
              return;
            }
            store.saveTeam(next);
            setEditingTeam(null);
            toast.show('保存しました', 'ok');
          }}
          onDelete={() => {
            setConfirmDelete(editingTeam);
            setEditingTeam(null);
          }}
          onLinkN01={
            store.teams.some((entry) => entry.id === editingTeam.id) && !editingTeam.n01
              ? () => {
                  setWizard({ kind: 'link', team: editingTeam });
                  setEditingTeam(null);
                }
              : undefined
          }
        />
      ) : null}
      {wizard ? (
        <N01TeamWizard
          mode={wizard}
          onClose={() => setWizard(null)}
          onDone={() => {
            setWizard(null);
            onClose();
          }}
          onManual={
            wizard.kind === 'create'
              ? () => {
                  setWizard(null);
                  setEditingTeam({ id: createId('team'), name: '', createdAt: Date.now() });
                }
              : undefined
          }
        />
      ) : null}

      {confirmDelete ? (
        <ConfirmDialog
          title="チームを削除"
          message={`${confirmDelete.name} とそのメンバー・フォーマット・ペア設定・履歴をすべて削除します。この操作は取り消せません。`}
          confirmLabel="削除する"
          destructive
          onCancel={() => setConfirmDelete(null)}
          onConfirm={() => {
            // The dialog stays up until the deletion is stored, so "削除しました" is only
            // ever shown about a deletion that will still be gone after a restart.
            void store.deleteTeam(confirmDelete.id).then(() => {
              toast.show('削除しました', 'ok');
              setConfirmDelete(null);
              onClose();
            });
          }}
        />
      ) : null}

      {confirmSwitch ? (
        <ConfirmDialog
          title="チームを切り替える"
          message={`作業中のオーダーに保存されていない変更があります。${confirmSwitch.name} に切り替えると破棄されます。残す場合は結果画面で保存または確定してください。`}
          confirmLabel="破棄して切り替える"
          destructive
          onCancel={() => setConfirmSwitch(null)}
          onConfirm={() => {
            const target = confirmSwitch;
            setConfirmSwitch(null);
            switchTeam(target);
          }}
        />
      ) : null}
    </>
  );
}

function TeamEditor({
  team,
  canDelete,
  onClose,
  onSave,
  onDelete,
  onLinkN01,
}: {
  team: Team;
  canDelete: boolean;
  onClose: () => void;
  onSave: (team: Team) => void;
  onDelete: () => void;
  /** Offered for an existing team that is not linked to n01 yet. */
  onLinkN01?: () => void;
}): React.JSX.Element {
  const [draft, setDraft] = useState(team);
  return (
    <Sheet
      title="チーム"
      onClose={onClose}
      footer={
        <>
          {canDelete ? (
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
      <Field label="チーム名">
        <input
          type="text"
          value={draft.name}
          onChange={(event) => setDraft({ ...draft, name: event.target.value })}
          placeholder="例: KALAVINKA"
        />
      </Field>
      <Field label="リーグ名 (任意)" hint="共有するオーダーの見出しに使われます。">
        <input
          type="text"
          value={draft.leagueName ?? ''}
          onChange={(event) => setDraft({ ...draft, leagueName: event.target.value })}
          placeholder="例: 秋季リーグ Div.2"
        />
      </Field>
      <Field label="メモ (任意)">
        <textarea
          value={draft.note ?? ''}
          onChange={(event) => setDraft({ ...draft, note: event.target.value })}
        />
      </Field>
      {team.n01 ? (
        <div className="sheet-section">
          <span className="kicker">n01</span>
          <p className="small-text" style={{ margin: 0 }}>
            {team.n01.leagueTitle} ・ {team.n01.lastTournamentTitle}
            {team.n01.lastDivisionTitle ? ` ・ ${divisionLabel(team.n01.lastDivisionTitle)}` : ''} ・ n01 名「{team.n01.lastTeamName}」
          </p>
        </div>
      ) : onLinkN01 ? (
        <div className="sheet-section">
          <span className="kicker">n01</span>
          <p className="tiny muted" style={{ marginTop: 0 }}>
            n01 のチームと接続すると、メンバー・PPR・フォーマットを n01 から同期します。Rating などこのアプリの設定は残ります。
          </p>
          <button type="button" className="btn small" onClick={onLinkN01}>
            <Icon name="refresh" size={16} />
            n01と接続
          </button>
        </div>
      ) : null}
    </Sheet>
  );
}
