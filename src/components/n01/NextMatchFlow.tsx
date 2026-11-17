import { useCallback, useEffect, useRef, useState } from 'react';
import type { Team } from '../../domain/types';
import { DEFAULT_N01_SETTINGS } from '../../domain/types';
import type { N01MatchIntelligenceSnapshot, N01NextMatch } from '../../domain/n01/intelligence';
import { describeChanges, hasImportantChanges } from '../../domain/n01/changes';
import { formatSyncTime, freshness, isLatest } from '../../domain/n01/freshness';
import { CONFIDENCE_LABELS } from '../../domain/prediction/confidence';
import { describeN01Error } from '../../integrations/n01/client';
import type { N01SyncStep, N01TeamSelection } from '../../integrations/n01/sync';
import { N01_SYNC_STEPS } from '../../integrations/n01/sync';
import { useAppStore } from '../../state/appStore';
import { useN01Environment } from '../../state/n01Environment';
import { useN01FreshSync, useN01LinkResolution, type FreshSyncResult } from '../../state/useN01FreshSync';
import { PendingLinks } from './PendingLinks';
import { useToast } from '../ui';
import { Icon } from '../icons';
import { SyncProgress, type SyncProgressState } from './SyncProgress';

/**
 * 「次戦のオーダーを作る」 (MASTER SPEC Phase 5), inside ORDER SETUP.
 *
 *   fresh sync → (change summary, only when something important changed)
 *   → (next-match picker, only when ambiguous) → the next match's conditions on SETUP
 *
 * The sync runs while SETUP is already on screen: its state is shown at the top of the page
 * and the conditions below stay locked until the next match is known. When n01 cannot be
 * reached the captain is told when the data on the device was last synced and chooses to
 * continue with it — nothing old is ever presented as current.
 */
type SyncedOk = Extract<FreshSyncResult, { kind: 'ok' }>;

export type NextMatchPhase =
  /** Not syncing and nothing chosen (the captain is making another match by hand). */
  | { kind: 'idle' }
  | { kind: 'syncing' }
  | { kind: 'offline'; message: string }
  | { kind: 'season'; options: { tournamentId: string; title: string; teamTpid: string }[] }
  | { kind: 'notFound' }
  | { kind: 'links'; result: SyncedOk; then: NextMatchPhase }
  | { kind: 'changes'; lines: string[]; then: NextMatchPhase }
  | { kind: 'pickMatch'; options: N01NextMatch[] }
  | { kind: 'noMatch' }
  /**
   * The next match is known (or there is no opponent data and the order is made as 勝利優先).
   * `run` names the sync (or the choice to use the data on the device) that got here: the
   * conditions are built once per `run`.
   */
  | { kind: 'ready'; fresh: boolean; run: number };

export interface NextMatchSync {
  phase: NextMatchPhase;
  progress: SyncProgressState;
  /** Saving the answers to 「同じ人ですか？」. */
  resolving: boolean;
  /** The analysis on the device (the latest one once a sync has finished). */
  intel: N01MatchIntelligenceSnapshot | null;
  /** When the data on the device was last fetched from n01. */
  lastSyncAt: number | null;
  /** Syncs, or uses the data on the device, as the settings say (see below). */
  start: () => void;
  /** Drops whatever is running: its answer will change nothing on screen. */
  cancel: () => void;
  retry: () => void;
  /** Offline: go on with the data on the device. Only offered when there is some. */
  continueWithCached: () => void;
  pickSeason: (option: { tournamentId: string; teamTpid: string }) => void;
  pickMatch: (matchId: string) => void;
  skipLinks: () => void;
  applyLinks: (answers: Map<string, string | null>) => void;
  confirmChanges: () => void;
}

/** The analysis cached for a team (opponent data for its next match), or null. */
function cachedIntel(records: readonly { kind: string }[]): N01MatchIntelligenceSnapshot | null {
  return (records.find((record) => record.kind === 'intel') as N01MatchIntelligenceSnapshot | undefined) ?? null;
}

/**
 * The n01 side of the next match on SETUP. Every answer carries the number of the attempt
 * that asked for it; an answer from an attempt that is no longer current (cancelled for a
 * match made by hand, the page left, the team switched) is dropped without touching anything.
 */
export function useNextMatchSync(team: Team): NextMatchSync {
  const store = useAppStore();
  const env = useN01Environment();
  const freshSync = useN01FreshSync();
  const resolveLinks = useN01LinkResolution();
  const toast = useToast();
  const [phase, setPhase] = useState<NextMatchPhase>({ kind: 'idle' });
  const [progress, setProgress] = useState<SyncProgressState>({});
  const [resolving, setResolving] = useState(false);
  const run = useRef(0);
  const n01Settings = store.settings.n01 ?? DEFAULT_N01_SETTINGS;
  const cache = store.n01CacheFor(team.id);
  const intel = cachedIntel(cache);
  const lastSyncAt = cache.find((record) => record.kind === 'sync')?.fetchedAt ?? null;

  const afterIntel = useCallback((snapshot: N01MatchIntelligenceSnapshot | null, fresh: boolean, attempt: number): NextMatchPhase => {
    if (snapshot?.nextMatchStatus === 'ambiguous') return { kind: 'pickMatch', options: snapshot.nextMatchOptions };
    if (snapshot?.nextMatchStatus === 'none') return { kind: 'noMatch' };
    return { kind: 'ready', fresh, run: attempt };
  }, []);

  const sync = useCallback(
    async (selection?: N01TeamSelection, chosenMatchId?: string) => {
      const attempt = ++run.current;
      setPhase({ kind: 'syncing' });
      setProgress({});
      const report = (step: N01SyncStep, status: SyncProgressState[N01SyncStep]): void => {
        if (attempt === run.current && status) setProgress((current) => ({ ...current, [step]: status }));
      };
      try {
        const result = await freshSync(team, { onProgress: report, selection, chosenMatchId, isCurrent: () => attempt === run.current });
        if (!result || attempt !== run.current) return;
        if (result.kind === 'seasonAmbiguous') return setPhase({ kind: 'season', options: result.options });
        if (result.kind === 'teamNotFound') return setPhase({ kind: 'notFound' });
        const next = afterIntel(result.intel, true, attempt);
        const staged: NextMatchPhase =
          hasImportantChanges(result.plan.changes) && next.kind === 'ready'
            ? { kind: 'changes', lines: describeChanges(result.plan.changes), then: next }
            : next;
        // n01 players who might be members added by hand are confirmed first, never merged
        // or added twice on a guess.
        setPhase(result.plan.roster.pending.length > 0 ? { kind: 'links', result, then: staged } : staged);
      } catch (error) {
        if (attempt === run.current) setPhase({ kind: 'offline', message: describeN01Error(error) });
      }
    },
    [freshSync, team, afterIntel],
  );

  const start = useCallback(() => {
    if (!team.n01) return;
    if (n01Settings.autoSync || !intel) {
      void sync();
      return;
    }
    // Without auto sync the cached analysis is used; it is "current" only if it was
    // fetched by a successful sync in this session a moment ago.
    const attempt = ++run.current;
    setPhase(afterIntel(intel, isLatest(store.n01SessionSyncAt(team.id), env.now()), attempt));
  }, [team, n01Settings.autoSync, intel, sync, afterIntel, store, env]);

  const cancel = useCallback(() => {
    run.current += 1;
    setResolving(false);
    setPhase({ kind: 'idle' });
  }, []);

  // Nothing that answers after SETUP is gone may write to it.
  useEffect(
    () => () => {
      run.current += 1;
    },
    [],
  );

  return {
    phase,
    progress,
    resolving,
    intel,
    lastSyncAt,
    start,
    cancel,
    retry: () => void sync(),
    continueWithCached: () => {
      if (!intel) return;
      const attempt = ++run.current;
      setPhase(afterIntel(intel, false, attempt));
    },
    pickSeason: (option) => {
      if (!team.n01) return;
      void sync({ leagueId: team.n01.leagueId, leagueTitle: team.n01.leagueTitle, tournamentId: option.tournamentId, teamTpid: option.teamTpid });
    },
    pickMatch: (matchId) => void sync(undefined, matchId),
    skipLinks: () => setPhase((current) => (current.kind === 'links' ? current.then : current)),
    applyLinks: (answers) => {
      if (phase.kind !== 'links') return;
      const attempt = run.current;
      const { result, then } = phase;
      setResolving(true);
      resolveLinks(team, result, answers)
        .then(() => {
          if (attempt === run.current) setPhase(then);
        })
        .catch((error: unknown) => toast.show(`確認内容を保存できませんでした: ${describeN01Error(error)}`, 'error'))
        .finally(() => {
          if (attempt === run.current) setResolving(false);
        });
    },
    confirmChanges: () => setPhase((current) => (current.kind === 'changes' ? current.then : current)),
  };
}

/** True while SETUP must not be edited or generated: the next match is not settled yet. */
export function isNextMatchPending(phase: NextMatchPhase): boolean {
  return phase.kind !== 'ready' && phase.kind !== 'noMatch';
}

/**
 * The n01 state of the next match at the top of SETUP: progress, the questions a sync can
 * raise (season, 「同じ人ですか？」, an important change, which match), and what the data is.
 * Every action here is one the state actually needs.
 */
export function NextMatchStatus({
  team,
  sync,
  onRelink,
}: {
  team: Team;
  sync: NextMatchSync;
  onRelink: () => void;
}): React.JSX.Element | null {
  const env = useN01Environment();
  const { phase, intel, lastSyncAt } = sync;
  switch (phase.kind) {
    case 'idle':
      return null;
    case 'syncing':
      return (
        <div className="next-match-status" data-testid="setup-syncing">
          <SyncProgress steps={N01_SYNC_STEPS} state={sync.progress} title="n01から試合情報を取得中…" />
        </div>
      );
    case 'offline':
      return (
        <div className="next-match-status" role="alert" data-testid="flow-offline">
          <p className="notice danger">
            <Icon name="alert" size={18} />
            <span className="small-text">{phase.message}</span>
          </p>
          {lastSyncAt ? (
            <p className="body-text">
              前回: <strong>{formatSyncTime(lastSyncAt)}</strong> ({freshness(lastSyncAt, env.now()).label}) のデータがあります。
              このデータは最新ではありません。
            </p>
          ) : (
            <p className="body-text">この端末には前回のデータがありません。「別の試合を作る」で手動で設定できます。</p>
          )}
          <div className="flow-actions">
            {lastSyncAt && intel ? (
              <button type="button" className="btn" onClick={sync.continueWithCached}>
                前回データで続ける
              </button>
            ) : null}
            <button type="button" className="btn primary" onClick={sync.retry}>
              <Icon name="refresh" size={18} />
              再試行
            </button>
          </div>
        </div>
      );
    case 'season':
      return (
        <div className="next-match-status">
          <p className="body-text">このチームは複数の開催中シーズンに登録されています。どのシーズンの試合ですか？</p>
          <ul className="choice-list">
            {phase.options.map((option) => (
              <li key={`${option.tournamentId}:${option.teamTpid}`}>
                <button type="button" className="list-row" onClick={() => sync.pickSeason(option)}>
                  <span className="grow title">{option.title}</span>
                  <Icon name="chevronRight" size={18} className="chevron" />
                </button>
              </li>
            ))}
          </ul>
        </div>
      );
    case 'notFound':
      return (
        <div className="notice warn" role="alert">
          <Icon name="alert" size={18} />
          <span className="grow small-text">
            n01 の現在のシーズンに「{team.n01?.lastTeamName}」が見つかりません。チーム名が変わったか、まだ登録されていない可能性があります。
          </span>
          <button type="button" className="btn small" onClick={onRelink}>
            チームを選び直す
          </button>
        </div>
      );
    case 'links':
      return <PendingLinks pending={phase.result.plan.roster.pending} busy={sync.resolving} onSkip={sync.skipLinks} onApply={sync.applyLinks} />;
    case 'changes':
      return (
        <div className="next-match-status" data-testid="flow-changes">
          <p className="body-text">
            <strong>n01 で変更がありました</strong>
          </p>
          <ul className="change-list">
            {phase.lines.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
          <div className="flow-actions">
            <button type="button" className="btn primary" onClick={sync.confirmChanges}>
              確認して続ける
            </button>
          </div>
        </div>
      );
    case 'pickMatch':
      return (
        <div className="next-match-status">
          <p className="body-text">次の試合を 1 つに決められませんでした。どの試合のオーダーですか？</p>
          <ul className="choice-list">
            {phase.options.map((option) => (
              <li key={option.matchId}>
                <button type="button" className="list-row" onClick={() => sync.pickMatch(option.matchId)}>
                  <span className="grow">
                    <span className="title">vs {option.opponentName}</span>
                    <span className="meta">{option.title}</span>
                  </span>
                  <Icon name="chevronRight" size={18} className="chevron" />
                </button>
              </li>
            ))}
          </ul>
        </div>
      );
    case 'noMatch':
      return (
        <p className="notice info small-text" role="status" data-testid="flow-no-match">
          <Icon name="info" size={18} />
          <span className="grow">このシーズンの残り試合は見つかりませんでした。対戦相手と試合日を入力して作成できます。</span>
        </p>
      );
    case 'ready': {
      const age = intel ? freshness(intel.generatedAt, env.now()) : null;
      return (
        <div className="next-match-status" data-testid="flow-ready">
          {phase.fresh ? (
            <p className="n01-fresh" role="status">
              <Icon name="checkCircle" size={16} /> n01 ✓ 最新
            </p>
          ) : age ? (
            <p className={`stale-note level-${age.level}`} role="status" data-testid="flow-stale">
              <Icon name="alert" size={16} /> {age.label} ({intel ? formatSyncTime(intel.generatedAt) : ''}) のデータを使用しています。最新ではありません。
            </p>
          ) : null}
          {intel?.nextMatch ? (
            <p className="small-text secondary next-match-conf">相手データの信頼度: {CONFIDENCE_LABELS[intel.orderConfidence]}</p>
          ) : (
            <p className="small-text" data-testid="flow-no-opponent">次戦の相手データがないため、勝利優先で作成します。</p>
          )}
        </div>
      );
    }
  }
}
