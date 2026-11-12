import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Icon } from '../../../components/icons';
import type { MatchesApi } from '../api';
import type { CardOrder, GameRow, LiveState, SeasonDocument } from '../parse';
import { parseLeagueTmid, slotOf, slotsFor } from '../parse';
import { gameWinner } from '../cards';
import type { LiveStatus } from '../livePoller';
import { LivePoller, medianMs } from '../livePoller';
import type { LiveEvent } from '../gameStats';
import { throwEvents } from '../gameStats';
import { outlookTrail, slotChances } from '../cardTrail';
import { checkReproduction, projectMany } from '../standings';
import type { SeasonData } from './useMatchContext';
import { formatClock, seasonStatsSource, useFollowed, useTodayBoard } from './useMatchContext';
import { GameView } from './GameView';
import { CardTrail, shortSlot } from './CardTrail';
import { LiveSheet } from './LiveSheet';
import { liveStatusText } from './MatchSheet';
import type { PlayerLevel } from './LiveSheet';
import { usePlayerStats } from './useMatchContext';
import type { MatchesApiFactory } from '../environment';
import { ListCoverage, listIncomplete } from './ListCoverage';

/**
 * LIVE (ライブ). The first screen answers, without scrolling: which cards are on and their score
 * (the tiles stay at the top while the page scrolls, so another team's card is one tap away),
 * the chosen card's games as a row of tabs — won, in progress, to come — and, right under it,
 * the game in progress: which leg is on, the score left and who throws next.
 *
 * A tap on an earlier game shows that game in the same place (its legs, its score sheets), with
 * one line that keeps the live game in sight and returns to it. Everything else — the estimate,
 * who plays next and how strong they are, the events, the standings if it ended now — follows
 * below, never on another page.
 *
 * On a large screen (1200 px and up) two cards can be shown side by side (「2 カードを並べる」):
 * the chosen card on the left, another on the right. A tap on a tile not shown puts it in the
 * pane shown longer, so the card just picked stays; the tiles say which pane holds them.
 */

/** Width from which two cards fit side by side (each pane keeps the phone layout of the sheet). */
export const PAIR_MIN_WIDTH = 1200;

/** Whether two cards were shown side by side last time (this session). */
let rememberedPair = false;

function useWideScreen(): boolean {
  const query = `(min-width: ${PAIR_MIN_WIDTH}px)`;
  const read = (): boolean => typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia(query).matches;
  const [wide, setWide] = useState(read);
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const list = window.matchMedia(query);
    const onChange = (): void => setWide(list.matches);
    onChange();
    list.addEventListener('change', onChange);
    return () => list.removeEventListener('change', onChange);
  }, [query]);
  return wide;
}

export interface PlayerRef {
  oid: string;
  name: string;
  teamId: string | null;
}

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
    card.finished = card.current === null && (card.games.some((game) => game.cardFinished) || card.games.length >= slotsFor(season, card.divisionIndex).length);
  }
  return [...byTmid.values()];
}

const slotLabel = (season: SeasonDocument, schid: string | null): string => slotOf(season, schid)?.label ?? 'ゲーム';

export function LiveTab({
  data,
  registered,
  api,
  factory,
  onPlayer,
}: {
  data: SeasonData;
  registered: string[];
  api: MatchesApi;
  factory: MatchesApiFactory;
  /** Opens a player's card (season figures, results). */
  onPlayer?: (player: PlayerRef) => void;
}): React.JSX.Element {
  const board = useTodayBoard(api, data.season.tournamentId, true);
  const cards = useMemo(() => (board.games ? boardCards(data.season, board.games) : []), [board.games, data.season]);
  const followed = useFollowed();
  // Followed players on today's cards: the game they are in (in progress first), one line each.
  const spots = useMemo(() => followedSpots(cards, followed.names), [cards, followed.names]);
  const sorted = useMemo(
    () =>
      [...cards].sort(
        (x, y) =>
          Number(y.teams.some((t) => registered.includes(t.id))) - Number(x.teams.some((t) => registered.includes(t.id))) ||
          Number(spots.some((spot) => spot.card === y)) - Number(spots.some((spot) => spot.card === x)) ||
          Number(!!y.current) - Number(!!x.current) ||
          x.divisionIndex - y.divisionIndex,
      ),
    [cards, registered, spots],
  );
  const [chosen, setChosen] = useState<string | null>(null);
  // The tiles stay under the header while the page scrolls (two or more cards); once they are
  // stuck there they shrink to two lines, so they do not take the room of the game below.
  const sentinel = useRef<HTMLDivElement | null>(null);
  const [stuck, setStuck] = useState(false);
  const many = sorted.length > 1;
  useEffect(() => {
    const node = sentinel.current;
    if (!node || !many || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(([entry]) => setStuck(!entry.isIntersecting && entry.boundingClientRect.top < 120), { rootMargin: '-72px 0px 0px 0px' });
    observer.observe(node);
    return () => observer.disconnect();
  }, [many]);
  // Shrinking the tiles must not move the page: the room they give up is kept as a margin, so
  // nothing below shifts (browsers without scroll anchoring — iOS Safari — would jump otherwise).
  const boardRef = useRef<HTMLUListElement | null>(null);
  const fullHeight = useRef(0);
  const compact = stuck && many;
  useLayoutEffect(() => {
    const node = boardRef.current;
    if (!node) return;
    if (!compact) {
      node.style.marginBottom = '';
      fullHeight.current = node.getBoundingClientRect().height;
      return;
    }
    node.style.marginBottom = `${Math.max(0, fullHeight.current - node.getBoundingClientRect().height)}px`;
  }, [compact, sorted.length]);
  const focus = sorted.find((card) => card.tmid === chosen) ?? sorted.find((card) => card.current) ?? sorted[0] ?? null;

  // Two cards side by side (large screens): the right pane's card, and which pane a new pick replaces.
  const wide = useWideScreen();
  const [pairWanted, setPairWanted] = useState(rememberedPair);
  const pair = pairWanted && wide && many;
  const [second, setSecond] = useState<string | null>(null);
  const [lastSet, setLastSet] = useState<'left' | 'right'>('left');
  const right = pair && focus ? (sorted.find((card) => card.tmid === second && card.tmid !== focus.tmid) ?? sorted.find((card) => card.tmid !== focus.tmid && card.current) ?? sorted.find((card) => card.tmid !== focus.tmid) ?? null) : null;
  const paneOf = (tmid: string): 'left' | 'right' | null => (focus?.tmid === tmid ? 'left' : right?.tmid === tmid ? 'right' : null);
  const pick = (tmid: string): void => {
    if (!pair) {
      // One card shown: it is the left pane's card, and the one just picked (kept when widened).
      setChosen(tmid);
      setLastSet('left');
      return;
    }
    if (paneOf(tmid)) return;
    // The pane shown longer gives way: the card picked just before stays in sight.
    if (lastSet === 'left') {
      setSecond(tmid);
      setLastSet('right');
    } else {
      setChosen(tmid);
      setLastSet('left');
    }
  };
  const togglePair = (): void => {
    rememberedPair = !pairWanted;
    setPairWanted(!pairWanted);
  };

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
        <p className="small-text">{listIncomplete(board) ? '取得できた本日の試合はありません (一覧の一部は未取得)。' : 'いま進行中・本日終了した試合はありません。'}</p>
        <ListCoverage state={board} kind="today" />
        <NextRound data={data} registered={registered} />
      </div>
    );
  }

  return (
    <div className={`live-hub${pair ? ' is-pair' : ''}`} data-testid="live-hub">
      <div className="live-meta-row">
        <p className="muted small-text live-meta">
          <span className="live-dot" aria-hidden="true" /> 進行中 {cards.filter((card) => card.current).length} ・ 本日 {cards.length} カード ・ 一覧の取得{' '}
          {formatClock(board.fetchedAt)}
          {board.error ? ` ・ 取得エラー (前回の値を表示中)` : ''}
        </p>
        {wide && many ? (
          <button type="button" className="chip pair-toggle" aria-pressed={pair} onClick={togglePair} data-testid="pair-toggle">
            2 カードを並べる
          </button>
        ) : null}
      </div>
      <ListCoverage state={board} kind="today" />
      {spots.length ? (
        <section className="followed-now" aria-label="注目選手" data-testid="followed-now">
          <h3 className="section-mini">
            <span aria-hidden="true">★</span> 注目選手
          </h3>
          <ul className="plain">
            {spots.map((spot) => (
              <li key={`${spot.name}:${spot.card.tmid}`}>
                <button type="button" className={`followed-row${spot.live ? ' is-live' : ''}`} onClick={() => setChosen(spot.card.tmid)}>
                  <strong>{spot.name}</strong>
                  <span>
                    {slotLabel(data.season, spot.game.schid)} {spot.live ? '出場中' : '出場済み'}
                  </span>
                  <span className="muted small-text">
                    {spot.card.teams[0].name} vs {spot.card.teams[1].name}
                  </span>
                </button>
              </li>
            ))}
          </ul>
          <p className="muted small-text">選手名で照合しています (同姓同名は区別できません)。</p>
        </section>
      ) : null}
      <div ref={sentinel} className="board-sentinel" aria-hidden="true" />
      <ul ref={boardRef} className={`board${compact ? ' is-stuck' : ''}`} aria-label="本日の対戦">
        {sorted.map((card) => {
          const game = card.current;
          const legs = game ? ([game.sides[0].legsWon ?? 0, game.sides[1].legsWon ?? 0] as const) : null;
          const flip = game ? game.sides[0].teamId === card.teams[1].id : false;
          const people = game && game.sides.every((side) => side.members.length > 0 && side.members.length <= 2) ? (flip ? [game.sides[1], game.sides[0]] : [...game.sides]).map((side) => side.members.map((m) => m.name).join('/')) : null;
          return (
            <li key={card.tmid}>
              <button
                type="button"
                className={`board-tile${game ? ' is-live' : ''}`}
                aria-pressed={paneOf(card.tmid) !== null}
                onClick={() => pick(card.tmid)}
                data-testid="board-tile"
                data-pane={pair ? (paneOf(card.tmid) ?? undefined) : undefined}
              >
                {pair && paneOf(card.tmid) ? (
                  <span className="pane-tag" aria-label={paneOf(card.tmid) === 'left' ? '左に表示中' : '右に表示中'}>
                    {paneOf(card.tmid) === 'left' ? '左' : '右'}
                  </span>
                ) : null}
                <span className={`t${registered.includes(card.teams[0].id) ? ' own' : ''}`}>{card.teams[0].name}</span>
                <strong className="s">
                  {card.won[0]}-{card.won[1]}
                </strong>
                <span className={`t${registered.includes(card.teams[1].id) ? ' own' : ''}`}>{card.teams[1].name}</span>
                <span className="g">
                  {game && legs ? (
                    <>
                      <span className="live-tag">LIVE</span> {shortSlot(slotLabel(data.season, game.schid))} ・ Leg {legs[0] + legs[1] + 1} ({flip ? `${legs[1]}-${legs[0]}` : `${legs[0]}-${legs[1]}`})
                    </>
                  ) : (
                    <span className="muted">{card.finished ? '終了' : '休憩中 (次のゲーム待ち)'}</span>
                  )}
                </span>
                {people ? <span className="p muted">{people.join(' vs ')}</span> : null}
              </button>
            </li>
          );
        })}
      </ul>
      {pair && focus && right ? (
        <div className="focus-pair" data-testid="focus-pair">
          <FocusCard key={focus.tmid} card={focus} data={data} registered={registered} todayCards={cards} factory={factory} api={api} onPlayer={onPlayer} pane="left" />
          <FocusCard key={right.tmid} card={right} data={data} registered={registered} todayCards={cards} factory={factory} api={api} onPlayer={onPlayer} pane="right" />
        </div>
      ) : focus ? (
        <FocusCard key={focus.tmid} card={focus} data={data} registered={registered} todayCards={cards} factory={factory} api={api} onPlayer={onPlayer} />
      ) : null}
    </div>
  );
}

export interface FollowedSpot {
  card: BoardCard;
  game: GameRow;
  name: string;
  live: boolean;
}

/** Each followed player's game on today's board: the game in progress, else the latest one. */
export function followedSpots(cards: readonly BoardCard[], names: ReadonlySet<string>): FollowedSpot[] {
  const byName = new Map<string, FollowedSpot>();
  for (const card of cards) {
    for (const game of card.games) {
      for (const side of game.sides) {
        for (const member of side.members) {
          const name = member.name.trim();
          if (!names.has(name)) continue;
          const spot = { card, game, name, live: !game.finished };
          const held = byName.get(name);
          if (!held || (spot.live && !held.live) || (spot.live === held.live && (game.startTime ?? 0) > (held.game.startTime ?? 0))) byName.set(name, spot);
        }
      }
    }
  }
  return [...byName.values()].sort((a, b) => Number(b.live) - Number(a.live) || a.name.localeCompare(b.name, 'ja'));
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

function FocusCard({
  card,
  data,
  registered,
  todayCards,
  factory,
  api,
  onPlayer,
  pane,
}: {
  /** Side by side: which pane this card is in. */
  pane?: 'left' | 'right';
  card: BoardCard;
  data: SeasonData;
  registered: string[];
  todayCards: BoardCard[];
  factory: MatchesApiFactory;
  api: MatchesApi;
  onPlayer?: (player: PlayerRef) => void;
}): React.JSX.Element {
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

  const schedule = slotsFor(data.season, card.divisionIndex);
  const flipOf = (game: GameRow): boolean => game.sides[0].teamId === card.teams[1].id;
  const bySchid = new Map(card.games.map((game) => [game.schid, game]));
  const currentSchid = live && !live.gameEnded ? live.schid : card.current?.schid ?? null;
  const selected = picked ?? currentSchid ?? card.games[card.games.length - 1]?.schid ?? null;
  const selectedGame = selected ? bySchid.get(selected) ?? null : null;

  // Card score: n01's live count when there is one (it includes the game just won), else the board's.
  const liveFlip = live?.sides[0].teamId === card.teams[1].id;
  const won: [number, number] = live?.isSchedule ? (liveFlip ? [live.sets[1], live.sets[0]] : [live.sets[0], live.sets[1]]) : card.won;

  // Estimate: season win rates per kind (without this card's games), the game in progress by its
  // legs; and the same estimate after each game so far (カード勝率の推移).
  const { chance, seasonGames } = slotChances(data.season, data.cards, data.games, [card.teams[0].id, card.teams[1].id], new Set(card.games.map((game) => game.mid)), schedule);
  const results = card.games.flatMap((game) => {
    const winner = game.finished ? gameWinner(game) : null;
    return winner === null || !game.schid ? [] : [{ schid: game.schid, winner: (flipOf(game) ? 1 - winner : winner) as 0 | 1, endedAt: game.updateTime }];
  });
  const liveGame =
    live && live.schid && !live.gameEnded && live.limitLeg
      ? { schid: live.schid, legs: (liveFlip ? [live.legs[1], live.legs[0]] : [live.legs[0], live.legs[1]]) as [number, number], need: live.limitLeg }
      : null;
  const trail = outlookTrail(schedule, chance, results, liveGame);
  const outlook = trail[trail.length - 1].outlook;

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
  const upcoming = schedule.filter((slot) => !bySchid.has(slot.schid));
  const minutesPerGame = (() => {
    const done = card.games.filter((game) => game.finished && game.startTime && game.updateTime);
    if (done.length === 0) return null;
    const spans = done.map((game) => (game.updateTime! / 1000 - game.startTime!) / 60).filter((m) => m > 0 && m < 120);
    return spans.length ? spans.reduce((a, b) => a + b, 0) / spans.length : null;
  })();

  // Season figures of the players (n01's own), matched within the team by exact name — only
  // when exactly one member of the team has that name; otherwise no figure at all.
  const statsSource = useMemo(() => seasonStatsSource(data.season), [data.season]);
  const stats = usePlayerStats(api, data.season.tournamentId, data.season.teamGames, statsSource);
  const levelOf = (teamId: string | null, name: string): PlayerLevel => {
    const hits = stats.kind === 'ready' && stats.unit === 'member' ? stats.value.filter((row) => row.teamId === teamId && row.name.trim() === name.trim()) : [];
    const hit = hits.length === 1 ? hits[0] : null;
    const line = hit?.line ?? null;
    return { oid: hit?.oid ?? null, name, teamId, average: line && line.score !== null && line.darts ? (line.score / line.darts) * 3 : null, legs: line?.leg ?? null, legsWon: line?.winLeg ?? null };
  };
  const levels: [PlayerLevel[], PlayerLevel[]] | undefined =
    live && stats.kind === 'ready' ? [live.sides[0].members.map((name) => levelOf(live.sides[0].teamId, name)), live.sides[1].members.map((name) => levelOf(live.sides[1].teamId, name))] : undefined;
  const withAverage = (teamId: string, members: readonly string[]): string =>
    members
      .map((name) => {
        const average = levelOf(teamId, name).average;
        return average === null ? name : `${name} (${average.toFixed(1)})`;
      })
      .join('・');
  const anyAverage = stats.kind === 'ready' && stats.value.length > 0;

  const liveSchid = live && !live.gameEnded ? live.schid : null;
  const showsLive = liveSchid !== null && selected === liveSchid;
  const liveLabel = liveSchid ? slotLabel(data.season, liveSchid) : null;
  const pct = (p: number): string => `${Math.round(p * 100)}%`;

  return (
    <section className="focus-card" aria-label={`${pane === 'left' ? '左: ' : pane === 'right' ? '右: ' : ''}${names[0]} 対 ${names[1]}`} data-testid="focus-card" data-pane={pane}>
      <header className="focus-head">
        <span className={registered.includes(card.teams[0].id) ? 'own' : ''}>{names[0]}</span>
        <strong aria-label={`獲得ゲーム ${won[0]} 対 ${won[1]}`}>
          {won[0]} - {won[1]}
        </strong>
        <span className={registered.includes(card.teams[1].id) ? 'own' : ''}>{names[1]}</span>
      </header>
      <ol className="game-tabs" aria-label="ゲームの流れ" data-testid="game-tabs">
        {schedule.map((slot) => {
          const game = bySchid.get(slot.schid);
          const winner = game ? gameWinner(game) : null;
          const cardWinner = game && winner !== null ? (flipOf(game) ? 1 - winner : winner) : null;
          // Which game is live is the poller's word (1.5 s) once it has one: the board's rows are a
          // few seconds older, and right after a game ends they still call the previous game
          // unfinished and do not hold the next one yet.
          const isLive = liveSchid !== null ? slot.schid === liveSchid : !!game && !game.finished;
          const legs = game ? (flipOf(game) ? [game.sides[1].legsWon ?? 0, game.sides[0].legsWon ?? 0] : [game.sides[0].legsWon ?? 0, game.sides[1].legsWon ?? 0]) : null;
          return (
            <li key={slot.schid}>
              <button
                type="button"
                className={`game-tab${cardWinner === 0 ? ' a' : cardWinner === 1 ? ' b' : ''}${isLive ? ' is-live' : ''}${!game && !isLive ? ' todo' : ''}`}
                aria-pressed={selected === slot.schid}
                disabled={!game && !isLive}
                onClick={() => setPicked(isLive ? null : slot.schid)}
                title={slot.label}
                data-testid="game-tab"
              >
                <span className="n" aria-hidden="true">
                  {shortSlot(slot.label)}
                </span>
                <span className="r" aria-hidden="true">
                  {isLive ? <span className="live-tag">LIVE</span> : legs ? (
                    <>
                      <b className={cardWinner === 0 ? 'win' : undefined}>{legs[0]}</b>-<b className={cardWinner === 1 ? 'win' : undefined}>{legs[1]}</b>
                    </>
                  ) : (
                    '—'
                  )}
                </span>
                <span className="sr-only">
                  {slot.label} {cardWinner === 0 ? `${names[0]} 勝ち` : cardWinner === 1 ? `${names[1]} 勝ち` : isLive ? '進行中' : '未実施'}
                  {legs && !isLive ? ` ${legs[0]} 対 ${legs[1]}` : ''}
                </span>
              </button>
            </li>
          );
        })}
      </ol>

      {live && !live.gameEnded && !showsLive ? (
        <button type="button" className="live-return" onClick={() => setPicked(null)} data-testid="back-to-live">
          <span className="live-tag">LIVE</span>
          <span className="grow">
            {liveLabel} ・ Leg {(live.leg?.index ?? live.currentLeg ?? 0) + 1} ・ {live.legs[0]}-{live.legs[1]}
            {live.leg?.left ? ` ・ 残り ${live.leg.left[0]} / ${live.leg.left[1]}` : ''}
          </span>
          <span className="go">ライブに戻る</span>
        </button>
      ) : null}

      {live && !live.gameEnded ? (
        <div hidden={!showsLive}>
          <LiveSheet
            key={live.mid}
            api={api}
            live={live}
            title={liveLabel ?? undefined}
            levels={levels}
            onPlayer={onPlayer}
            status={{ ...liveStatusText(status, card.finished), updated: new Date(live.updateTime).toLocaleTimeString('ja-JP') }}
          />
        </div>
      ) : null}

      {selectedGame && !showsLive ? (
        <section className="game-block" aria-label={slotLabel(data.season, selectedGame.schid)} data-testid="game-block">
          <h3 className="game-block-head">
            {slotLabel(data.season, selectedGame.schid)}
            <span className={`tag state-${selectedGame.finished ? 'official' : 'live'}`}>{selectedGame.finished ? '終了' : '進行中'}</span>
          </h3>
          <p className="small-text game-block-people">
            <span>{(flipOf(selectedGame) ? selectedGame.sides[1] : selectedGame.sides[0]).members.map((m) => m.name).join(' / ') || names[0]}</span>
            <span className="muted">vs</span>
            <span>{(flipOf(selectedGame) ? selectedGame.sides[0] : selectedGame.sides[1]).members.map((m) => m.name).join(' / ') || names[1]}</span>
          </p>
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
        </section>
      ) : null}

      <details className="outlook" data-testid="outlook">
        <summary data-testid="estimate">
          <span>
            参考予測: {names[0]} <strong>{pct(outlook.win)}</strong>
            {outlook.draw > 0.005 ? ` ・ 引分 ${pct(outlook.draw)}` : ''} ・ {names[1]} <strong>{pct(outlook.loss)}</strong>
          </span>
          <span className="muted small-text">推移を見る</span>
        </summary>
        <p className="muted small-text">
          このシーズンの種別勝率から計算 (このカードを除く{seasonGames < 20 ? '・データ少なめ' : ''})。
        </p>
        <CardTrail steps={trail} names={names} labelOf={(schid) => slotLabel(data.season, schid)} basis="このシーズンの種別ごとの勝率 (このカードを除く) から計算した参考値です。" />
      </details>

      {upcoming.length > 0 ? (
        <div className="upcoming" data-testid="upcoming">
          <h3 className="section-mini">このあとの出場予定{minutesPerGame ? ` (1ゲーム 約${Math.round(minutesPerGame)}分)` : ''}</h3>
          <ol className="plain small-text">
            {upcoming.map((slot, index) => {
              const a = orderOf(card.teams[0].id, slot.schid);
              const b = orderOf(card.teams[1].id, slot.schid);
              return (
                <li key={slot.schid}>
                  <strong>{slot.label}</strong> {a?.members.length ? withAverage(card.teams[0].id, a.members) : '(未提出)'} vs {b?.members.length ? withAverage(card.teams[1].id, b.members) : '(未提出)'}
                  {minutesPerGame ? <span className="muted"> ・ 約{Math.round(minutesPerGame * (index + (card.current ? 1 : 0)))}分後</span> : null}
                </li>
              );
            })}
          </ol>
          <p className="muted small-text">
            オーダーは n01 に提出された内容。{anyAverage ? '( ) 内はこのシーズンの平均 (n01 公式)。' : ''}時刻はこの対戦の終了ゲームの平均から計算した目安です。
          </p>
        </div>
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
