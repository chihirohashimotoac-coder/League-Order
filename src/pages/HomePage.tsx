import { useMemo, useState } from 'react';
import type { OrderLifecycleState, Player, SavedOrder, Team } from '../domain/types';
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
import { ChangelogSheet } from '../components/ChangelogSheet';
import { N01TeamWizard, type N01WizardMode } from '../components/n01/N01TeamWizard';
import { N01SyncSheet } from '../components/n01/N01SyncSheet';
import { freshness, isLatest } from '../domain/n01/freshness';
import { divisionLabel } from '../domain/n01/division';
import { NextMatchFlow } from '../components/n01/NextMatchFlow';
import type { NextMatchOrder } from '../domain/n01/nextMatch';
import type { N01MatchIntelligenceSnapshot } from '../domain/n01/intelligence';
import type { ParticipantConfig } from '../domain/types';
import { useN01Environment } from '../state/n01Environment';
import type { Page } from '../navigation';
import { latestVersion } from '../domain/orders/lifecycle';
import { applyHistoryStrength } from '../domain/n01/historyStrength';
import { formatPpr } from '../domain/players/strength';
import { formatRating, onRadioGroupKeyDown, rovingTabIndex } from '../components/ui';
import { Carousel } from '../components/Carousel';
import { BarChart, KineticText, RingGauge, RollingNumber, StackedBar, type BarDatum } from '../components/motion';

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
  onOpenOrder,
}: {
  onNavigate: (page: Page) => void;
  onNewOrder: () => void;
  working: WorkingOrderSummary | null;
  onResume: () => void;
  /** Generates the next match's order (n01 teams). */
  onNextMatch?: (order: NextMatchOrder) => void;
  /** Attendance being worked on in this session. */
  currentParticipants?: readonly ParticipantConfig[] | null;
  /** Opens a saved order (the recent-orders carousel). */
  onOpenOrder?: (order: SavedOrder) => void;
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
  const [showChangelog, setShowChangelog] = useState(false);
  const [showStrength, setShowStrength] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState<SavedOrder | null>(null);

  // Opening a saved order replaces the working copy: unsaved work is confirmed first.
  const openOrder = (order: SavedOrder): void => {
    if (!onOpenOrder) return;
    if (working && !working.saved) {
      setConfirmOpen(order);
      return;
    }
    onOpenOrder(order);
  };

  // Switching teams detaches the working order (it belongs to the old team), so unsaved
  // work there is confirmed first, exactly like starting a new order.
  const switchTeam = (target: Team): void => {
    store.setActiveTeam(target.id);
    setTeamSheet(false);
    toast.show(`${target.name} に切り替えました`, 'ok');
  };

  const format = store.teamFormats[0];
  const team = store.activeTeam;
  // The Rating / PPR the order generator would use for each member (SETUP builds the same):
  // n01 or hand-typed PPR, or the estimate from the last analysis.
  const intel = team?.n01
    ? (store.n01CacheFor(team.id).find((record): record is N01MatchIntelligenceSnapshot => record.kind === 'intel') ?? null)
    : null;
  const strengthPlayers = useMemo(() => applyHistoryStrength(store.teamPlayers, intel).players, [store.teamPlayers, intel]);

  const tertiary: { key: string; icon: IconName; title: string; meta: string; onSelect: () => void }[] = [
    {
      key: 'pairs',
      icon: 'pair',
      title: 'ペア相性',
      meta: `${store.teamPairs.length} 件設定済み`,
      onSelect: () => onNavigate('pairs'),
    },
    ...(team?.n01
      ? [
          {
            key: 'analytics',
            icon: 'spark' as IconName,
            title: 'データ分析',
            meta: '選手・チームの成績分析',
            onSelect: () => onNavigate('analytics'),
          },
        ]
      : []),
    {
      key: 'history',
      icon: 'history',
      title: '履歴',
      meta: `${store.teamOrders.length} 件のオーダー`,
      onSelect: () => onNavigate('history'),
    },
    {
      key: 'settings',
      icon: 'settings',
      title: '設定 / バックアップ',
      meta: '重み調整・JSON 入出力',
      onSelect: () => onNavigate('settings'),
    },
    {
      key: 'changelog',
      icon: 'info',
      title: '更新履歴',
      meta: `v${__APP_VERSION__} ・ アプリの変更点`,
      onSelect: () => setShowChangelog(true),
    },
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
            <span className="kicker">
              <KineticText text="LEAGUE ORDER" variant="track" step={30} />
            </span>
            <h2 className="hero-title" id="hero-title">
              <KineticText text="試合のオーダーを、" step={34} />
              <br />
              <KineticText text="速く・公平に・強く。" variant="drop" delay={320} step={46} className="hero-accent" />
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

          {store.teamOrders.length === 0 && !working && !team?.demo ? (
            <NextStepCard
              hasPlayers={store.teamPlayers.length > 0}
              formats={store.teamFormats.length}
              allManaged={store.teamFormats.length > 0 && store.teamFormats.every((entry) => entry.source)}
              onNavigate={onNavigate}
              onNewOrder={onNewOrder}
            />
          ) : null}

          <section className="card team-card" aria-label="アクティブなチーム">
            <div className="team-card-top">
              <span className="grow">
                <span className="kicker">ACTIVE TEAM</span>
                <span className="team-name">
                  <KineticText text={team?.name ?? '未設定'} step={30} />
                </span>
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
                <RollingNumber className="v" value={store.teamPlayers.length} />
              </div>
              <div>
                <span className="k">FORMATS</span>
                <RollingNumber className="v" value={store.teamFormats.length} />
              </div>
              <div>
                <span className="k">ORDERS</span>
                <RollingNumber className="v" value={store.teamOrders.length} />
              </div>
            </div>
          </section>

          {store.teamOrders.length > 0 && onOpenOrder ? (
            <RecentOrdersCarousel orders={store.teamOrders} onOpen={openOrder} />
          ) : (
            <GuideCarousel
              players={store.teamPlayers.length}
              formats={store.teamFormats.length}
              managedFormats={store.teamFormats.filter((entry) => entry.source).length}
              onNavigate={onNavigate}
              onNewOrder={onNewOrder}
            />
          )}
        </div>

        <div>
          <TeamInsight orders={store.teamOrders} players={strengthPlayers} onShowStrength={() => setShowStrength(true)} />

          <div className="quick-grid">
            <button type="button" className="quick-tile" onClick={() => onNavigate('players')}>
              <span className="tile-icon" aria-hidden="true">
                <Icon name="users" />
              </span>
              <span>
                <span className="title">メンバー</span>
                <span className="meta">{store.teamPlayers.length} 名 ・ Rating・PPR 任意</span>
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
                <li key={entry.key}>
                  <button type="button" className="list-row" onClick={entry.onSelect}>
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

      {showChangelog ? <ChangelogSheet onClose={() => setShowChangelog(false)} /> : null}

      {showStrength ? (
        <StrengthModal players={strengthPlayers} teamName={team?.name ?? ''} onClose={() => setShowStrength(false)} />
      ) : null}

      {confirmOpen && onOpenOrder ? (
        <ConfirmDialog
          title="保存済みのオーダーを開く"
          message={`作業中のオーダーに保存されていない変更があります。「${confirmOpen.title}」を開くと破棄されます。残す場合は結果画面で保存または確定してください。`}
          confirmLabel="破棄して開く"
          destructive
          onCancel={() => setConfirmOpen(null)}
          onConfirm={() => {
            const target = confirmOpen;
            setConfirmOpen(null);
            onOpenOrder(target);
          }}
        />
      ) : null}

      {teamSheet ? (
        <Sheet
          title="チーム"
          onClose={() => setTeamSheet(false)}
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
          {binding.lastDivisionTitle ? ` ・ ${divisionLabel(binding.lastDivisionTitle)}` : ''}
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
        {binding.lastDivisionTitle ? ` ・ ${divisionLabel(binding.lastDivisionTitle)}` : ''}
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

/**
 * TEAM INSIGHT: how much of the saved work is finalized, as a ring and a proportion bar,
 * plus the way into the members' strength chart. Read-only — it counts stored records.
 */
function TeamInsight({
  orders,
  players,
  onShowStrength,
}: {
  orders: readonly SavedOrder[];
  players: readonly Player[];
  onShowStrength: () => void;
}): React.JSX.Element {
  const finalized = orders.filter((order) => latestVersion(order.versions) !== null).length;
  const drafts = orders.length - finalized;
  const rate = orders.length > 0 ? finalized / orders.length : 0;
  const hasRating = (player: Player): boolean => player.rating !== null && Number.isFinite(player.rating);
  const hasPpr = (player: Player): boolean => player.ppr !== null && Number.isFinite(player.ppr);
  const rated = players.filter(hasRating).length;
  const withPpr = players.filter(hasPpr).length;
  const withEither = players.filter((player) => hasRating(player) || hasPpr(player)).length;
  return (
    <section className="card insight-card" aria-labelledby="insight-title">
      <div className="card-head">
        <h2 className="card-title" id="insight-title">
          <span className="kicker" aria-hidden="true">
            INSIGHT
          </span>
          チームの状況
        </h2>
      </div>
      <div className="insight-body">
        <RingGauge
          value={rate}
          label="確定率"
          display={orders.length > 0 ? `${Math.round(rate * 100)}%` : '—'}
          tone="success"
        />
        <div className="insight-side">
          <StackedBar
            label="オーダーの内訳"
            segments={[
              { key: 'final', label: '確定', value: finalized, tone: 'success' },
              { key: 'draft', label: '下書き', value: drafts, tone: 'draft' },
            ]}
          />
          <p className="tiny muted insight-note" data-testid="strength-coverage">
            戦力データあり <strong className="num">{withEither}</strong> / {players.length} 名 (Rating または PPR)
            <span className="insight-breakdown">
              Rating {rated} 名 ・ PPR (3投平均) {withPpr} 名 ・ オーダー生成で使う値で数えています
            </span>
          </p>
          <button type="button" className="btn small" onClick={onShowStrength} disabled={players.length === 0}>
            <Icon name="chart" size={16} />
            メンバーの戦力分布
          </button>
        </div>
      </div>
    </section>
  );
}

type StrengthMetric = 'rating' | 'ppr';

/**
 * Members' strength as a bar chart in a modal. Values are the stored Rating or the PPR
 * the order generator would use (n01 or manual); a missing value is shown as "—", never 0.
 */
function StrengthModal({
  players,
  teamName,
  onClose,
}: {
  players: readonly Player[];
  teamName: string;
  onClose: () => void;
}): React.JSX.Element {
  const ratingOf = (player: Player): number | null =>
    player.rating !== null && Number.isFinite(player.rating) ? player.rating : null;
  // Already the value the generator uses (see `applyHistoryStrength` in HomePage).
  const pprOf = (player: Player): number | null => (player.ppr !== null && Number.isFinite(player.ppr) ? player.ppr : null);
  const hasRating = players.some((player) => ratingOf(player) !== null);
  const hasPpr = players.some((player) => pprOf(player) !== null);
  const [metric, setMetric] = useState<StrengthMetric>(hasRating || !hasPpr ? 'rating' : 'ppr');

  const valueOf = metric === 'rating' ? ratingOf : pprOf;
  const known = players.map(valueOf).filter((value): value is number => value !== null);
  const max = known.length > 0 ? Math.max(...known) : 0;
  const average = known.length > 0 ? known.reduce((sum, value) => sum + value, 0) / known.length : null;
  const data: BarDatum[] = [...players]
    .sort((a, b) => (valueOf(b) ?? -Infinity) - (valueOf(a) ?? -Infinity))
    .map((player) => {
      const value = valueOf(player);
      return {
        key: player.id,
        label: player.name,
        ratio: value !== null && max > 0 ? value / max : 0,
        display: metric === 'rating' ? formatRating(value) : formatPpr(value),
        muted: value === null,
      };
    });

  const options: { key: StrengthMetric; label: string }[] = [
    { key: 'rating', label: 'Rating' },
    { key: 'ppr', label: 'PPR' },
  ];

  return (
    <Sheet title="メンバーの戦力分布" onClose={onClose} variant="modal" className="strength-modal">
      <p className="tiny muted" style={{ marginTop: 0 }}>
        {teamName} ・ {players.length} 名。未入力の値は「—」で表示し、0 としては扱いません。
      </p>
      <div className="segmented" role="radiogroup" aria-label="表示する指標" onKeyDown={onRadioGroupKeyDown}>
        {options.map((option, index) => (
          <button
            type="button"
            key={option.key}
            role="radio"
            aria-checked={metric === option.key}
            tabIndex={rovingTabIndex(metric === option.key, index, true)}
            onClick={() => setMetric(option.key)}
          >
            {option.label}
          </button>
        ))}
      </div>
      <div className="scoreboard strength-summary">
        <div>
          <span className="k">入力済み</span>
          <RollingNumber className="v" value={`${known.length}/${players.length}`} />
        </div>
        <div>
          <span className="k">平均</span>
          <RollingNumber className="v" value={average === null ? '—' : average.toFixed(1)} />
        </div>
        <div>
          <span className="k">最高</span>
          <RollingNumber className="v" value={known.length > 0 ? (Number.isInteger(max) ? String(max) : max.toFixed(1)) : '—'} />
        </div>
      </div>
      {/* Keyed by the metric: switching replays the bars growing in. */}
      <BarChart key={metric} data={data} label={metric === 'rating' ? 'メンバー別 Rating' : 'メンバー別 PPR'} />
    </Sheet>
  );
}

/** The latest saved orders, one per slide; a slide opens its order. */
function RecentOrdersCarousel({
  orders,
  onOpen,
}: {
  orders: readonly SavedOrder[];
  onOpen: (order: SavedOrder) => void;
}): React.JSX.Element {
  const recent = orders.slice(0, 6);
  return (
    <Carousel
      label="最近のオーダー"
      kicker="RECENT"
      slideLabel={(index) => `${index + 1} / ${recent.length}: ${recent[index].title}`}
      slides={recent.map((order) => {
        const latest = latestVersion(order.versions);
        const players = new Set(order.solution.assignments.flatMap((assignment) => assignment.playerIds).filter(Boolean)).size;
        return {
          key: order.id,
          content: (
            <button type="button" className="order-slide" onClick={() => onOpen(order)}>
              <span className="order-slide-top">
                {latest ? (
                  <StatusBadge tone="finalized" icon="checkCircle">
                    v{latest.version} 確定
                  </StatusBadge>
                ) : (
                  <StatusBadge tone="draft" icon="edit">
                    未確定
                  </StatusBadge>
                )}
                <span className="tiny muted">{new Date(latest?.finalizedAt ?? order.updatedAt).toLocaleDateString('ja-JP')}</span>
              </span>
              <span className="order-slide-title">{order.title}</span>
              <span className="order-slide-vs">{order.match?.opponentName ? `vs ${order.match.opponentName}` : '対戦相手 未設定'}</span>
              <span className="order-slide-stats">
                <span>
                  <RollingNumber className="v" value={order.input.games.length} />
                  <span className="k">ゲーム</span>
                </span>
                <span>
                  <RollingNumber className="v" value={players} />
                  <span className="k">出場者</span>
                </span>
                <span>
                  <RollingNumber className="v" value={order.versions.length} />
                  <span className="k">確定版</span>
                </span>
              </span>
              <span className="order-slide-open">
                開いて編集
                <Icon name="chevronRight" size={16} />
              </span>
            </button>
          ),
        };
      })}
    />
  );
}

/**
 * What to do next on a team with no order yet: check the format (a starter template is an
 * example, not the league's rules), then make the first order. n01-managed formats come
 * from the league itself and need no check.
 */
function NextStepCard({
  hasPlayers,
  formats,
  allManaged,
  onNavigate,
  onNewOrder,
}: {
  hasPlayers: boolean;
  formats: number;
  allManaged: boolean;
  onNavigate: (page: Page) => void;
  onNewOrder: () => void;
}): React.JSX.Element {
  return (
    <section className="card next-step-card" aria-labelledby="next-step-title" data-testid="next-step">
      <h2 className="card-title" id="next-step-title">
        <span className="kicker" aria-hidden="true">
          NEXT
        </span>
        次にやること
      </h2>
      <ol className="next-step-list">
        {!hasPlayers ? (
          <li>
            <span className="grow">
              <strong>メンバーを登録</strong>
              <span className="tiny muted">Rating・PPR (3投平均) は任意です。</span>
            </span>
            <button type="button" className="btn small" onClick={() => onNavigate('players')}>
              メンバー
            </button>
          </li>
        ) : null}
        {formats === 0 ? (
          <li>
            <span className="grow">
              <strong>フォーマットを作成</strong>
              <span className="tiny muted">リーグのゲーム数・人数・順番を登録します。</span>
            </span>
            <button type="button" className="btn small" onClick={() => onNavigate('formats')}>
              フォーマット
            </button>
          </li>
        ) : allManaged ? null : (
          <li>
            <span className="grow">
              <strong>フォーマットの内容を確認</strong>
              <span className="tiny muted">
                テンプレートは一般的な例です。リーグのゲーム数・人数・順番、ソフト / ハードの種別と合っているか確かめてください。
              </span>
            </span>
            <button type="button" className="btn small" onClick={() => onNavigate('formats')}>
              確認する
            </button>
          </li>
        )}
        <li>
          <span className="grow">
            <strong>最初のオーダーを作る</strong>
            <span className="tiny muted">参加者と条件を選ぶと、最大 3 つの候補を作ります。</span>
          </span>
          <button type="button" className="btn small primary" onClick={onNewOrder}>
            オーダーを作る
          </button>
        </li>
      </ol>
    </section>
  );
}

/** First-run guide: the four steps from roster to a shared order, one per slide. */
function GuideCarousel({
  players,
  formats,
  managedFormats,
  onNavigate,
  onNewOrder,
}: {
  players: number;
  formats: number;
  /** Formats n01 manages: they come from the league, so they need no checking. */
  managedFormats: number;
  onNavigate: (page: Page) => void;
  onNewOrder: () => void;
}): React.JSX.Element {
  const steps: {
    key: string;
    icon: IconName;
    title: string;
    body: string;
    /** `done`: nothing left to do; `check`: exists but the captain should look; `todo`: missing. */
    status: 'done' | 'check' | 'todo';
    statusLabel?: string;
    action: string;
    onAction: () => void;
  }[] = [
    {
      key: 'players',
      icon: 'users',
      title: 'メンバーを登録',
      body: 'Rating・PPR (3投平均) は任意。未入力でも 0 扱いにはなりません。',
      status: players > 0 ? 'done' : 'todo',
      statusLabel: players > 0 ? `${players} 名登録済み` : undefined,
      action: 'メンバーを見る',
      onAction: () => onNavigate('players'),
    },
    {
      key: 'formats',
      icon: 'format',
      title: 'フォーマットを確認',
      body: 'リーグのゲーム構成。Singles・Doubles・Trios などの人数と順番、ソフト / ハードの種別です。',
      status: formats === 0 ? 'todo' : managedFormats === formats ? 'done' : 'check',
      statusLabel: formats === 0 ? undefined : managedFormats === formats ? 'n01 管理' : `${formats} 件 ・ 内容を確認`,
      action: 'フォーマットを見る',
      onAction: () => onNavigate('formats'),
    },
    {
      key: 'setup',
      icon: 'sliders',
      title: '条件を決めて生成',
      body: '参加者・出場条件・プリセットを選ぶと、最大 3 つの候補を作ります。',
      status: 'todo',
      action: 'オーダーを作る',
      onAction: onNewOrder,
    },
    {
      key: 'share',
      icon: 'share',
      title: '確定して共有',
      body: '確定すると v1・v2… と版が残り、LINE 向けの画像やテキストで共有できます。',
      status: 'todo',
      action: 'オーダーを作る',
      onAction: onNewOrder,
    },
  ];
  return (
    <Carousel
      label="はじめかた"
      kicker="GUIDE"
      slideLabel={(index) => `ステップ ${index + 1} / ${steps.length}: ${steps[index].title}`}
      slides={steps.map((step, index) => ({
        key: step.key,
        content: (
          <div className="guide-slide">
            <span className="guide-no" aria-hidden="true">
              <RollingNumber value={String(index + 1).padStart(2, '0')} />
            </span>
            <span className="guide-icon" aria-hidden="true">
              <Icon name={step.icon} size={22} />
            </span>
            <strong className="guide-title">{step.title}</strong>
            <p className="guide-body">{step.body}</p>
            <span className="guide-foot">
              {step.status === 'done' ? (
                <StatusBadge tone="finalized" icon="check">
                  {step.statusLabel ?? '完了'}
                </StatusBadge>
              ) : step.status === 'check' ? (
                <StatusBadge tone="draft" icon="alert">
                  {step.statusLabel ?? '要確認'}
                </StatusBadge>
              ) : (
                <span />
              )}
              <button type="button" className="btn small" onClick={step.onAction}>
                {step.action}
              </button>
            </span>
          </div>
        ),
      }))}
    />
  );
}
