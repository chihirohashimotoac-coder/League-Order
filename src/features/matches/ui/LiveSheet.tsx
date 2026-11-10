import { useMemo, useState } from 'react';
import type { MatchesApi } from '../api';
import type { LiveState, LiveThrow, ThrowLeg } from '../parse';
import { withLiveLeg } from '../parse';
import { gameStats } from '../gameStats';
import { checkoutRoute, freshLegChance, legChance, liveEstimateScope, shrunkAverage } from '../checkout';
import { useGameLegs } from './useGameLegs';
import { LegsStatusLine } from './LegsStatusLine';
import { raceChance } from '../probability';
import { CricketGrid, ZeroOneGrid } from './ScoreGrid';
import { FinishChances, RaceChart } from './LegCharts';
import { useFollowLatest } from './useFollowLatest';

/**
 * The live game the way a darts scoreboard shows it — the layout spectators know from n01's
 * viewer: legs in the header, the points left large right under it (the first thing a spectator
 * looks for, so it needs no scrolling), the score sheet of the leg (Scored / To Go per visit,
 * darts in the middle), the game's figures below.
 *
 * Then what only League Order adds, in two visibly separate blocks:
 * - 実績 (what happened): the thrower's standard route, the race chart, finishing chances, recent
 *   form against the game average, the legs so far, (league cards) n01's season average;
 * - 参考予測 (a model; the leg chance recalibrated on past games, the game chance unchecked): the chance of taking this leg and the game, shown only
 *   where the model applies (`liveEstimateScope`) — otherwise no number at all.
 *
 * Which leg is on is said in words under the score (「Leg 3 進行中」) and in the row of legs below
 * it: one chip per leg, the ended ones with their winner and darts. A tap on an ended leg shows
 * that leg's score sheet in place of the live one — the points left stay live underneath — and
 * one tap returns to the leg in progress.
 *
 * `levels` (league cards) are n01's own season figures of the players in this game, shown under
 * the names: how strong the opponent is, without leaving the scoreboard.
 *
 * The game's legs come from `useGameLegs`, bound to this game's `mid`: figures computed from
 * the legs wait until they are read, and a failed read says so (with a retry) instead of
 * showing another game's legs or a partial game as the whole.
 */

const fmt = (value: number | null, digits = 2): string => (value === null ? '—' : value.toFixed(digits));

/** A player's season figures as n01 counts them (`null` = n01 has none; never shown as 0). */
export interface PlayerLevel {
  /** The season member id, when the name matched exactly one member of the team. */
  oid: string | null;
  name: string;
  teamId: string | null;
  average: number | null;
  legs: number | null;
  legsWon: number | null;
}

/** The first word of a name, for a chip: 「青木 一郎 / 井上 次郎」 → 「青木」. */
const shortName = (name: string): string => {
  const first = name.split('/')[0].trim().split(/\s+/u)[0] ?? name;
  return first.length > 7 ? `${first.slice(0, 6)}…` : first;
};

function legDarts(entry: ThrowLeg, winner: 0 | 1): number | null {
  const total = entry.dartsTotal?.[winner] ?? entry.throws.filter((t) => t.side === winner).reduce((sum, t) => sum + (t.kind === '01' ? t.darts : 3), 0);
  return total > 0 ? total : null;
}

export function LiveSheet({
  api,
  live,
  title,
  levels,
  onPlayer,
}: {
  api: MatchesApi;
  live: LiveState;
  /** A short name of the game (the slot: 「シングルス1」) in place of n01's long title. */
  title?: string;
  /** Season figures of each side's players (n01 side order), league cards only. */
  levels?: [PlayerLevel[], PlayerLevel[]];
  /** Opens a player's card (league cards). */
  onPlayer?: (player: { oid: string; name: string; teamId: string | null }) => void;
}): React.JSX.Element {
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
  // An ended leg the viewer chose to look at; `null` = the leg in progress.
  const [pickedLeg, setPickedLeg] = useState<number | null>(null);
  const past = pickedLeg !== null && pickedLeg !== legIndex ? (all.find((entry) => entry.index === pickedLeg && entry.ended) ?? null) : null;
  // The score sheet's own box follows the newest visit while the viewer is at it (01 only).
  const follow = useFollowLatest<HTMLDivElement>({ enabled: !cricket && leg !== null, game: live.mid, update: leg });
  const toLive = (): void => {
    setPickedLeg(null);
    follow.resume();
  };
  const ended = all.filter((entry) => entry.ended && entry.index !== legIndex);
  const hasLevels = !!levels && levels.some((side) => side.some((entry) => entry.average !== null || entry.legs !== null));

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
          {legIndex !== null && !live.gameEnded ? (
            <span data-testid="live-leg">
              <span className="live-dot" aria-hidden="true" /> {title || live.title || 'ゲーム'} ・ <strong>Leg {legIndex + 1} 進行中</strong>
              {need ? <span className="ns-need"> ({need} Leg先取)</span> : null}
            </span>
          ) : (
            <span>
              {title || live.title || 'ゲーム'}
              {need ? ` (${need} Leg先取)` : ''}
            </span>
          )}
          {live.gameEnded ? <span className="ns-live done">終了</span> : <span className="sr-only">Live</span>}
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

      <div className="ns-body">
        <div className="ns-board">
          {past ? <p className="ns-left-note small-text">進行中の Leg {legIndex !== null ? legIndex + 1 : ''} の{cricket ? '点数' : '残り点数'}</p> : null}
          <div className="ns-left" aria-label={cricket ? '点数' : '残り点数'}>
            {([0, 1] as const).map((side) => (
              <div key={side} className={`ns-big${thrower === side ? ' on' : ''}`} data-testid={thrower === side ? 'next-thrower' : undefined}>
                {cricket ? (leg?.points?.[side] ?? 0) : (leg?.left?.[side] ?? live.startScore ?? '—')}
                {thrower === side && leg?.member ? <span className="ns-member">{leg.member}</span> : null}
              </div>
            ))}
          </div>
          {legIndex !== null && (ended.length > 0 || legIndex > 0) ? (
            <div className="ns-legtabs" role="group" aria-label="Leg を選ぶ" data-testid="leg-tabs">
              {Array.from({ length: legIndex + 1 }, (_, index) => {
                const entry = all.find((held) => held.index === index);
                const isLive = index === legIndex;
                const winner = entry && !isLive && entry.ended && (entry.winner === 0 || entry.winner === 1) ? entry.winner : null;
                const darts = entry && winner !== null ? legDarts(entry, winner) : null;
                const usable = isLive || (entry?.ended ?? false);
                return (
                  <button
                    key={index}
                    type="button"
                    className={`leg-tab${isLive ? ' is-live' : ''}`}
                    aria-pressed={isLive ? past === null : past?.index === index}
                    disabled={!usable}
                    onClick={() => (isLive ? toLive() : setPickedLeg(index))}
                  >
                    <span className="l">Leg {index + 1}</span>
                    <span className="w">
                      {isLive ? (
                        <>
                          <span className="live-dot" aria-hidden="true" /> 進行中
                        </>
                      ) : winner !== null ? (
                        `${shortName(names[winner])}${darts ? ` ${darts}本` : ''}${entry?.bull ? ' (ブル)' : ''}`
                      ) : usable ? (
                        '終了'
                      ) : (
                        '取得中…'
                      )}
                    </span>
                  </button>
                );
              })}
            </div>
          ) : null}

          {past ? (
            <div className="ns-past" data-testid="past-leg">
              <p className="ns-past-bar small-text">
                <span>
                  <strong>Leg {past.index + 1}</strong> (終了) のスコアを表示中
                </span>
                <button type="button" className="btn small" onClick={toLive} data-testid="back-to-live-leg">
                  進行中の Leg {legIndex !== null ? legIndex + 1 : ''} へ
                </button>
              </p>
              <div className="ns-scroll" tabIndex={0} role="region" aria-label={`Leg ${past.index + 1} のスコア表`}>
                {cricket ? <CricketGrid leg={past} names={names} label={`Leg ${past.index + 1} のスコアシート`} /> : <ZeroOneGrid leg={past} startScore={live.startScore} label={`Leg ${past.index + 1} のスコアシート`} />}
              </div>
            </div>
          ) : null}
          {leg ? (
            cricket ? (
              <div hidden={past !== null}>
                <CricketBoard leg={leg} />
              </div>
            ) : (
              <div className="ns-follow" hidden={past !== null}>
                <div
                  className="ns-scroll"
                  ref={follow.ref}
                  tabIndex={0}
                  role="region"
                  aria-label={follow.following ? 'スコア表 (最新の得点を表示中)' : 'スコア表 (過去のラウンドを表示中)'}
                  data-testid="live-scroll"
                  data-following={follow.following ? 'true' : 'false'}
                >
                  <ZeroOneGrid leg={leg} startScore={live.startScore} thrower={thrower} minRows={4} spare={leg.ended ? 0 : 1} />
                </div>
                {!follow.following ? (
                  <button
                    type="button"
                    className="btn small ns-latest"
                    data-testid="follow-latest"
                    onClick={(event) => {
                      const hadFocus = document.activeElement === event.currentTarget;
                      follow.resume();
                      // The button goes away: keep a keyboard user in the sheet, not at the page top.
                      if (hadFocus) follow.ref.current?.focus({ preventScroll: true });
                    }}
                  >
                    最新へ
                  </button>
                ) : null}
              </div>
            )
          ) : null}

        </div>

        <div className="ns-side">
          {hasLevels ? (
            <div className="ns-levels" data-testid="player-levels">
              {([0, 1] as const).map((side) => (
                <ul key={side} className="plain">
                  {levels![side].map((entry) => (
                    <li key={`${entry.oid ?? ''}:${entry.name}`}>
                      {onPlayer && entry.oid ? (
                        <button type="button" className="linklike" onClick={() => onPlayer({ oid: entry.oid!, name: entry.name, teamId: entry.teamId })}>
                          {entry.name}
                        </button>
                      ) : (
                        <span>{entry.name}</span>
                      )}
                      <span className="lv">
                        平均 <strong>{fmt(entry.average)}</strong>
                        {entry.legs ? ` ・ Leg ${entry.legsWon ?? 0}/${entry.legs}` : ''}
                      </span>
                    </li>
                  ))}
                </ul>
              ))}
              <p className="muted small-text">今季の成績 (n01 公式){onPlayer ? '。名前をタップで選手カード' : ''}</p>
            </div>
          ) : null}

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
        </div>
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
