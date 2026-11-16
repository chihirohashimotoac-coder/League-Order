/**
 * 読み込みゲージ: under the filters, the stages the current view needs — シーズン取得, ゲーム一覧取得,
 * Leg明細の照合 — each with a bar. A stage whose size is known shows its real count (determinate);
 * a stage whose size is not known yet shows a moving bar (still with its text, and without motion
 * when the reader asks for reduced motion). Screen readers get each stage as a progress bar with its
 * label and value text, and the whole as a polite status. After loading it says whether everything
 * was read, read in part, or failed, and when; while the same condition is read again it says that
 * the figures shown are the previous ones, read at that time.
 */

export type StageState = 'waiting' | 'running' | 'done' | 'partial' | 'failed';

export interface GaugeStage {
  id: 'season' | 'games' | 'legs';
  label: string;
  state: StageState;
  /** Known size: `done` of `total` (`unit` after the numbers). `null`: size not known yet. */
  count: { done: number; total: number; unit: string } | null;
  /** What is happening, or why it ended so. */
  text: string;
}

const STATE_TEXT: Record<StageState, string> = { waiting: '待機中', running: '取得中', done: '完了', partial: '部分集計', failed: '取得失敗' };

import { formatDateTime } from '../format';
import type { TeamDetailState } from './useRoleData';

/** hh:mm in Japan time, as the rest of the screen (「最終取得」) shows times. */
function clock(at: number): string {
  return formatDateTime(at).slice(-5);
}

function Bar({ stage }: { stage: GaugeStage }): React.JSX.Element {
  const determinate = stage.count !== null && stage.count.total > 0;
  const pct = determinate ? Math.round((Math.min(stage.count!.done, stage.count!.total) / stage.count!.total) * 100) : stage.state === 'running' || stage.state === 'waiting' ? null : 100;
  const valueText = determinate ? `${stage.count!.done}/${stage.count!.total}${stage.count!.unit}` : STATE_TEXT[stage.state];
  return (
    <div
      className={`gauge-bar ${pct === null ? 'indeterminate' : ''} ${stage.state}`}
      role="progressbar"
      aria-label={stage.label}
      aria-valuemin={pct === null ? undefined : 0}
      aria-valuemax={pct === null ? undefined : 100}
      aria-valuenow={pct === null ? undefined : pct}
      aria-valuetext={`${STATE_TEXT[stage.state]}：${valueText}`}
    >
      <span className="gauge-fill" style={pct === null ? undefined : { width: `${pct}%` }} />
    </div>
  );
}

export function LoadGauge({
  stages,
  outcome,
  previous,
}: {
  stages: GaugeStage[];
  /** After loading: the whole read's outcome and when it ended. */
  outcome: { state: 'done' | 'partial' | 'failed'; at: number | null; text?: string } | null;
  /** The same condition is being read again: the figures shown were read at this time. */
  previous: number | null;
}): React.JSX.Element | null {
  const active = stages.some((s) => s.state === 'running' || s.state === 'waiting');
  if (stages.length === 0 && !outcome) return null;
  if (!active && outcome?.state === 'done' && previous === null) {
    return (
      <p className="load-gauge-done small-text muted" data-testid="load-gauge" data-state="done" role="status">
        取得完了{outcome.at ? `（${clock(outcome.at)}）` : ''}
      </p>
    );
  }
  return (
    <section className="load-gauge" data-testid="load-gauge" data-state={active ? 'running' : (outcome?.state ?? 'done')} aria-label="読み込み状況">
      {previous !== null ? (
        <p className="small-text" data-testid="load-gauge-previous">
          再取得中です。表示中の値は前回（{clock(previous)} 取得）のものです。
        </p>
      ) : null}
      <ol className="gauge-stages">
        {stages.map((stage) => (
          <li key={stage.id} className={`gauge-stage ${stage.state}`} data-testid={`gauge-${stage.id}`} data-state={stage.state}>
            <span className="gauge-label">
              <strong>{stage.label}</strong>
              <span className="gauge-count">{stage.count && stage.count.total > 0 ? `${stage.count.done}/${stage.count.total}${stage.count.unit}` : STATE_TEXT[stage.state]}</span>
            </span>
            <Bar stage={stage} />
            {stage.text ? <span className="gauge-text small-text muted">{stage.text}</span> : null}
          </li>
        ))}
      </ol>
      <p className="sr-only" role="status" aria-live="polite" data-testid="load-gauge-live">
        {stages.map((s) => `${s.label}：${STATE_TEXT[s.state]}${s.count && s.count.total > 0 ? ` ${s.count.done}/${s.count.total}${s.count.unit}` : ''}`).join('、')}
        {!active && outcome ? `。${outcome.state === 'done' ? '取得完了' : outcome.state === 'partial' ? '一部を取得できず、部分集計です' : '取得に失敗しました'}` : ''}
      </p>
      {!active && outcome && outcome.state !== 'done' ? (
        <p className={`small-text${outcome.state === 'failed' ? ' danger-text' : ''}`} data-testid="load-gauge-outcome">
          {outcome.state === 'partial' ? '部分集計：一部を取得できませんでした（内訳は「集計の内訳」）' : '取得に失敗しました'}
          {outcome.text ? `。${outcome.text}` : ''}
          {outcome.at ? `（${clock(outcome.at)}）` : ''}
        </p>
      ) : null}
    </section>
  );
}

/** The team view's "Leg明細の照合" stage, from the team read's phase (never 完了 for a read that did not happen). */
export function teamLegStage(teamDetail: Pick<TeamDetailState, 'phase' | 'result'>): GaugeStage {
  const seasons = teamDetail.result?.seasons.filter((x) => x.games > 0) ?? [];
  const total = seasons.reduce((n, x) => n + x.games, 0);
  const done = seasons.reduce((n, x) => n + x.rebuilt, 0);
  const p = teamDetail.phase;
  const TEXT: Record<typeof p, string> = {
    idle: '',
    'waiting-games': 'ゲーム一覧の取得を待っています',
    'games-failed': 'ゲーム一覧を取得できないため、Leg明細を照合できません',
    running: 'チームのこの種別のゲームのLeg明細を取得しています',
    'no-games': 'この種別の対象試合がありません',
    failed: teamDetail.result?.failures[0] ?? 'Leg明細を取得できませんでした',
    partial: `${total - done}ゲームのLeg明細を確認できていません`,
    done: '',
  };
  return {
    id: 'legs',
    label: 'Leg明細の照合',
    state: p === 'waiting-games' ? 'waiting' : p === 'running' ? 'running' : p === 'games-failed' || p === 'failed' ? 'failed' : p === 'partial' ? 'partial' : 'done',
    count: teamDetail.result && total > 0 ? { done, total, unit: 'ゲーム' } : null,
    text: TEXT[p],
  };
}

/** The whole read's outcome after loading: a failed or partial stage is never reported as 完了. */
export function gaugeOutcomeOf(stages: readonly GaugeStage[], hasSeasons: boolean, periodPartial: boolean, at: number | null): { state: 'done' | 'partial' | 'failed'; at: number | null } {
  const failed = stages.some((x) => x.state === 'failed');
  const partial = stages.some((x) => x.state === 'partial') || periodPartial;
  return { state: failed && !hasSeasons ? 'failed' : failed || partial ? 'partial' : 'done', at };
}
