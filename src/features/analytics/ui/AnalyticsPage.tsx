import { useMemo, useState } from 'react';
import { EmptyState } from '../../../components/ui';
import type { Page } from '../../../navigation';
import { useAppStore } from '../../../state/appStore';
import type { PeriodMode, PeriodRequest } from '../seasons';
import { PlayerAnalytics } from './PlayerAnalytics';
import { LoadBanner, PeriodBar, Segmented, SourceNote } from './parts';
import { defaultServices, usePeriodLoad } from './usePeriodLoad';
import type { AnalyticsServices } from './usePeriodLoad';

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

  const currentId = binding?.lastTournamentId ?? '';
  const request: PeriodRequest | null = binding
    ? { mode, currentTournamentId: currentId, specifiedTournamentId: mode === 'specified' ? specified || currentId : undefined }
    : null;
  const state = usePeriodLoad(resolved, binding?.leagueId ?? null, request, reload);

  if (!team || !binding) {
    return (
      <EmptyState kicker="ANALYTICS" title="n01 と連携したチームで使えます" icon="target">
        <p className="small-text">ホーム画面の「n01から作成」でリーグのチームを連携すると、選手・チームの成績を分析できます。</p>
      </EmptyState>
    );
  }

  const baseId = mode === 'specified' ? specified || currentId : currentId;
  const load = state.load;
  const loading = state.status === 'loading';

  return (
    <div className="analytics" data-testid="analytics-page">
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
      <LoadBanner load={load} loading={loading} />
      {load && load.seasons.length > 0 ? (
        <div className={loading ? 'analytics-body stale' : 'analytics-body'} aria-busy={loading}>
          {view === 'player' ? (
            <PlayerAnalytics
              team={team}
              players={store.teamPlayers}
              load={load}
              baseTournamentId={baseId}
              onOpenMembers={() => onNavigate('players')}
            />
          ) : TeamView ? (
            <TeamView team={team} players={store.teamPlayers} load={load} baseTournamentId={baseId} />
          ) : (
            <p className="small-text muted">チーム分析は準備中です。</p>
          )}
          <SourceNote load={load} />
        </div>
      ) : null}
    </div>
  );
}

export interface TeamViewProps {
  team: NonNullable<ReturnType<typeof useAppStore>['activeTeam']>;
  players: ReturnType<typeof useAppStore>['teamPlayers'];
  load: NonNullable<ReturnType<typeof usePeriodLoad>['load']>;
  baseTournamentId: string;
}
