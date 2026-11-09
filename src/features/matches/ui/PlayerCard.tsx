import { useEffect, useMemo, useState } from 'react';
import { Sheet } from '../../../components/ui';
import type { MatchesApi } from '../api';
import { percent, playerForms } from '../insights';
import type { PlayerThrowStats } from '../playerCard';
import { playerGames, playerThrowStats } from '../playerCard';
import type { ThrowLeg } from '../parse';
import type { SeasonData } from './useMatchContext';
import { formatRate, useFollowed } from './useMatchContext';

/**
 * 選手カード: one player's season on one sheet — the Singles 01 average game by game, 100+ and
 * 180 visits, finishing chances (上がり圏), the highest checkout, the fewest darts in a singles
 * leg, the win rate by kind — and, for a registered team, the way into the next order.
 *
 * The throws of the player's 01 games are read on opening (memoised, three at a time).
 */

const STRUCTURE_LABEL: Record<string, string> = { SINGLES: 'Singles', DOUBLES: 'Doubles', TRIOS: 'Trios', GALLON: 'Gallon', TEAM: 'Team', UNKNOWN: '不明' };
const PARALLEL = 3;

type Throws = { kind: 'loading'; done: number; total: number } | { kind: 'ready'; stats: PlayerThrowStats; failed: number };

export function PlayerCard({
  oid,
  name,
  teamId,
  data,
  api,
  orderTeamName,
  onOrder,
  onTeam,
  onClose,
}: {
  oid: string;
  name: string;
  teamId: string | null;
  data: SeasonData;
  api: MatchesApi;
  /** Set when the player's team is registered: the button opens its next order. */
  orderTeamName: string | null;
  onOrder: () => void;
  onTeam: (teamId: string) => void;
  onClose: () => void;
}): React.JSX.Element {
  const games = useMemo(() => playerGames(data.games, oid), [data.games, oid]);
  const zeroOne = games.filter((game) => game.matchType === '01');
  const form = useMemo(() => (teamId ? playerForms(data.season, data.games, teamId).find((entry) => entry.oid === oid) ?? null : null), [data, teamId, oid]);
  const trend = games.filter((game) => game.singlesAverage !== null).map((game) => game.singlesAverage!);
  const season = trend.length ? trend.reduce((a, b) => a + b, 0) / trend.length : null;
  const [throws, setThrows] = useState<Throws>({ kind: 'loading', done: 0, total: zeroOne.length });

  useEffect(() => {
    let alive = true;
    const entries: { game: (typeof zeroOne)[number]; legs: ThrowLeg[] }[] = [];
    let failed = 0;
    let done = 0;
    let next = 0;
    setThrows({ kind: 'loading', done: 0, total: zeroOne.length });
    const worker = async (): Promise<void> => {
      while (alive && next < zeroOne.length) {
        const game = zeroOne[next++];
        try {
          entries.push({ game, legs: (await api.throws(game.mid, null, { finished: true })).legs });
        } catch {
          failed += 1;
        }
        done += 1;
        if (alive) setThrows({ kind: 'loading', done, total: zeroOne.length });
      }
    };
    void Promise.all(Array.from({ length: Math.min(PARALLEL, zeroOne.length) }, worker)).then(() => {
      if (alive) setThrows({ kind: 'ready', stats: playerThrowStats(entries), failed });
    });
    return () => {
      alive = false;
    };
  }, [api, oid, zeroOne.length]);

  const followed = useFollowed();
  const following = followed.isFollowed(name);
  const stats = throws.kind === 'ready' ? throws.stats : null;
  const pct = (part: number, whole: number): string => (whole > 0 ? `${Math.round((part / whole) * 100)}%` : '—');

  return (
    <Sheet title={name} onClose={onClose}>
      <div className="player-card" data-testid="player-card">
        <p className="small-text">
          {teamId ? (
            <button type="button" className="linklike" onClick={() => onTeam(teamId)}>
              {data.season.teams.get(teamId) ?? teamId}
            </button>
          ) : null}
          {teamId ? ' ・ ' : ''}今季 {games.length} 試合
        </p>
        <button
          type="button"
          className={`btn small follow${following ? ' on' : ''}`}
          aria-pressed={following}
          disabled={!following && followed.full}
          onClick={() => followed.toggle(name, teamId ? (data.season.teams.get(teamId) ?? null) : null)}
        >
          <span aria-hidden="true">{following ? '★' : '☆'}</span> {following ? '注目選手から外す' : '注目選手に追加'}
        </button>

        <div className="pc-top">
          <div>
            <span className="muted small-text">Singles 01 平均 ({trend.length} 試合)</span>
            <div className="pc-big">{formatRate(season)}</div>
          </div>
          <Sparkline values={trend} />
        </div>

        {throws.kind === 'loading' ? (
          <p className="muted small-text" role="status">
            投擲記録を集計中… ({throws.done}/{throws.total})
          </p>
        ) : null}
        <dl className="pc-grid">
          <div>
            <dt>100+ の割合</dt>
            <dd>{stats ? pct(stats.ton, stats.visits) : '…'}</dd>
          </div>
          <div>
            <dt>上がり圏</dt>
            <dd>
              {stats ? (
                <>
                  {stats.finished}/{stats.chances} <span className="muted">({pct(stats.finished, stats.chances)})</span>
                </>
              ) : (
                '…'
              )}
            </dd>
          </div>
          <div>
            <dt>180</dt>
            <dd>{stats ? stats.ton80 : '…'}</dd>
          </div>
          <div>
            <dt>High Out</dt>
            <dd>{stats ? (stats.highOut ?? '—') : '…'}</dd>
          </div>
          <div className="wide">
            <dt>最短 Leg (Singles)</dt>
            <dd>{stats ? (stats.bestLegs.length ? stats.bestLegs.map((entry) => `${entry.darts} 本 (${entry.start})`).join(' ・ ') : '—') : '…'}</dd>
          </div>
        </dl>

        {form && Object.keys(form.byStructure).length ? (
          <>
            <h3 className="section-mini">種別ごとの勝率</h3>
            <dl className="pc-grid">
              {Object.entries(form.byStructure).map(([kind, record]) => (
                <div key={kind}>
                  <dt>{STRUCTURE_LABEL[kind] ?? kind}</dt>
                  <dd>
                    {record.wins}-{record.games - record.wins} <span className="muted">({percent(record)})</span>
                  </dd>
                </div>
              ))}
            </dl>
            {form.notes.map((note) => (
              <p key={note} className="muted small-text">
                {note}
              </p>
            ))}
          </>
        ) : null}

        {orderTeamName ? (
          <button type="button" className="btn primary" onClick={onOrder}>
            {orderTeamName} の次戦オーダーを作る
          </button>
        ) : (
          <p className="muted small-text">チームを登録すると、ここから次戦のオーダー作成に進めます。</p>
        )}

        <p className="muted small-text">
          League Order が n01 の記録から集計。平均は n01 の各試合の合計から、100+・上がり圏・180・High Out・最短 Leg は {stats?.games ?? zeroOne.length} 試合の投擲記録から (ブル決着の Leg を除く)。上がり圏はラウンド単位 (n01 はダブルへの本数を記録しないため)。
          {throws.kind === 'ready' && throws.failed ? ` ${throws.failed} 試合の記録を読めませんでした。` : ''}
        </p>
      </div>
    </Sheet>
  );
}

function Sparkline({ values }: { values: number[] }): React.JSX.Element | null {
  if (values.length < 2) return null;
  const W = 150;
  const H = 46;
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const span = hi - lo || 1;
  const x = (i: number): number => 4 + ((W - 8) * i) / (values.length - 1);
  const y = (v: number): number => 6 + ((H - 12) * (hi - v)) / span;
  const line = values.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  return (
    <svg className="pc-spark" viewBox={`0 0 ${W} ${H}`} width={W} height={H} role="img" aria-label={`Singles 01 平均の推移 (試合順): ${values[0].toFixed(2)} から ${values[values.length - 1].toFixed(2)}、最高 ${hi.toFixed(2)}`}>
      <polygon points={`${x(0)},${H - 2} ${line} ${x(values.length - 1)},${H - 2}`} className="area" />
      <polyline points={line} fill="none" className="stroke" />
      <circle cx={x(values.length - 1)} cy={y(values[values.length - 1])} r={3.5} className="end" />
    </svg>
  );
}
