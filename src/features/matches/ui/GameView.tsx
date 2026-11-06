import { useEffect, useMemo, useState } from 'react';
import { describeN01Error } from '../../../integrations/n01/client';
import type { MatchesApi } from '../api';
import type { LiveLeg, ThrowLeg } from '../parse';
import { mergeLegs } from '../parse';
import { gameStats } from '../gameStats';
import type { SideStats } from '../gameStats';

/**
 * One game, the way n01's match Details and score sheet show it — and side by side.
 *
 * - The comparison table is computed from the throws (`gameStats`), in card order.
 * - Leg chips: winner, darts, who threw first, bull-decided legs marked.
 * - The score sheet of the chosen leg, every visit: 01 score / left (100+ 140+ 180 marked,
 *   the finishing visit with its darts), Cricket hits / marks / points.
 *
 * A finished game is read once (`match/throws`, memoised). A game in progress takes its current
 * leg from the live poller and re-reads the other legs only when a leg ends.
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
}): React.JSX.Element {
  const [legs, setLegs] = useState<ThrowLeg[]>([]);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState('');
  const [chosen, setChosen] = useState<number | null>(null);
  const [since, setSince] = useState<number | null>(null);
  const liveIndex = liveLeg?.index ?? null;

  useEffect(() => {
    let alive = true;
    setState('loading');
    api
      .throws(mid, null, { finished })
      .then((reply) => {
        if (!alive) return;
        setLegs(reply.legs);
        setSince(reply.updateTime);
        setState('ready');
      })
      .catch((reason) => {
        if (!alive) return;
        setError(describeN01Error(reason));
        setState('error');
      });
    return () => {
      alive = false;
    };
  }, [api, mid, finished]);

  // A leg ended (the live leg moved on): re-read only the legs changed since the last read.
  useEffect(() => {
    if (finished || liveIndex === null || since === null || state !== 'ready') return;
    let alive = true;
    api
      .throws(mid, since)
      .then((reply) => {
        if (!alive || !reply.changed) return;
        setLegs((held) => mergeLegs(held, reply.legs));
        if (reply.updateTime) setSince(reply.updateTime);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
    // Only when the live leg index changes.
  }, [liveIndex]);

  const all = useMemo(() => {
    if (!liveLeg) return legs;
    return mergeLegs(legs, [{ ...liveLeg, bull: false, dartsTotal: null }]);
  }, [legs, liveLeg]);
  const stats = useMemo(() => gameStats(all, cricket), [all, cricket]);
  const card = (pair: [SideStats, SideStats]): [SideStats, SideStats] => (flip ? [pair[1], pair[0]] : pair);
  const [a, b] = card(stats);
  const at = (side: 0 | 1): 0 | 1 => (flip ? ((1 - side) as 0 | 1) : side);
  const shown = chosen ?? (all.length ? all[all.length - 1].index : null);
  const leg = all.find((entry) => entry.index === shown) ?? null;

  if (state === 'loading' && !liveLeg) return <p className="muted small-text">記録を読み込み中…</p>;
  if (state === 'error' && !liveLeg) return <p className="small-text">取得エラー: {error}</p>;

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
      <p className="muted small-text">n01 の記録から League Order が計算 (ブル決着の Leg は平均・ダーツ数に含めません)。</p>
      {all.length > 0 ? (
        <div className="chip-row" role="tablist" aria-label="Leg">
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
      {leg ? <ScoreSheet leg={leg} cricket={cricket} names={names} at={at} /> : null}
    </div>
  );
}

function ScoreSheet({ leg, cricket, names, at }: { leg: ThrowLeg; cricket: boolean; names: [string, string]; at: (side: 0 | 1) => 0 | 1 }): React.JSX.Element {
  const rounds = new Map<number, [LiveLeg['throws'][number] | null, LiveLeg['throws'][number] | null]>();
  for (const entry of leg.throws) {
    const row = rounds.get(entry.round) ?? [null, null];
    row[entry.side] = entry;
    rounds.set(entry.round, row);
  }
  const first = leg.first === null ? null : at(leg.first);
  const cell = (entry: LiveLeg['throws'][number] | null, align: 'l' | 'r'): React.JSX.Element => {
    if (!entry) return <td colSpan={2} />;
    if (entry.kind === '01') {
      const tone = entry.score === 180 ? 't180' : entry.score >= 140 ? 't140' : entry.score >= 100 ? 't100' : '';
      const score = (
        <td className={`num ${tone}`} key="s">
          {entry.finish ? `${entry.score} (${entry.darts}本)` : entry.score}
        </td>
      );
      const left = (
        <td className="num muted" key="l">
          {entry.left}
        </td>
      );
      return <>{align === 'l' ? [score, left] : [left, score]}</>;
    }
    const hits = entry.hits.map((hit) => `${hit.mark === 3 ? 'T' : hit.mark === 2 ? 'D' : 'S'}${hit.number === 25 ? 'B' : hit.number}`).join(' ') || '—';
    const a = (
      <td className="hits" key="h">
        {hits}
      </td>
    );
    const b = (
      <td className={`num ${entry.marks >= 5 ? 't140' : ''}`} key="m">
        {entry.marks}M{entry.points ? ` +${entry.points}` : ''}
      </td>
    );
    return <>{align === 'l' ? [a, b] : [b, a]}</>;
  };
  return (
    <div className="table-scroll">
      <table className="score-sheet small-text" aria-label={`Leg ${leg.index + 1} のスコアシート`} data-testid="score-sheet">
        <thead>
          <tr>
            <th scope="col" colSpan={2}>
              {names[0]}
              {first === 0 ? ' (先攻)' : ''}
            </th>
            <th scope="col">R</th>
            <th scope="col" colSpan={2}>
              {names[1]}
              {first === 1 ? ' (先攻)' : ''}
            </th>
          </tr>
        </thead>
        <tbody>
          {[...rounds.entries()].map(([round, pair]) => (
            <tr key={round}>
              {cell(pair[at(0)], 'l')}
              <th scope="row" className="center muted">
                {round}
              </th>
              {cell(pair[at(1)], 'r')}
            </tr>
          ))}
        </tbody>
      </table>
      {cricket && leg.marks && leg.numbers ? (
        <p className="small-text muted">
          {leg.numbers.map((number, index) => `${number === 25 ? 'BULL' : number}: ${leg.marks![at(0)][index]}-${leg.marks![at(1)][index]}`).join(' ・ ')}
        </p>
      ) : null}
    </div>
  );
}
