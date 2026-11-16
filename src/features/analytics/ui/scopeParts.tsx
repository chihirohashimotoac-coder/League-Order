import { Icon } from '../../../components/icons';
import { pairOf } from '../metrics';
import { fullName } from '../personLink';
import type { LinkBasis, PeriodLinks } from '../personLink';
import type { IdentityControls } from './useIdentityDecisions';
import type { MetricId, StatLine } from '../types';
import type { Composition } from '../gameKind';
import { contributingSeasons, METRIC_GROUP_LABEL } from '../projection';
import type { MetricGroup, Projection, SeasonAdoption } from '../projection';
import { SCOPE_LABEL } from '../roleGames';
import type { GameScope } from '../roleGames';
import { DETAIL_MAX_REQUESTS } from '../service/detailService';
import { GAMES_UNIT_REQUESTS } from '../service/gamesLoader';
import type { PlayerDetailResult } from '../service/detailService';
import { formatStart, START_GAME_EXCLUSION_LABEL, START_LEG_EXCLUSION_LABEL } from '../startRate';
import type { PeriodStart } from '../startRate';
import type { SeasonCheckState } from '../reconstruct';
import type { PeriodLoad } from '../service/periodService';
import { periodLabelAllowed } from '../service/periodService';
import type { GamesState } from './useRoleData';
import { hasRetry, STATUS_BADGE } from './detailStatus';
import type { DetailRole, DetailStatus } from './detailStatus';
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
  /** Seasons where only the players with a verified leg read have it. */
  players: number;
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
      players: states.filter((s) => s.state === 'players').length,
      excluded: states.filter((s) => s.state === 'excluded').length,
      unavailable: states.length > 0 && states.every((s) => s.state === 'unavailable'),
      reasons,
    };
  });
}

function recollatedText(r: { rows: number; corrected: number; removed: number; added: number }): string {
  const changes = r.corrected + r.removed + r.added;
  return changes === 0
    ? `途中まで取得していた${r.rows}件を照合し、変化なし`
    : `途中まで取得していた${r.rows}件を照合し、訂正${r.corrected}件・削除${r.removed}件・追加${r.added}件を最新の一覧で取り込み`;
}

function groupText(g: GroupSummary): string {
  if (g.players > 0) return `Leg明細を照合できた選手のみ採用（${g.players}季）${g.excluded > 0 ? `・${g.excluded}季対象外` : ''}`;
  if (g.unavailable) return 'この表示では対象外（ゲーム記録に含まれません）';
  if (g.excluded === 0) return `採用（${g.used}季）`;
  return g.used > 0 ? `部分採用（${g.used}季採用・${g.excluded}季対象外）` : `対象外（${g.excluded}季）`;
}

function slotStateLabel(state: 'loaded' | 'failed' | 'not-fetched'): string {
  return state === 'loaded' ? '集計' : state === 'failed' ? '取得失敗' : '未取得';
}

/**
 * The first thing under the filters: period, game kind, seasons used / not obtained, and
 * whether any metric is withheld — one line. Everything else is folded into "集計の内訳" so
 * the figures are never pushed off a phone screen by warnings.
 */
export function AnalysisSummary({
  load,
  projection,
  scope,
  games,
  focus = null,
}: {
  load: PeriodLoad;
  projection: Projection;
  scope: GameScope;
  games: GamesState;
  /** The shown player's leg read (player view of シングルス / ダブルス). */
  focus?: { name: string; status: DetailStatus } | null;
}): React.JSX.Element {
  const multi = load.request.mode === 'last3' || load.request.mode === 'last12';
  const used = contributingSeasons(projection.adoption);
  // Seasons the period has: a league with fewer seasons than the period's limit is not missing any.
  const available = load.available ?? load.wanted;
  const obtained = load.window.filter((w) => w.state === 'loaded').length;
  const notObtained = load.window.filter((w) => w.state !== 'loaded').length + (multi ? Math.max(0, available - load.window.length) : 0);
  const gamesMissing = projection.adoption.filter((a) => a.gamesState === 'missing' || a.gamesState === 'partial').length;
  const gamesLoading = projection.adoption.filter((a) => a.gamesState === 'loading').length;
  const gamesNeeded = projection.adoption.filter((a) => a.gamesState !== 'not-needed').length;
  const groups = summarizeGroups(projection.adoption);
  const flagged = groups.some((g) => g.excluded > 0 || g.unavailable) || projection.adoption.some((a) => a.playerPpr === 'unavailable' || a.playerPpr === 'partly-verified');
  const partial = periodLabelAllowed(load) !== 'full' || gamesMissing > 0 || gamesLoading > 0;
  const retryable = (games.load?.failures ?? []).length > 0 && games.status !== 'loading';
  const missingStandings = load.meta.filter((m) => m.missing.includes('standings')).length;
  const missingRoster = load.meta.filter((m) => m.missing.includes('roster')).length;
  return (
    <section className={`analysis-summary${partial ? ' warn' : ''}`} data-testid="analysis-summary" aria-live="polite">
      <p className="summary-line">
        <Icon name={partial ? 'alert' : 'target'} size={16} />
        <span>
          <strong>{PERIOD_LABEL[load.request.mode]}</strong> ・ {SCOPE_LABEL[scope]} ・{' '}
          <span data-testid="summary-range">
            対象{available}季・
            {gamesNeeded > 0 ? (
              <>
                {scope === 'all01' ? '' : 'ゲーム記録'}
                <strong data-testid="summary-used">{used}</strong>季分で集計
              </>
            ) : (
              <>
                <strong data-testid="summary-used">{obtained}</strong>季取得済み
              </>
            )}
          </span>
          {notObtained > 0 ? <span className="badge warn" data-testid="summary-missing">未取得 {notObtained}季</span> : null}
          {gamesMissing > 0 ? <span className="badge warn">ゲーム記録が不完全・未取得 {gamesMissing}季</span> : null}
          {flagged ? <span className="badge" data-testid="summary-flag">対象外・未検証の指標あり</span> : null}
          {games.load?.stale && games.load.stale.size > 0 ? (
            <span className="badge warn" data-testid="summary-stale">
              保存済みのゲーム記録（最新とは限らない）{games.load.stale.size}季
            </span>
          ) : null}
          {games.status === 'loading' ? (
            <span className="badge" data-testid="summary-games-loading">
              ゲーム記録を取得中…（{gamesNeeded - gamesLoading}/{gamesNeeded}季）
            </span>
          ) : null}
        </span>
      </p>
      <details className="analytics-details" data-testid="analysis-details">
        <summary>集計の内訳（シーズン・指標ごとの採用状況）</summary>
        {partial ? (
          <p className="small-text">
            {gamesLoading > 0 ? `ゲーム記録を取得中です。取得を終えた季から集計に反映します（残り${gamesLoading}季）。` : '取得できた範囲のみの集計（部分集計）です。'}
            {multi && notObtained > 0 ? `対象${available}季のうち${notObtained}季を取得できていません。` : ''}
          </p>
        ) : null}
        {multi && available < load.wanted ? (
          <p className="small-text muted" data-testid="summary-fewer">
            {PERIOD_LABEL[load.request.mode]}の上限は{load.wanted}季ですが、このリーグの対象シーズンは{available}季です（未取得ではありません）。
          </p>
        ) : null}
        {focus ? (
          <section data-testid="focus-summary">
            <h3 className="mini-title">表示中の選手（{focus.name}）</h3>
            <p className="small-text">
              <span className={`badge${focus.status.kind === 'failed' || focus.status.kind === 'partial' ? ' warn' : ''}`}>{STATUS_BADGE[focus.status.kind]}</span> {focus.status.text}
            </p>
            <p className="small-text muted">Leg明細から求める指標（{scope === 'doubles' ? '個人の3DA・First 9・ダブルイン成功率' : 'First 9・Keep率・Break率・100+〜180・High Finish'}）は、この選手の分だけ取得・照合しています。下の「リーグ全体」は、チーム・ランキングの集計に使う取得状況です。</p>
          </section>
        ) : null}
        <h3 className="mini-title">リーグ全体の取得状況</h3>
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
                      {a?.held?.map((h) => (
                        <span key={h.teamId} className="sub" data-testid="games-held-team">
                          {h.reason}
                        </span>
                      ))}
                      {games.load?.stale?.has(slot.tournamentId) ? <span className="sub" data-testid="games-stale-reason">保存済みのゲーム記録（期限切れ・最新とは限らない）。オンラインに戻ると自動で取り直します</span> : null}
                      {games.load?.games.get(slot.tournamentId)?.recollated ? (
                        <span className="sub" data-testid="games-recollated">{recollatedText(games.load.games.get(slot.tournamentId)!.recollated!)}</span>
                      ) : null}
                      {a && a.gamesState === 'loading' ? (
                        <span className="sub" data-testid="games-loading-reason">
                          ゲーム記録を取得中{games.load?.progress.get(slot.tournamentId) ? `（${games.load.progress.get(slot.tournamentId)!.rows}件まで）` : ''}
                        </span>
                      ) : null}
                      {a && a.gamesState === 'partial' ? (
                        <span className="sub" data-testid="games-partial-reason">
                          {games.load?.games.get(slot.tournamentId)?.heldReason ?? (a.unreadableGames > 0 ? `読めない試合記録 ${a.unreadableGames}件のため部分集計（この季は不使用）` : 'ゲーム一覧が途中まで（この季は不使用）')}
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
              <strong>{METRIC_GROUP_LABEL[g.group]}</strong>：{groupText(g)}
              {g.reasons.length > 0 ? <span className="meta">{g.reasons.join(' / ')}</span> : null}
            </li>
          ))}
          {gamesNeeded > 0 ? (
            <li data-testid="games-scope-note">
              <strong>ゲーム記録の集計対象</strong>：リーグ戦の試合（n01 の試合ID が「_lg_」のもの）だけです。プレーオフ等（「_m_」など）は含みません。01全体の公式通算はn01が数えた全試合のため、プレーオフ等を含む場合があり、ゲーム記録の合計と一致しないことがあります。
            </li>
          ) : null}
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
        {games.load?.saveFailed ? <p className="small-text" data-testid="games-save-failed">端末に保存できなかったため、ゲーム記録はこの画面を開いている間だけ使います（取得を繰り返すことはありません。画面を閉じた後は取り直します）。</p> : null}
        {retryable ? (
          <button type="button" className="btn small" onClick={games.retry} data-testid="games-retry">
            <Icon name="refresh" size={16} />
            ゲーム記録を再試行（取得済みの範囲を照合して続きを取得）
          </button>
        ) : null}
        <p className="small-text muted">
          通信: シーズン {load.requestsSent} 回{games.load ? ` ・ ゲーム記録 ${games.load.requestsSent} 回（${GAMES_UNIT_REQUESTS}回ごとに区切って続けて取得）` : ''}
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
      {result ? <ReconstructionResultList result={result} titleOf={titleOf} /> : null}
    </div>
  );
}

/** What a reconstruction compared and accepted, season by season. */
function ReconstructionResultList({ result, titleOf }: { result: PlayerDetailResult; titleOf: (tournamentId: string) => string }): React.JSX.Element {
  return (
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
          {result.stale.length > 0 ? (
            <li data-testid="reconstruction-stale">
              再取得できず保存済みの記録を使用 (最新とは限りません): {result.stale.map((s) => `${s.title} ${s.games}ゲーム`).join('、')}
            </li>
          ) : null}
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
  );
}

/**
 * Per-player figures of the singles / doubles views, read automatically when a player is shown
 * (the leg details of that player only). A retry is offered only when something could not be read.
 */
export function LegDetailPanel({
  role,
  personName,
  status,
  result,
  start,
  onRetry,
  titleOf,
}: {
  role: DetailRole;
  personName: string;
  status: DetailStatus;
  result: PlayerDetailResult | undefined;
  start: PeriodStart | null;
  onRetry: () => void;
  titleOf: (tournamentId: string) => string;
}): React.JSX.Element {
  const retry = hasRetry(status);
  return (
    <div className="reconstruction" data-testid="reconstruction" data-state={status.kind}>
      <p className="small-text">
        {role === 'doubles'
          ? `n01の記録はペア単位の得点です。${personName}さん個人の3DA・First 9・ダブルイン成功率は、Leg明細を自動で取得し、登録投順から復元して、指標ごとにn01公式の集計範囲（平均の対象外の枠は除く）と一致した季だけ表示します。平均の対象外の枠のゲームは、100+〜180・High Finishの公式記録との一致で裏付けます（推測で補いません）。`
          : `First 9・Keep率・Break率はゲーム記録に含まれません。${personName}さんの01のゲームのLeg明細を自動で取得し、シングルスは本人のLeg明細（ゲームの合計と一致したもの）から表示します。ダブルス等の照合結果に左右されません（3DA・Leg/Set勝率はゲーム記録から先に表示しています）。`}
      </p>
      <p className="small-text" data-testid="reconstruction-status" role="status">
        <span className={`badge${status.kind === 'failed' || status.kind === 'partial' ? ' warn' : ''}`} data-testid="reconstruction-badge">{STATUS_BADGE[status.kind]}</span>{' '}
        {status.kind === 'running' || status.kind === 'waiting' ? <Icon name="refresh" size={14} /> : null} {status.text}
      </p>
      {retry ? (
        <button type="button" className="btn small" onClick={onRetry} data-testid="reconstruct-retry">
          <Icon name="refresh" size={16} />
          取得できなかった明細を再試行
        </button>
      ) : null}
      {start && start.state !== 'no-games' ? <StartBreakdown start={start} /> : null}
      {result ? (
        <details className="analytics-details" data-testid="reconstruction-details">
          <summary>照合の内訳（シーズンごと）</summary>
          <ReconstructionResultList result={result} titleOf={titleOf} />
          {result.saveFailed ? <p className="small-text" data-testid="detail-save-failed">端末に保存できなかったため、取得した明細はこの画面を開いている間だけ使います（同じ明細を取り直すことはありません。画面を閉じた後は取り直します）。</p> : null}
          <p className="small-text muted">n01への通信 {result.requestsSent} 回（1回の取得単位の上限 {DETAIL_MAX_REQUESTS} 回。超える分は続けて自動で取得し、保存済みの明細は通信しません）</p>
        </details>
      ) : null}
    </div>
  );
}

const START_STATE_NOTE: Record<PeriodStart['state'], string> = {
  value: '',
  'no-trials': '試技なし',
  'no-games': '対象なし',
  'rule-unknown': 'ルール不明',
  excluded: '対象外（ストレートイン）',
  failed: '取得失敗',
  unavailable: '算出不可',
};

/** ダブルイン成功率 as a metric card: the rate with its successes / attempts, or why there is none. */
export function StartRateCard({ start, pendingText, seasonsUsed = null }: { start: PeriodStart | null; pendingText: string | null; /** 「3季分」: the seasons with attempts, when they differ from the period's common range. */ seasonsUsed?: string | null }): React.JSX.Element {
  // 試技なし (no throw before the pair started) is not 0%: it has no rate at all.
  const shown = start ? (start.state === 'no-trials' ? { value: '試技なし', sample: '0/0スロー' } : formatStart(start)) : { value: '—', sample: '' };
  const note = !start ? (pendingText ?? 'Leg明細の取得後に表示します') : start.state === 'value' ? (start.partial ? '一部集計（内訳は下の「ダブルイン成功率の内訳」）' : 'Leg明細から算出（n01の公式値ではありません）') : (start.reason ?? '');
  const badge = !start || start.state !== 'value' ? (start ? START_STATE_NOTE[start.state] : '取得待ち') : start.partial ? '一部集計' : 'Leg明細から算出';
  return (
    <div className="metric-card" data-testid="metric-ダブルイン成功率">
      <span className="k">ダブルイン成功率</span>
      <span className="v">{shown.value}</span>
      <span className="s">
        {shown.sample || '—'}
        {seasonsUsed && start?.state === 'value' ? ` ・ ${seasonsUsed}` : ''}
      </span>
      {note ? <span className="n">{note}</span> : null}
      <span className={`badge${(start?.state === 'value' && start.partial) || start?.state === 'failed' ? ' warn' : ''}`}>{badge}</span>
    </div>
  );
}

function StartBreakdown({ start }: { start: PeriodStart }): React.JSX.Element {
  const games = Object.entries(start.excludedGames).filter(([, n]) => (n ?? 0) > 0) as [keyof typeof START_GAME_EXCLUSION_LABEL, number][];
  const legs = Object.entries(start.excludedLegs).filter(([, n]) => (n ?? 0) > 0) as [keyof typeof START_LEG_EXCLUSION_LABEL, number][];
  return (
    <details className="analytics-details" data-testid="start-breakdown">
      <summary>ダブルイン成功率の内訳{start.partial ? '（一部集計）' : ''}</summary>
      <ul className="plain-list small-text">
        <li>
          定義：ペアが未スタートの状態で本人が投げたスローのうち、ペアをスタートさせたスローの割合（1スロー＝1試技）。ダブルインと確認できたダブルス01の終了済みLegのみ。Leg明細から算出した値で、n01の公式値ではありません。
        </li>
        <li data-testid="start-adopted">
          採用：ダブルス01 {start.doublesGames}ゲーム中 {start.counted}ゲーム ・ 成功 {start.successes} / 試技 {start.attempts}スロー
        </li>
        {games.map(([why, n]) => (
          <li key={why}>
            対象外：{START_GAME_EXCLUSION_LABEL[why]} {n}ゲーム
          </li>
        ))}
        {legs.map(([why, n]) => (
          <li key={why}>
            対象外：{START_LEG_EXCLUSION_LABEL[why]} {n}Leg
          </li>
        ))}
        {start.seasonsMissing.map((m) => (
          <li key={m.title}>
            未取得：{m.title}（{m.reason}）
          </li>
        ))}
        {start.ruleNotes.slice(0, 3).map((note) => (
          <li key={note} className="muted">
            {note}
          </li>
        ))}
        {start.highInAgreements > 0 ? <li>n01のハイイン記録と開始者・点数が一致したスタート：{start.highInAgreements}件</li> : null}
        <li className="muted">投げた選手は n01 の登録投順（各Legで1人目から交互）で決めています。記録されずに投順を入れ替えた場合は判別できません。</li>
      </ul>
    </details>
  );
}

/**
 * "3季分": the seasons a card's figure really uses, shown next to it only when they differ from the
 * period's common range (the summary line), in a multi-season period. `null` otherwise.
 */
export function seasonsUsedText(lines: readonly (StatLine | null)[], metric: MetricId, common: number | null, multi: boolean, hasValue: boolean): string | null {
  if (!multi || !hasValue || common === null) return null;
  const n = lines.filter((line) => line !== null && pairOf(metric, line) !== null).length;
  return n !== common ? `${n}季分` : null;
}

const BASIS_LABEL: Record<LinkBasis, string> = { id: '会員ID', rename: '姓の変更', guest: '共用ラベル・IDなし', 'id-variant': '会員IDの表記ゆれ', confirmed: '手動で確認' };

/**
 * ⑨ 本人照合 of the shown player: every season row joined into them with its basis, a way to undo an
 * automatic join (the row stays apart after the next read too), the rows held because they may be
 * theirs (confirm by hand), and the rows undone before (take the undo back).
 */
export function IdentityPanel({ personKey, identity }: { personKey: string; identity: { links: PeriodLinks; controls: IdentityControls } }): React.JSX.Element | null {
  const entries = identity.links.people.get(personKey) ?? [];
  const mine = new Set(entries.map((e) => e.row.key));
  const held = identity.links.held.filter((h) => h.candidates.includes(personKey) && !mine.has(h.row.key));
  const rows = new Map([...identity.links.people.values()].flat().map((e) => [e.row.key, e.row]));
  // Rows undone that bear this player's name (so they can be taken back from here).
  const names = new Set(entries.map((e) => fullName(e.row.name)));
  const undone = identity.controls.decisions.unlinks.map((k) => rows.get(k)).filter((r): r is NonNullable<typeof r> => !!r && names.has(fullName(r.name)));
  const seasons = new Set(entries.map((e) => e.row.tournamentId)).size;
  if (entries.length === 0) return null;
  return (
    <details className="analytics-details" data-testid="identity-links">
      <summary>本人照合（{seasons}季{held.length > 0 ? `・保留 ${held.length}件` : ''}）</summary>
      <p className="small-text muted">同じリーグで会員ID・氏名・所属・時系列から本人と確認できた行だけを結合しています（n01公式値との数値の照合とは別です）。自動で結合した行は解除でき、解除した行は取得し直しても自動では戻りません。</p>
      <ul className="plain-list small-text">
        {entries.map((e) => (
          <li key={e.row.key} data-testid="identity-row">
            <strong>{e.row.title}</strong>：{e.row.name}（{e.row.opid ?? '会員IDなし'}）{e.row.hasStats ? '' : '・成績行なし'}
            <span className="meta">
              {BASIS_LABEL[e.basis]}：{e.reason}
            </span>
            {e.undoable ? (
              <button type="button" className="btn small" onClick={() => identity.controls.unlink(e.row.key)} data-testid="identity-unlink">
                この季の結合を解除
              </button>
            ) : null}
          </li>
        ))}
        {held.map((h) => (
          <li key={`held-${h.row.key}`} data-testid="identity-held">
            保留：<strong>{h.row.title}</strong> {h.row.name}（{h.row.opid ?? '会員IDなし'}）
            <span className="meta">{h.reason}</span>
            <button type="button" className="btn small" onClick={() => identity.controls.confirm(h.row.key, entries[0].row.key)} data-testid="identity-confirm">
              本人と確認して結合
            </button>
          </li>
        ))}
        {undone.map((r) => (
          <li key={`undone-${r.key}`} data-testid="identity-undone">
            解除済み：<strong>{r.title}</strong> {r.name}
            <button type="button" className="btn small" onClick={() => identity.controls.reset(r.key)}>
              解除を取り消す
            </button>
          </li>
        ))}
      </ul>
    </details>
  );
}
