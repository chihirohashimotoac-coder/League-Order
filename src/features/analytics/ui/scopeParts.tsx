import { Icon } from '../../../components/icons';
import type { Composition } from '../gameKind';
import { contributingSeasons, METRIC_GROUP_LABEL } from '../projection';
import type { MetricGroup, Projection, SeasonAdoption } from '../projection';
import { SCOPE_LABEL } from '../roleGames';
import type { GameScope } from '../roleGames';
import type { PlayerDetailResult } from '../service/detailService';
import type { SeasonCheckState } from '../reconstruct';
import type { PeriodLoad } from '../service/periodService';
import { periodLabelAllowed } from '../service/periodService';
import type { GamesState } from './useRoleData';
import { PERIOD_LABEL, Segmented } from './parts';

/** Game-kind switch, the compact analysis summary and the leg-reconstruction panel. */

export type MainScope = 'all01' | 'singles' | 'doubles' | 'others';
export type OthersPart = 'others' | 'trios' | 'gallon' | 'team';

const MAIN_LABEL: Record<MainScope, string> = { all01: '01全体', singles: 'シングルス', doubles: 'ダブルス', others: 'その他' };
const PART_LABEL: Record<OthersPart, string> = { others: 'すべて', trios: 'トリオス', gallon: 'ガロン', team: 'チーム戦' };

export function effectiveScope(main: MainScope, part: OthersPart): GameScope {
  return main === 'others' ? part : main;
}

export function ScopeBar({ main, part, onMain, onPart }: { main: MainScope; part: OthersPart; onMain: (m: MainScope) => void; onPart: (p: OthersPart) => void }): React.JSX.Element {
  return (
    <div className="analytics-scope" data-testid="scope-bar">
      <Segmented label="対象ゲーム種別" value={main} onChange={onMain} options={(Object.keys(MAIN_LABEL) as MainScope[]).map((value) => ({ value, label: MAIN_LABEL[value] }))} />
      {main === 'others' ? (
        <div className="chip-row" role="group" aria-label="その他の01の内訳">
          {(Object.keys(PART_LABEL) as OthersPart[]).map((value) => (
            <button key={value} type="button" className={part === value ? 'chip on' : 'chip'} aria-pressed={part === value} onClick={() => onPart(value)}>
              {PART_LABEL[value]}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

const COMPOSITION_LABEL: Record<Composition, string> = { pure01: '01のみ', mixed: 'Cricketを含む', unknown: '種別不明の枠あり' };
const GROUPS: MetricGroup[] = ['ppr', 'first9', 'legSet', 'keepBreak', 'records', 'match'];

interface GroupSummary {
  group: MetricGroup;
  used: number;
  excluded: number;
  unavailable: boolean;
  reasons: string[];
}

function summarizeGroups(adoption: readonly SeasonAdoption[]): GroupSummary[] {
  return GROUPS.map((group) => {
    const states = adoption.map((a) => a.metrics[group]);
    const reasons = [...new Set(states.map((s) => s.reason).filter((r): r is string => !!r))];
    return {
      group,
      used: states.filter((s) => s.state === 'official' || s.state === 'recomputed').length,
      excluded: states.filter((s) => s.state === 'excluded').length,
      unavailable: states.length > 0 && states.every((s) => s.state === 'unavailable'),
      reasons,
    };
  });
}

function slotStateLabel(state: 'loaded' | 'failed' | 'not-fetched'): string {
  return state === 'loaded' ? '集計' : state === 'failed' ? '取得失敗' : '未取得';
}

/**
 * The first thing under the filters: period, game kind, seasons used / not obtained, and
 * whether any metric is withheld — one line. Everything else is folded into "集計の内訳" so
 * the figures are never pushed off a phone screen by warnings.
 */
export function AnalysisSummary({ load, projection, scope, games }: { load: PeriodLoad; projection: Projection; scope: GameScope; games: GamesState }): React.JSX.Element {
  const multi = load.request.mode === 'last3' || load.request.mode === 'last12';
  const used = contributingSeasons(projection.adoption);
  const notObtained = load.window.filter((w) => w.state !== 'loaded').length + (multi ? Math.max(0, load.wanted - load.window.length) : 0);
  const gamesMissing = projection.adoption.filter((a) => a.gamesState === 'missing' || a.gamesState === 'partial').length;
  const groups = summarizeGroups(projection.adoption);
  const flagged = groups.some((g) => g.excluded > 0 || g.unavailable) || projection.adoption.some((a) => a.playerPpr === 'unavailable' || a.playerPpr === 'partly-verified');
  const partial = periodLabelAllowed(load) !== 'full' || gamesMissing > 0;
  const missingStandings = load.meta.filter((m) => m.missing.includes('standings')).length;
  const missingRoster = load.meta.filter((m) => m.missing.includes('roster')).length;
  return (
    <section className={`analysis-summary${partial ? ' warn' : ''}`} data-testid="analysis-summary" aria-live="polite">
      <p className="summary-line">
        <Icon name={partial ? 'alert' : 'target'} size={16} />
        <span>
          <strong>{PERIOD_LABEL[load.request.mode]}</strong> ・ {SCOPE_LABEL[scope]} ・ 集計 <strong data-testid="summary-used">{used}</strong>季{multi ? ` / ${load.wanted}季` : ''}
          {notObtained > 0 ? <span className="badge warn" data-testid="summary-missing">未取得 {notObtained}季</span> : null}
          {gamesMissing > 0 ? <span className="badge warn">ゲーム記録が不完全・未取得 {gamesMissing}季</span> : null}
          {flagged ? <span className="badge" data-testid="summary-flag">対象外・未検証の指標あり</span> : null}
          {games.status === 'loading' ? <span className="badge">ゲーム記録を取得中…</span> : null}
        </span>
      </p>
      <details className="analytics-details" data-testid="analysis-details">
        <summary>集計の内訳（シーズン・指標ごとの採用状況）</summary>
        {partial ? <p className="small-text">取得できた範囲のみの集計（部分集計）です。{multi ? `${load.wanted}季すべてを確認できていません。` : ''}</p> : null}
        <div className="analytics-table-wrap">
          <table className="analytics-table compact" data-testid="season-adoption">
            <caption>対象シーズン（新しい順）</caption>
            <thead>
              <tr>
                <th scope="col">シーズン</th>
                <th scope="col">取得</th>
                <th scope="col">ゲーム構成</th>
                <th scope="col" className="num">集計ゲーム</th>
              </tr>
            </thead>
            <tbody>
              {load.window.map((slot) => {
                const a = projection.adoption.find((x) => x.tournamentId === slot.tournamentId);
                return (
                  <tr key={slot.tournamentId}>
                    <th scope="row">{slot.title}</th>
                    <td>
                      {slotStateLabel(slot.state)}
                      {slot.reason ? <span className="sub">{slot.reason}</span> : null}
                    </td>
                    <td>
                      {a ? COMPOSITION_LABEL[a.composition] : '—'}
                      {a && a.gamesState === 'missing' ? <span className="sub">ゲーム記録を取得できません</span> : null}
                      {a && a.gamesState === 'partial' ? (
                        <span className="sub" data-testid="games-partial-reason">
                          {a.unreadableGames > 0 ? `読めない試合記録 ${a.unreadableGames}件のため部分集計（この季は不使用）` : 'ゲーム一覧が途中まで（この季は不使用）'}
                        </span>
                      ) : null}
                    </td>
                    <td className="num">{a && a.gamesState !== 'not-needed' ? a.gamesCounted : '—'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <h3 className="mini-title">指標ごとの採用</h3>
        <ul className="plain-list small-text" data-testid="metric-adoption">
          {groups.map((g) => (
            <li key={g.group}>
              <strong>{METRIC_GROUP_LABEL[g.group]}</strong>：{g.unavailable ? 'この表示では対象外' : g.excluded === 0 ? `採用（${g.used}季）` : g.used > 0 ? `部分採用（${g.used}季採用・${g.excluded}季対象外）` : `対象外（${g.excluded}季）`}
              {g.reasons.length > 0 ? <span className="meta">{g.reasons.join(' / ')}</span> : null}
            </li>
          ))}
          {scope !== 'all01' && scope !== 'singles' ? (
            <li>
              <strong>選手個人の3DA</strong>：チーム合計を選手に配分することはしません。Leg明細から復元し、n01公式の通算値と一致した選手・季のみ表示します。
            </li>
          ) : null}
        </ul>
        {missingStandings > 0 || missingRoster > 0 || load.failures.length > 0 || games.load?.failures.length ? (
          <ul className="plain-list small-text">
            {missingStandings > 0 ? <li>{missingStandings}季で公式順位を取得できませんでした。</li> : null}
            {missingRoster > 0 ? <li>{missingRoster}季で名簿を取得できず、その季の選手は他の季と結び付けていません。</li> : null}
            {load.failures.map((f) => (
              <li key={f.tournamentId}>
                {f.title || f.tournamentId}: {f.reason}
              </li>
            ))}
            {games.load?.failures.map((f) => (
              <li key={`g-${f.tournamentId}`}>
                {load.seasons.find((s) => s.tournamentId === f.tournamentId)?.title ?? f.tournamentId}（ゲーム記録）: {f.reason}
              </li>
            ))}
          </ul>
        ) : null}
        <p className="small-text muted">
          通信: シーズン {load.requestsSent} 回{games.load ? ` ・ ゲーム記録 ${games.load.requestsSent} 回` : ''}
          {games.load?.usedStaleCache ? ' ・ 一部は保存済み（期限切れ）のゲーム記録' : ''}
        </p>
      </details>
    </section>
  );
}

const CHECK_LABEL: Record<SeasonCheckState, string> = {
  verified: '検証済み（全項目が公式値と一致）',
  'partly-verified': '3DAは公式値と一致（一部の項目は未検証）',
  mismatch: '公式値と一致せず（表示しません）',
  incomplete: '未完了',
  'no-games': '01のゲームなし',
};

/**
 * Per-player figures of multi-thrower games: on request only, with what was compared and
 * whether it matched n01's totals. Nothing is shown for a season that did not match.
 */
export function ReconstructionPanel({
  personName,
  result,
  running,
  disabled,
  onRun,
  titleOf,
}: {
  personName: string;
  result: PlayerDetailResult | undefined;
  running: boolean;
  disabled: boolean;
  onRun: () => void;
  titleOf: (tournamentId: string) => string;
}): React.JSX.Element {
  return (
    <div className="reconstruction" data-testid="reconstruction">
      <p className="small-text">
        n01の記録はペア・チーム単位の得点です。{personName}さん個人の成績は、Leg明細を取得して投順から復元し、n01公式の通算値と一致した季だけ表示します（推測で補いません）。
      </p>
      <button type="button" className="btn small" onClick={onRun} disabled={disabled || running} data-testid="reconstruct-run">
        <Icon name="refresh" size={16} />
        {running ? 'Leg明細を取得中…' : result ? '再度復元する' : 'Leg明細から個人成績を復元'}
      </button>
      {result ? (
        <ul className="plain-list small-text" data-testid="reconstruction-result">
          {result.checks.map((check) => (
            <li key={check.tournamentId}>
              <strong>{titleOf(check.tournamentId)}</strong>：{CHECK_LABEL[check.state]}
              {check.compared ? (
                <span className="meta">
                  復元 {check.compared.score[0]}点/{check.compared.darts[0]}投 ・ 公式 {check.compared.score[1] ?? '—'}点/{check.compared.darts[1] ?? '—'}投（{check.reconstructed}/{check.games}ゲーム）
                </span>
              ) : null}
              {check.reason ? <span className="meta">{check.reason}</span> : null}
            </li>
          ))}
          {result.notAttempted.length > 0 ? <li>通信の上限のため未取得: {result.notAttempted.map((s) => s.title).join('、')}</li> : null}
          {result.failures.slice(0, 3).map((f) => (
            <li key={f}>{f}</li>
          ))}
          {result.bestLegHeld.all || result.bestLegHeld.starts.length > 0 ? (
            <li data-testid="best-leg-held">
              Best Leg{result.bestLegHeld.all ? '' : `（${result.bestLegHeld.starts.join('・')}）`}：一部のシングルスのLeg明細を確認できていないため保留
              <span className="meta">{result.bestLegHeld.reasons.slice(0, 2).join(' / ')}</span>
            </li>
          ) : null}
          {result.bestLegs.size > 0 ? (
            <li>
              Best Leg（シングルス・開始点数別）: {[...result.bestLegs].sort((a, b) => a[0] - b[0]).map(([start, darts]) => `${start}: ${darts}本`).join(' ・ ')}
            </li>
          ) : null}
        </ul>
      ) : null}
    </div>
  );
}
