import { useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from '../../../components/icons';
import type { MatchesApi } from '../api';
import type { CardOrder, GameRow, LiveState, SeasonDocument } from '../parse';
import { parseLeagueTmid } from '../parse';
import { gameWinner, sideRate, slotStructure } from '../cards';
import type { LiveStatus } from '../livePoller';
import { LivePoller, medianMs } from '../livePoller';
import type { LiveEvent } from '../gameStats';
import { throwEvents } from '../gameStats';
import { cardOutlook, log5, shrunk } from '../probability';
import type { GameOutlook } from '../probability';
import { teamProfile } from '../insights';
import { checkReproduction, projectMany } from '../standings';
import type { SeasonData } from './useMatchContext';
import { formatClock, useTodayBoard } from './useMatchContext';
import { GameView } from './GameView';
import { LiveSheet } from './LiveSheet';
import { usePlayerStats } from './useMatchContext';
import type { MatchesApiFactory } from '../environment';

/**
 * LIVE (ライブ). The first screen answers, without scrolling: which cards are on and their score,
 * the chosen card's games so far, the score left and who throws next. Everything else — the
 * score sheet of any game, the events, the estimate and the standings if it ended now — is
 * on the same screen below, never another page.
 */

export interface BoardCard {
  tmid: string;
  divisionIndex: number;
  lsid: string;
  teams: [{ id: string; name: string }, { id: string; name: string }];
  /** Games won, card order. */
  won: [number, number];
  games: GameRow[];
  current: GameRow | null;
  finished: boolean;
}

export function boardCards(season: SeasonDocument, games: readonly GameRow[]): BoardCard[] {
  const byTmid = new Map<string, BoardCard>();
  for (const game of [...games].sort((x, y) => (x.startTime ?? 0) - (y.startTime ?? 0))) {
    const parts = parseLeagueTmid(game.tmid, season.tournamentId);
    if (!parts || !game.tmid) continue;
    const card =
      byTmid.get(game.tmid) ??
      ({
        tmid: game.tmid,
        divisionIndex: parts.divisionIndex,
        lsid: parts.lsid,
        teams: [
          { id: parts.teamIds[0], name: season.teams.get(parts.teamIds[0]) ?? game.sides[0].name },
          { id: parts.teamIds[1], name: season.teams.get(parts.teamIds[1]) ?? game.sides[1].name },
        ],
        won: [0, 0],
        games: [],
        current: null,
        finished: false,
      } as BoardCard);
    card.games.push(game);
    byTmid.set(game.tmid, card);
  }
  for (const card of byTmid.values()) {
    for (const game of card.games) {
      const winner = gameWinner(game);
      if (winner !== null) card.won[game.sides[winner].teamId === card.teams[0].id ? 0 : 1] += 1;
      if (!game.finished) card.current = game;
    }
    card.finished = card.current === null && (card.games.some((game) => game.cardFinished) || card.games.length >= season.slots.length);
  }
  return [...byTmid.values()];
}

const slotLabel = (season: SeasonDocument, schid: string | null): string => season.slots.find((slot) => slot.schid === schid)?.label ?? 'ゲーム';

export function LiveTab({ data, registered, api, factory }: { data: SeasonData; registered: string[]; api: MatchesApi; factory: MatchesApiFactory }): React.JSX.Element {
  const board = useTodayBoard(api, data.season.tournamentId, true);
  const cards = useMemo(() => (board.games ? boardCards(data.season, board.games) : []), [board.games, data.season]);
  const sorted = useMemo(
    () =>
      [...cards].sort(
        (x, y) =>
          Number(y.teams.some((t) => registered.includes(t.id))) - Number(x.teams.some((t) => registered.includes(t.id))) ||
          Number(!!y.current) - Number(!!x.current) ||
          x.divisionIndex - y.divisionIndex,
      ),
    [cards, registered],
  );
  const [chosen, setChosen] = useState<string | null>(null);
  const focus = sorted.find((card) => card.tmid === chosen) ?? sorted.find((card) => card.current) ?? sorted[0] ?? null;

  if (board.games === null) {
    return board.error ? (
      <p className="small-text" role="alert">
        取得エラー: {board.error} (20 秒後に再試行します)
      </p>
    ) : (
      <p className="muted small-text" role="status">
        <span className="spinner" aria-hidden="true" /> 今日の試合を確認中…
      </p>
    );
  }

  if (sorted.length === 0) {
    return (
      <div className="live-empty" data-testid="live-empty">
        <p className="small-text">いま進行中・本日終了した試合はありません。</p>
        <NextRound data={data} registered={registered} />
      </div>
    );
  }

  return (
    <div className="live-hub" data-testid="live-hub">
      <p className="muted small-text live-meta">
        <span className="live-dot" aria-hidden="true" /> 進行中 {cards.filter((card) => card.current).length} ・ 本日 {cards.length} カード ・ 一覧の取得{' '}
        {formatClock(board.fetchedAt)}
        {board.error ? ` ・ 取得エラー (前回の値を表示中)` : ''}
      </p>
      <ul className="board" aria-label="本日の対戦">
        {sorted.map((card) => (
          <li key={card.tmid}>
            <button type="button" className={`board-tile${card.current ? ' is-live' : ''}`} aria-pressed={focus?.tmid === card.tmid} onClick={() => setChosen(card.tmid)} data-testid="board-tile">
              <span className={`t${registered.includes(card.teams[0].id) ? ' own' : ''}`}>{card.teams[0].name}</span>
              <strong className="s">
                {card.won[0]}-{card.won[1]}
              </strong>
              <span className={`t${registered.includes(card.teams[1].id) ? ' own' : ''}`}>{card.teams[1].name}</span>
              <span className="g muted">
                {card.current ? `${slotLabel(data.season, card.current.schid)} ${card.current.sides[0].legsWon ?? 0}-${card.current.sides[1].legsWon ?? 0}` : card.finished ? '終了' : '休憩中'}
              </span>
            </button>
          </li>
        ))}
      </ul>
      {focus ? <FocusCard key={focus.tmid} card={focus} data={data} registered={registered} todayCards={cards} factory={factory} api={api} /> : null}
    </div>
  );
}

function NextRound({ data, registered }: { data: SeasonData; registered: string[] }): React.JSX.Element | null {
  const upcoming = data.cards.filter((card) => card.state === 'scheduled');
  if (upcoming.length === 0) return null;
  const title = upcoming[0].title;
  const round = upcoming.filter((card) => card.title === title);
  return (
    <div>
      <h3 className="section-mini">次の節 {title}</h3>
      <ul className="small-text plain">
        {round.map((card) => (
          <li key={card.key} className={card.teams.some((t) => registered.includes(t.id)) ? 'own' : ''}>
            {card.divisionTitle}: {card.teams[0].name} vs {card.teams[1].name}
          </li>
        ))}
      </ul>
    </div>
  );
}

function FocusCard({ card, data, registered, todayCards, factory, api }: { card: BoardCard; data: SeasonData; registered: string[]; todayCards: BoardCard[]; factory: MatchesApiFactory; api: MatchesApi }): React.JSX.Element {
  const liveApi = useMemo(() => factory({ maxRequests: 100_000 }), [factory]);
  const [live, setLive] = useState<LiveState | null>(null);
  const [status, setStatus] = useState<LiveStatus>({ kind: 'idle' });
  const [events, setEvents] = useState<LiveEvent[]>([]);
  const [lag, setLag] = useState<number | null>(null);
  const [orders, setOrders] = useState<CardOrder[] | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  const ages = useRef<number[]>([]);
  const previous = useRef<LiveState | null>(null);
  const names: [string, string] = [card.teams[0].name, card.teams[1].name];

  // The card in progress is followed by `match/live` (tmid): 1.5 s, paused when hidden.
  useEffect(() => {
    if (card.finished) return;
    const poller = new LivePoller(liveApi, { tmid: card.tmid }, {
      maxRequests: 20_000,
      onState: (state) => {
        const before = previous.current;
        const add: LiveEvent[] = [];
        const at = Date.now();
        const sideNames: [string, string] = [state.sides[0].name, state.sides[1].name];
        if (state.leg) {
          const sameLeg = before && before.mid === state.mid && before.leg?.index === state.leg.index;
          add.push(...throwEvents(sameLeg ? before!.leg!.throws : [], state.leg.throws, sideNames, `${state.mid}:${state.leg.index}`, at));
          if (state.leg.ended && !(sameLeg && before!.leg!.ended) && (state.leg.winner === 0 || state.leg.winner === 1)) {
            add.push({ id: `${state.mid}:${state.leg.index}:end`, kind: 'leg', at, text: `Leg ${state.leg.index + 1}: ${sideNames[state.leg.winner]}` });
          }
        }
        if (state.gameEnded && !(before && before.mid === state.mid && before.gameEnded)) {
          add.push({ id: `${state.mid}:game`, kind: 'game', at, text: `${state.title.split(' ').slice(-1)[0]} 決着 (${state.legs[0]}-${state.legs[1]})` });
        }
        if (state.cardEnded && !before?.cardEnded) add.push({ id: `${state.tmid}:card`, kind: 'card', at, text: `対戦終了 ${state.sets[0]}-${state.sets[1]}` });
        // First reply: what already happened is not news.
        if (before) setEvents((held) => [...add.filter((event) => !held.some((h) => h.id === event.id)).reverse(), ...held].slice(0, 40));
        previous.current = state;
        setLive(state);
      },
      onStatus: setStatus,
      onSample: (sample) => {
        ages.current = [...ages.current.slice(-19), sample.ageMs];
        setLag(medianMs(ages.current));
      },
    });
    const onVisibility = (): void => poller.setHidden(document.visibilityState === 'hidden');
    document.addEventListener('visibilitychange', onVisibility);
    poller.setHidden(document.visibilityState === 'hidden');
    poller.start();
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      poller.stop();
    };
  }, [card.tmid, card.finished, liveApi]);

  // Who plays which game: read once, again every 2 minutes while the card runs.
  useEffect(() => {
    let alive = true;
    const load = (): void => {
      api
        .cardOrders(data.season.tournamentId, card.tmid)
        .then((list) => alive && setOrders(list))
        .catch(() => alive && setOrders((held) => held ?? []));
    };
    load();
    const timer = card.finished ? null : setInterval(load, 120_000);
    return () => {
      alive = false;
      if (timer) clearInterval(timer);
    };
  }, [api, card.tmid, card.finished, data.season.tournamentId]);

  const flipOf = (game: GameRow): boolean => game.sides[0].teamId === card.teams[1].id;
  const bySchid = new Map(card.games.map((game) => [game.schid, game]));
  const currentSchid = live && !live.gameEnded ? live.schid : card.current?.schid ?? null;
  const selected = picked ?? currentSchid ?? card.games[card.games.length - 1]?.schid ?? null;
  const selectedGame = selected ? bySchid.get(selected) ?? null : null;

  // Card score: n01's live count when there is one (it includes the game just won), else the board's.
  const liveFlip = live?.sides[0].teamId === card.teams[1].id;
  const won: [number, number] = live?.isSchedule ? (liveFlip ? [live.sets[1], live.sets[0]] : [live.sets[0], live.sets[1]]) : card.won;

  // Estimate: season win rates per kind, the game in progress by its legs.
  const ours = teamProfile(data.season, data.cards, data.games, card.teams[0].id);
  const theirs = teamProfile(data.season, data.cards, data.games, card.teams[1].id);
  const outlook = cardOutlook(
    data.season.slots.map((slot): GameOutlook => {
      const game = bySchid.get(slot.schid);
      const kind = slotStructure(slot);
      const p = log5(shrunk(ours.byStructure[kind]), shrunk(theirs.byStructure[kind]));
      if (game?.finished) {
        const winner = gameWinner(game);
        if (winner !== null) return { state: 'done', winner: (flipOf(game) ? 1 - winner : winner) as 0 | 1 };
      }
      if (live && live.schid === slot.schid && !live.gameEnded && live.limitLeg) {
        const legs: [number, number] = liveFlip ? [live.legs[1], live.legs[0]] : [live.legs[0], live.legs[1]];
        return { state: 'live', p, legs, need: live.limitLeg };
      }
      return { state: 'todo', p };
    }),
  );
  const seasonGames = Object.values(ours.byStructure).reduce((sum, r) => sum + r.games, 0) + Object.values(theirs.byStructure).reduce((sum, r) => sum + r.games, 0);

  // Standings if every card of this division today ended as it stands.
  const group = data.standings?.find((entry) => entry.divisionIndex === card.divisionIndex);
  const divisionCards = data.cards.filter((entry) => entry.divisionIndex === card.divisionIndex);
  const reproduction = group ? checkReproduction(data.season.pointRule, group, divisionCards) : null;
  const projected =
    group && reproduction?.ok
      ? projectMany(
          data.season.pointRule,
          group,
          todayCards
            .filter((entry) => entry.divisionIndex === card.divisionIndex)
            .map((entry) => {
              const official = data.cards.find((c) => c.lsid === entry.lsid && c.divisionIndex === entry.divisionIndex);
              if (!official || official.official) return null;
              const score: [number, number] = official.teams[0].id === entry.teams[0].id ? entry.won : [entry.won[1], entry.won[0]];
              if (entry.tmid === card.tmid) return { card: official, score: official.teams[0].id === card.teams[0].id ? won : ([won[1], won[0]] as [number, number]) };
              return { card: official, score };
            })
            .filter((entry): entry is NonNullable<typeof entry> => entry !== null),
        )
      : null;

  const orderOf = (teamId: string, schid: string): CardOrder | undefined => orders?.find((order) => order.teamId === teamId && order.schid === schid);
  const upcoming = data.season.slots.filter((slot) => !bySchid.has(slot.schid));
  const minutesPerGame = (() => {
    const done = card.games.filter((game) => game.finished && game.startTime && game.updateTime);
    if (done.length === 0) return null;
    const spans = done.map((game) => (game.updateTime! / 1000 - game.startTime!) / 60).filter((m) => m > 0 && m < 120);
    return spans.length ? spans.reduce((a, b) => a + b, 0) / spans.length : null;
  })();

  // Each singles player's season average (n01's own figure), matched within the team by exact name.
  const stats = usePlayerStats(api, data.season.tournamentId, !card.finished);
  const seasonAverage: [number | null, number | null] | undefined =
    live && stats.kind === 'ready'
      ? ([0, 1] as const).map((side) => {
          const members = live.sides[side].members;
          if (members.length !== 1) return null;
          const hits = stats.value.filter((row) => row.teamId === live.sides[side].teamId && row.name === members[0]);
          const line = hits.length === 1 ? hits[0].line : null;
          return line && line.score !== null && line.darts ? (line.score / line.darts) * 3 : null;
        }) as [number | null, number | null]
      : undefined;

  return (
    <section className="focus-card" aria-label={`${names[0]} 対 ${names[1]}`} data-testid="focus-card">
      <header className="focus-head">
        <span className={registered.includes(card.teams[0].id) ? 'own' : ''}>{names[0]}</span>
        <strong aria-label={`獲得ゲーム ${won[0]} 対 ${won[1]}`}>
          {won[0]} - {won[1]}
        </strong>
        <span className={registered.includes(card.teams[1].id) ? 'own' : ''}>{names[1]}</span>
      </header>
      <ol className="flow" aria-label="ゲームの流れ">
        {data.season.slots.map((slot) => {
          const game = bySchid.get(slot.schid);
          const winner = game ? gameWinner(game) : null;
          const cardWinner = game && winner !== null ? (flipOf(game) ? 1 - winner : winner) : null;
          const isLive = game && !game.finished;
          return (
            <li key={slot.schid}>
              <button
                type="button"
                className={`dot${cardWinner === 0 ? ' a' : cardWinner === 1 ? ' b' : ''}${isLive ? ' live' : ''}${!game ? ' todo' : ''}`}
                aria-pressed={selected === slot.schid}
                disabled={!game}
                onClick={() => setPicked(slot.schid)}
                title={slot.label}
              >
                <span className="sr-only">
                  {slot.label} {cardWinner === 0 ? `${names[0]} 勝ち` : cardWinner === 1 ? `${names[1]} 勝ち` : isLive ? '進行中' : '未実施'}
                </span>
              </button>
              <span className="dot-label">{slot.label.replace(/シングルス/u, 'S').replace(/ダブルス/u, 'D').replace(/トリオス/u, 'T').replace(/チーム/u, 'Team')}</span>
            </li>
          );
        })}
      </ol>
      <p className="small-text estimate" data-testid="estimate">
        予測: {names[0]} 勝ち {Math.round(outlook.win * 100)}%{outlook.draw > 0.005 ? ` ・ 引分 ${Math.round(outlook.draw * 100)}%` : ''} ・ {names[1]} 勝ち {Math.round(outlook.loss * 100)}%
        <span className="muted"> (今季の種別勝率から計算{seasonGames < 20 ? '・データ少なめ' : ''})</span>
      </p>

      {live && !live.gameEnded ? <LiveSheet api={api} live={live} seasonAverage={seasonAverage} /> : null}

      {selectedGame && !(live && !live.gameEnded && live.mid === selectedGame.mid) ? (
        <details className="game-block" open>
          <summary>
            {slotLabel(data.season, selectedGame.schid)} ・ {selectedGame.finished ? '終了' : '進行中'} ・ {names[0]} {sideRate(selectedGame, flipOf(selectedGame) ? 1 : 0)?.toFixed(2) ?? '—'} / {names[1]}{' '}
            {sideRate(selectedGame, flipOf(selectedGame) ? 0 : 1)?.toFixed(2) ?? '—'}
          </summary>
          <GameView
            key={selectedGame.mid}
            api={api}
            mid={selectedGame.mid}
            cricket={selectedGame.matchType === 'cricket'}
            finished={selectedGame.finished && !(live && live.mid === selectedGame.mid && !live.gameEnded)}
            names={names}
            flip={flipOf(selectedGame)}
            liveLeg={live && live.mid === selectedGame.mid && !live.gameEnded ? live.leg : null}
          />
        </details>
      ) : null}

      {events.length > 0 ? (
        <div className="events" data-testid="events">
          <h3 className="section-mini">出来事</h3>
          <ol className="plain small-text">
            {events.slice(0, 8).map((event) => (
              <li key={event.id} className={`ev-${event.kind}`}>
                <span className="muted">{new Date(event.at).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' })}</span> {event.text}
              </li>
            ))}
          </ol>
        </div>
      ) : null}

      {upcoming.length > 0 ? (
        <div className="upcoming" data-testid="upcoming">
          <h3 className="section-mini">このあとの出場予定{minutesPerGame ? ` (1ゲーム 約${Math.round(minutesPerGame)}分)` : ''}</h3>
          <ol className="plain small-text">
            {upcoming.map((slot, index) => {
              const a = orderOf(card.teams[0].id, slot.schid);
              const b = orderOf(card.teams[1].id, slot.schid);
              return (
                <li key={slot.schid}>
                  <strong>{slot.label}</strong> {a?.members.join('・') || '(未提出)'} vs {b?.members.join('・') || '(未提出)'}
                  {minutesPerGame ? <span className="muted"> ・ 約{Math.round(minutesPerGame * (index + (card.current ? 1 : 0)))}分後</span> : null}
                </li>
              );
            })}
          </ol>
          <p className="muted small-text">オーダーは n01 に提出された内容。時刻はこの対戦の終了ゲームの平均から計算した目安です。</p>
        </div>
      ) : null}

      {projected ? (
        <div className="projected-block" data-testid="live-standings">
          <h3 className="section-mini">このまま終わった場合の順位 (予測)</h3>
          <ol className="plain small-text">
            {projected.map((row) => (
              <li key={row.teamId} className={registered.includes(row.teamId) ? 'own' : ''}>
                {row.tied ? `${row.projectedPosition}位タイ` : `${row.projectedPosition}位`} {row.name} {row.projectedPoints}点
                <span className="muted">
                  {' '}
                  (公式 {row.officialRank > 0 ? `${row.officialRank}位` : '—'}
                  {row.officialRank > 0 && row.projectedPosition < row.officialRank ? ' ↑' : row.officialRank > 0 && row.projectedPosition > row.officialRank ? ' ↓' : ''})
                </span>
              </li>
            ))}
          </ol>
        </div>
      ) : reproduction && !reproduction.ok ? (
        <p className="muted small-text">順位予測なし: {reproduction.reason}</p>
      ) : null}

      <p className={`small-text live-status ${status.kind}`} role="status" data-testid="live-status">
        <Icon name="refresh" size={14} />{' '}
        {card.finished
          ? 'この対戦は終了しています'
          : status.kind === 'polling'
            ? '自動更新中'
            : status.kind === 'paused-hidden'
              ? '画面が非表示のため一時停止中'
              : status.kind === 'retrying'
                ? `取得エラー: ${status.message} (${Math.round(status.retryInMs / 1000)}秒後に再試行・表示は前回の値)`
                : status.kind === 'finished'
                  ? '終了しました'
                  : '接続中…'}
        {live ? ` ・ n01 更新 ${new Date(live.updateTime).toLocaleTimeString('ja-JP')}` : ''}
        {lag !== null ? ` ・ 遅れ 約${(lag / 1000).toFixed(1)}秒 (実測)` : ''}
      </p>
    </section>
  );
}
