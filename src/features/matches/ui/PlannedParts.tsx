import { useId, useState } from 'react';
import type { ReactNode } from 'react';
import { Icon } from '../../../components/icons';
import type { CardOrderMember } from '../parse';
import type { PlanStatus, PlannedCard, PlannedGame } from '../plannedOrders';
import { PLAN_TEXT } from '../plannedOrders';
import type { CardOrders } from './useCardOrders';

/**
 * 開始前のゲーム (予定) の表示部品: 1 ゲームの詳細 (`PlannedGameView`) と、カードの全ゲームの
 * オーダー一覧 (`OrderOverview`)。ライブタブ・日程・結果の両方で同じものを使う。
 *
 * 予定は実績と混ぜない: 0-0・Leg・残り点数のような試合の記録らしい値は出さず「VS」と書く。選手名は
 * 両チームの確定済みオーダー (plannedOrders.ts の公開条件) だけ。出典 (n01) と取得の状態を必ず添える。
 */

/** What the plan of a game is, from the card's orders and the read of them. */
export function planStatusOf(orders: Pick<CardOrders, 'rows' | 'error'>, planned: PlannedCard | null, schid: string): PlanStatus {
  const game = planned?.games.get(schid);
  if (orders.rows !== null && game) return game.state;
  return orders.error ? 'error' : 'loading';
}

const nameOf = (member: CardOrderMember): string => member.name || '(名前なし)';

/** One team's planned players, one per line, in n01's order — or what is known instead. */
function PlannedSide({ game, side, status, label }: { game: PlannedGame | null; side: 0 | 1; status: PlanStatus; label?: (name: string) => ReactNode }): React.JSX.Element {
  const members = status === 'published' ? game?.sides[side].members ?? null : null;
  if (members === null) {
    const fixed = game?.sides[side].state === 'fixed';
    return <span className="planned-names muted">{status === 'oneSide' ? (fixed ? '確定済み' : '未確定') : '—'}</span>;
  }
  if (members.length === 0) return <span className="planned-names muted">—</span>;
  return (
    <span className="planned-names">
      {members.map((member, index) => (
        <span key={`${member.oid ?? ''}:${index}`} className="planned-name">
          {label ? label(nameOf(member)) : nameOf(member)}
        </span>
      ))}
    </span>
  );
}

/** The age of the orders shown and whether the last read failed. */
function OrdersSource({ orders, status }: { orders: CardOrders; status: PlanStatus }): React.JSX.Element {
  const at = (ms: number | null): string => (ms === null ? '—' : new Date(ms).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit', second: '2-digit' }));
  return (
    <div className="planned-source small-text">
      <p className="muted">
        {status === 'published' ? 'n01 確定済みオーダー' : '出典: n01 のオーダー'}
        {orders.fetchedAt !== null ? ` ・ 取得 ${at(orders.fetchedAt)}` : ''}
      </p>
      {orders.error && orders.rows !== null ? (
        <p className="planned-stale" role="status" data-testid="orders-stale">
          <Icon name="alert" size={14} /> 更新に失敗しました ({orders.error})。表示は {at(orders.fetchedAt)} に取得した情報です。
        </p>
      ) : null}
      <button type="button" className="btn ghost small" onClick={orders.refresh} disabled={orders.loading} data-testid="orders-refresh">
        <Icon name="refresh" size={14} /> {orders.loading ? '取得中…' : 'オーダーを再取得'}
      </button>
    </div>
  );
}

/** The game chosen before it starts: its name and kind, both teams, the planned players and what to wait for. */
export function PlannedGameView({
  label,
  kind,
  names,
  status,
  game,
  orders,
  waiting,
}: {
  label: string;
  /** 「Singles 501」: only what the season's schedule says (never guessed). */
  kind: string | null;
  names: [string, string];
  status: PlanStatus;
  game: PlannedGame | null;
  orders: CardOrders | null;
  /** The card is still to be played (else this game was not played and never will be). */
  waiting: boolean;
}): React.JSX.Element {
  return (
    <section className="game-block planned-game" aria-label={`${label} (開始前)`} data-testid="planned-game">
      <header className="unit-head">
        <h3 className="game-block-head" data-testid="planned-title">
          {label}
          {kind ? <span className="muted small-text">{kind}</span> : null}
          <span className="tag state-planned">{waiting ? '開始前' : '未実施'}</span>
        </h3>
        <div className="unit-duel planned-duel">
          <span className="planned-team">
            <strong className="planned-team-name">{names[0]}</strong>
            {orders ? <PlannedSide game={game} side={0} status={status} /> : null}
          </span>
          <strong className="planned-vs" aria-label="対">
            VS
          </strong>
          <span className="planned-team">
            <strong className="planned-team-name">{names[1]}</strong>
            {orders ? <PlannedSide game={game} side={1} status={status} /> : null}
          </span>
        </div>
      </header>
      {orders ? (
        <p className={`planned-status plan-${status}`} data-testid="planned-status">
          {PLAN_TEXT[status]}
        </p>
      ) : null}
      {waiting ? (
        <p className="planned-wait" data-testid="planned-wait">
          <strong>ゲーム開始待ち</strong>
          <span className="muted small-text">開始されるとスコアが表示されます</span>
        </p>
      ) : (
        <p className="muted small-text">このゲームの記録はありません (実施されていません)。</p>
      )}
      {orders ? <OrdersSource orders={orders} status={status} /> : null}
    </section>
  );
}

export interface OverviewRow {
  schid: string;
  label: string;
  /** Who plays (or played), per card side. */
  sides: [ReactNode, ReactNode];
  /** 「2 - 1／終了」「LIVE」「開始前・確定済み」 */
  state: ReactNode;
  live: boolean;
  /** A note under the row (an estimated start). */
  note?: string;
}

/**
 * 「オーダー一覧」: every game of the card with both sides' players and its state, closed at first
 * and opened in place (no other page). Picking a row opens that game.
 */
export function OrderOverview({
  names,
  rows,
  selected,
  onPick,
  footnote,
  orders,
}: {
  names: [string, string];
  rows: readonly OverviewRow[];
  selected: string | null;
  onPick: (schid: string) => void;
  footnote?: ReactNode;
  orders: CardOrders | null;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <div className="order-overview" data-testid="order-overview">
      <button type="button" className="btn small order-overview-toggle" aria-expanded={open} aria-controls={id} onClick={() => setOpen(!open)} data-testid="order-overview-toggle">
        <Icon name="chevronDown" size={14} /> オーダー一覧
      </button>
      <div id={id} className="order-overview-panel" hidden={!open} data-testid="order-overview-panel">
        <table className="order-table small-text">
          <caption className="sr-only">全ゲームのオーダー ({names[0]} 対 {names[1]})</caption>
          <thead>
            <tr>
              <th scope="col">{names[0]}</th>
              <th scope="col">{names[1]}</th>
            </tr>
          </thead>
          {rows.map((row) => (
            <tbody key={row.schid} className={`order-row${row.live ? ' is-live' : ''}${selected === row.schid ? ' is-selected' : ''}`}>
              <tr>
                <th scope="colgroup" colSpan={2} className="order-row-head">
                  <button
                    type="button"
                    className="linklike order-row-pick"
                    aria-current={selected === row.schid ? 'true' : undefined}
                    onClick={() => {
                      onPick(row.schid);
                      setOpen(false);
                    }}
                    data-testid="order-row"
                    data-key={row.schid}
                  >
                    {row.label}
                  </button>
                  <span className="order-row-state">
                    {row.state}
                    {row.note ? <span className="muted"> ・ {row.note}</span> : null}
                  </span>
                </th>
              </tr>
              <tr>
                <td>{row.sides[0]}</td>
                <td>{row.sides[1]}</td>
              </tr>
            </tbody>
          ))}
        </table>
        {footnote ? <p className="muted small-text">{footnote}</p> : null}
        {orders?.error && orders.rows !== null ? (
          <p className="planned-stale small-text" role="status">
            <Icon name="alert" size={14} /> オーダーの更新に失敗しました。予定は最後に取得した情報です。
          </p>
        ) : null}
        {orders ? (
          <button type="button" className="btn ghost small" onClick={orders.refresh} disabled={orders.loading}>
            <Icon name="refresh" size={14} /> {orders.loading ? '取得中…' : 'オーダーを再取得'}
          </button>
        ) : null}
      </div>
    </div>
  );
}

/** A side of a row of the overview: the players, one per line (actual or planned). */
export function NameLines({ names }: { names: readonly string[] }): React.JSX.Element {
  if (names.length === 0) return <span className="muted">—</span>;
  return (
    <span className="planned-names">
      {names.map((name, index) => (
        <span key={`${name}:${index}`} className="planned-name">
          {name}
        </span>
      ))}
    </span>
  );
}

/** The planned players of one side for the overview (names only when published). */
export function plannedNames(game: PlannedGame | undefined, side: 0 | 1, status: PlanStatus): string[] | null {
  if (status !== 'published' || !game) return null;
  return (game.sides[side].members ?? []).map(nameOf);
}
