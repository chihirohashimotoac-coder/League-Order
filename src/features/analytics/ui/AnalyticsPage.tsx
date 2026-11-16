import { useCallback, useMemo, useState } from 'react';
import { EmptyState } from '../../../components/ui';
import type { Page } from '../../../navigation';
import { useAppStore } from '../../../state/appStore';
import type { PeriodMode, PeriodRequest } from '../seasons';
import { projectSeasons } from '../projection';
import type { Projection, SeasonAdoption } from '../projection';
import type { GameScope } from '../roleGames';
import { PlayerAnalytics } from './PlayerAnalytics';
import type { FocusSummary } from './PlayerAnalytics';
import { LoadBanner, PeriodBar, Segmented, SourceNote } from './parts';
import { gaugeOutcomeOf, LoadGauge, teamLegStage } from './LoadGauge';
import type { GaugeStage } from './LoadGauge';
import { periodLabelAllowed } from '../service/periodService';
import { AnalysisSummary, effectiveScope, ScopeBar } from './scopeParts';
import type { MainScope, OthersPart } from './scopeParts';
import { defaultServices, usePeriodLoad } from './usePeriodLoad';
import type { AnalyticsServices } from './usePeriodLoad';
import { useGamesLoad, usePlayerDetail, useTeamDetail } from './useRoleData';
import { useIdentityDecisions } from './useIdentityDecisions';
import type { IdentityControls } from './useIdentityDecisions';
import { applyLinks, linkPeople } from '../personLink';
import type { PeriodLinks } from '../personLink';
import { aggregateTeams } from '../aggregate';
import { resolveBaseTeam } from '../teamView';
import { pushWatchLink, requestWatchTab } from '../../matches/watchLink';
import type { DetailControls, DetailState, GamesState, TeamDetailState } from './useRoleData';

/**
 * データ分析: PLAYER / TEAM analytics behind one shell.
 *
 * The shell owns what both share — the period, the season, the load state and the
 * freshness line — so the two views always describe the same data. It reads the active
 * team's n01 link as plain values and never writes to the store; if analytics fails, the
 * rest of the app is unaffected.
 */

type View = 'player' | 'team';

export default function AnalyticsPage({
  onNavigate,
  services,
  TeamView,
}: {
  onNavigate: (page: Page) => void;
  services?: AnalyticsServices;
  TeamView?: React.ComponentType<TeamViewProps>;
}): React.JSX.Element {
  const store = useAppStore();
  const team = store.activeTeam;
  const binding = team?.n01 ?? null;
  const resolved = useMemo(() => services ?? defaultServices(), [services]);

  const [view, setView] = useState<View>('player');
  const [mode, setMode] = useState<PeriodMode>('current');
  const [specified, setSpecified] = useState('');
  const [reload, setReload] = useState(0);
  const [mainScope, setMainScope] = useState<MainScope>('all01');
  const [othersPart, setOthersPart] = useState<OthersPart>('others');
  const scope = effectiveScope(mainScope, othersPart);
  const [focusSummary, setFocusSummaryState] = useState<FocusSummary | null>(null);
  const setFocusSummary = useCallback((next: FocusSummary | null) => {
    setFocusSummaryState((prev) => (prev?.name === next?.name && prev?.status.kind === next?.status.kind && prev?.status.text === next?.status.text ? prev : next));
  }, []);

  const currentId = binding?.lastTournamentId ?? '';
  const request: PeriodRequest | null = binding
    ? { mode, currentTournamentId: currentId, specifiedTournamentId: mode === 'specified' ? specified || currentId : undefined }
    : null;
  const periodState = usePeriodLoad(resolved, binding?.leagueId ?? null, request, reload);
  // The load of another condition (the previous period / season while the new one is read) is never
  // shown as this one: only the gauge for the new condition is. The same condition read again keeps
  // its previous figures, said to be the previous ones.
  const sameCondition = periodState.loadKey === periodState.requestKey;
  const shown = sameCondition ? periodState : { ...periodState, load: null };
  // ⑨ 本人照合: the period's rows joined into people (automatic rules + the decisions kept on this device).
  const identity = useIdentityDecisions(binding?.leagueId ?? null);
  const linked = useMemo(() => {
    if (!shown.load) return null;
    const links = linkPeople(shown.load.seasons, identity.decisions);
    return { load: { ...shown.load, seasons: applyLinks(shown.load.seasons, links) }, links };
  }, [shown.load, identity.decisions]);
  const state = { ...shown, load: linked?.load ?? null };
  const rawLoad = state.status === 'done' ? state.load : null;
  const games = useGamesLoad(resolved, rawLoad, scope, reload);
  const detail = usePlayerDetail(resolved, rawLoad, games.load, reload);
  // The team view of シングルス / ダブルス: the shown team's own legs give its First 9 and Keep/Break.
  const baseIdForTeam = mode === 'specified' ? specified || currentId : currentId;
  const teamSeasons = useMemo(() => {
    if (view !== 'team' || !rawLoad || !binding || (scope !== 'singles' && scope !== 'doubles')) return null;
    const base = rawLoad.seasons.find((s) => s.tournamentId === baseIdForTeam);
    const baseTeam = base ? resolveBaseTeam(base, binding) : null;
    if (!baseTeam) return null;
    const period = aggregateTeams(rawLoad.seasons).find((t) => t.seasons.some((s) => s.tournamentId === baseIdForTeam && s.teamId === baseTeam.teamId));
    return period ? new Map(period.seasons.map((s) => [s.tournamentId, s.teamId])) : null;
  }, [view, rawLoad, binding, scope, baseIdForTeam]);
  const teamDetail = useTeamDetail(resolved, rawLoad, games.load, teamSeasons ? (scope as 'singles' | 'doubles') : null, teamSeasons, reload);
  // The chosen game kind's view of the seasons: which counters each season contributes.
  const projection = useMemo<Projection | null>(
    () => (state.load ? projectSeasons(state.load.seasons, scope, { games: games.load?.games ?? new Map(), failed: games.load?.failed ?? new Set(), pending: games.load?.pending }, detail.contributions, teamDetail.contributions) : null),
    [state.load, scope, games.load, detail.contributions, teamDetail.contributions],
  );

  if (!team || !binding) {
    return (
      <EmptyState
        kicker="ANALYTICS"
        title="n01 と連携したチームで使えます"
        icon="target"
        action={
          <div className="row wrap" style={{ gap: 8, justifyContent: 'center' }}>
            <button type="button" className="btn primary" onClick={() => onNavigate('home')}>
              ホームでチームを連携
            </button>
            <button type="button" className="btn" onClick={() => onNavigate('matches')}>
              観戦でスタッツを見る
            </button>
          </div>
        }
      >
        <p className="small-text">ホームの「n01から作成」でリーグのチームを連携すると、選手・チームの複数シーズンの成績を分析できます。リーグのスタッツ・選手カードは観戦からチームなしで見られます。</p>
      </EmptyState>
    );
  }

  const baseId = mode === 'specified' ? specified || currentId : currentId;
  // The league and the season chosen here are carried over: 観戦 opens on their スタッツ.
  const openWatchStats = (): void => {
    requestWatchTab('stats');
    pushWatchLink({ league: binding.leagueId, ...(baseId ? { season: baseId } : {}) });
    onNavigate('watch');
  };
  const load = state.load && projection ? { ...state.load, seasons: projection.seasons } : state.load;
  const loading = state.status === 'loading';
  const roleView: RoleViewProps = { scope, adoption: projection?.adoption ?? [], games, detail, teamDetail, identity: linked ? { links: linked.links, controls: identity } : undefined };

  // 読み込みゲージ: the stages this view needs now.
  const stages: GaugeStage[] = [];
  stages.push(
    loading
      ? {
          id: 'season',
          label: 'シーズン取得',
          state: 'running',
          count: periodState.progress && periodState.progress.total > 0 ? { ...periodState.progress, unit: '季' } : null,
          text: periodState.progress ? (sameCondition && state.load ? '同じ条件を取り直しています' : '選んだ条件のシーズンを取得しています') : 'シーズン一覧を取得しています',
        }
      : {
          id: 'season',
          label: 'シーズン取得',
          state: !state.load || state.load.listError ? 'failed' : state.load.failures.length > 0 ? 'partial' : 'done',
          count: state.load ? { done: state.load.window.filter((w) => w.state === 'loaded').length, total: state.load.window.length, unit: '季' } : null,
          text: state.load?.listError ? state.load.listError.reason : state.load && state.load.failures.length > 0 ? `${state.load.failures.length}季を取得できませんでした` : '',
        },
  );
  if (!loading && games.needed.length > 0) {
    const g = games.load;
    const read = games.needed.filter((id) => g?.games.get(id)?.complete).length;
    const failed = games.needed.filter((id) => g?.failed.has(id) || (g?.games.has(id) && !g.games.get(id)!.complete && !g.pending.has(id))).length;
    const rows = games.needed.reduce((n, id) => n + (g?.progress.get(id)?.rows ?? 0), 0);
    stages.push({
      id: 'games',
      label: 'ゲーム一覧取得',
      state: games.status === 'loading' ? 'running' : failed > 0 ? (read > 0 ? 'partial' : 'failed') : 'done',
      count: { done: read + failed, total: games.needed.length, unit: '季' },
      text: games.status === 'loading' ? `取得中${rows > 0 ? `（${rows}件まで）` : ''}` : failed > 0 ? `${failed}季のゲーム一覧を取得できませんでした` : '',
    });
  }
  if (!loading && view === 'player' && focusSummary && (scope === 'singles' || scope === 'doubles')) {
    const k = focusSummary.status.kind;
    stages.push({ id: 'legs', label: 'Leg明細の照合', state: k === 'waiting' || k === 'running' ? 'running' : k === 'partial' ? 'partial' : k === 'failed' ? 'failed' : 'done', count: null, text: `${focusSummary.name}：${focusSummary.status.text}` });
  }
  if (!loading && view === 'team' && teamDetail.key) stages.push(teamLegStage(teamDetail));
  const gaugeOutcome = loading ? null : gaugeOutcomeOf(stages, !!state.load?.seasons.length, state.load ? periodLabelAllowed(state.load) === 'partial' : false, periodState.loadedAt);
  const previousAt = loading && sameCondition && state.load ? periodState.loadedAt : null;

  return (
    <div className="analytics" data-testid="analytics-page">
      {/* One toolbar: on a large screen the three switches share a row instead of three full-width rows. */}
      <div className="analytics-toolbar" data-testid="analytics-toolbar">
      <Segmented
        label="分析の対象"
        value={view}
        onChange={setView}
        options={[
          { value: 'player', label: 'プレイヤー' },
          { value: 'team', label: 'チーム' },
        ]}
      />
      <PeriodBar
        mode={mode}
        onMode={setMode}
        specifiedId={specified || currentId}
        onSpecified={setSpecified}
        options={state.seasonOptions}
        onReload={() => setReload((n) => n + 1)}
        loading={loading}
        load={load}
        currentTournamentId={currentId}
      />
      <ScopeBar main={mainScope} part={othersPart} onMain={setMainScope} onPart={setOthersPart} />
      </div>
      <LoadGauge stages={stages} outcome={gaugeOutcome} previous={previousAt} />
      <LoadBanner load={state.load} loading={loading} onRetry={() => setReload((n) => n + 1)} onWatch={openWatchStats} />
      {state.load && projection && state.load.seasons.length > 0 ? <AnalysisSummary load={state.load} projection={projection} scope={scope} games={games} focus={view === 'player' ? focusSummary : null} /> : null}
      {load && load.seasons.length > 0 ? (
        <div className={loading ? 'analytics-body stale' : 'analytics-body'} aria-busy={loading}>
          {view === 'player' ? (
            <PlayerAnalytics
              team={team}
              players={store.teamPlayers}
              load={load}
              baseTournamentId={baseId}
              onOpenMembers={() => onNavigate('players')}
              role={roleView}
              onFocusSummary={setFocusSummary}
            />
          ) : TeamView ? (
            <TeamView team={team} players={store.teamPlayers} load={load} baseTournamentId={baseId} role={roleView} />
          ) : (
            <p className="small-text muted">チーム分析は準備中です。</p>
          )}
          <SourceNote load={load} />
        </div>
      ) : null}
    </div>
  );
}

/** What the game-kind switch adds to both views. Optional so the views also render on their own (tests). */
export interface RoleViewProps {
  scope: GameScope;
  adoption: SeasonAdoption[];
  games: GamesState;
  detail: DetailState & DetailControls;
  /** The team view's leg read of the shown team (シングルス / ダブルス). */
  teamDetail?: TeamDetailState;
  /** ⑨ 本人照合: who is who across the period, and the controls to undo / confirm a join. */
  identity?: { links: PeriodLinks; controls: IdentityControls };
}

export interface TeamViewProps {
  team: NonNullable<ReturnType<typeof useAppStore>['activeTeam']>;
  players: ReturnType<typeof useAppStore>['teamPlayers'];
  load: NonNullable<ReturnType<typeof usePeriodLoad>['load']>;
  baseTournamentId: string;
  role?: RoleViewProps;
}
