import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Card } from '../../../components/ui';
import type { Player, Team } from '../../../domain/types';
import { normalizeName } from '../../../domain/n01/names';
import { formatSample, formatValue, METRIC_LABEL } from '../format';
import type { RankMetric } from '../format';
import { MIN_SAMPLE, reliabilityOf } from '../metrics';
import { buildInsights, buildPopulation, cellText, COMPARE_METRICS, findPerson, findPersonInPeriod, metricValue, rankIn, standingOf, trendOf } from '../playerView';
import type { PlayerScope } from '../ranking';
import type { PeriodLoad } from '../service/periodService';
import type { MetricId } from '../types';
import { SCOPE_LABEL as GAME_SCOPE_LABEL } from '../roleGames';
import { scopeMetrics } from '../scopeMetrics';
import type { RoleViewProps } from './AnalyticsPage';
import { InsightList, MetricCard, RankingTable, Segmented, TrendChart } from './parts';
import { IdentityPanel, LegDetailPanel, ReconstructionPanel, seasonsUsedText, StartRateCard } from './scopeParts';
import { contributingSeasons } from '../projection';
import { detailCoverage, doublesCoverage, roleExposure, singlesCoverage } from '../service/detailService';
import { periodStart } from '../startRate';
import { detailStatusOf, legCardNote } from './detailStatus';
import type { DetailRole, DetailStatus } from './detailStatus';

/**
 * PLAYER ANALYTICS (design §4). Reads a loaded period; computes nothing it cannot show the
 * basis of, and never writes anything back to the roster, the optimizer or n01.
 */

type ScopeKind = 'team' | 'division' | 'league';
const SCOPE_LABEL: Record<ScopeKind, string> = { team: 'チーム内', division: 'ディビジョン', league: 'リーグ全体' };
const TREND_METRICS: MetricId[] = ['ppr', 'first9', 'legRate'];
const MAX_COMPARE = 3;

/** The shown player's leg read, as the analysis summary reports it. */
export interface FocusSummary {
  name: string;
  status: DetailStatus;
}

export function PlayerAnalytics({
  team,
  players,
  load,
  baseTournamentId,
  onOpenMembers,
  role,
  onFocusSummary,
}: {
  team: Team;
  players: Player[];
  load: PeriodLoad;
  baseTournamentId: string;
  onOpenMembers?: () => void;
  role?: RoleViewProps;
  /** The shown player and the state of their leg read, for the page's "集計の内訳". */
  onFocusSummary?: (summary: FocusSummary | null) => void;
}): React.JSX.Element {
  const gameScope = role?.scope ?? 'all01';
  const roleView = gameScope !== 'all01';
  const multiThrower = roleView && gameScope !== 'singles';
  const available_ = useMemo(() => scopeMetrics(gameScope, load.seasons, 'player'), [gameScope, load.seasons]);
  const CARD_METRICS = available_.cards;
  const base = load.seasons.find((s) => s.tournamentId === baseTournamentId) ?? null;
  const binding = team.n01;

  // The team in the base season: its tpid is season-scoped, so a past season is matched by
  // an exact, unique name only.
  const baseTeam = useMemo(() => {
    if (!base || !binding) return null;
    if (base.tournamentId === binding.lastTournamentId) return base.teams.find((t) => t.teamId === binding.lastTeamId) ?? null;
    const wanted = normalizeName(binding.lastTeamName);
    const named = base.teams.filter((t) => normalizeName(t.name) === wanted);
    return named.length === 1 ? named[0] : null;
  }, [base, binding]);

  const available: ScopeKind[] = ['league'];
  if (baseTeam?.divisionIndex !== null && baseTeam?.divisionIndex !== undefined) available.unshift('division');
  if (baseTeam) available.unshift('team');
  const [scopeKind, setScopeKind] = useState<ScopeKind>('team');
  const activeScope: ScopeKind = available.includes(scopeKind) ? scopeKind : available[0];

  const scope: PlayerScope =
    activeScope === 'team' && baseTeam
      ? { kind: 'team', teamId: baseTeam.teamId }
      : activeScope === 'division' && baseTeam?.divisionIndex !== null && baseTeam?.divisionIndex !== undefined
        ? { kind: 'division', divisionIndex: baseTeam.divisionIndex }
        : { kind: 'league' };

  const scopeKey = scope.kind === 'team' ? `team:${scope.teamId}` : scope.kind === 'division' ? `division:${scope.divisionIndex}` : 'league';
  const population = useMemo(
    () => buildPopulation(load.seasons, scope, baseTournamentId),
    // `scope` is fully described by `scopeKey`.
    [load.seasons, scopeKey, baseTournamentId],
  );
  const everyone = useMemo(() => buildPopulation(load.seasons, { kind: 'league' }, baseTournamentId).people, [load.seasons, baseTournamentId]);
  const byKey = useMemo(() => new Map(everyone.map((p) => [p.personKey, p])), [everyone]);

  // The roster. 今季・複数季: League Order's members, matched to n01 rows only where identity is
  // proven. 指定季: everyone registered for the team in that season (former members included),
  // opened by that season's own player id — a player without a stats row is "出場なし".
  const specifiedSeason = load.request.mode === 'specified';
  const seasonGames = base ? role?.games.load?.games.get(base.tournamentId) : undefined;
  const rosterNote = specifiedSeason && base && baseTeam ? (base.roster ? null : '名簿を取得できないため、この季に成績のある選手だけを表示しています。') : null;
  const roster = useMemo((): { id: string; name: string; personKey: string | null; reason?: string; period: (typeof everyone)[number] | null }[] => {
    if (!base) return [];
    if (specifiedSeason && baseTeam) {
      const statsOf = new Map(base.players.filter((p) => p.teamId === baseTeam.teamId).map((p) => [p.oid, p]));
      const rows = base.roster ? base.roster.filter((r) => r.teamId === baseTeam.teamId) : [];
      const listed = new Set(rows.map((r) => r.oid));
      const extra = [...statsOf.values()].filter((p) => !listed.has(p.oid)).map((p) => ({ oid: p.oid, name: p.name }));
      // 出場なし only when the season's whole game list shows no game of theirs; a game of theirs
      // without a stats row is a missing record; without a complete list, it is not known.
      const list = seasonGames?.complete ? seasonGames : null;
      // A game of the team whose throwing order n01 left out may be theirs: then nobody is known absent.
      const orderMissing = !!list?.games.some((g) => g.missingOrder && g.sides.some((x, i) => g.missingOrder![i] && x.teamId === baseTeam.teamId));
      const played = (oid: string): boolean | null => {
        if (!list) return null;
        if (list.games.some((g) => g.sides.some((x) => x.players.some((p) => p.oid === oid)))) return true;
        return orderMissing ? null : false;
      };
      const noStats = (oid: string): string => {
        const p = played(oid);
        return p === false ? '出場なし（この季のゲーム記録に出場がありません）' : p === true ? '記録欠損（ゲーム記録に出場がありますが、n01の成績行がありません）' : '成績記録なし（出場の有無はゲーム記録で未確認）';
      };
      return [...rows.map((r) => ({ oid: r.oid, name: r.name })), ...extra].map((r) => {
        const stats = statsOf.get(r.oid);
        const conflict = base.conflicts.some((c) => c.oid === r.oid);
        return {
          id: `oid:${r.oid}`,
          name: stats?.name ?? r.name,
          personKey: stats?.personKey ?? null,
          reason: stats ? undefined : conflict ? '同じ選手IDが複数チームにあるため集計から除外しています' : noStats(r.oid),
          period: stats ? (byKey.get(stats.personKey) ?? null) : null,
        };
      });
    }
    const multi = load.request.mode === 'last3' || load.request.mode === 'last12';
    const withFigures = new Set(byKey.keys());
    const links = role?.identity?.links;
    return players
      .filter((p) => !p.archived && !p.guest)
      .map((p) => {
        if (!links) {
          const match = findPerson(base, p.n01);
          return { id: p.id, name: p.name, personKey: match.personKey, reason: match.reason, period: match.personKey ? (byKey.get(match.personKey) ?? null) : null };
        }
        // ⑩: the member's row anywhere in the period (本人照合 applied); figures only where they played.
        const match = findPersonInPeriod(load.seasons, base, p.n01, links, multi, withFigures);
        const period = match.state === 'found' && match.personKey ? (byKey.get(match.personKey) ?? null) : null;
        const failed = !period && load.failures.length > 0 ? `（取得できなかった季が${load.failures.length}季あります）` : '';
        const reason = period ? (match.inBase ? undefined : '今季は出場記録なし') : `${match.reason ?? '成績を確認できません'}${failed}`;
        return { id: p.id, name: p.name, personKey: period ? match.personKey : null, reason, period };
      });
  }, [base, baseTeam, specifiedSeason, players, byKey, seasonGames, role?.identity?.links, load.request.mode, load.seasons, load.failures.length]);

  const [selected, setSelectedKey] = useState<string | null>(null);
  const detailRef = useRef<HTMLDivElement | null>(null);
  // A phone shows the detail under the roster: picking a player brings their name and figures
  // into view (a large screen has them beside the roster already).
  const setSelected = (key: string): void => {
    setSelectedKey(key);
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function' || !window.matchMedia('(max-width: 899px)').matches) return;
    const behavior: ScrollBehavior = window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth';
    requestAnimationFrame(() => detailRef.current?.scrollIntoView({ block: 'start', behavior }));
  };
  const selectedKey = selected && byKey.has(selected) ? selected : (roster.find((r) => r.period)?.personKey ?? null);
  const person = selectedKey ? (byKey.get(selectedKey) ?? null) : null;

  const [metricChoice, setMetric] = useState<RankMetric>('ppr');
  const metric: RankMetric = available_.rank.includes(metricChoice) ? metricChoice : available_.rank[0];
  const [trendMetric, setTrendMetric] = useState<MetricId>('ppr');
  const [compare, setCompare] = useState<string[]>([]);
  const compareSelectId = useId();
  const metricSelectId = useId();

  // シングルス / ダブルス: the shown player's leg details are read automatically (that player
  // only, once per period, continued part after part; a failed read is offered again, and retried
  // by itself only when the browser comes back online).
  const doublesView = gameScope === 'doubles';
  const singlesView = gameScope === 'singles';
  const detailRole: DetailRole | null = doublesView ? 'doubles' : singlesView ? 'singles' : null;
  const gamesState = role?.games;
  const exposure = useMemo(
    () => (detailRole && person && gamesState?.load ? roleExposure(load.seasons, gamesState.load.games, person.personKey, detailRole) : null),
    [detailRole, person, gamesState?.load, load.seasons],
  );
  const wantsRead = !!detailRole && !!exposure && exposure.games > 0;
  const focus = role?.detail.focus;
  const personKey = person?.personKey ?? null;
  useEffect(() => {
    // Another view of the same player lets a running part finish; another player stops it.
    focus?.(personKey, wantsRead);
  }, [personKey, wantsRead, focus]);
  const focusRef = useRef({ focus, personKey });
  useEffect(() => {
    focusRef.current = { focus, personKey };
  }, [focus, personKey]);
  // The player view closed (team view): no new part starts; the page closing stops the read.
  useEffect(() => () => focusRef.current.focus?.(focusRef.current.personKey, false), []);
  const detailResult = person && role ? role.detail.results.get(person.personKey) : undefined;
  const detailRunning = !!person && role?.detail.running === person.personKey;
  const detailPartial = !!person && !!role?.detail.partial?.has(person.personKey);
  // No doubles game in the lists loaded now (some may have been removed since the read): no start rate.
  const start = useMemo(() => (doublesView && detailResult && exposure && exposure.games > 0 ? periodStart(detailResult.starts) : null), [doublesView, detailResult, exposure]);
  const detailStatus: DetailStatus | null = detailRole
    ? detailStatusOf({
        role: detailRole,
        gamesLoading: gamesState?.status === 'loading',
        exposure,
        running: detailRunning,
        partial: detailPartial,
        result: detailResult,
        outdated: !!detailResult?.coverage && !!person && !!gamesState?.load && detailResult.coverage !== detailCoverage(load.seasons, gamesState.load.games, person.personKey),
      })
    : null;
  const singles = singlesView && detailResult && exposure ? singlesCoverage(detailResult, exposure.seasons) : null;
  const doubles = doublesView && detailResult ? doublesCoverage(detailResult) : null;
  const legNote = (m: MetricId, hasValue: boolean): string | undefined => {
    if (!detailStatus) return undefined;
    if (doublesView && (m === 'ppr' || m === 'first9')) {
      const verified = doubles ? (m === 'ppr' ? doubles.scoreVerified : doubles.f9Verified) : 0;
      const note = legCardNote(METRIC_LABEL[m], hasValue, detailStatus, verified, doubles?.seasons ?? 0);
      // n01 has no average for an ignore_avg slot: those games are backed by its 100+〜180 / High Finish.
      const outside = hasValue && !!detailResult?.checks.some((c) => (c.avgExcludedGames ?? 0) > 0 && c.verified.outsideAvg);
      return outside && note ? `${note}。平均の対象外の枠（ignore_avg）のゲームは、100+〜180・High Finishの公式記録との一致で照合` : note;
    }
    if (singlesView && (m === 'first9' || m === 'keep' || m === 'break')) {
      const verified = singles ? (m === 'first9' ? singles.f9Verified : singles.breakVerified) : 0;
      return legCardNote(METRIC_LABEL[m], hasValue, detailStatus, verified, singles?.seasons ?? 0, 'singles');
    }
    return undefined;
  };
  useEffect(() => {
    onFocusSummary?.(person && detailStatus ? { name: person.name, status: detailStatus } : null);
  }, [onFocusSummary, person, detailStatus?.kind, detailStatus?.text]);

  if (!base) {
    return (
      <Card title="プレイヤー分析">
        <p className="small-text">基準となるシーズンの成績を取得できませんでした。期間を変えるか、再取得してください。</p>
      </Card>
    );
  }

  const ranking = rankIn(population.scoped.members, metric);
  const rankingFor = (m: MetricId) => rankIn(population.scoped.members, m);
  // In doubles / others views a player's Leg and Set rates are the pair's results: no personal verdict.
  const insights = person
    ? multiThrower
      ? { strengths: [], improvements: [], held: 'この表示ではLeg/Set勝率がペア・チームとしての結果のため、個人の強み・改善候補は判定しません。' }
      : buildInsights(person, population, rankingFor)
    : null;
  const myStanding = person ? standingOf(ranking, person.personKey) : null;
  const teamNameOf = (id: string): string => {
    const p = byKey.get(id);
    const entry = p?.seasons.find((s) => s.tournamentId === baseTournamentId) ?? p?.seasons[0];
    return base.teams.find((t) => t.teamId === entry?.teamId)?.name ?? '';
  };
  const comparePeople = compare.map((key) => byKey.get(key)).filter((p): p is NonNullable<typeof p> => !!p);
  const compareCandidates = population.scoped.members.filter((m) => m.personKey !== selectedKey && !compare.includes(m.personKey));
  const multiSeason = load.request.mode === 'last3' || load.request.mode === 'last12';
  const commonSeasons = role ? contributingSeasons(role.adoption) : load.seasons.length;
  const sampleText = (m: MetricId): string => {
    if (!person) return '';
    const used = seasonsUsedText(person.seasons.map((x) => x.line), m, commonSeasons, multiSeason, person.metrics[m].value !== null);
    return `${formatSample(m, person.metrics[m].den)}${used ? ` ・ ${used}` : ''}`;
  };

  return (
    <div className="analytics-columns">
        <Card title="チームメンバー" kicker="ROSTER" className="analytics-roster-card" action={onOpenMembers ? <button type="button" className="btn small" onClick={onOpenMembers}>メンバー管理</button> : undefined}>
          {specifiedSeason && baseTeam ? (
            <p className="small-text muted" data-testid="season-roster-note">
              {base.title}に{baseTeam.name}で登録された選手です（その季の選手IDで成績を開きます）。{rosterNote ?? ''}
            </p>
          ) : null}
          {roster.length === 0 ? <p className="small-text muted">メンバーが登録されていません。</p> : null}
          <ul className="list analytics-roster">
            {roster.map(({ id, name, personKey, reason, period }) => (
              <li key={id}>
                <button
                  type="button"
                  className="list-row"
                  disabled={!period}
                  aria-pressed={personKey !== null && personKey === selectedKey}
                  onClick={() => personKey && setSelected(personKey)}
                >
                  <span className="grow">
                    <span className="title">{name}</span>
                    <span className="meta">
                      {period
                        ? `3DA ${formatValue('ppr', period.metrics.ppr.value)} ・ Leg ${formatValue('legRate', period.metrics.legRate.value)}${period.linked ? ` ・ ${period.seasons.length}季` : ''}${reason ? ` ・ ${reason}` : ''}`
                        : (reason ?? '成績を確認できません')}
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </Card>

      <div className="analytics-detail" ref={detailRef} data-testid="analytics-detail">
        {!person ? (
          <Card title="プレイヤー詳細" kicker="PLAYER">
            <p className="small-text">成績を確認できる選手を選んでください。選手が見つからない場合、n01 と連携した選手かどうか、期間を確認してください。</p>
          </Card>
        ) : (
          <>
            <Card title={person.name} kicker="PLAYER">
              <p className="small-text muted" data-testid="player-basis">
                {person.metrics.seasons}シーズンの合算{roleView ? `（${GAME_SCOPE_LABEL[gameScope]}のゲームのみ）` : ''}
                {person.linked ? '（本人と確認できた季のみ結合。内訳は下の「本人照合」）' : ''}
                {!person.seasons.some((x) => x.tournamentId === baseTournamentId) ? <span data-testid="player-no-base"> ・ {load.request.mode === 'specified' ? '指定季は出場記録なし' : '今季は出場記録なし'}（期間内の他の季の成績）</span> : null}
                {roleView
                  ? ` ・ ${person.metrics.setRate.den}ゲーム`
                  : ` ・ 出場 ${person.metrics.counts.match ?? '—'} 試合（勝利数ではありません）`}
              </p>
              <div className="metric-grid">
                {CARD_METRICS.map((m) => {
                  const ratio = person.metrics[m];
                  const avg = population.averages[m];
                  const diff =
                    ratio.value !== null && avg.value !== null
                      ? m === 'ppr' || m === 'first9'
                        ? `平均 ${formatValue(m, avg.value)}（${ratio.value - avg.value >= 0 ? '+' : ''}${(ratio.value - avg.value).toFixed(2)}）`
                        : `平均 ${formatValue(m, avg.value)}（${ratio.value - avg.value >= 0 ? '+' : ''}${((ratio.value - avg.value) * 100).toFixed(1)}pt）`
                      : undefined;
                  const ranked = available_.rank.includes(m);
                  const st = ranked ? standingOf(rankIn(population.scoped.members, m), person.personKey) : null;
                  const fromLegs = legNote(m, ratio.value !== null);
                  const note =
                    fromLegs !== undefined
                      ? fromLegs
                      : ratio.value !== null
                      ? m === 'legRate' || m === 'setRate'
                        ? multiThrower
                          ? 'ペア・チームとしての結果'
                          : undefined
                        : undefined
                      : m === 'ppr' && multiThrower
                        ? '個人別に復元できません（Leg明細から復元し、公式値と一致した場合のみ表示）'
                        : roleView
                          ? 'データ不足（ゲーム記録に含まれません。Leg明細の復元で検証できた場合のみ表示）'
                          : 'データ不足';
                  return (
                    <MetricCard
                      key={m}
                      label={METRIC_LABEL[m]}
                      value={formatValue(m, ratio.value)}
                      sample={sampleText(m)}
                      reliability={reliabilityOf(m, ratio)}
                      compare={diff}
                      rank={st?.rank ? `${SCOPE_LABEL[activeScope]} ${st.rank}位 / ${st.population}名` : undefined}
                      note={note}
                    />
                  );
                })}
                {doublesView ? <StartRateCard start={start} pendingText={detailStatus && detailStatus.kind !== 'done' && detailStatus.kind !== 'partial' ? detailStatus.text : null} seasonsUsed={start && multiSeason && start.seasonsCounted !== commonSeasons ? `${start.seasonsCounted}季分` : null} /> : null}
              </div>
              <details className="analytics-details" open>
                <summary>スコア・フィニッシュ記録</summary>
                <dl className="kv-grid">
                  {(
                    [
                      ['100+', person.metrics.counts.ton00, 'ton00Rate'],
                      ['140+', person.metrics.counts.ton40, 'ton40Rate'],
                      ['170+', person.metrics.counts.ton70, 'ton70Rate'],
                      ['180', person.metrics.counts.ton80, 'ton80Rate'],
                    ] as const
                  ).map(([label, count, rate]) => (
                    <div key={label}>
                      <dt>{label}</dt>
                      <dd>
                        {count === null ? '—' : `${count}回`}{person.metrics[rate].value !== null ? `（${(person.metrics[rate].value! * 100).toFixed(1)}% / Leg）` : ''}
                      </dd>
                    </div>
                  ))}
                  <div>
                    <dt>High Finish</dt>
                    <dd>{person.metrics.extremes.highOut ?? '記録なし'}</dd>
                  </div>
                  <div>
                    <dt>Best Leg</dt>
                    <dd>{person.metrics.extremes.bestLeg !== null ? `${person.metrics.extremes.bestLeg}本` : '記録なし'}</dd>
                  </div>
                </dl>
                <p className="small-text muted">
                  100+/140+/170+/180 は n01 が区分ごとに報告する回数です（100–139・140–169・170–179・180 の排他区分であることを実データで確認）。
                  {roleView ? 'この表示ではLeg明細の復元で公式値と一致した場合のみ表示します。' : ''}
                  {!roleView && person.metrics.extremes.bestLeg !== null ? ' Best Leg は n01 公式値で、開始点数（501/1001等）の区別はありません。' : ''}
                </p>
              </details>
              {role?.identity ? <IdentityPanel personKey={person.personKey} identity={role.identity} /> : null}
              {myStanding?.state === 'reference' ? <p className="small-text muted">この指標はサンプル数が基準({MIN_SAMPLE[metric as MetricId] ?? '—'})未満のため、順位に含めていません。</p> : null}
            </Card>

            {detailRole && role && detailStatus ? (
              <Card title="個人別の成績（Leg明細から）" kicker="RECONSTRUCT">
                <LegDetailPanel
                  role={detailRole}
                  personName={person.name}
                  status={detailStatus}
                  result={detailResult}
                  start={start}
                  onRetry={() => role.detail.run(person.personKey, { fresh: false, auto: true, recheck: true })}
                  titleOf={(id) => load.seasons.find((s) => s.tournamentId === id)?.title ?? id}
                />
              </Card>
            ) : null}

            {multiThrower && !detailRole && role ? (
              <Card title="個人別の復元" kicker="RECONSTRUCT">
                <ReconstructionPanel
                  personName={person.name}
                  result={role.detail.results.get(person.personKey)}
                  running={role.detail.running === person.personKey}
                  disabled={role.games.status !== 'done' || role.detail.running !== null}
                  onRun={() => role.detail.run(person.personKey)}
                  titleOf={(id) => load.seasons.find((s) => s.tournamentId === id)?.title ?? id}
                />
              </Card>
            ) : null}

            <Card title="強みと改善候補" kicker="INSIGHT">
              {insights ? <InsightList insights={insights} scopeLabel={SCOPE_LABEL[activeScope]} /> : null}
            </Card>

            <Card title="シーズン推移" kicker="TREND">
              <Segmented label="推移の指標" value={trendMetric} onChange={setTrendMetric} options={TREND_METRICS.map((m) => ({ value: m, label: METRIC_LABEL[m] }))} />
              <TrendChart points={trendOf(person, trendMetric)} metric={trendMetric} />
            </Card>

            <Card title="選手を比較" kicker="COMPARE">
              <div className="field">
                <label htmlFor={compareSelectId}>
                  <span>比較する選手を追加（最大{MAX_COMPARE}名）</span>
                </label>
                <select
                  id={compareSelectId}
                  value=""
                  disabled={compare.length >= MAX_COMPARE}
                  onChange={(event) => event.target.value && setCompare([...compare, event.target.value])}
                >
                  <option value="">選手を選択…</option>
                  {compareCandidates
                    .slice()
                    .sort((a, b) => a.name.localeCompare(b.name, 'ja'))
                    .map((c) => (
                      <option key={c.personKey} value={c.personKey}>
                        {c.name}
                      </option>
                    ))}
                </select>
              </div>
              {comparePeople.length > 0 ? (
                <>
                  <div className="chip-row">
                    {comparePeople.map((c) => (
                      <button key={c.personKey} type="button" className="chip on" aria-label={`${c.name}を比較から外す`} onClick={() => setCompare(compare.filter((k) => k !== c.personKey))}>
                        {c.name} ×
                      </button>
                    ))}
                  </div>
                  <div className="analytics-table-wrap">
                    <table className="analytics-table" data-testid="compare-table">
                      <caption>{SCOPE_LABEL[activeScope]}の選手比較</caption>
                      <thead>
                        <tr>
                          <th scope="col">指標</th>
                          {[person, ...comparePeople].map((p) => (
                            <th key={p.personKey} scope="col">
                              {p.name}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {COMPARE_METRICS.map((m) => {
                          const cells = [person, ...comparePeople].map((p) => ({ p, ...cellText(p, m), ...metricValue(p, m) }));
                          const valued = cells.filter((c) => c.value !== null && !c.reference);
                          const best = valued.length > 1 ? (m === 'bestLeg' ? Math.min(...valued.map((c) => c.value as number)) : Math.max(...valued.map((c) => c.value as number))) : null;
                          return (
                            <tr key={m}>
                              <th scope="row">{METRIC_LABEL[m]}</th>
                              {cells.map((c) => (
                                <td key={c.p.personKey} className={`num${best !== null && c.value === best ? ' best' : ''}`}>
                                  {c.text}
                                  {c.reference ? <span className="sub">参考</span> : null}
                                </td>
                              ))}
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                  <p className="small-text muted">「参考」はサンプル数が基準未満です。最良値の強調は基準を満たす値同士のみで行います。</p>
                </>
              ) : (
                <p className="small-text muted">比較する選手を追加すると、指標を並べて表示します。</p>
              )}
            </Card>
          </>
        )}
      </div>

        <Card title="ランキング" kicker="RANKING" className="analytics-rank">
          <Segmented label="比較する母集団" value={activeScope} onChange={setScopeKind} options={available.map((k) => ({ value: k, label: SCOPE_LABEL[k] }))} />
          <div className="field">
            <label htmlFor={metricSelectId}>
              <span>指標</span>
            </label>
            <select id={metricSelectId} value={metric} onChange={(event) => setMetric(event.target.value as RankMetric)}>
              {available_.rank.map((m) => (
                <option key={m} value={m}>
                  {METRIC_LABEL[m]}
                </option>
              ))}
            </select>
          </div>
          {population.scoped.includesOtherDivisions ? (
            <p className="small-text muted" data-testid="other-division-note">
              他のディビジョンでの成績を含みます（純粋な同一ディビジョン比較ではありません）。
            </p>
          ) : null}
          {activeScope === 'league' && load.request.mode !== 'current' ? <p className="small-text muted">期間内にディビジョンや試合形式が異なる成績を含む場合があります。</p> : null}
          {available_.notes.map((note) => (
            <p key={note} className="small-text muted" data-testid="scope-rank-note">
              {note}
            </p>
          ))}
          <RankingTable
            ranking={ranking}
            metric={metric}
            highlight={selectedKey ?? undefined}
            teamNameOf={activeScope === 'team' ? undefined : teamNameOf}
            caption={`${SCOPE_LABEL[activeScope]}の${METRIC_LABEL[metric]}ランキング`}
          />
        </Card>
    </div>
  );
}

