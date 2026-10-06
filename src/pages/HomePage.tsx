import { useState } from 'react';
import type { OrderLifecycleState, Team } from '../domain/types';
import { createId } from '../utils/id';
import { totalSlots } from '../domain/games/format';
import { useAppStore } from '../state/appStore';
import {
  Card,
  ConfirmDialog,
  Field,
  STATE_META,
  Sheet,
  StatusBadge,
  useToast,
} from '../components/ui';
import { Icon, type IconName } from '../components/icons';
import type { Page } from '../navigation';

/** What HOME needs to know about the order currently open in this session. */
export interface WorkingOrderSummary {
  lifecycle: OrderLifecycleState;
  /** Latest finalized version, or 0. */
  version: number;
  label: string;
  saved: boolean;
}

/**
 * HOME — the face of the app.
 *
 * One dominant action (new order), the active team as a scoreboard, then the rest in
 * decreasing weight: members and formats as tiles, pairs / history / settings as rows.
 */
export function HomePage({
  onNavigate,
  onNewOrder,
  working,
  onResume,
}: {
  onNavigate: (page: Page) => void;
  onNewOrder: () => void;
  working: WorkingOrderSummary | null;
  onResume: () => void;
}): React.JSX.Element {
  const store = useAppStore();
  const toast = useToast();
  const [teamSheet, setTeamSheet] = useState(false);
  const [editingTeam, setEditingTeam] = useState<Team | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<Team | null>(null);
  const [confirmLeaveDemo, setConfirmLeaveDemo] = useState(false);

  const format = store.teamFormats[0];
  const team = store.activeTeam;

  const tertiary: { page: Page; icon: IconName; title: string; meta: string }[] = [
    {
      page: 'pairs',
      icon: 'pair',
      title: 'ペア相性',
      meta: `${store.teamPairs.length} 件設定済み`,
    },
    { page: 'history', icon: 'history', title: '履歴', meta: `${store.teamOrders.length} 件のオーダー` },
    { page: 'settings', icon: 'settings', title: '設定 / バックアップ', meta: '重み調整・JSON 入出力' },
  ];

  return (
    <>
      {store.storageNotice ? (
        <div className="notice warn">
          <Icon name="alert" size={18} />
          <span className="small-text">{store.storageNotice}</span>
        </div>
      ) : null}

      {team?.demo ? (
        <div className="demo-banner" data-testid="demo-banner">
          <span className="demo-badge">DEMO</span>
          <span className="grow">
            <strong>サンプルデータ</strong>
            <span className="muted"> ・ 実在のチームではありません</span>
          </span>
          <button type="button" className="btn small" onClick={() => setConfirmLeaveDemo(true)}>
            自分のチームで始める
          </button>
        </div>
      ) : null}

      <div className="home-grid">
        <div>
          <section className="hero" aria-labelledby="hero-title">
            <span className="kicker">LEAGUE ORDER</span>
            <h2 className="hero-title" id="hero-title">
              試合のオーダーを、
              <br />
              速く・公平に・強く。
            </h2>
            <div className="hero-actions">
              <button type="button" className="btn primary xl" onClick={onNewOrder}>
                <Icon name="plus" size={22} strokeWidth={2.6} />
                新しいオーダーを作る
              </button>
              {working ? (
                <button type="button" className="resume-card" onClick={onResume}>
                  <Icon name="target" />
                  <span className="grow">
                    <span className="title">作業中のオーダーを開く</span>
                    <span className="meta">{working.label}</span>
                  </span>
                  <StatusBadge tone={STATE_META[working.lifecycle].tone} icon={STATE_META[working.lifecycle].icon}>
                    {working.lifecycle === 'DRAFT' ? 'DRAFT' : `v${working.version}`}
                  </StatusBadge>
                </button>
              ) : null}
            </div>
          </section>

          <section className="card team-card" aria-label="アクティブなチーム">
            <div className="team-card-top">
              <span className="grow">
                <span className="kicker">ACTIVE TEAM</span>
                <span className="team-name">{team?.name ?? '未設定'}</span>
                {team?.leagueName ? <span className="team-league">{team.leagueName}</span> : null}
              </span>
              <button type="button" className="btn small" onClick={() => setTeamSheet(true)}>
                切替 / 管理
              </button>
            </div>
            <div className="scoreboard">
              <div>
                <span className="k">PLAYERS</span>
                <span className="v">{store.teamPlayers.length}</span>
              </div>
              <div>
                <span className="k">FORMATS</span>
                <span className="v">{store.teamFormats.length}</span>
              </div>
              <div>
                <span className="k">ORDERS</span>
                <span className="v">{store.teamOrders.length}</span>
              </div>
            </div>
          </section>
        </div>

        <div>
          <div className="quick-grid">
            <button type="button" className="quick-tile" onClick={() => onNavigate('players')}>
              <span className="tile-icon" aria-hidden="true">
                <Icon name="users" />
              </span>
              <span>
                <span className="title">メンバー</span>
                <span className="meta">{store.teamPlayers.length} 名 ・ Rating 任意</span>
              </span>
            </button>
            <button type="button" className="quick-tile" onClick={() => onNavigate('formats')}>
              <span className="tile-icon" aria-hidden="true">
                <Icon name="format" />
              </span>
              <span>
                <span className="title">フォーマット</span>
                <span className="meta">{store.teamFormats.length} 件</span>
              </span>
            </button>
          </div>

          <Card flush>
            <ul className="list">
              {tertiary.map((entry) => (
                <li key={entry.page}>
                  <button type="button" className="list-row" onClick={() => onNavigate(entry.page)}>
                    <span className="lead" aria-hidden="true">
                      <Icon name={entry.icon} size={18} />
                    </span>
                    <span className="grow">
                      <span className="title">{entry.title}</span>
                      <span className="meta">{entry.meta}</span>
                    </span>
                    <Icon name="chevronRight" size={18} className="chevron" />
                  </button>
                </li>
              ))}
            </ul>
          </Card>

          {format ? (
            <Card
              title={format.name}
              kicker="LINEUP"
              action={<span className="badge">総枠 {totalSlots(format.games)}</span>}
            >
              <ol className="lineup-preview">
                {format.games.map((game) => (
                  <li key={game.id}>
                    <span className="no">{String(game.order).padStart(2, '0')}</span>
                    <span>{game.name}</span>
                    <span className="badge">{game.playerCount}名</span>
                  </li>
                ))}
              </ol>
            </Card>
          ) : null}
        </div>
      </div>

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
              <Icon name="plus" size={18} />
              チームを追加
            </button>
          }
        >
          <ul className="list">
            {store.teams.map((entry) => (
              <li key={entry.id}>
                <div className="row" style={{ gap: 8 }}>
                  <button
                    type="button"
                    className="list-row grow"
                    onClick={() => {
                      store.setActiveTeam(entry.id);
                      setTeamSheet(false);
                      toast.show(`${entry.name} に切り替えました`, 'ok');
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
      ) : null}

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

      {confirmLeaveDemo ? (
        <ConfirmDialog
          title="自分のチームで始める"
          message="サンプルのチーム・メンバー・フォーマット・履歴をすべて削除し、最初の画面に戻ります。"
          confirmLabel="サンプルを削除"
          destructive
          onCancel={() => setConfirmLeaveDemo(false)}
          onConfirm={() => {
            setConfirmLeaveDemo(false);
            void store.replaceEverything({
              teams: [],
              players: [],
              formats: [],
              pairs: [],
              orders: [],
              seasonCommits: [],
              settings: { ...store.settings, activeTeamId: null },
            });
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
    </Sheet>
  );
}
