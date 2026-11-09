import { useMemo } from 'react';
import type { MatchesApi } from '../api';
import type { LiveState, LiveThrow } from '../parse';
import { withLiveLeg } from '../parse';
import { gameStats } from '../gameStats';
import { checkoutRoute, freshLegChance, legChance, liveEstimateScope, shrunkAverage } from '../checkout';
import { useGameLegs } from './useGameLegs';
import { LegsStatusLine } from './LegsStatusLine';
import { raceChance } from '../probability';
import { ZeroOneGrid } from './ScoreGrid';
import { FinishChances, RaceChart } from './LegCharts';

/**
 * The live game the way a darts scoreboard shows it — the layout spectators know from n01's
 * viewer: legs in the header, the score sheet of the leg (Scored / To Go per visit, darts in
 * the middle), the points left large at the bottom, the game's figures below.
 *
 * Then what only League Order adds, in two visibly separate blocks:
 * - 実績 (what happened): the thrower's standard route, the race chart, finishing chances, recent
 *   form against the game average, the legs so far, (league cards) n01's season average;
 * - 参考予測 (a model; the leg chance recalibrated on past games, the game chance unchecked): the chance of taking this leg and the game, shown only
 *   where the model applies (`liveEstimateScope`) — otherwise no number at all.
 *
 * The game's legs come from `useGameLegs`, bound to this game's `mid`: figures computed from
 * the legs wait until they are read, and a failed read says so (with a retry) instead of
 * showing another game's legs or a partial game as the whole.
 */

const fmt = (value: number | null, digits = 2): string => (value === null ? '—' : value.toFixed(digits));

export function LiveSheet({ api, live, seasonAverage }: { api: MatchesApi; live: LiveState; seasonAverage?: [number | null, number | null] }): React.JSX.Element {
  const cricket = live.matchType === 'cricket';
  const leg = live.leg;
  // Where the game is: the live leg, or n01's current leg when the poller carries no leg.
  const legIndex = leg?.index ?? live.currentLeg ?? null;
  const history = useGameLegs(api, live.mid, { finished: false, liveLegIndex: legIndex });
  // Every ended leg is held: only then are the game's figures and the estimate shown.
  const complete = history.complete;

  // The live leg laid over the legs read for this game, keeping its own bull flag and darts.
  const all = useMemo(() => withLiveLeg(history.legs, leg), [history.legs, leg]);
  const stats = useMemo(() => gameStats(all, cricket), [all, cricket]);
  const names: [string, string] = [live.sides[0].members.join(' / ') || live.sides[0].name, live.sides[1].members.join(' / ') || live.sides[1].name];
  const thrower = leg && !leg.ended ? leg.thrower : null;

  // --- League Order's own figures ---------------------------------------------------------
  const average: [number, number] = [shrunkAverage(stats[0].rate, stats[0].darts), shrunkAverage(stats[1].rate, stats[1].darts)];
  const left = leg?.left ?? null;
  const need = live.limitLeg;
  const scope = liveEstimateScope({ cricket, left, thrower, startScore: live.startScore, limitLeg: need, drawMode: live.drawMode, complete });
  const legP = scope.leg && left && thrower !== null ? legChance(left, average, thrower) : null;
  const gameP =
    legP !== null && scope.game && need && live.startScore
      ? (() => {
          const q = freshLegChance(average, live.startScore);
          return legP * raceChance(q, need, live.legs[0] + 1, live.legs[1]) + (1 - legP) * raceChance(q, need, live.legs[0], live.legs[1] + 1);
        })()
      : null;
  const recent = (side: 0 | 1): number | null => {
    if (!complete) return null;
    const mine = (leg?.throws ?? []).filter((entry): entry is Extract<LiveThrow, { kind: '01' }> => entry.side === side && entry.kind === '01');
    const visits = [...all.flatMap((entry) => (entry.index === leg?.index ? [] : entry.throws)), ...mine].filter((entry): entry is Extract<LiveThrow, { kind: '01' }> => entry.side === side && entry.kind === '01').slice(-3);
    return visits.length === 3 ? visits.reduce((sum, entry) => sum + entry.score, 0) / 3 : null;
  };
  const route = !cricket && left && thrower !== null ? checkoutRoute(left[thrower]) : null;

  return (
    <section className="n01-sheet" aria-label="ライブスコア" data-testid="live-board">
      <header className="ns-head">
        <div className="ns-title">
          <span>
            {live.title || 'ゲーム'}
            {need ? ` (${need} Leg先取)` : ''}
          </span>
          {!live.gameEnded ? <span className="ns-live">Live</span> : <span className="ns-live done">終了</span>}
        </div>
        <div className="ns-names">
          <span>
            {leg?.first === 0 ? '* ' : ''}
            {names[0]}
          </span>
          <strong aria-label={`Leg ${live.legs[0]} 対 ${live.legs[1]}`}>
            {live.legs[0]} - {live.legs[1]}
          </strong>
          <span>
            {leg?.first === 1 ? '* ' : ''}
            {names[1]}
          </span>
        </div>
      </header>

      {leg ? (
        cricket ? (
          <CricketBoard leg={leg} />
        ) : (
          <div className="ns-scroll">
            <ZeroOneGrid leg={leg} startScore={live.startScore} thrower={thrower} minRows={4} spare={leg.ended ? 0 : 1} />
          </div>
        )
      ) : null}

      <div className="ns-left" aria-label={cricket ? '点数' : '残り点数'}>
        {([0, 1] as const).map((side) => (
          <div key={side} className={`ns-big${thrower === side ? ' on' : ''}`} data-testid={thrower === side ? 'next-thrower' : undefined}>
            {cricket ? (leg?.points?.[side] ?? 0) : (leg?.left?.[side] ?? live.startScore ?? '—')}
            {thrower === side && leg?.member ? <span className="ns-member">{leg.member}</span> : null}
          </div>
        ))}
      </div>

      {!complete ? <LegsStatusLine history={history} /> : null}
      {complete ? (
      <table className="ns-stats" aria-label="このゲームのスタッツ">
        <tbody>
          {(cricket
            ? [
                ['MPR', fmt(stats[0].rate), fmt(stats[1].rate)],
                ...[9, 8, 7, 6, 5].map((marks) => [`${marks} Mark`, String(stats[0].markVisits[marks]), String(stats[1].markVisits[marks])]),
                ['Best Leg', stats[0].bestLeg ?? '—', stats[1].bestLeg ?? '—'],
              ]
            : [
                ['3 Darts', fmt(stats[0].rate), fmt(stats[1].rate)],
                ['First 9', fmt(stats[0].first9), fmt(stats[1].first9)],
                ['100+', String(stats[0].ton), String(stats[1].ton)],
                ['140+', String(stats[0].ton40), String(stats[1].ton40)],
                ["180's", String(stats[0].ton80), String(stats[1].ton80)],
                ['High Finish', stats[0].highOut ?? '—', stats[1].highOut ?? '—'],
                ['Best Leg', stats[0].bestLeg ?? '—', stats[1].bestLeg ?? '—'],
              ]
          ).map(([label, a, b]) => (
            <tr key={String(label)}>
              <td>{a}</td>
              <th scope="row">{label}</th>
              <td>{b}</td>
            </tr>
          ))}
        </tbody>
      </table>
      ) : null}

      <div className="ns-plus" data-testid="league-order-plus">
        <h3 className="section-mini">League Order の分析 (記録から)</h3>
        {route && thrower !== null ? (
          <p className="ns-route" data-testid="checkout-route">
            基準ルート ({names[thrower]} 残り {left![thrower]}): <strong>{route.join(' ')}</strong>
            <span className="muted small-text"> ・ 01 Arrangement Support の基準ルート</span>
          </p>
        ) : !cricket && left && thrower !== null && left[thrower] <= 170 && left[thrower] > 1 ? (
          <p className="ns-route muted">残り {left[thrower]} は 3 本で上がれない数字です (セットアップ)。</p>
        ) : null}
        {!cricket && leg ? <RaceChart leg={leg} startScore={live.startScore} names={names} /> : null}
        {!cricket && complete ? <FinishChances legs={all} names={names} /> : null}
        {!cricket ? (
          <table className="ns-form small-text">
            <tbody>
              <tr>
                <td>{trend(recent(0), stats[0].rate)}</td>
                <th scope="row">直近3ラウンド平均</th>
                <td>{trend(recent(1), stats[1].rate)}</td>
              </tr>
              {seasonAverage && (seasonAverage[0] !== null || seasonAverage[1] !== null) ? (
                <tr>
                  <td>{fmt(seasonAverage[0])}</td>
                  <th scope="row">今季平均 (n01 公式)</th>
                  <td>{fmt(seasonAverage[1])}</td>
                </tr>
              ) : null}
            </tbody>
          </table>
        ) : null}
        {complete && all.filter((entry) => entry.ended).length > 0 ? (
          <ol className="ns-legs small-text" aria-label="Legの経過">
            {all
              .filter((entry) => entry.ended)
              .map((entry) => {
                const winner = entry.winner === 0 || entry.winner === 1 ? entry.winner : null;
                const finish = [...entry.throws].reverse().find((t) => t.kind === '01' && t.finish) as Extract<LiveThrow, { kind: '01' }> | undefined;
                const darts = winner === null ? null : entry.dartsTotal?.[winner] ?? entry.throws.filter((t) => t.side === winner).reduce((sum, t) => sum + (t.kind === '01' ? t.darts : 3), 0);
                return (
                  <li key={entry.index}>
                    L{entry.index + 1}: {winner === null ? '—' : names[winner]}
                    {darts ? ` ${darts}本` : ''}
                    {finish ? ` ・ ${finish.score} アウト` : ''}
                    {entry.bull ? ' ・ ブル決着' : ''}
                  </li>
                );
              })}
          </ol>
        ) : null}
        {!cricket ? (
          <div className="ns-estimate" data-testid="live-estimate">
            <h3 className="section-mini">
              参考予測 <span className="tag">参考</span>
            </h3>
            {legP !== null ? (
              <div className="ns-chance" data-testid="leg-chance">
                <span>このLeg</span>
                <span className="bar" aria-hidden="true">
                  <i style={{ width: `${Math.round(legP * 100)}%` }} />
                </span>
                <span>
                  {Math.round(legP * 100)}% - {100 - Math.round(legP * 100)}%
                </span>
              </div>
            ) : null}
            {gameP !== null ? (
              <div className="ns-chance" data-testid="game-chance">
                <span>{live.showSets ? 'このセット' : 'このゲーム'}</span>
                <span className="bar" aria-hidden="true">
                  <i style={{ width: `${Math.round(gameP * 100)}%` }} />
                </span>
                <span>
                  {Math.round(gameP * 100)}% - {100 - Math.round(gameP * 100)}%
                </span>
              </div>
            ) : null}
            <p className="muted small-text">
              {legP !== null
                ? `残り点・このゲームの平均・次に投げる側から計算した参考値です (Leg は過去の試合で簡易検証、${live.showSets ? 'セット' : 'ゲーム'}は未検証)。${gameP === null && 'reason' in scope ? `${live.showSets ? 'セット' : 'ゲーム'}の予測なし: ${scope.reason}。` : ''}`
                : `予測なし: ${'reason' in scope ? scope.reason : '—'}。`}
            </p>
          </div>
        ) : null}
      </div>
    </section>
  );
}

function trend(recent: number | null, game: number | null): string {
  if (recent === null) return '—';
  if (game === null) return recent.toFixed(1);
  const arrow = recent - game >= 5 ? ' ↑' : recent - game <= -5 ? ' ↓' : '';
  return `${recent.toFixed(1)}${arrow}`;
}

function CricketBoard({ leg }: { leg: NonNullable<LiveState['leg']> }): React.JSX.Element {
  const mark = (value: number): string => (value >= 3 ? 'Ⓧ' : value === 2 ? 'X' : value === 1 ? '/' : '');
  const numbers = leg.numbers ?? [20, 19, 18, 17, 16, 15, 25];
  return (
    <div className="ns-scroll">
      <table className="ns-table cricket" data-testid="score-sheet">
        <tbody>
          {numbers.map((number, index) => (
            <tr key={number}>
              <td className="sc">
                {mark(leg.marks?.[0][index] ?? 0)}
                {(leg.marks?.[0][index] ?? 0) > 3 ? <small> +{(leg.marks![0][index] - 3)}</small> : null}
              </td>
              <td className="mid">{number === 25 ? 'BULL' : number}</td>
              <td className="sc">
                {mark(leg.marks?.[1][index] ?? 0)}
                {(leg.marks?.[1][index] ?? 0) > 3 ? <small> +{(leg.marks![1][index] - 3)}</small> : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
