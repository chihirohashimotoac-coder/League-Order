import { useId, useMemo, useState } from 'react';
import { Card } from '../../../components/ui';
import type { Player, Team } from '../../../domain/types';
import { normalizeName } from '../../../domain/n01/names';
import { formatSample, formatValue, METRIC_LABEL, RANK_METRICS } from '../format';
import type { RankMetric } from '../format';
import { MIN_SAMPLE, reliabilityOf } from '../metrics';
import { buildInsights, buildPopulation, cellText, COMPARE_METRICS, findPerson, metricValue, rankIn, standingOf, trendOf } from '../playerView';
import type { Insight } from '../playerView';
import type { PlayerScope } from '../ranking';
import type { PeriodLoad } from '../service/periodService';
import type { MetricId } from '../types';
import { MetricCard, RankingTable, Segmented, TrendChart } from './parts';

/**
 * PLAYER ANALYTICS (design §4). Reads a loaded period; computes nothing it cannot show the
 * basis of, and never writes anything back to the roster, the optimizer or n01.
 */

type ScopeKind = 'team' | 'division' | 'league';
const SCOPE_LABEL: Record<ScopeKind, string> = { team: 'チーム内', division: 'ディビジョン', league: 'リーグ全体' };
const CARD_METRICS: MetricId[] = ['ppr', 'first9', 'legRate', 'setRate', 'keep', 'break'];
const TREND_METRICS: MetricId[] = ['ppr', 'first9', 'legRate'];
const MAX_COMPARE = 3;

export function PlayerAnalytics({
  team,
  players,
  load,
  baseTournamentId,
  onOpenMembers,
}: {
  team: Team;
  players: Player[];
  load: PeriodLoad;
  baseTournamentId: string;
  onOpenMembers?: () => void;
}): React.JSX.Element {
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

  // The roster as League Order knows it, matched to n01 rows only where identity is proven.
  const roster = useMemo(() => {
    if (!base) return [];
    return players
      .filter((p) => !p.archived && !p.guest)
      .map((p) => {
        const match = findPerson(base, p.n01);
        return { player: p, personKey: match.personKey, reason: match.reason, period: match.personKey ? (byKey.get(match.personKey) ?? null) : null };
      });
  }, [base, players, byKey]);

  const [selected, setSelected] = useState<string | null>(null);
  const selectedKey = selected && byKey.has(selected) ? selected : (roster.find((r) => r.period)?.personKey ?? null);
  const person = selectedKey ? (byKey.get(selectedKey) ?? null) : null;

  const [metric, setMetric] = useState<RankMetric>('ppr');
  const [trendMetric, setTrendMetric] = useState<MetricId>('ppr');
  const [compare, setCompare] = useState<string[]>([]);
  const compareSelectId = useId();
  const metricSelectId = useId();

  if (!base) {
    return (
      <Card title="プレイヤー分析">
        <p className="small-text">基準となるシーズンの成績を取得できませんでした。期間を変えるか、再取得してください。</p>
      </Card>
    );
  }

  const ranking = rankIn(population.scoped.members, metric);
  const rankingFor = (m: MetricId) => rankIn(population.scoped.members, m);
  const insights = person ? buildInsights(person, population, rankingFor) : null;
  const myStanding = person ? standingOf(ranking, person.personKey) : null;
  const teamNameOf = (id: string): string => {
    const p = byKey.get(id);
    const entry = p?.seasons.find((s) => s.tournamentId === baseTournamentId) ?? p?.seasons[0];
    return base.teams.find((t) => t.teamId === entry?.teamId)?.name ?? '';
  };
  const comparePeople = compare.map((key) => byKey.get(key)).filter((p): p is NonNullable<typeof p> => !!p);
  const compareCandidates = population.scoped.members.filter((m) => m.personKey !== selectedKey && !compare.includes(m.personKey));
  const sampleText = (m: MetricId): string => (person ? formatSample(m, person.metrics[m].den) : '');

  return (
    <div className="analytics-columns">
      <div className="analytics-col">
        <Card title="チームメンバー" kicker="ROSTER" action={onOpenMembers ? <button type="button" className="btn small" onClick={onOpenMembers}>メンバー管理</button> : undefined}>
          {roster.length === 0 ? <p className="small-text muted">メンバーが登録されていません。</p> : null}
          <ul className="list analytics-roster">
            {roster.map(({ player, personKey, reason, period }) => (
              <li key={player.id}>
                <button
                  type="button"
                  className="list-row"
                  disabled={!period}
                  aria-pressed={personKey !== null && personKey === selectedKey}
                  onClick={() => personKey && setSelected(personKey)}
                >
                  <span className="grow">
                    <span className="title">{player.name}</span>
                    <span className="meta">
                      {period
                        ? `3DA ${formatValue('ppr', period.metrics.ppr.value)} ・ Leg ${formatValue('legRate', period.metrics.legRate.value)}${period.linked ? ` ・ ${period.seasons.length}季` : ''}`
                        : (reason ?? '成績を確認できません')}
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </Card>

        <Card title="ランキング" kicker="RANKING" className="analytics-rank">
          <Segmented label="比較する母集団" value={activeScope} onChange={setScopeKind} options={available.map((k) => ({ value: k, label: SCOPE_LABEL[k] }))} />
          <div className="field">
            <label htmlFor={metricSelectId}>
              <span>指標</span>
            </label>
            <select id={metricSelectId} value={metric} onChange={(event) => setMetric(event.target.value as RankMetric)}>
              {RANK_METRICS.map((m) => (
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
          <RankingTable
            ranking={ranking}
            metric={metric}
            highlight={selectedKey ?? undefined}
            teamNameOf={activeScope === 'team' ? undefined : teamNameOf}
            caption={`${SCOPE_LABEL[activeScope]}の${METRIC_LABEL[metric]}ランキング`}
          />
        </Card>
      </div>

      <div className="analytics-col">
        {!person ? (
          <Card title="プレイヤー詳細" kicker="PLAYER">
            <p className="small-text">成績を確認できる選手を選んでください。選手が見つからない場合、n01 と連携した選手かどうか、期間を確認してください。</p>
          </Card>
        ) : (
          <>
            <Card title={person.name} kicker="PLAYER">
              <p className="small-text muted" data-testid="player-basis">
                {person.seasons.length}シーズンの合算
                {person.linked ? '（n01のIDが一意と確認できた季のみ結合）' : ''} ・ 出場 {person.metrics.counts.match ?? '—'} 試合（勝利数ではありません）
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
                  const st = standingOf(rankIn(population.scoped.members, m), person.personKey);
                  return (
                    <MetricCard
                      key={m}
                      label={METRIC_LABEL[m]}
                      value={formatValue(m, ratio.value)}
                      sample={sampleText(m)}
                      reliability={reliabilityOf(m, ratio)}
                      compare={diff}
                      rank={st.rank ? `${SCOPE_LABEL[activeScope]} ${st.rank}位 / ${st.population}名` : undefined}
                    />
                  );
                })}
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
                <p className="small-text muted">100+/140+/170+/180 は n01 が区分ごとに報告する回数です。区分の重なりは未確認のため合計していません。</p>
              </details>
              {myStanding?.state === 'reference' ? <p className="small-text muted">この指標はサンプル数が基準({MIN_SAMPLE[metric as MetricId] ?? '—'})未満のため、順位に含めていません。</p> : null}
            </Card>

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
    </div>
  );
}

function InsightList({ insights, scopeLabel }: { insights: ReturnType<typeof buildInsights>; scopeLabel: string }): React.JSX.Element {
  if (insights.held) {
    return (
      <p className="small-text" data-testid="insight-held">
        {insights.held}
      </p>
    );
  }
  const line = (i: Insight): React.JSX.Element => (
    <li key={`${i.kind}-${i.metric}`}>
      <strong>{METRIC_LABEL[i.metric]}</strong> {formatValue(i.metric, i.value)}（{scopeLabel}平均 {formatValue(i.metric, i.average)}、{i.diffText}）
      <span className="meta">
        サンプル {i.sample.toLocaleString('ja-JP')} ・ 比較 {i.population}名{i.rank ? ` ・ ${i.rank}位` : ''}
      </span>
    </li>
  );
  return (
    <div className="insights">
      <div>
        <h3 className="mini-title">強み</h3>
        {insights.strengths.length > 0 ? <ul className="plain-list">{insights.strengths.map(line)}</ul> : <p className="small-text muted">明確な強みは検出されませんでした。</p>}
      </div>
      <div>
        <h3 className="mini-title">改善候補</h3>
        {insights.improvements.length > 0 ? <ul className="plain-list">{insights.improvements.map(line)}</ul> : <p className="small-text muted">明確な改善候補は検出されませんでした。</p>}
      </div>
      <p className="small-text muted">同じ期間・同じ母集団の平均との数値差です。原因（スコアリング力・フィニッシュ力など）を示すものではありません。</p>
    </div>
  );
}
