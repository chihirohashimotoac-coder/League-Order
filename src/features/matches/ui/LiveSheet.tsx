import { useEffect, useMemo, useState } from 'react';
import type { MatchesApi } from '../api';
import type { LiveState, LiveThrow, ThrowLeg } from '../parse';
import { mergeLegs } from '../parse';
import { gameStats } from '../gameStats';
import { checkoutRoute, freshLegChance, legChance, shrunkAverage } from '../checkout';
import { raceChance } from '../probability';

/**
 * The live game the way a darts scoreboard shows it — the layout spectators know from n01's
 * viewer: legs in the header, the score sheet of the leg (Scored / To Go per visit, darts in
 * the middle), the points left large at the bottom, the game's figures below.
 *
 * Then what only League Order adds, all labelled 予測 / 参考: the thrower's checkout route,
 * the chance of taking this leg and the game, recent form against the game average, the legs
 * so far, and (league cards) the season average.
 */

const fmt = (value: number | null, digits = 2): string => (value === null ? '—' : value.toFixed(digits));

export function LiveSheet({ api, live, seasonAverage }: { api: MatchesApi; live: LiveState; seasonAverage?: [number | null, number | null] }): React.JSX.Element {
  const [legs, setLegs] = useState<ThrowLeg[]>([]);
  const [since, setSince] = useState<number | null>(null);
  const cricket = live.matchType === 'cricket';
  const leg = live.leg;
  const legIndex = leg?.index ?? null;

  // Every leg of the game once, then the legs changed since whenever the live leg moves on.
  useEffect(() => {
    let alive = true;
    api
      .throws(live.mid, null)
      .then((reply) => {
        if (!alive) return;
        setLegs(reply.legs);
        setSince(reply.updateTime);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [api, live.mid]);
  useEffect(() => {
    if (since === null || legIndex === null) return;
    let alive = true;
    api
      .throws(live.mid, since)
      .then((reply) => {
        if (!alive || !reply.changed) return;
        setLegs((held) => mergeLegs(held, reply.legs));
        if (reply.updateTime) setSince(reply.updateTime);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [legIndex]);

  const all = useMemo(() => (leg ? mergeLegs(legs, [{ ...leg, bull: false, dartsTotal: null }]) : legs), [legs, leg]);
  const stats = useMemo(() => gameStats(all, cricket), [all, cricket]);
  const names: [string, string] = [live.sides[0].members.join(' / ') || live.sides[0].name, live.sides[1].members.join(' / ') || live.sides[1].name];
  const thrower = leg && !leg.ended ? leg.thrower : null;

  // --- League Order's own figures ---------------------------------------------------------
  const average: [number, number] = [shrunkAverage(stats[0].rate, stats[0].darts), shrunkAverage(stats[1].rate, stats[1].darts)];
  const left = leg?.left ?? null;
  const legP = !cricket && left && thrower !== null ? legChance(left, average, thrower) : null;
  const need = live.limitLeg;
  const gameP =
    legP !== null && need
      ? (() => {
          const q = freshLegChance(average);
          return legP * raceChance(q, need, live.legs[0] + 1, live.legs[1]) + (1 - legP) * raceChance(q, need, live.legs[0], live.legs[1] + 1);
        })()
      : null;
  const recent = (side: 0 | 1): number | null => {
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

      {leg ? cricket ? <CricketBoard leg={leg} /> : <ZeroOneSheet leg={leg} startScore={live.startScore} thrower={thrower} /> : null}

      <div className="ns-left" aria-label={cricket ? '点数' : '残り点数'}>
        {([0, 1] as const).map((side) => (
          <div key={side} className={`ns-big${thrower === side ? ' on' : ''}`} data-testid={thrower === side ? 'next-thrower' : undefined}>
            {cricket ? (leg?.points?.[side] ?? 0) : (leg?.left?.[side] ?? live.startScore ?? '—')}
            {thrower === side && leg?.member ? <span className="ns-member">{leg.member}</span> : null}
          </div>
        ))}
      </div>

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

      <div className="ns-plus" data-testid="league-order-plus">
        <h3 className="section-mini">League Order の分析</h3>
        {route && thrower !== null ? (
          <p className="ns-route" data-testid="checkout-route">
            アガリ候補 ({names[thrower]} 残り {left![thrower]}): <strong>{route.join(' ')}</strong>
          </p>
        ) : !cricket && left && thrower !== null && left[thrower] <= 170 && left[thrower] > 1 ? (
          <p className="ns-route muted">残り {left[thrower]} は 3 本で上がれない数字です (セットアップ)。</p>
        ) : null}
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
          <div className="ns-chance">
            <span>このゲーム</span>
            <span className="bar" aria-hidden="true">
              <i style={{ width: `${Math.round(gameP * 100)}%` }} />
            </span>
            <span>
              {Math.round(gameP * 100)}% - {100 - Math.round(gameP * 100)}%
            </span>
          </div>
        ) : null}
        {legP !== null ? <p className="muted small-text">予測: 残り点・このゲームの平均・次に投げる側から計算した参考値です。</p> : null}
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
        {all.filter((entry) => entry.ended).length > 0 ? (
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

function ZeroOneSheet({ leg, startScore, thrower }: { leg: NonNullable<LiveState['leg']>; startScore: number | null; thrower: 0 | 1 | null }): React.JSX.Element {
  const rounds = new Map<number, [Extract<LiveThrow, { kind: '01' }> | null, Extract<LiveThrow, { kind: '01' }> | null]>();
  for (const entry of leg.throws) {
    if (entry.kind !== '01') continue;
    const row = rounds.get(entry.round) ?? [null, null];
    row[entry.side] = entry;
    rounds.set(entry.round, row);
  }
  const last = Math.max(0, ...rounds.keys());
  // The round the next visit goes into: highlighted where it will be written.
  const nextRound = thrower === null ? null : (() => {
    const mine = leg.throws.filter((entry) => entry.side === thrower).length;
    return mine + 1;
  })();
  const shown = Math.max(4, last + 1, nextRound ?? 0);
  const start = leg.start ?? [startScore ?? 501, startScore ?? 501];
  const cell = (entry: Extract<LiveThrow, { kind: '01' }> | null, side: 0 | 1, round: number): React.JSX.Element[] => {
    const waiting = !entry && nextRound === round && thrower === side;
    const tone = entry ? (entry.score === 180 ? ' t180' : entry.score >= 140 ? ' t140' : entry.score >= 100 ? ' t100' : '') : '';
    const scored = (
      <td key="s" className={`sc${waiting ? ' waiting' : ''}${tone}`}>
        {entry ? entry.score : waiting ? <span className="ns-dot" aria-label="投擲中" /> : ''}
      </td>
    );
    const togo = (
      <td key="g" className="tg">
        {entry ? entry.left : ''}
      </td>
    );
    return side === 0 ? [scored, togo] : [scored, togo];
  };
  return (
    <div className="ns-scroll">
      <table className="ns-table" data-testid="score-sheet">
        <thead>
          <tr>
            <th scope="col">Scored</th>
            <th scope="col">To Go</th>
            <th scope="col" aria-label="ダーツ数" />
            <th scope="col">Scored</th>
            <th scope="col">To Go</th>
          </tr>
        </thead>
        <tbody>
          <tr className="start">
            <td className="sc" />
            <td className="tg">{start[0]}</td>
            <td className="mid" />
            <td className="sc" />
            <td className="tg">{start[1]}</td>
          </tr>
          {Array.from({ length: shown }, (_, i) => i + 1).map((round) => {
            const [a, b] = rounds.get(round) ?? [null, null];
            const finish = [a, b].find((entry) => entry?.finish) ?? null;
            return (
              <tr key={round}>
                {cell(a, 0, round)}
                <td className="mid">{finish ? (round - 1) * 3 + finish.darts : round * 3}</td>
                {cell(b, 1, round)}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
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
