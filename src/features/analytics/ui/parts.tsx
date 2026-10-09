import { useId } from 'react';
import { Icon } from '../../../components/icons';
import { formatDateTime, formatValue, METRIC_LABEL } from '../format';
import type { RankMetric } from '../format';
import type { PeriodMode } from '../seasons';
import { describeLoad, periodLabelAllowed } from '../service/periodService';
import type { PeriodLoad } from '../service/periodService';
import type { RankingResult } from '../ranking';
import type { TrendPoint } from '../playerView';
import type { SeasonOption } from './usePeriodLoad';

/** Presentation pieces shared by the player and team analytics screens. */

export const PERIOD_LABEL: Record<PeriodMode, string> = {
  current: '今季',
  specified: '指定季',
  last3: '直近3季',
  all: '全期間',
};

const SOURCE_LABEL = { network: '最新取得', cache: '保存済み', 'stale-cache': '保存済み（期限切れ）' } as const;

export function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (value: T) => void;
}): React.JSX.Element {
  return (
    <div className="segmented" role="group" aria-label={label}>
      {options.map((option) => (
        <button key={option.value} type="button" aria-pressed={value === option.value} onClick={() => onChange(option.value)}>
          {option.label}
        </button>
      ))}
    </div>
  );
}

export function PeriodBar({
  mode,
  onMode,
  specifiedId,
  onSpecified,
  options,
  onReload,
  loading,
  load,
  currentTournamentId,
}: {
  mode: PeriodMode;
  onMode: (mode: PeriodMode) => void;
  specifiedId: string;
  onSpecified: (id: string) => void;
  options: SeasonOption[];
  onReload: () => void;
  loading: boolean;
  load: PeriodLoad | null;
  currentTournamentId: string;
}): React.JSX.Element {
  const selectId = useId();
  return (
    <div className="analytics-filters">
      <Segmented
        label="集計期間"
        value={mode}
        onChange={onMode}
        options={(Object.keys(PERIOD_LABEL) as PeriodMode[]).map((value) => ({ value, label: PERIOD_LABEL[value] }))}
      />
      {mode === 'specified' ? (
        <div className="field">
          <label htmlFor={selectId}>
            <span>シーズン</span>
          </label>
          <select id={selectId} value={specifiedId} onChange={(event) => onSpecified(event.target.value)}>
            {options.length === 0 ? <option value={currentTournamentId}>現在のシーズン</option> : null}
            {options.map((option) => (
              <option key={option.id} value={option.id}>
                {option.title}
              </option>
            ))}
          </select>
        </div>
      ) : null}
      <div className="analytics-status">
        <span className="small-text muted" data-testid="analytics-updated">
          {loading ? '取得中…' : load?.fetchedAt ? `最終取得 ${formatDateTime(load.fetchedAt.oldest)}` : '取得日時なし'}
          {!loading && load && load.seasons.length > 0 ? ` ・ ${load.seasons.length}シーズン` : ''}
        </span>
        <button type="button" className="btn small" onClick={onReload} disabled={loading}>
          <Icon name="refresh" size={16} />
          再取得
        </button>
      </div>
    </div>
  );
}

/** Loading / empty / offline / partial / error: always says which, and what is missing. */
export function LoadBanner({ load, loading }: { load: PeriodLoad | null; loading: boolean }): React.JSX.Element | null {
  if (loading && !load) {
    return (
      <div className="notice info" role="status" data-testid="analytics-loading">
        <Icon name="refresh" size={18} />
        <span className="small-text">分析データを取得しています…</span>
      </div>
    );
  }
  if (!load) return null;
  const state = describeLoad(load);
  const notes: string[] = [];
  const missingStandings = load.meta.filter((m) => m.missing.includes('standings')).length;
  const missingRoster = load.meta.filter((m) => m.missing.includes('roster')).length;
  if (missingStandings > 0) notes.push(`${missingStandings}シーズンで公式順位を取得できませんでした。`);
  if (missingRoster > 0) notes.push(`${missingRoster}シーズンで名簿を取得できず、その季の選手は他の季と結び付けていません。`);
  if (load.request.mode === 'all' && periodLabelAllowed(load) !== 'full' && load.seasons.length > 0) {
    notes.push('取得できた範囲のみの集計です（全期間の完全な集計ではありません）。');
  }
  for (const failure of load.failures.slice(0, 3)) notes.push(`${failure.title || failure.tournamentId}: ${failure.reason}`);
  for (const excluded of load.formatExcluded) notes.push(`${excluded.title}: ${excluded.reason}`);
  if (state.kind === 'ready' && notes.length === 0) return null;
  const tone = state.kind === 'error' ? 'danger' : state.kind === 'empty' ? 'info' : 'warn';
  return (
    <div className={`notice ${tone}`} role="status" data-testid={`analytics-banner-${state.kind}`}>
      <Icon name="alert" size={18} />
      <span className="small-text">
        {state.message ? <span>{state.message} </span> : null}
        {notes.map((note) => (
          <span key={note} className="block">
            {note}
          </span>
        ))}
      </span>
    </div>
  );
}

export function SourceNote({ load }: { load: PeriodLoad }): React.JSX.Element | null {
  if (load.meta.length === 0) return null;
  return (
    <details className="analytics-details">
      <summary>データの取得元と信頼度</summary>
      <ul className="plain-list small-text">
        {load.meta.map((m) => (
          <li key={m.tournamentId}>
            {m.title} ・ {SOURCE_LABEL[m.source]} ・ {formatDateTime(m.fetchedAt)}
            {m.missing.length > 0 ? ` ・ 未取得: ${m.missing.map((x) => (x === 'standings' ? '公式順位' : '名簿')).join('・')}` : ''}
          </li>
        ))}
      </ul>
      <p className="small-text muted">
        サンプル数の基準（3DA・First 9: 90投 / Leg: 20 / Set: 10）は暫定的な目安で、統計的な信頼性を保証するものではありません。基準未満は「参考」として順位に含めません。
      </p>
    </details>
  );
}

/** A metric card: value, what it was computed from, and how it compares. */
export function MetricCard({
  label,
  value,
  sample,
  reliability,
  compare,
  rank,
}: {
  label: string;
  value: string;
  sample: string;
  reliability: 'none' | 'reference' | 'sufficient';
  compare?: string;
  rank?: string;
}): React.JSX.Element {
  const badge = reliability === 'sufficient' ? '基準充足' : reliability === 'reference' ? '参考' : 'データなし';
  return (
    <div className="metric-card" data-testid={`metric-${label}`}>
      <span className="k">{label}</span>
      <span className="v">{value}</span>
      <span className="s">{sample || '—'}</span>
      {compare ? <span className="c">{compare}</span> : null}
      {rank ? <span className="r">{rank}</span> : null}
      <span className={`badge ${reliability === 'sufficient' ? 'ok' : reliability === 'reference' ? 'warn' : ''}`}>{badge}</span>
    </div>
  );
}

export function RankingTable({
  ranking,
  metric,
  highlight,
  teamNameOf,
  caption,
}: {
  ranking: RankingResult;
  metric: RankMetric;
  highlight?: string;
  teamNameOf?: (id: string) => string;
  caption: string;
}): React.JSX.Element {
  const row = (entry: RankingResult['ranked'][number], reference: boolean): React.JSX.Element => (
    <tr key={entry.id} className={entry.id === highlight ? 'me' : ''} aria-current={entry.id === highlight ? 'true' : undefined}>
      <td className="rank">{reference ? '参考' : entry.rank}</td>
      <th scope="row">
        {entry.label}
        {teamNameOf ? <span className="sub">{teamNameOf(entry.id)}</span> : null}
      </th>
      <td className="num">{formatValue(metric, entry.value)}</td>
      <td className="num sample">{metric === 'bestLeg' ? '' : entry.sample.toLocaleString('ja-JP')}</td>
    </tr>
  );
  return (
    <div className="analytics-table-wrap">
      <table className="analytics-table">
        <caption>{caption}</caption>
        <thead>
          <tr>
            <th scope="col">順位</th>
            <th scope="col">選手</th>
            <th scope="col" className="num">
              {METRIC_LABEL[metric]}
            </th>
            <th scope="col" className="num">
              {metric === 'bestLeg' ? '' : 'サンプル'}
            </th>
          </tr>
        </thead>
        <tbody>
          {ranking.ranked.map((entry) => row(entry, false))}
          {ranking.ranked.length === 0 ? (
            <tr>
              <td colSpan={4} className="muted">
                基準を満たす選手がいません。
              </td>
            </tr>
          ) : null}
        </tbody>
        {ranking.reference.length > 0 ? (
          <tbody className="reference">
            <tr>
              <th scope="colgroup" colSpan={4}>
                参考値（サンプル数が基準未満・順位なし）
              </th>
            </tr>
            {ranking.reference.map((entry) => row(entry, true))}
          </tbody>
        ) : null}
      </table>
      <p className="small-text muted">
        順位は{ranking.population}名中。{ranking.excluded > 0 ? `${ranking.excluded}名はサンプル不足またはデータなしのため順位から除外。` : ''}
        n01の公式順位とは別の、League Order独自の並びです。
      </p>
    </div>
  );
}

/** Line chart of one metric across seasons, with a text table for screen readers. */
export function TrendChart({ points, metric }: { points: TrendPoint[]; metric: RankMetric }): React.JSX.Element {
  const width = 320;
  const height = 150;
  const pad = { l: 40, r: 12, t: 14, b: 30 };
  const valued = points.filter((p) => p.value !== null);
  if (points.length < 2 || valued.length === 0) {
    return <p className="small-text muted">推移を表示するには2シーズン以上のデータが必要です。</p>;
  }
  const values = valued.map((p) => p.value as number);
  let min = Math.min(...values);
  let max = Math.max(...values);
  if (min === max) {
    min -= 1;
    max += 1;
  }
  const span = max - min;
  min -= span * 0.1;
  max += span * 0.1;
  const x = (i: number): number => pad.l + (points.length === 1 ? 0 : (i * (width - pad.l - pad.r)) / (points.length - 1));
  const y = (v: number): number => pad.t + ((max - v) * (height - pad.t - pad.b)) / (max - min);
  // A gap (no usable denominator) breaks the line rather than drawing through a 0.
  const segments: { i: number; v: number }[][] = [];
  let current: { i: number; v: number }[] = [];
  points.forEach((p, i) => {
    if (p.value === null) {
      if (current.length > 0) segments.push(current);
      current = [];
    } else current.push({ i, v: p.value });
  });
  if (current.length > 0) segments.push(current);
  const summary = points.map((p) => `${p.title} ${formatValue(metric, p.value)}`).join('、');
  return (
    <figure className="trend">
      <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`${METRIC_LABEL[metric]}のシーズン推移: ${summary}`} className="trend-svg">
        {[min + (max - min) * 0.1, (min + max) / 2, max - (max - min) * 0.1].map((v) => (
          <g key={v}>
            <line x1={pad.l} x2={width - pad.r} y1={y(v)} y2={y(v)} className="grid" />
            <text x={pad.l - 4} y={y(v) + 3} textAnchor="end" className="axis">
              {formatValue(metric, v)}
            </text>
          </g>
        ))}
        {segments.map((segment) => (
          <polyline key={segment[0].i} points={segment.map((s) => `${x(s.i)},${y(s.v)}`).join(' ')} className="series" />
        ))}
        {points.map((p, i) =>
          p.value === null ? null : (
            <circle key={p.tournamentId} cx={x(i)} cy={y(p.value)} r={3.5} className="dot" />
          ),
        )}
        {points.map((p, i) => (
          <text key={`l${p.tournamentId}`} x={x(i)} y={height - 10} textAnchor="middle" className="axis">
            {p.title.length > 7 ? `${p.title.slice(0, 6)}…` : p.title}
          </text>
        ))}
      </svg>
      <details className="analytics-details">
        <summary>推移の数値</summary>
        <table className="analytics-table compact">
          <caption>{METRIC_LABEL[metric]}のシーズン別の値</caption>
          <thead>
            <tr>
              <th scope="col">シーズン</th>
              <th scope="col">値</th>
              <th scope="col">サンプル</th>
            </tr>
          </thead>
          <tbody>
            {points.map((p) => (
              <tr key={p.tournamentId}>
                <th scope="row">{p.title}</th>
                <td className="num">{formatValue(metric, p.value)}</td>
                <td className="num sample">{metric === 'bestLeg' ? '' : p.sample}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </figure>
  );
}
