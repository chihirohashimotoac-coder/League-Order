import type { ThrowLeg } from '../parse';
import type { FinishChance } from '../legAnalysis';
import { chanceRate, finishChances, raceLead, raceSeries } from '../legAnalysis';

/**
 * Two League Order figures drawn from a 01 leg's throws (n01 shows neither):
 *
 * - RaceChart: points left against darts thrown, both sides on one scale, so who is ahead at
 *   the same number of darts is read at a glance.
 * - FinishChances: the visits that started on a finish (上がり圏) as ○ / ×, per side.
 *
 * Columns follow `order` (n01 side shown left first), as in the score sheet.
 */

type LegLike = Pick<ThrowLeg, 'index' | 'throws' | 'start' | 'ended' | 'winner' | 'first'> & { bull?: boolean; dartsTotal?: [number, number] | null };

const W = 320;
const H = 176;
const PAD = { left: 38, right: 10, top: 10, bottom: 24 };

function step(max: number, wanted: number): number {
  for (const candidate of [1, 2, 3, 5, 6, 10, 12, 20, 25, 50, 100, 200, 250, 500]) if (max / candidate <= wanted) return candidate;
  return 1000;
}

export function RaceChart({ leg, startScore, order = [0, 1], names }: { leg: LegLike; startScore: number | null; order?: [0 | 1, 0 | 1]; names: [string, string] }): React.JSX.Element | null {
  const series = raceSeries(leg, startScore);
  if (series[0].length + series[1].length <= 2) return null;
  const columns = [series[order[0]], series[order[1]]] as const;
  const maxDarts = Math.max(15, ...columns.map((points) => points[points.length - 1].darts));
  const xMax = Math.ceil(maxDarts / 3) * 3;
  const yMax = Math.max(...columns.map((points) => points[0].left));
  const x = (darts: number): number => PAD.left + ((W - PAD.left - PAD.right) * darts) / xMax;
  const y = (left: number): number => PAD.top + ((H - PAD.top - PAD.bottom) * (yMax - left)) / yMax;
  const xStep = Math.max(3, Math.ceil(step(xMax, 8) / 3) * 3);
  const yStep = step(yMax, 6);
  const yTicks = Array.from({ length: Math.floor(yMax / yStep) + 1 }, (_, i) => i * yStep);
  const xTicks = Array.from({ length: Math.floor(xMax / xStep) + 1 }, (_, i) => i * xStep);

  const winner = leg.ended && (leg.winner === 0 || leg.winner === 1) ? leg.winner : null;
  const lead = raceLead(series);
  const column = (side: 0 | 1): 0 | 1 => (order[0] === side ? 0 : 1);
  const caption =
    winner !== null
      ? `${names[column(winner)]} が ${series[winner][series[winner].length - 1].darts} 本で上がり`
      : lead
        ? lead.side === null
          ? `${lead.visits} ラウンド時点で同点`
          : `${lead.visits} ラウンド (${lead.visits * 3} 本) 時点で ${names[column(lead.side)]} が ${lead.by} 点先行`
        : '';

  return (
    <figure className="race" data-testid="race-chart">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`残り点の推移。${caption}`}>
        {yTicks.map((tick) => (
          <g key={`y${tick}`}>
            <line x1={PAD.left} x2={W - PAD.right} y1={y(tick)} y2={y(tick)} className="grid" />
            <text x={PAD.left - 6} y={y(tick) + 4} textAnchor="end" className="tick">
              {tick}
            </text>
          </g>
        ))}
        {xTicks.map((tick) => (
          <text key={`x${tick}`} x={x(tick)} y={H - 6} textAnchor="middle" className="tick">
            {tick}
          </text>
        ))}
        {columns.map((points, index) => (
          <g key={index} className={`line c${index}`}>
            <polyline points={points.map((point) => `${x(point.darts).toFixed(1)},${y(point.left).toFixed(1)}`).join(' ')} fill="none" />
            {points.map((point, at) => (
              <circle key={at} cx={x(point.darts)} cy={y(point.left)} r={point.left === 0 ? 4 : 2.5} />
            ))}
          </g>
        ))}
      </svg>
      <figcaption className="small-text">
        <span className="race-key">
          <i className="c0" aria-hidden="true" />
          {names[0]}
        </span>
        <span className="race-key">
          <i className="c1" aria-hidden="true" />
          {names[1]}
        </span>
        <span className="muted">{caption}。横軸はダーツ数。</span>
      </figcaption>
    </figure>
  );
}

export function FinishChances({ legs, order = [0, 1], names, title = '上がり圏 (このゲーム)' }: { legs: readonly LegLike[]; order?: [0 | 1, 0 | 1]; names: [string, string]; title?: string }): React.JSX.Element | null {
  const sides = [finishChances(legs, order[0]), finishChances(legs, order[1])];
  if (sides[0].length + sides[1].length === 0) return null;
  const SHOWN = 12;
  const pips = (chances: FinishChance[]): React.JSX.Element => (
    <span className="fc-pips">
      {chances.length > SHOWN ? <span className="muted small-text">…</span> : null}
      {chances.slice(-SHOWN).map((chance) => (
        <span key={`${chance.leg}:${chance.round}`} className={`fc-pip${chance.hit ? ' hit' : ''}`}
          role="img"
          aria-label={`L${chance.leg + 1} 残り ${chance.left} ${chance.hit ? '上がり' : '上がれず'}`}
          title={`L${chance.leg + 1} 残り ${chance.left}${chance.hit ? ' 上がり' : ''}`}
        >
          {chance.hit ? '○' : '×'}
        </span>
      ))}
    </span>
  );
  return (
    <section className="finish-chances" data-testid="finish-chances" aria-label={title}>
      <h4 className="section-mini">{title}</h4>
      {sides.map((chances, index) => {
        const rate = chanceRate(chances);
        return (
          <div key={index} className="fc-row">
            <span className="fc-name">{names[index]}</span>
            {pips(chances)}
            <span className="fc-rate">
              {rate.hits}/{rate.chances}
              {rate.rate !== null ? <span className="muted"> ({Math.round(rate.rate * 100)}%)</span> : null}
            </span>
          </div>
        );
      })}
      <p className="muted small-text">3 本で上がれる残り点 (170 以下、ボギー数を除く) で迎えたラウンドの数と上がった数。n01 はダブルへの本数を記録しないため、ラウンド単位です。</p>
    </section>
  );
}
