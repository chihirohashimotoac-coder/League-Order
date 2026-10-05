import { useState } from 'react';
import type { Team } from '../domain/types';
import { createId } from '../utils/id';
import { totalSlots } from '../domain/games/format';
import { useAppStore } from '../state/appStore';
import { Card, ConfirmDialog, Field, Sheet, useToast } from '../components/ui';
import type { Page } from '../navigation';

/** HOME screen (spec §26): entry points plus team management. */
export function HomePage({ onNavigate }: { onNavigate: (page: Page) => void }): React.JSX.Element {
  const store = useAppStore();
  const toast = useToast();
  const [teamSheet, setTeamSheet] = useState(false);
  const [editingTeam, setEditingTeam] = useState<Team | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<Team | null>(null);

  const format = store.teamFormats[0];

  return (
    <>
      {store.storageNotice ? (
        <div className="notice warn">
          <span aria-hidden="true">△</span>
          <span className="small-text">{store.storageNotice}</span>
        </div>
      ) : null}

      <Card>
        <div className="row between" style={{ marginBottom: 10 }}>
          <div>
            <p className="tiny dim" style={{ margin: 0 }}>
              チーム
            </p>
            <strong style={{ fontSize: 18 }}>{store.activeTeam?.name ?? '未設定'}</strong>
          </div>
          <button type="button" className="btn small" onClick={() => setTeamSheet(true)}>
            切替 / 管理
          </button>
        </div>
        <div className="metrics">
          <div className="metric">
            <span className="k">メンバー</span>
            <span className="v">{store.teamPlayers.length}</span>
          </div>
          <div className="metric">
            <span className="k">フォーマット</span>
            <span className="v">{store.teamFormats.length}</span>
          </div>
          <div className="metric">
            <span className="k">履歴</span>
            <span className="v">{store.teamOrders.length}</span>
          </div>
        </div>
      </Card>

      <button
        type="button"
        className="btn primary"
        style={{ width: '100%', minHeight: 58, fontSize: 17, marginBottom: 12 }}
        onClick={() => onNavigate('setup')}
      >
        新規オーダーを作成
      </button>

      <Card flush>
        <ul className="list">
          {(
            [
              ['players', 'メンバー管理', `${store.teamPlayers.length} 名 ・ Rating 任意`],
              ['pairs', 'ペア相性', `${store.teamPairs.length} 件設定済み ・ 禁止ペアは Hard 制約`],
              [
                'formats',
                'ゲームフォーマット',
                format ? `${format.name} ほか ${store.teamFormats.length} 件` : '未登録',
              ],
              ['history', '過去オーダー', `${store.teamOrders.length} 件`],
              ['settings', '設定 / バックアップ', 'ウェイト調整・JSON 入出力'],
            ] as [Page, string, string][]
          ).map(([page, title, meta]) => (
            <li key={page}>
              <button type="button" className="list-row" onClick={() => onNavigate(page)}>
                <span className="grow">
                  <span className="title">{title}</span>
                  <span className="meta">{meta}</span>
                </span>
                <span className="chevron" aria-hidden="true">
                  ›
                </span>
              </button>
            </li>
          ))}
        </ul>
      </Card>

      {format ? (
        <Card title="現在のフォーマット">
          <ol style={{ margin: 0, paddingLeft: 20 }}>
            {format.games.map((game) => (
              <li key={game.id} className="small-text">
                {game.name} <span className="dim">({game.playerCount}名)</span>
              </li>
            ))}
          </ol>
          <p className="tiny dim" style={{ marginBottom: 0, marginTop: 8 }}>
            総枠 {totalSlots(format.games)}
          </p>
        </Card>
      ) : null}

      {teamSheet ? (
        <Sheet
          title="チーム"
          onClose={() => setTeamSheet(false)}
          footer={
            <button
              type="button"
              className="btn primary grow"
              onClick={() =>
                setEditingTeam({ id: createId('team'), name: '', createdAt: Date.now() })
              }
            >
              ＋ チームを追加
            </button>
          }
        >
          <ul className="list">
            {store.teams.map((team) => (
              <li key={team.id}>
                <div className="row" style={{ padding: '6px 0', gap: 8 }}>
                  <button
                    type="button"
                    className="list-row grow"
                    onClick={() => {
                      store.setActiveTeam(team.id);
                      setTeamSheet(false);
                      toast.show(`${team.name} に切り替えました`, 'ok');
                    }}
                  >
                    <span className="grow">
                      <span className="title">
                        {team.name}
                        {team.id === store.activeTeamId ? (
                          <span className="badge accent" style={{ marginLeft: 6 }}>
                            使用中
                          </span>
                        ) : null}
                      </span>
                      <span className="meta">
                        {store.players.filter((player) => player.teamId === team.id).length} 名
                      </span>
                    </span>
                  </button>
                  <button type="button" className="btn small" onClick={() => setEditingTeam(team)}>
                    編集
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </Sheet>
      ) : null}

      {editingTeam ? (
        <TeamEditor
          team={editingTeam}
          canDelete={store.teams.length > 1 && store.teams.some((team) => team.id === editingTeam.id)}
          onClose={() => setEditingTeam(null)}
          onSave={(team) => {
            if (!team.name.trim()) {
              toast.show('チーム名を入力してください', 'error');
              return;
            }
            store.saveTeam(team);
            setEditingTeam(null);
            toast.show('保存しました', 'ok');
          }}
          onDelete={() => {
            setConfirmDelete(editingTeam);
            setEditingTeam(null);
          }}
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
            store.deleteTeam(confirmDelete.id);
            toast.show('削除しました', 'ok');
            setConfirmDelete(null);
            setTeamSheet(false);
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
}: {
  team: Team;
  canDelete: boolean;
  onClose: () => void;
  onSave: (team: Team) => void;
  onDelete: () => void;
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
          placeholder="例: チーム A"
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
    </Sheet>
  );
}
