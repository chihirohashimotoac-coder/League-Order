import { useCallback, useEffect, useRef, useState } from 'react';
import type { Team } from '../../domain/types';
import { describeChanges, hasAnyChanges, type N01ChangeSummary } from '../../domain/n01/changes';
import { formatSyncTime } from '../../domain/n01/freshness';
import { describeN01Error } from '../../integrations/n01/client';
import type { N01MatchIntelligenceSnapshot } from '../../domain/n01/intelligence';
import type { N01SyncStep, N01TeamSelection } from '../../integrations/n01/sync';
import { useAppStore } from '../../state/appStore';
import { useN01FreshSync } from '../../state/useN01FreshSync';
import { Sheet, useToast } from '../ui';
import { Icon } from '../icons';
import { SyncProgress, type SyncProgressState } from './SyncProgress';

/**
 * "n01を再同期" (MASTER SPEC Phase 1 §3–§11, Phase 5 §4–§6).
 *
 * Re-resolves the season and the team, then re-reads roster, PPR, division, discipline
 * and format, applies them in one batch and lists what changed. When the network fails
 * the captain is told when the data they have was last synced — it is never presented
 * as current.
 */
const STEPS: readonly N01SyncStep[] = ['season', 'team', 'roster', 'ppr', 'format', 'opponent', 'analysis'];

type Phase =
  | { kind: 'running' }
  | { kind: 'season'; options: { tournamentId: string; title: string; teamTpid: string }[] }
  | { kind: 'notFound' }
  | { kind: 'error'; message: string }
  | { kind: 'done'; changes: N01ChangeSummary; nextMatch: N01MatchIntelligenceSnapshot | null };

export function N01SyncSheet({
  team,
  onClose,
  onRelink,
}: {
  team: Team;
  onClose: () => void;
  /** Opens the team picker again (the team was renamed or did not enter this season). */
  onRelink: () => void;
}): React.JSX.Element {
  const freshSync = useN01FreshSync();
  const store = useAppStore();
  const toast = useToast();
  const [phase, setPhase] = useState<Phase>({ kind: 'running' });
  const [progress, setProgress] = useState<SyncProgressState>({});
  const run = useRef(0);
  const binding = team.n01!;

  const execute = useCallback(
    async (chosen?: N01TeamSelection) => {
      const attempt = ++run.current;
      const report = (step: N01SyncStep, status: SyncProgressState[N01SyncStep]): void => {
        if (attempt === run.current && status) setProgress((current) => ({ ...current, [step]: status }));
      };
      setPhase({ kind: 'running' });
      setProgress({});
      try {
        const result = await freshSync(team, { onProgress: report, selection: chosen, isCurrent: () => attempt === run.current });
        if (!result || attempt !== run.current) return;
        if (result.kind === 'seasonAmbiguous') {
          setPhase({ kind: 'season', options: result.options });
          return;
        }
        if (result.kind === 'teamNotFound') {
          setPhase({ kind: 'notFound' });
          return;
        }
        setPhase({ kind: 'done', changes: result.plan.changes, nextMatch: result.intel });
        toast.show('n01 と同期しました', 'ok');
      } catch (error) {
        if (attempt === run.current) setPhase({ kind: 'error', message: describeN01Error(error) });
      }
    },
    [freshSync, team, toast],
  );

  // Runs once per opened sheet; a retry calls `execute` explicitly.
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void execute();
  }, [execute]);
  useEffect(
    () => () => {
      run.current += 1;
    },
    [],
  );

  const cached = store.n01CacheFor(team.id).find((record) => record.kind === 'sync');

  return (
    <Sheet
      title="n01を再同期"
      onClose={onClose}
      footer={
        phase.kind === 'error' ? (
          <>
            <button type="button" className="btn" onClick={onClose}>
              閉じる
            </button>
            <button type="button" className="btn primary grow" onClick={() => void execute()}>
              <Icon name="refresh" size={18} />
              再試行
            </button>
          </>
        ) : (
          <button type="button" className="btn primary grow" onClick={onClose} disabled={phase.kind === 'running'}>
            閉じる
          </button>
        )
      }
    >
      <p className="small-text secondary" style={{ marginTop: 0 }}>
        {binding.leagueTitle} ・ {binding.lastTeamName}
      </p>
      {phase.kind === 'running' ? <SyncProgress steps={STEPS} state={progress} /> : null}

      {phase.kind === 'season' ? (
        <section aria-labelledby="sync-season-title">
          <h3 id="sync-season-title" className="wizard-title">
            シーズンを選択
          </h3>
          <p className="tiny muted">このチームは複数の開催中シーズンに登録されています。</p>
          <ul className="choice-list">
            {phase.options.map((option) => (
              <li key={`${option.tournamentId}:${option.teamTpid}`}>
                <button
                  type="button"
                  className="list-row"
                  onClick={() =>
                    void execute({
                      leagueId: binding.leagueId,
                      leagueTitle: binding.leagueTitle,
                      tournamentId: option.tournamentId,
                      teamTpid: option.teamTpid,
                    })
                  }
                >
                  <span className="grow">
                    <span className="title">{option.title}</span>
                  </span>
                  <Icon name="chevronRight" size={18} className="chevron" />
                </button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {phase.kind === 'notFound' ? (
        <div className="notice warn" role="alert">
          <Icon name="alert" size={18} />
          <span className="grow small-text">
            n01 の現在のシーズンに「{binding.lastTeamName}」が見つかりません。チーム名が変わったか、まだ登録されていない可能性があります。自動では別のチームに対応付けません。
          </span>
          <button type="button" className="btn small" onClick={onRelink}>
            チームを選び直す
          </button>
        </div>
      ) : null}

      {phase.kind === 'error' ? (
        <div className="notice danger" role="alert">
          <Icon name="alert" size={18} />
          <span className="grow small-text">
            {phase.message}
            {cached ? ` 前回の同期: ${formatSyncTime(cached.fetchedAt)} (このデータは最新ではありません)` : ''}
          </span>
        </div>
      ) : null}

      {phase.kind === 'done' ? (
        <div className="n01-done" data-testid="n01-sync-done">
          <p className="state-line">
            <Icon name="checkCircle" size={18} /> n01 ✓ 最新
          </p>
          {phase.nextMatch ? <NextMatchLine snapshot={phase.nextMatch} /> : null}
          {hasAnyChanges(phase.changes) ? (
            <ul className="change-list">
              {describeChanges(phase.changes).map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          ) : (
            <p className="small-text">変更はありません。</p>
          )}
        </div>
      ) : null}
    </Sheet>
  );
}

function NextMatchLine({ snapshot }: { snapshot: N01MatchIntelligenceSnapshot }): React.JSX.Element {
  if (snapshot.nextMatchStatus === 'resolved' && snapshot.nextMatch) {
    const match = snapshot.nextMatch;
    return (
      <p className="small-text" data-testid="sync-next-match">
        次戦: vs {match.opponentName}
        {match.date ? ` (${Number(match.date.slice(5, 7))}/${Number(match.date.slice(8, 10))})` : ''}
      </p>
    );
  }
  return (
    <p className="small-text muted" data-testid="sync-next-match">
      {snapshot.nextMatchStatus === 'ambiguous'
        ? `次戦を 1 試合に決められません (候補 ${snapshot.nextMatchOptions.length} 試合)。`
        : '残りの試合はありません。'}
    </p>
  );
}
