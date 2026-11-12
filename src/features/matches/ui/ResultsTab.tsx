import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Icon } from '../../../components/icons';
import { SPLIT_QUERY, useMediaQuery } from '../../../components/useMediaQuery';
import { useAppStore } from '../../../state/appStore';
import type { MatchesApi } from '../api';
import type { CardGame, MatchCard } from '../cards';
import { CARD_STATE_LABELS, cardScore, slotKindLabel } from '../cards';
import { fixtureDate, slotsFor } from '../parse';
import { checkReproduction, projectStandings } from '../standings';
import { headToHead, linkOrder, percent, teamProfile } from '../insights';
import type { WatchLink } from '../watchLink';
import { closeWatchLink, pushWatchLink, replaceWatchLink, watchLinkUrl } from '../watchLink';
import type { SeasonData } from './useMatchContext';
import { formatClock, formatRate } from './useMatchContext';
import { GameView } from './GameView';
import { Highlights } from './Highlights';
import { CardTrail } from './CardTrail';
import { CopyLink } from './CopyLink';
import { outlookTrail, slotChances } from '../cardTrail';
import type { HighlightFocus } from './Highlights';

/**
 * 日程・結果. The next round to be played comes first (the cards still to come are one tap away,
 * not under every result), then the played rounds newest first, then the rest of the schedule.
 * Registered teams are highlighted. A card opens the match center in place: the card is in the
 * address, so the browser's back button — and 「一覧に戻る」 — return to the list where it was
 * left (filter, position, focus on the card).
 */

type Filter = 'registered' | 'all' | number;

const STRUCTURE_LABEL: Record<string, string> = { SINGLES: 'Singles', DOUBLES: 'Doubles', TRIOS: 'Trios', GALLON: 'Gallon', TEAM: 'Team', UNKNOWN: '不明' };

interface Round {
  title: string;
  date: ReturnType<typeof fixtureDate>;
  cards: MatchCard[];
  played: boolean;
}

export function ResultsTab({
  data,
  registered,
  api,
  onTeam,
  link = null,
  base = {},
}: {
  data: SeasonData;
  registered: string[];
  api: MatchesApi;
  onTeam: (teamId: string) => void;
  /** What the address points at: its card is the one shown. */
  link?: WatchLink | null;
  /** The league and season every link made here starts from. */
  base?: WatchLink;
}): React.JSX.Element {
  const [filter, setFilter] = useState<Filter>(registered.length ? 'registered' : 'all');
  const openKey = link?.card ?? null;
  const card = openKey ? data.cards.find((entry) => entry.key === openKey) ?? null : null;

  const rounds = useMemo(() => {
    const visible = data.cards.filter((entry) =>
      filter === 'registered' ? entry.teams.some((team) => registered.includes(team.id)) : filter === 'all' ? true : entry.divisionIndex === filter,
    );
    const groups = new Map<string, MatchCard[]>();
    for (const entry of visible) {
      const key = entry.title || entry.divisionTitle;
      groups.set(key, [...(groups.get(key) ?? []), entry]);
    }
    const list: Round[] = [...groups.entries()].map(([title, cards]) => ({
      title,
      date: fixtureDate(title),
      cards: [...cards].sort((a, b) => Number(b.teams.some((t) => registered.includes(t.id))) - Number(a.teams.some((t) => registered.includes(t.id))) || a.divisionIndex - b.divisionIndex),
      played: cards.some((entry) => entry.state !== 'scheduled'),
    }));
    // Played rounds newest first; the rounds still to come in schedule order.
    return { played: list.filter((round) => round.played).reverse(), todo: list.filter((round) => !round.played) };
  }, [data.cards, filter, registered]);

  // The list as it was left: position and the card that was opened.
  const left = useRef<{ key: string; y: number } | null>(null);
  const wasOpen = useRef<string | null>(openKey);
  useLayoutEffect(() => {
    const before = wasOpen.current;
    wasOpen.current = openKey;
    if (openKey) {
      // The detail starts at its top, whatever the list's position was.
      if (before !== openKey) window.scrollTo(0, 0);
      return;
    }
    if (!before) return;
    const row = document.querySelector<HTMLElement>(`[data-card-key="${CSS.escape(before)}"]`);
    if (left.current?.key === before) window.scrollTo(0, left.current.y);
    else row?.scrollIntoView({ block: 'center' });
    row?.focus({ preventScroll: true });
    left.current = null;
  }, [openKey]);

  const open = (key: string): void => {
    left.current = { key, y: window.scrollY };
    pushWatchLink({ ...base, card: key });
  };
  const back = (): void => closeWatchLink(Object.keys(base).length ? base : null);

  if (card) return <MatchCenter card={card} data={data} registered={registered} api={api} onBack={back} onTeam={onTeam} link={link} base={base} />;

  const section = (round: Round, id?: string): React.JSX.Element => (
    <section key={round.title} className="round" id={id}>
      <h3 className="section-mini">
        {round.title}
        {round.date && !round.title.includes(`${round.date.month}月`) ? ` (${round.date.month}/${round.date.day})` : ''}
      </h3>
      <ul className="match-list">
        {round.cards.map((entry) => (
          <li key={entry.key}>
            <CardRow card={entry} registered={registered} onOpen={() => open(entry.key)} />
          </li>
        ))}
      </ul>
    </section>
  );
  const [next, ...later] = rounds.todo;
  const empty = rounds.played.length === 0 && rounds.todo.length === 0;

  return (
    <div className="results" data-testid="results-tab">
      {openKey ? (
        <div className="notice warn" role="alert" data-testid="card-not-found">
          <Icon name="alert" size={18} />
          <span className="grow small-text">リンクの対戦カードは、このシーズンの公開データに見つかりませんでした。下の一覧から選んでください。</span>
          <button type="button" className="btn small" onClick={() => replaceWatchLink(Object.keys(base).length ? base : null)}>
            一覧を表示
          </button>
        </div>
      ) : null}
      <div className="chip-row" role="radiogroup" aria-label="表示する対戦">
        {registered.length ? (
          <button type="button" className="chip" role="radio" aria-checked={filter === 'registered'} onClick={() => setFilter('registered')}>
            登録チーム
          </button>
        ) : null}
        <button type="button" className="chip" role="radio" aria-checked={filter === 'all'} onClick={() => setFilter('all')}>
          すべて
        </button>
        {data.season.divisions.map((division) => (
          <button key={division.index} type="button" className="chip" role="radio" aria-checked={filter === division.index} onClick={() => setFilter(division.index)}>
            {division.title}
          </button>
        ))}
      </div>
      {empty ? <p className="muted small-text">表示する対戦カードがありません。</p> : null}
      {next ? (
        <div className="next-round" data-testid="next-round">
          <p className="next-round-head">
            <span className="kicker">次の対戦</span>
            {later.length > 0 ? (
              <button
                type="button"
                className="linklike small-text"
                onClick={() => {
                  const target = document.getElementById('results-later');
                  target?.scrollIntoView({ block: 'start', behavior: window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
                  target?.querySelector<HTMLElement>('button')?.focus({ preventScroll: true });
                }}
              >
                その後の日程 ({later.length} 節) へ
              </button>
            ) : null}
          </p>
          {section(next)}
        </div>
      ) : null}
      {rounds.played.length > 0 && next ? <h3 className="list-divider">結果 (新しい順)</h3> : null}
      {rounds.played.map((round) => section(round))}
      {later.length > 0 ? (
        <div id="results-later" className="results-later">
          <h3 className="list-divider">その後の日程</h3>
          {later.map((round) => section(round))}
        </div>
      ) : null}
    </div>
  );
}

function CardRow({ card, registered, onOpen }: { card: MatchCard; registered: string[]; onOpen: () => void }): React.JSX.Element {
  const score = cardScore(card);
  return (
    <button type="button" className={`match-row state-${card.state}`} onClick={onOpen} data-testid="match-card" data-card-key={card.key}>
      <span className="match-teams">
        <span className={registered.includes(card.teams[0].id) ? 'own' : ''}>{card.teams[0].name}</span>
        <span className="match-score">{score ? `${score.score[0]} - ${score.score[1]}` : 'vs'}</span>
        <span className={registered.includes(card.teams[1].id) ? 'own' : ''}>{card.teams[1].name}</span>
      </span>
      {card.state !== 'scheduled' ? (
        <span className="mini-flow" aria-hidden="true">
          {card.games.map((game) => (
            <i key={game.slot.schid} className={game.winner === 0 ? 'a' : game.winner === 1 ? 'b' : game.state === 'live' ? 'live' : ''} />
          ))}
        </span>
      ) : null}
      <span className="match-tags">
        <span className={`tag state-${card.state}`}>{CARD_STATE_LABELS[card.state]}</span>
        {score?.source === 'counted' ? <span className="tag">ゲーム数は League Order の集計</span> : null}
        <span className="muted small-text">{card.divisionTitle}</span>
      </span>
    </button>
  );
}

function MatchCenter({
  card,
  data,
  registered,
  api,
  onBack,
  onTeam,
  link,
  base,
}: {
  card: MatchCard;
  data: SeasonData;
  registered: string[];
  api: MatchesApi;
  onBack: () => void;
  onTeam: (teamId: string) => void;
  link: WatchLink | null;
  base: WatchLink;
}): React.JSX.Element {
  // A large screen: the games on the left, the chosen game (legs, score sheet, figures) beside
  // them. A phone: the chosen game opens under its row and is brought to the top of the screen.
  const wide = useMediaQuery(SPLIT_QUERY);
  const playable = card.games.filter((entry) => entry.game);
  const linked = link?.game && playable.some((entry) => entry.slot.schid === link.game) ? link.game : null;
  const game = linked ?? (wide ? (playable[0]?.slot.schid ?? null) : null);
  const [focus, setFocus] = useState<HighlightFocus | null>(null);
  const names: [string, string] = [card.teams[0].name, card.teams[1].name];
  const here: WatchLink = { ...base, card: card.key };
  const setGame = (schid: string | null): void => replaceWatchLink(schid ? { ...here, game: schid } : here);
  const reveal = (schid: string): void => {
    if (wide) return;
    const behavior: ScrollBehavior = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth';
    requestAnimationFrame(() => document.getElementById(`game-row-${schid}`)?.scrollIntoView({ block: 'start', behavior }));
  };
  const openHighlight = (next: HighlightFocus): void => {
    setGame(next.schid);
    setFocus(next);
    // The sheet renders once the game's (memoised) throws are read: wait for the marked row.
    const behavior: ScrollBehavior = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth';
    const show = (tries: number): void => {
      const row = document.querySelector(`#game-${CSS.escape(next.schid)} tr.marked`);
      if (row) row.scrollIntoView({ block: 'center', behavior });
      else if (tries < 60) requestAnimationFrame(() => show(tries + 1));
      else document.getElementById(`game-${next.schid}`)?.scrollIntoView({ block: 'start', behavior });
    };
    requestAnimationFrame(() => show(0));
  };
  // A link that names a game opens with that game in view.
  const linkedOnOpen = useRef(linked);
  useEffect(() => {
    if (linkedOnOpen.current) reveal(linkedOnOpen.current);
    // Once, when the card opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const score = cardScore(card);
  const panel = (entry: CardGame): React.JSX.Element => (
    <section className="game-panel" id={`game-${entry.slot.schid}`} aria-label={`${entry.slot.label} の詳細`} data-testid="game-panel">
      {wide ? (
        <header className="game-panel-head">
          <span className="slot">
            {entry.slot.label} <span className="muted small-text">{slotKindLabel(entry.slot)}</span>
          </span>
          <span className="duel">
            <span className={entry.winner === 0 ? 'won' : ''}>{entry.members[0].join(' / ') || names[0]}</span>
            <strong>
              {entry.legs[0] ?? '—'} - {entry.legs[1] ?? '—'}
            </strong>
            <span className={entry.winner === 1 ? 'won' : ''}>{entry.members[1].join(' / ') || names[1]}</span>
          </span>
        </header>
      ) : null}
      <GameView
        key={focus?.schid === entry.slot.schid ? `${focus.leg}:${focus.n01Side}:${focus.round}` : 'game'}
        api={api}
        mid={entry.game!.mid}
        cricket={entry.slot.matchType === 'cricket'}
        finished={entry.game!.finished}
        names={[entry.members[0].join(' / ') || names[0], entry.members[1].join(' / ') || names[1]]}
        flip={entry.flip}
        focus={focus?.schid === entry.slot.schid ? focus : null}
      />
    </section>
  );
  const chosen = game ? (playable.find((entry) => entry.slot.schid === game) ?? null) : null;
  return (
    <div className="match-center" data-testid="match-detail">
      <div className="match-center-bar">
        <button type="button" className="btn ghost small" onClick={onBack}>
          <Icon name="chevronLeft" size={16} /> 一覧に戻る
        </button>
        <CopyLink url={watchLinkUrl(game && linked ? { ...here, game } : here)} />
      </div>
      <header className="focus-head">
        <button type="button" className={`linklike${registered.includes(card.teams[0].id) ? ' own' : ''}`} onClick={() => onTeam(card.teams[0].id)}>
          {names[0]}
        </button>
        <strong>{score ? `${score.score[0]} - ${score.score[1]}` : 'vs'}</strong>
        <button type="button" className={`linklike${registered.includes(card.teams[1].id) ? ' own' : ''}`} onClick={() => onTeam(card.teams[1].id)}>
          {names[1]}
        </button>
      </header>
      <p className="muted small-text center">
        {card.title} ・ {card.divisionTitle} ・ {card.official ? '公式結果 (n01)' : CARD_STATE_LABELS[card.state]}
        {card.officialAvg[0] !== null ? ` ・ 平均 ${formatRate(card.officialAvg[0])} / ${formatRate(card.officialAvg[1])}` : ''} ・ 更新 {formatClock(card.updatedAt)}
        {data.season.url ? (
          <>
            {' ・ '}
            <a href={data.season.url} target="_blank" rel="noreferrer noopener">
              n01 のシーズンページを開く
            </a>
          </>
        ) : null}
      </p>
      <div className={`match-body${wide ? ' is-split' : ''}`}>
        <ul className="game-list" aria-label="ゲーム">
          {card.games.map((entry) => {
            const selected = game === entry.slot.schid;
            return (
              <li key={entry.slot.schid} id={`game-row-${entry.slot.schid}`}>
                <button
                  type="button"
                  className="game-row"
                  aria-expanded={selected}
                  aria-controls={selected ? `game-${entry.slot.schid}` : undefined}
                  disabled={!entry.game}
                  onClick={() => {
                    setFocus(null);
                    if (selected && !wide) {
                      setGame(null);
                      return;
                    }
                    setGame(entry.slot.schid);
                    reveal(entry.slot.schid);
                  }}
                >
                  <span className="game-name">
                    {entry.slot.label}
                    <span className="muted small-text"> {slotKindLabel(entry.slot)}</span>
                  </span>
                  <span className={`side${entry.winner === 0 ? ' won' : ''}`}>
                    {entry.members[0].join(' / ') || '—'}
                    <span className="muted small-text">{formatRate(entry.rate[0])}</span>
                  </span>
                  <span className="legs">{entry.state === 'notPlayed' ? '未実施' : `${entry.legs[0] ?? '—'} - ${entry.legs[1] ?? '—'}`}</span>
                  <span className={`side right${entry.winner === 1 ? ' won' : ''}`}>
                    {entry.members[1].join(' / ') || '—'}
                    <span className="muted small-text">{formatRate(entry.rate[1])}</span>
                  </span>
                </button>
                {!wide && selected && entry.game ? panel(entry) : null}
              </li>
            );
          })}
        </ul>
        {wide ? (
          <div className="game-pane" data-testid="game-pane">
            {chosen ? panel(chosen) : <p className="muted small-text">このカードには、まだ記録のあるゲームがありません。</p>}
          </div>
        ) : null}
      </div>
      <Highlights card={card} api={api} onOpen={openHighlight} />
      <MatchTrail card={card} data={data} />
      <Insights card={card} data={data} registered={registered} />
    </div>
  );
}

function Insights({ card, data, registered }: { card: MatchCard; data: SeasonData; registered: string[] }): React.JSX.Element {
  const store = useAppStore();
  const link = useMemo(() => {
    for (const order of store.teamOrders) {
      const linked = linkOrder(order, card);
      if (linked) return linked;
    }
    return null;
  }, [store.teamOrders, card]);
  const a = teamProfile(data.season, data.cards, data.games, card.teams[0].id);
  const b = teamProfile(data.season, data.cards, data.games, card.teams[1].id);
  const structures = [...new Set([...Object.keys(a.byStructure), ...Object.keys(b.byStructure)])];
  const h2h = headToHead([data.season], { tournamentId: card.tournamentId, ourId: card.teams[0].id, theirId: card.teams[1].id, ourName: card.teams[0].name, theirName: card.teams[1].name });
  const group = data.standings?.find((entry) => entry.divisionIndex === card.divisionIndex);
  const check = group ? checkReproduction(data.season.pointRule, group, data.cards.filter((entry) => entry.divisionIndex === card.divisionIndex)) : null;
  const games = slotsFor(data.season, card.divisionIndex).length;
  const [first, setFirst] = useState(Math.ceil(games / 2));
  return (
    <section className="intel" aria-label="League Order の分析">
      <h3 className="intel-title">
        <Icon name="spark" size={16} /> League Order の分析 <span className="muted small-text">(独自計算 ・ n01 公式値ではありません)</span>
      </h3>
      {link ? (
        <div className="intel-block" data-testid="intel-prediction">
          <h4>保存したオーダーの予測と実績</h4>
          <p className="small-text">
            「{link.orderTitle}」 推定勝率 {link.matchWin !== null ? `${Math.round(link.matchWin * 100)}%` : '—'} → {link.actual === 'W' ? '勝ち' : link.actual === 'L' ? '負け' : link.actual === 'D' ? '引き分け' : '未確定'}
          </p>
          <ul className="small-text">
            {link.games.map((entry, index) => (
              <li key={index} className={entry.surprise ? 'surprise' : ''}>
                {entry.slotLabel}: 予測 {entry.predicted !== null ? `${Math.round(entry.predicted * 100)}%` : '—'} / 実績 {entry.actual === 'W' ? '勝ち' : entry.actual === 'L' ? '負け' : '—'}
                {entry.surprise ? ' ・ 予測と大きく異なる' : ''}
              </li>
            ))}
          </ul>
          {link.hints.map((hint) => (
            <p key={hint} className="small-text">
              {hint}
            </p>
          ))}
        </div>
      ) : null}
      <div className="intel-block" data-testid="intel-opponent">
        <h4>両チームのシーズン成績 ({data.season.title})</h4>
        <div className="table-scroll">
          <table className="compare small-text">
            <thead>
              <tr>
                <th scope="col">{a.name}</th>
                <th scope="col" />
                <th scope="col">{b.name}</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td className="num">
                  {a.cards.w}勝{a.cards.d}分{a.cards.l}敗
                </td>
                <th scope="row" className="center">
                  対戦 (公式)
                </th>
                <td className="num">
                  {b.cards.w}勝{b.cards.d}分{b.cards.l}敗
                </td>
              </tr>
              {structures.map((structure) => (
                <tr key={structure}>
                  <td className="num">{percent(a.byStructure[structure])}</td>
                  <th scope="row" className="center">
                    {STRUCTURE_LABEL[structure] ?? structure} 勝率
                  </th>
                  <td className="num">{percent(b.byStructure[structure])}</td>
                </tr>
              ))}
              <tr>
                <td className="num">{formatRate(a.singles01)}</td>
                <th scope="row" className="center">
                  Singles 01 平均
                </th>
                <td className="num">{formatRate(b.singles01)}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <p className="small-text" data-testid="intel-h2h">
          このシーズンの直接対戦 (公式): {h2h.length ? h2h.map((row) => `${row.ours}-${row.theirs}`).join(' ・ ') : 'なし'}
        </p>
      </div>
      {!card.official && group && check ? (
        <div className="intel-block" data-testid="intel-whatif">
          <h4>この対戦の結果を仮定した順位 (予測)</h4>
          {check.ok ? (
            <>
              <label className="small-text row" style={{ gap: 8 }}>
                {a.name} の獲得ゲーム
                <input type="range" min={0} max={games} value={first} onChange={(event) => setFirst(Number(event.target.value))} aria-valuetext={`${first} 対 ${games - first}`} />
                <strong>
                  {first} - {games - first}
                </strong>
              </label>
              <ol className="plain small-text">
                {projectStandings(data.season.pointRule, group, card, [first, games - first]).map((row) => (
                  <li key={row.teamId} className={registered.includes(row.teamId) ? 'own' : ''}>
                    {row.tied ? `${row.projectedPosition}位タイ` : `${row.projectedPosition}位`} {row.name} {row.projectedPoints}点
                    <span className="muted"> (公式 {row.officialRank > 0 ? `${row.officialRank}位` : '—'} {row.officialPoints}点)</span>
                  </li>
                ))}
              </ol>
              <p className="muted small-text">勝ち点は n01 の公式勝ち点を同じ規則で再現できることを確認済み。同点の順位は n01 の規則によります。</p>
            </>
          ) : (
            <p className="muted small-text">{check.reason}</p>
          )}
        </div>
      ) : null}
    </section>
  );
}

function MatchTrail({ card, data }: { card: MatchCard; data: SeasonData }): React.JSX.Element | null {
  const steps = useMemo(() => {
    const exclude = new Set(card.games.flatMap((entry) => (entry.game ? [entry.game.mid] : [])));
    const schedule = slotsFor(data.season, card.divisionIndex);
    const { chance } = slotChances(data.season, data.cards, data.games, [card.teams[0].id, card.teams[1].id], exclude, schedule);
    const results = card.games.flatMap((entry) => (entry.winner !== null && entry.game?.finished ? [{ schid: entry.slot.schid, winner: entry.winner, endedAt: entry.game.updateTime }] : []));
    return outlookTrail(schedule, chance, results);
  }, [card, data]);
  const labels = new Map(card.games.map((entry) => [entry.slot.schid, entry.slot.label]));
  return (
    <CardTrail
      steps={steps}
      names={[card.teams[0].name, card.teams[1].name]}
      labelOf={(schid) => labels.get(schid) ?? schid}
      basis="このシーズンの種別ごとの勝率 (このカードを除く) から計算した参考値で、結果の説明ではありません。"
    />
  );
}
