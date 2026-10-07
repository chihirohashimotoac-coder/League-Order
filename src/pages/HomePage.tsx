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
import { N01TeamWizard, type N01WizardMode } from '../components/n01/N01TeamWizard';
import { N01SyncSheet } from '../components/n01/N01SyncSheet';
import { freshness, isLatest } from '../domain/n01/freshness';
import { NextMatchFlow } from '../components/n01/NextMatchFlow';
import type { NextMatchOrder } from '../domain/n01/nextMatch';
import type { N01MatchIntelligenceSnapshot } from '../domain/n01/intelligence';
import type { ParticipantConfig } from '../domain/types';
import { useN01Environment } from '../state/n01Environment';
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
  onNextMatch,
  currentParticipants = null,
}: {
  onNavigate: (page: Page) => void;
  onNewOrder: () => void;
  working: WorkingOrderSummary | null;
  onResume: () => void;
  /** Generates the next match's order (n01 teams). */
  onNextMatch?: (order: NextMatchOrder) => void;
  /** Attendance being worked on in this session. */
  currentParticipants?: readonly ParticipantConfig[] | null;
}): React.JSX.Element {
  const store = useAppStore();
  const toast = useToast();
  const [teamSheet, setTeamSheet] = useState(false);
  const [editingTeam, setEditingTeam] = useState<Team | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<Team | null>(null);
  const [confirmLeaveDemo, setConfirmLeaveDemo] = useState(false);
  const [confirmSwitch, setConfirmSwitch] = useState<Team | null>(null);
  const [wizard, setWizard] = useState<N01WizardMode | null>(null);
  const [syncing, setSyncing] = useState<Team | null>(null);
  const [nextMatchFlow, setNextMatchFlow] = useState<Team | null>(null);

  // Switching teams detaches the working order (it belongs to the old team), so unsaved
  // work there is confirmed first, exactly like starting a new order.
  const switchTeam = (target: Team): void => {
    store.setActiveTeam(target.id);
    setTeamSheet(false);
    toast.show(`${target.name} に切り替えました`, 'ok');
  };

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
          {team?.n01 ? (
            <NextMatchCard team={team} onStart={() => setNextMatchFlow(team)} onSync={() => setSyncing(team)} />
          ) : null}
          <section className="hero" aria-labelledby="hero-title">
            <span className="kicker">LEAGUE ORDER</span>
            <h2 className="hero-title" id="hero-title">
              試合のオーダーを、
              <br />
              速く・公平に・強く。
            </h2>
            <div className="hero-actions">
              <button type="button" className={team?.n01 ? 'btn xl' : 'btn primary xl'} onClick={onNewOrder}>
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
            {team?.n01 ? <N01TeamStatus team={team} /> : null}
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
            <>
              <button type="button" className="btn grow" onClick={() => setWizard({ kind: 'create' })}>
                <Icon name="refresh" size={18} />
                n01から追加
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
          <ul className="list">
            {store.teams.map((entry) => (
              <li key={entry.id}>
                <div className="row" style={{ gap: 8 }}>
                  <button
                    type="button"
                    className="list-row grow"
                    onClick={() => {
                      if (entry.id === store.activeTeamId) {
                        setTeamSheet(false);
                        return;
                      }
                      if (working && !working.saved) {
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

      {nextMatchFlow && onNextMatch ? (
        <NextMatchFlow
          team={nextMatchFlow}
          currentParticipants={currentParticipants}
          onClose={() => setNextMatchFlow(null)}
          onGenerate={(order) => {
            setNextMatchFlow(null);
            onNextMatch(order);
          }}
          onRelink={() => {
            setWizard({ kind: 'link', team: nextMatchFlow });
            setNextMatchFlow(null);
          }}
          onManual={() => {
            setNextMatchFlow(null);
            onNewOrder();
          }}
        />
      ) : null}

      {syncing ? (
        <N01SyncSheet
          team={syncing}
          onClose={() => setSyncing(null)}
          onRelink={() => {
            setWizard({ kind: 'link', team: syncing });
            setSyncing(null);
          }}
        />
      ) : null}

      {wizard ? (
        <N01TeamWizard
          mode={wizard}
          onClose={() => setWizard(null)}
          onDone={() => {
            setWizard(null);
            setTeamSheet(false);
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
            // The dialog stays up until the deletion is stored, so "削除しました" is only
            // ever shown about a deletion that will still be gone after a restart.
            void store.deleteTeam(confirmDelete.id).then(() => {
              toast.show('削除しました', 'ok');
              setConfirmDelete(null);
              setTeamSheet(false);
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

      {confirmLeaveDemo ? (
        <ConfirmDialog
          title="自分のチームで始める"
          message={
            store.teams.some((entry) => !entry.demo)
              ? 'サンプルのチームと、そのメンバー・フォーマット・履歴を削除します。ほかのチームはそのまま残ります。'
              : 'サンプルのチーム・メンバー・フォーマット・履歴をすべて削除し、最初の画面に戻ります。'
          }
          confirmLabel="サンプルを削除"
          destructive
          onCancel={() => setConfirmLeaveDemo(false)}
          onConfirm={() => {
            // Only the sample goes. A team the captain created next to it keeps all of its
            // data and becomes the active team; with no team left, the app returns to the
            // first-run screen.
            //
            // The dialog closes only once the removal is stored. Closing first showed the
            // sample as gone while the write was still in flight, so reopening the app in
            // that window brought the whole sample back.
            const samples = store.teams.filter((candidate) => candidate.demo);
            void (async () => {
              for (const entry of samples) {
                await store.deleteTeam(entry.id);
              }
              setConfirmLeaveDemo(false);
            })();
          }}
        />
      ) : null}
    </>
  );
}

/**
 * The team's n01 state (MASTER SPEC Phase 5 §8): league, season, division, the current
 * opponent and the age of the last sync.
 */
function N01TeamStatus({ team }: { team: Team }): React.JSX.Element {
  const store = useAppStore();
  const env = useN01Environment();
  const binding = team.n01!;
  const cache = store.n01CacheFor(team.id);
  const synced = cache.find((record) => record.kind === 'sync');
  const intel = cache.find((record): record is N01MatchIntelligenceSnapshot => record.kind === 'intel');
  const age = synced ? freshness(synced.fetchedAt, env.now()) : null;
  return (
    <div className="n01-status" data-testid="n01-team-status">
      <span className="grow">
        <span className="n01-line">
          <span className="n01-tag">n01</span>
          {binding.leagueTitle} ・ {binding.lastTournamentTitle}
          {binding.lastDivisionTitle ? ` ・ ${binding.lastDivisionTitle} Division` : ''}
        </span>
        {intel?.nextMatch ? <span className="n01-age">現在の対戦相手: {intel.nextMatch.opponentName}</span> : null}
        <span className={`n01-age level-${age?.level ?? 'danger'}`}>{age ? `最終同期 ${age.label}` : '未同期'}</span>
      </span>
    </div>
  );
}

/**
 * NEXT MATCH (MASTER SPEC Phase 5 §1): who, when, how fresh the data is, and the one
 * action that builds the order. "最新" only right after a successful sync in this session.
 */
function NextMatchCard({
  team,
  onStart,
  onSync,
}: {
  team: Team;
  onStart: () => void;
  onSync: () => void;
}): React.JSX.Element {
  const store = useAppStore();
  const env = useN01Environment();
  const binding = team.n01!;
  const cache = store.n01CacheFor(team.id);
  const synced = cache.find((record) => record.kind === 'sync');
  const intel = cache.find((record): record is N01MatchIntelligenceSnapshot => record.kind === 'intel');
  const now = env.now();
  const latest = isLatest(store.n01SessionSyncAt(team.id), now);
  const age = synced ? freshness(synced.fetchedAt, now) : null;
  const match = intel?.nextMatch;
  return (
    <section className="next-match-card" aria-labelledby="next-match-title" data-testid="next-match-card">
      <span className="kicker">NEXT MATCH</span>
      <h2 className="next-match-title" id="next-match-title">
        {match ? `vs ${match.opponentName}` : intel?.nextMatchStatus === 'none' ? '残りの試合はありません' : intel?.nextMatchStatus === 'ambiguous' ? '次戦の候補が複数あります' : '次戦: 未取得'}
      </h2>
      {match?.date ? <p className="next-match-date">{Number(match.date.slice(5, 7))}/{Number(match.date.slice(8, 10))}</p> : null}
      <p className="next-match-team">
        {team.name} ・ {binding.leagueTitle}
        {binding.lastDivisionTitle ? ` ・ ${binding.lastDivisionTitle} Division` : ''}
      </p>
      <p className={latest ? 'n01-fresh' : `n01-fresh level-${age?.level ?? 'danger'}`} data-testid="n01-freshness">
        {latest ? (
          <>
            <Icon name="checkCircle" size={16} /> n01 ✓ 最新
          </>
        ) : (
          <>
            <Icon name={age?.level === 'recent' ? 'history' : 'alert'} size={16} /> {age ? `n01 ${age.label}のデータ` : 'n01 未同期'}
          </>
        )}
      </p>
      <div className="next-match-actions">
        <button type="button" className="btn primary xl" onClick={onStart}>
          <Icon name="target" size={22} />
          次戦のオーダーを作る
        </button>
        <button type="button" className="btn small" onClick={onSync}>
          <Icon name="refresh" size={16} />
          n01を再同期
        </button>
      </div>
    </section>
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
            {team.n01.lastDivisionTitle ? ` ・ ${team.n01.lastDivisionTitle} Division` : ''} ・ n01 名「{team.n01.lastTeamName}」
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
