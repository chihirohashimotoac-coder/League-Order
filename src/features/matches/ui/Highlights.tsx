import { useEffect, useState } from 'react';
import type { MatchesApi } from '../api';
import type { MatchCard } from '../cards';
import type { Highlight } from '../legAnalysis';
import { COMEBACK_AT, cardHighlights, gameHighlights } from '../legAnalysis';

/**
 * 見どころ: the moments of a card worth opening, read from the throws of its finished games
 * (comebacks, high finishes, 180s, 9-mark visits, the fastest leg per starting score). A line
 * opens that game at that leg with the visit marked in the score sheet.
 *
 * The games' throws are the same memoised reads the score sheets use, fetched three at a time.
 */

const KIND_LABEL: Record<Highlight['kind'], string> = { comeback: '逆転', highOut: 'High Out', ton80: '180', nineMark: '9 Mark', fastLeg: '最短' };
const SHOWN = 6;
const PARALLEL = 3;

export interface HighlightFocus {
  schid: string;
  leg: number;
  n01Side: 0 | 1;
  round: number;
}

type State = { kind: 'loading'; done: number; total: number } | { kind: 'ready'; items: Highlight[]; failed: number };

export function Highlights({ card, api, onOpen }: { card: MatchCard; api: MatchesApi; onOpen: (focus: HighlightFocus) => void }): React.JSX.Element | null {
  const games = card.games.filter((entry) => entry.game?.finished);
  const [state, setState] = useState<State>({ kind: 'loading', done: 0, total: games.length });
  const [all, setAll] = useState(false);
  const key = games.map((entry) => entry.game!.mid).join(',');

  useEffect(() => {
    let alive = true;
    const names: [string, string] = [card.teams[0].name, card.teams[1].name];
    const candidates: Highlight[] = [];
    let failed = 0;
    let done = 0;
    let next = 0;
    setState({ kind: 'loading', done: 0, total: games.length });
    const worker = async (): Promise<void> => {
      while (alive && next < games.length) {
        const entry = games[next++];
        try {
          const reply = await api.throws(entry.game!.mid, null, { finished: true });
          candidates.push(...gameHighlights(reply.legs, { schid: entry.slot.schid, slotLabel: entry.slot.label, flip: entry.flip, names, members: entry.members }));
        } catch {
          failed += 1;
        }
        done += 1;
        if (alive) setState({ kind: 'loading', done, total: games.length });
      }
    };
    void Promise.all(Array.from({ length: Math.min(PARALLEL, games.length) }, worker)).then(() => {
      if (!alive) return;
      // Keep card order of games for equal values.
      const slotOrder = new Map(card.games.map((entry, index) => [entry.slot.schid, index]));
      candidates.sort((a, b) => (slotOrder.get(a.schid) ?? 0) - (slotOrder.get(b.schid) ?? 0) || a.leg - b.leg || a.round - b.round);
      setState({ kind: 'ready', items: cardHighlights(candidates), failed });
    });
    return () => {
      alive = false;
    };
  }, [api, key]);

  if (games.length === 0) return null;
  if (state.kind === 'loading') {
    return (
      <section className="highlights" aria-label="見どころ" data-testid="highlights">
        <h3 className="section-mini">見どころ</h3>
        <p className="muted small-text">
          ゲームの記録を集計中… ({state.done}/{state.total})
        </p>
      </section>
    );
  }
  const items = all ? state.items : state.items.slice(0, SHOWN);
  return (
    <section className="highlights" aria-label="見どころ" data-testid="highlights">
      <h3 className="section-mini">見どころ</h3>
      {state.items.length === 0 ? <p className="muted small-text">逆転・100 以上の上がり・180 はありませんでした。</p> : null}
      <ul className="hl-list">
        {items.map((item) => (
          <li key={item.id}>
            <button type="button" className="hl-row" onClick={() => onOpen({ schid: item.schid, leg: item.leg, n01Side: item.n01Side, round: item.round })}>
              <span className={`hl-kind k-${item.kind}`}>{KIND_LABEL[item.kind]}</span>
              <span className="hl-text">
                <strong>{item.who}</strong> {item.detail}
                <span className="muted small-text">
                  {' '}
                  {item.who === card.teams[item.cardSide].name ? '' : `${card.teams[item.cardSide].name} ・ `}
                  {item.slotLabel} L{item.leg + 1}
                </span>
              </span>
              <span className="hl-go small-text">シート</span>
            </button>
          </li>
        ))}
      </ul>
      {state.items.length > SHOWN ? (
        <button type="button" className="btn ghost small" onClick={() => setAll(!all)}>
          {all ? '少なく表示' : `ほか ${state.items.length - SHOWN} 件を表示`}
        </button>
      ) : null}
      <p className="muted small-text">
        League Order が n01 の投擲記録から抽出 (逆転 = 同じラウンド数の時点で {COMEBACK_AT} 点以上多く残していた側が取った Leg)。
        {state.failed ? ` ${state.failed} ゲームの記録を読めませんでした。` : ''}
      </p>
    </section>
  );
}
