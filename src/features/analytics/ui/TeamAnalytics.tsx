import { useId, useMemo, useState } from 'react';
import { Card } from '../../../components/ui';
import type { Player, Team } from '../../../domain/types';
import { aggregatePlayers } from '../aggregate';
import { formatSample, formatValue, METRIC_LABEL, RANK_METRICS } from '../format';
import type { RankMetric } from '../format';
import { MIN_SAMPLE, reliabilityOf } from '../metrics';
import { buildInsightsFor, cellText, COMPARE_METRICS, metricValue, standingOf } from '../playerView';
import type { TeamScope } from '../ranking';
import type { PeriodLoad } from '../service/periodService';
import { buildTeamPopulation, findTeamPeriod, officialOf, officialPerSeason, rankTeams, resolveBaseTeam, teamPlayerRows, teamTrend, unlinkedSeasons } from '../teamView';
import type { MetricId } from '../types';
import { InsightList, MetricCard, RankingTable, Segmented, TrendChart } from './parts';

/**
 * TEAM ANALYTICS (design §5). The team's own scorecard, n01's official standing (shown as
 * given, per season and division), League Order's own ordering (clearly a different list),
 * comparison with other teams, the season trend, and the team's players.
 */

type ScopeKind = 'division' | 'league';
const SCOPE_LABEL: Record<ScopeKind, string> = { division: 'ディビジョン', league: 'リーグ全体' };
const CARD_METRICS: MetricId[] = ['ppr', 'first9', 'legRate', 'setRate', 'keep', 'break'];
const TREND_METRICS: MetricId[] = ['ppr', 'first9', 'legRate'];
const MAX_COMPARE = 3;

export function TeamAnalytics({
  team,
  load,
  baseTournamentId,
}: {
  team: Team;
  players: Player[];
  load: PeriodLoad;
  baseTournamentId: string;
}): React.JSX.Element {
  const base = load.seasons.find((s) => s.tournamentId === baseTournamentId) ?? null;
  const binding = team.n01;
  const baseTeam = useMemo(() => (base && binding ? resolveBaseTeam(base, binding) : null), [base, binding]);

  const available: ScopeKind[] = baseTeam?.divisionIndex !== null && baseTeam?.divisionIndex !== undefined ? ['division', 'league'] : ['league'];
  const [scopeKind, setScopeKind] = useState<ScopeKind>('division');
  const activeScope: ScopeKind = available.includes(scopeKind) ? scopeKind : available[0];
  const scope: TeamScope =
    activeScope === 'division' && baseTeam?.divisionIndex !== null && baseTeam?.divisionIndex !== undefined
      ? { kind: 'division', divisionIndex: baseTeam.divisionIndex }
      : { kind: 'league' };
  const scopeKey = scope.kind === 'division' ? `division:${scope.divisionIndex}` : 'league';

  const population = useMemo(
    () => buildTeamPopulation(load.seasons, scope, baseTournamentId),
    // `scope` is fully described by `scopeKey`.
    [load.seasons, scopeKey, baseTournamentId],
  );
  const myPeriod = useMemo(() => (baseTeam ? findTeamPeriod(population.teams, baseTournamentId, baseTeam.teamId) : null), [population.teams, baseTournamentId, baseTeam]);
  const people = useMemo(() => aggregatePlayers(load.seasons), [load.seasons]);

  const [metric, setMetric] = useState<RankMetric>('ppr');
  const [trendMetric, setTrendMetric] = useState<MetricId>('ppr');
  const [compare, setCompare] = useState<string[]>([]);
  const metricSelectId = useId();
  const compareSelectId = useId();

  if (!base || !baseTeam || !myPeriod) {
    return (
      <Card title="チーム分析" kicker="TEAM">
        <p className="small-text" data-testid="team-unresolved">
          {!base
            ? '基準となるシーズンの成績を取得できませんでした。期間を変えるか、再取得してください。'
            : 'このシーズンで自チームを一意に特定できませんでした（チーム名の変更・同名チームなど）。今季、またはチームを連携したシーズンでご確認ください。'}
        </p>
      </Card>
    );
  }

  const official = officialOf(base, baseTeam);
  const myKey = myPeriod.teamKey;
  const ranking = rankTeams(population.scoped.members, metric);
  const rankingFor = (m: MetricId) => rankTeams(population.scoped.members, m);
  const insights = buildInsightsFor({ key: myKey, metrics: myPeriod.metrics }, population.averages, rankingFor);
  const comparePeriods = compare.map((key) => population.teams.find((t) => t.teamKey === key)).filter((t): t is NonNullable<typeof t> => !!t);
  const compareCandidates = population.scoped.members.filter((t) => t.teamKey !== myKey && !compare.includes(t.teamKey));
  const unlinked = unlinkedSeasons(myPeriod, load.seasons);
  const rows = teamPlayerRows(people, baseTournamentId, baseTeam.teamId, myPeriod);
  const m = myPeriod.metrics;
  const hasLine = baseTeam.line !== null || myPeriod.seasons.some((s) => s.line !== null);
  const match = myPeriod.match;

  return (
    <div className="analytics-columns">
      <div className="analytics-col">
        <Card title={myPeriod.name} kicker="TEAM">
          <p className="small-text muted" data-testid="team-basis">
            {myPeriod.seasons.filter((s) => s.line !== null).length}シーズンの合算（チームの成績行のみ。選手個人の成績は加算していません）
          </p>
          {!hasLine ? (
            <p className="small-text" data-testid="team-unmeasured">
              n01 にこのチームの成績行がありません（未対戦・未計測）。0 とは扱いません。
            </p>
          ) : (
            <div className="metric-grid">
              {CARD_METRICS.map((id) => {
                const ratio = m[id];
                const avg = population.averages[id];
                const diff =
                  ratio.value !== null && avg.value !== null
                    ? id === 'ppr' || id === 'first9'
                      ? `${SCOPE_LABEL[activeScope]}平均 ${formatValue(id, avg.value)}（${ratio.value - avg.value >= 0 ? '+' : ''}${(ratio.value - avg.value).toFixed(2)}）`
                      : `${SCOPE_LABEL[activeScope]}平均 ${formatValue(id, avg.value)}（${ratio.value - avg.value >= 0 ? '+' : ''}${((ratio.value - avg.value) * 100).toFixed(1)}pt）`
                    : undefined;
                const st = standingOf(rankTeams(population.scoped.members, id), myKey);
                return (
                  <MetricCard
                    key={id}
                    label={METRIC_LABEL[id]}
                    value={formatValue(id, ratio.value)}
                    sample={formatSample(id, ratio.den)}
                    reliability={reliabilityOf(id, ratio)}
                    compare={diff}
                    rank={st.rank ? `独自 ${st.rank}位 / ${st.population}チーム` : undefined}
                  />
                );
              })}
            </div>
          )}
          <details className="analytics-details" open>
            <summary>Match / Set / Leg 実績とスコア記録</summary>
            <dl className="kv-grid">
              <div>
                <dt>Match</dt>
                <dd data-testid="team-match">
                  {match ? `${match.won}勝${match.drawn}分${match.lost}敗（${match.played}試合）` : '—'}
                </dd>
              </div>
              <div>
                <dt>Match勝率</dt>
                <dd>{match?.winRate !== null && match?.winRate !== undefined ? formatValue('legRate', match.winRate) : '—'}</dd>
              </div>
              <div>
                <dt>Set</dt>
                <dd>{m.setRate.den > 0 ? `${m.setRate.num}勝 / ${m.setRate.den}` : '—'}</dd>
              </div>
              <div>
                <dt>Leg</dt>
                <dd>{m.legRate.den > 0 ? `${m.legRate.num}勝 / ${m.legRate.den}` : '—'}</dd>
              </div>
              {(
                [
                  ['100+', m.counts.ton00, 'ton00Rate'],
                  ['140+', m.counts.ton40, 'ton40Rate'],
                  ['170+', m.counts.ton70, 'ton70Rate'],
                  ['180', m.counts.ton80, 'ton80Rate'],
                ] as const
              ).map(([label, count, rate]) => (
                <div key={label}>
                  <dt>{label}</dt>
                  <dd>
                    {count === null ? '—' : `${count}回`}
                    {m[rate].value !== null ? `（${(m[rate].value! * 100).toFixed(1)}% / Leg）` : ''}
                  </dd>
                </div>
              ))}
              <div>
                <dt>High Finish</dt>
                <dd>{m.extremes.highOut ?? '記録なし'}</dd>
              </div>
              <div>
                <dt>Best Leg</dt>
                <dd>{m.extremes.bestLeg !== null ? `${m.extremes.bestLeg}本` : '記録なし'}</dd>
              </div>
            </dl>
            <p className="small-text muted">
              Match の勝敗は n01 の公式順位表と成績の両方が一致した季のみ集計しています。100+/140+/170+/180 は n01 が区分ごとに報告する回数で、区分の重なりは未確認のため合計していません。
            </p>
          </details>
        </Card>

        <Card title="公式順位（n01）" kicker="OFFICIAL">
          {official.group ? (
            <>
              <p className="small-text muted" data-testid="official-basis">
                {base.title} ・ {official.group.title}。n01が計算した、この季・このディビジョンだけの順位表です。
              </p>
              <div className="analytics-table-wrap">
                <table className="analytics-table" data-testid="official-table">
                  <caption>{base.title} {official.group.title} の公式順位</caption>
                  <thead>
                    <tr>
                      <th scope="col">順位</th>
                      <th scope="col">チーム</th>
                      <th scope="col" className="num">勝分敗</th>
                      <th scope="col" className="num">Pts</th>
                    </tr>
                  </thead>
                  <tbody>
                    {official.group.rows.map((row) => (
                      <tr key={row.teamId} className={row.teamId === baseTeam.teamId ? 'me' : ''} aria-current={row.teamId === baseTeam.teamId ? 'true' : undefined}>
                        <td className="rank">{row.rank > 0 ? row.rank : '未対戦'}</td>
                        <th scope="row">{row.name}</th>
                        <td className="num">{row.won}-{row.drawn}-{row.lost}</td>
                        <td className="num">{row.points}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          ) : (
            <p className="small-text" data-testid="official-missing">
              このシーズンの公式順位を取得できませんでした。
            </p>
          )}
          {myPeriod.seasons.length > 1 ? (
            <details className="analytics-details">
              <summary>シーズン別の公式順位</summary>
              <div className="analytics-table-wrap">
                <table className="analytics-table compact" data-testid="official-seasons">
                  <caption>シーズン別の公式順位（合算・平均はしません）</caption>
                  <thead>
                    <tr>
                      <th scope="col">シーズン</th>
                      <th scope="col" className="num">順位</th>
                      <th scope="col" className="num">勝分敗</th>
                      <th scope="col" className="num">Pts</th>
                    </tr>
                  </thead>
                  <tbody>
                    {officialPerSeason(myPeriod).map((line) => (
                      <tr key={line.tournamentId}>
                        <th scope="row">{line.title}</th>
                        <td className="num">{line.rank ?? '—'}</td>
                        <td className="num">{line.record ?? '—'}</td>
                        <td className="num">{line.points ?? '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </details>
          ) : null}
        </Card>

        <Card title="独自ランキング" kicker="RANKING" className="analytics-rank">
          <p className="small-text muted" data-testid="own-ranking-note">
            League Order が成績の数値から並べた順位で、n01の公式順位とは別物です。
          </p>
          <Segmented label="比較する母集団" value={activeScope} onChange={setScopeKind} options={available.map((k) => ({ value: k, label: SCOPE_LABEL[k] }))} />
          <div className="field">
            <label htmlFor={metricSelectId}>
              <span>指標</span>
            </label>
            <select id={metricSelectId} value={metric} onChange={(event) => setMetric(event.target.value as RankMetric)}>
              {RANK_METRICS.map((id) => (
                <option key={id} value={id}>
                  {METRIC_LABEL[id]}
                </option>
              ))}
            </select>
          </div>
          {population.scoped.includesOtherDivisions ? (
            <p className="small-text muted" data-testid="other-division-note">
              他のディビジョンでの成績を含みます（純粋な同一ディビジョン比較ではありません）。
            </p>
          ) : null}
          {activeScope === 'league' ? (
            <p className="small-text muted" data-testid="cross-division-note">
              ディビジョンや対戦相手の水準が異なるため、この並びはディビジョン間の強さの優劣を示すものではありません。
            </p>
          ) : null}
          <RankingTable ranking={ranking} metric={metric} highlight={myKey} caption={`${SCOPE_LABEL[activeScope]}の${METRIC_LABEL[metric]}（独自ランキング）`} entityLabel="チーム" />
        </Card>
      </div>

      <div className="analytics-col">
        <Card title="強みと改善候補" kicker="INSIGHT">
          <InsightList insights={insights} scopeLabel={SCOPE_LABEL[activeScope]} />
        </Card>

        <Card title="シーズン推移" kicker="TREND">
          <Segmented label="推移の指標" value={trendMetric} onChange={setTrendMetric} options={TREND_METRICS.map((id) => ({ value: id, label: METRIC_LABEL[id] }))} />
          <TrendChart points={teamTrend(myPeriod, trendMetric)} metric={trendMetric} />
          {unlinked.length > 0 ? (
            <p className="small-text muted" data-testid="unlinked-note">
              {unlinked.map((s) => s.title).join('、')} は、チーム名の変更や同名チームなどで同一チームと確認できないため、このチームの推移に含めていません。
            </p>
          ) : null}
        </Card>

        <Card title="他チームと比較" kicker="COMPARE">
          <div className="field">
            <label htmlFor={compareSelectId}>
              <span>比較するチームを追加（最大{MAX_COMPARE}チーム）</span>
            </label>
            <select id={compareSelectId} value="" disabled={compare.length >= MAX_COMPARE} onChange={(event) => event.target.value && setCompare([...compare, event.target.value])}>
              <option value="">チームを選択…</option>
              {compareCandidates
                .slice()
                .sort((a, b) => a.name.localeCompare(b.name, 'ja'))
                .map((c) => (
                  <option key={c.teamKey} value={c.teamKey}>
                    {c.name}
                  </option>
                ))}
            </select>
          </div>
          {comparePeriods.length > 0 ? (
            <>
              <div className="chip-row">
                {comparePeriods.map((c) => (
                  <button key={c.teamKey} type="button" className="chip on" aria-label={`${c.name}を比較から外す`} onClick={() => setCompare(compare.filter((k) => k !== c.teamKey))}>
                    {c.name} ×
                  </button>
                ))}
              </div>
              <div className="analytics-table-wrap">
                <table className="analytics-table" data-testid="team-compare-table">
                  <caption>{SCOPE_LABEL[activeScope]}のチーム比較</caption>
                  <thead>
                    <tr>
                      <th scope="col">指標</th>
                      {[myPeriod, ...comparePeriods].map((t) => (
                        <th key={t.teamKey} scope="col">
                          {t.name}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {COMPARE_METRICS.map((id) => {
                      const cells = [myPeriod, ...comparePeriods].map((t) => ({ t, ...cellText(t, id), ...metricValue(t, id) }));
                      const valued = cells.filter((c) => c.value !== null && !c.reference);
                      const best = valued.length > 1 ? (id === 'bestLeg' ? Math.min(...valued.map((c) => c.value as number)) : Math.max(...valued.map((c) => c.value as number))) : null;
                      return (
                        <tr key={id}>
                          <th scope="row">{METRIC_LABEL[id]}</th>
                          {cells.map((c) => (
                            <td key={c.t.teamKey} className={`num${best !== null && c.value === best ? ' best' : ''}`}>
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
              <p className="small-text muted">「参考」はサンプル数が基準({MIN_SAMPLE.ppr}投など)未満です。最良値の強調は基準を満たす値同士のみで行います。</p>
            </>
          ) : (
            <p className="small-text muted">比較するチームを追加すると、指標を並べて表示します。</p>
          )}
        </Card>

        <Card title="チームの選手" kicker="PLAYERS">
          <div className="analytics-table-wrap">
            <table className="analytics-table" data-testid="team-players-table">
              <caption>{base.title} のチームの選手（期間内の合算）</caption>
              <thead>
                <tr>
                  <th scope="col">選手</th>
                  <th scope="col" className="num">3DA</th>
                  <th scope="col" className="num">Leg勝率</th>
                  <th scope="col" className="num">関与Leg</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(({ person, involvement }) => {
                  const ppr = cellText(person, 'ppr');
                  const leg = cellText(person, 'legRate');
                  return (
                    <tr key={person.personKey}>
                      <th scope="row">{person.name}</th>
                      <td className="num">
                        {ppr.text}
                        {ppr.reference ? <span className="sub">参考</span> : null}
                      </td>
                      <td className="num">
                        {leg.text}
                        {leg.reference ? <span className="sub">参考</span> : null}
                      </td>
                      <td className="num">{involvement === null ? '—' : `${(involvement * 100).toFixed(0)}%`}</td>
                    </tr>
                  );
                })}
                {rows.length === 0 ? (
                  <tr>
                    <td colSpan={4} className="muted">
                      選手の成績行がありません。
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
          <p className="small-text muted">
            「関与Leg」はチームのLeg数のうち、その選手が出場したLegの割合です（基準シーズン）。ダブルスのLegは両者に数えるため合計は100%を超え、勝利への貢献度ではありません。選手の成績をチームの成績に加算することはしていません。
          </p>
        </Card>
      </div>
    </div>
  );
}
