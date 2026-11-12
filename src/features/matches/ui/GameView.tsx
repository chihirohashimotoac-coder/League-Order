import { useMemo, useState } from 'react';
import { onTabListKeyDown } from '../../../components/ui';
import type { MatchesApi } from '../api';
import type { LiveLeg, ThrowLeg } from '../parse';
import { withLiveLeg } from '../parse';
import { useGameLegs } from './useGameLegs';
import { gameStats } from '../gameStats';
import type { SideStats } from '../gameStats';
import { CricketGrid, ZeroOneGrid } from './ScoreGrid';
import { FinishChances, RaceChart } from './LegCharts';
import { LegsStatusLine } from './LegsStatusLine';

/**
 * One game, the way n01's match Details and score sheet show it — and side by side.
 *
 * Order on the page: the leg chips and the chosen leg's score sheet first (what a reader opens a
 * game for), then the comparison table. On a wide container the two sit side by side.
 *
 * - The comparison table is computed from the throws (`gameStats`), in card order.
 * - Leg chips: winner, darts, who threw first, bull-decided legs marked.
 * - The score sheet of the chosen leg in n01's grid (`ScoreGrid`): 01 Scored / To Go with the
 *   darts in the middle, 100+ circled and marked (bold / colour), the finish as x1 / x2 / x3;
 *   Cricket hits / marks.
 *
 * A finished game is read once (`match/throws`, memoised). A game in progress takes its current
 * leg from the live poller and re-reads the other legs only when a leg ends. The legs belong to
 * this `mid` only (`useGameLegs`); a failed read shows as such, with a retry.
 */

const fmt = (value: number | null, digits = 2): string => (value === null ? '—' : value.toFixed(digits));

export function GameView({
  api,
  mid,
  cricket,
  finished,
  names,
  flip,
  liveLeg,
  focus = null,
}: {
  api: MatchesApi;
  mid: string;
  cricket: boolean;
  finished: boolean;
  /** Card order. */
  names: [string, string];
  /** True when n01's left side is the card's second team. */
  flip: boolean;
  /** The current leg from the live poller (games in progress). */
  liveLeg?: LiveLeg | null;
  /** Open this leg with this visit marked (a highlight). */
  focus?: { leg: number; n01Side: 0 | 1; round: number } | null;
}): React.JSX.Element {
  const [chosen, setChosen] = useState<number | null>(focus?.leg ?? null);
  const liveIndex = liveLeg?.index ?? null;
  const history = useGameLegs(api, mid, { finished, liveLegIndex: liveIndex });
  const legs = history.legs;
  const state = history.status;
  const all = useMemo(() => withLiveLeg(legs, liveLeg), [legs, liveLeg]);
  const stats = useMemo(() => gameStats(all, cricket), [all, cricket]);
  const card = (pair: [SideStats, SideStats]): [SideStats, SideStats] => (flip ? [pair[1], pair[0]] : pair);
  const [a, b] = card(stats);
  const at = (side: 0 | 1): 0 | 1 => (flip ? ((1 - side) as 0 | 1) : side);
  const shown = chosen ?? (all.length ? all[all.length - 1].index : null);
  const leg = all.find((entry) => entry.index === shown) ?? null;

  // Figures are computed from the whole game only: until it is read, none are shown.
  if (state === 'loading') return <p className="muted small-text" role="status">記録を読み込み中…</p>;
  if (state === 'error') {
    return (
      <p className="small-text" role="alert" data-testid="legs-status">
        このゲームの記録を取得できませんでした{history.error ? ` (${history.error})` : ''}。{' '}
        <button type="button" className="btn small" onClick={history.retry}>
          再取得
        </button>
      </p>
    );
  }

  const rows: [string, string, string][] = [
    ['Legs', String(a.legsWon), String(b.legsWon)],
    [cricket ? 'MPR' : '平均 (3投)', fmt(a.rate), fmt(b.rate)],
    ...(!cricket
      ? ([
          ['First 9', fmt(a.first9), fmt(b.first9)],
          ['100+', String(a.ton), String(b.ton)],
          ['140+', String(a.ton40), String(b.ton40)],
          ['180', String(a.ton80), String(b.ton80)],
          ['High Out', a.highOut === null ? '—' : String(a.highOut), b.highOut === null ? '—' : String(b.highOut)],
        ] as [string, string, string][])
      : ([9, 8, 7, 6, 5]
          .filter((marks) => a.markVisits[marks] + b.markVisits[marks] > 0)
          .map((marks) => [`${marks} Mark`, String(a.markVisits[marks]), String(b.markVisits[marks])]) as [string, string, string][])),
    ['Best Leg', a.bestLeg === null ? '—' : `${a.bestLeg} 本`, b.bestLeg === null ? '—' : `${b.bestLeg} 本`],
    ['Break (後攻で取った Leg)', `${a.breaks} / ${a.secondLegs}`, `${b.breaks} / ${b.secondLegs}`],
  ];

  return (
    <div className="game-view" data-testid="game-view">
      <div className="gv-body">
        <div className="gv-legs">
          {all.length > 0 ? (
            <div className="chip-row leg-chips" role="tablist" aria-label="Leg" onKeyDown={onTabListKeyDown} data-testid="leg-chips">
              {all.map((entry) => {
                const winner = entry.winner === 0 || entry.winner === 1 ? (flip ? 1 - entry.winner : entry.winner) : null;
                return (
                  <button
                    key={entry.index}
                    type="button"
                    role="tab"
                    className="chip"
                    aria-selected={entry.index === shown}
                    aria-pressed={entry.index === shown}
                    tabIndex={entry.index === shown ? 0 : -1}
                    onClick={() => setChosen(entry.index)}
                  >
                    L{entry.index + 1} {winner === null ? '…' : winner === 0 ? '◀' : '▶'}
                    {entry.bull ? ' (ブル)' : ''}
                  </button>
                );
              })}
            </div>
          ) : (
            <p className="muted small-text">まだ投げた記録がありません。</p>
          )}
          {leg ? <ScoreSheet leg={leg} cricket={cricket} names={names} at={at} mark={focus && focus.leg === leg.index ? { side: focus.n01Side, round: focus.round } : null} /> : null}
        </div>
        <div className="gv-figures">
          {!history.complete ? <LegsStatusLine history={history} /> : null}
          {history.complete ? (
            <div className="table-scroll">
              <table className="compare small-text" aria-label="ゲームの詳細">
                <thead>
                  <tr>
                    <th scope="col">{names[0]}</th>
                    <th scope="col" />
                    <th scope="col">{names[1]}</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map(([label, left, right]) => (
                    <tr key={label}>
                      <td className="num">{left}</td>
                      <th scope="row" className="center">
                        {label}
                      </th>
                      <td className="num">{right}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
          {history.complete ? (
            <p className="muted small-text">
              n01 の記録から League Order が計算 (ブル決着の Leg は平均・ダーツ数に含めません。First 9 は各 Leg の最初の 3 ラウンドの得点 ÷ 実際の本数 × 3)。
            </p>
          ) : null}
          {!cricket && history.complete ? <FinishChances legs={all} order={[at(0), at(1)]} names={names} /> : null}
        </div>
      </div>
    </div>
  );
}

function ScoreSheet({
  leg,
  cricket,
  names,
  at,
  mark,
}: {
  leg: ThrowLeg;
  cricket: boolean;
  names: [string, string];
  at: (side: 0 | 1) => 0 | 1;
  mark: { side: 0 | 1; round: number } | null;
}): React.JSX.Element {
  // Column order is the card's: the n01 side shown on the left is `at(0)`.
  const order: [0 | 1, 0 | 1] = [at(0), at(1)];
  const label = `Leg ${leg.index + 1} のスコアシート`;
  return (
    <div className="ns-grid-wrap" data-testid="leg-sheet">
      <h4 className="gv-sheet-title">Leg {leg.index + 1} のスコア表</h4>
      {cricket ? <CricketGrid leg={leg} order={order} names={names} label={label} mark={mark} /> : <ZeroOneGrid leg={leg} order={order} names={names} label={label} mark={mark} />}
      {cricket && leg.marks && leg.numbers ? (
        <p className="small-text muted">
          {leg.numbers.map((number, index) => `${number === 25 ? 'BULL' : number}: ${leg.marks![order[0]][index]}-${leg.marks![order[1]][index]}`).join(' ・ ')}
        </p>
      ) : null}
      {!cricket ? <RaceChart leg={leg} startScore={null} order={order} names={names} /> : null}
    </div>
  );
}
