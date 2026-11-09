import type { TrailStep } from '../cardTrail';
import { biggestSwing } from '../cardTrail';

/**
 * The card estimate after each game as a line (side 0's chance of winning the card), the game
 * that moved it most marked. An estimate (予測), labelled as such.
 */

const W = 320;
const H = 150;
const PAD = { left: 36, right: 10, top: 10, bottom: 22 };

/** Short slot label: シングルス1 → S1, ダブルス2 → D2 … */
export function shortSlot(label: string): string {
  return label.replace(/シングルス/u, 'S').replace(/ダブルス/u, 'D').replace(/トリオス/u, 'T').replace(/ガロン/u, 'G').replace(/チーム/u, 'Team').replace(/クリケット/u, 'C');
}

export function CardTrail({ steps, names, labelOf, basis }: { steps: TrailStep[]; names: [string, string]; labelOf: (schid: string) => string; basis: string }): React.JSX.Element | null {
  if (steps.length < 2) return null;
  const n = steps.length;
  const x = (i: number): number => PAD.left + ((W - PAD.left - PAD.right) * i) / Math.max(1, n - 1);
  const y = (p: number): number => PAD.top + (H - PAD.top - PAD.bottom) * (1 - p);
  const swing = biggestSwing(steps);
  const pct = (p: number): string => `${Math.round(p * 100)}%`;
  const last = steps[n - 1];
  const caption = swing
    ? `最も動いたゲーム: ${labelOf(steps[swing.index].schid!)} (${pct(swing.from)} → ${pct(swing.to)})`
    : 'どのゲームでも 5 ポイント以上は動いていません';
  const every = n > 12 ? 2 : 1;
  return (
    <figure className="card-trail" data-testid="card-trail">
      <figcaption className="small-text">
        <strong>{names[0]} の勝率 (予測) の推移</strong>
      </figcaption>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${names[0]} の勝率の推移。開始時 ${pct(steps[0].outlook.win)}、現在 ${pct(last.outlook.win)}。${caption}`}>
        {swing ? <rect x={x(swing.index) - 8} y={PAD.top - 4} width={16} height={H - PAD.top - PAD.bottom + 8} className="swing" /> : null}
        {[0, 0.5, 1].map((p) => (
          <g key={p}>
            <line x1={PAD.left} x2={W - PAD.right} y1={y(p)} y2={y(p)} className={p === 0.5 ? 'half' : 'grid'} />
            <text x={PAD.left - 6} y={y(p) + 4} textAnchor="end" className="tick">
              {pct(p)}
            </text>
          </g>
        ))}
        <polyline points={steps.map((step, i) => `${x(i).toFixed(1)},${y(step.outlook.win).toFixed(1)}`).join(' ')} className="trail" fill="none" />
        {steps.map((step, i) => (
          <g key={i}>
            <circle cx={x(i)} cy={y(step.outlook.win)} r={swing?.index === i ? 4.5 : 3} className={`pt${step.winner === 0 ? ' a' : step.winner === 1 ? ' b' : ''}${step.live ? ' live' : ''}`} />
            {i % every === 0 || i === n - 1 ? (
              <text x={x(i)} y={H - 6} textAnchor="middle" className="tick">
                {i === 0 ? '開始' : step.live ? '今' : shortSlot(labelOf(step.schid!))}
              </text>
            ) : null}
          </g>
        ))}
      </svg>
      <p className="small-text">
        {caption}
        <span className="muted">
          {' '}
          ・ 塗りつぶし = {names[0]} が取ったゲーム、白抜き = {names[1]}。{basis}
        </span>
      </p>
    </figure>
  );
}
