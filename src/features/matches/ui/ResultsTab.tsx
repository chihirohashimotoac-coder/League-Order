import { useMemo, useState } from 'react';
import { Icon } from '../../../components/icons';
import { useAppStore } from '../../../state/appStore';
import type { MatchesApi } from '../api';
import type { MatchCard } from '../cards';
import { CARD_STATE_LABELS, cardScore, slotKindLabel } from '../cards';
import { fixtureDate } from '../parse';
import { checkReproduction, projectStandings } from '../standings';
import { headToHead, linkOrder, percent, teamProfile } from '../insights';
import type { SeasonData } from './useMatchContext';
import { formatClock, formatRate } from './useMatchContext';
import { GameView } from './GameView';

/**
 * 日程・結果. Every card of the season, grouped by round (節) with its date, newest played round
 * first; registered teams highlighted and one tap away. A card opens the match center in place.
 */

type Filter = 'registered' | 'all' | number;

const STRUCTURE_LABEL: Record<string, string> = { SINGLES: 'Singles', DOUBLES: 'Doubles', TRIOS: 'Trios', GALLON: 'Gallon', TEAM: 'Team', UNKNOWN: '不明' };

export function ResultsTab({
  data,
  registered,
  api,
  onTeam,
}: {
  data: SeasonData;
  registered: string[];
  api: MatchesApi;
  onTeam: (teamId: string) => void;
}): React.JSX.Element {
  const [filter, setFilter] = useState<Filter>(registered.length ? 'registered' : 'all');
  const [open, setOpen] = useState<string | null>(null);
  const card = open ? data.cards.find((entry) => entry.key === open) ?? null : null;

  const rounds = useMemo(() => {
    const visible = data.cards.filter((entry) =>
      filter === 'registered' ? entry.teams.some((team) => registered.includes(team.id)) : filter === 'all' ? true : entry.divisionIndex === filter,
    );
    const groups = new Map<string, MatchCard[]>();
    for (const entry of visible) {
      const key = entry.title || entry.divisionTitle;
      groups.set(key, [...(groups.get(key) ?? []), entry]);
    }
    const list = [...groups.entries()].map(([title, cards]) => ({
      title,
      date: fixtureDate(title),
      cards: [...cards].sort((a, b) => Number(b.teams.some((t) => registered.includes(t.id))) - Number(a.teams.some((t) => registered.includes(t.id))) || a.divisionIndex - b.divisionIndex),
      played: cards.some((entry) => entry.state !== 'scheduled'),
    }));
    // Played rounds newest first, then the rounds still to come in order.
    const played = list.filter((round) => round.played).reverse();
    const todo = list.filter((round) => !round.played);
    return [...played, ...todo];
  }, [data.cards, filter, registered]);

  if (card) return <MatchCenter card={card} data={data} registered={registered} api={api} onBack={() => setOpen(null)} onTeam={onTeam} />;

  return (
    <div className="results" data-testid="results-tab">
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
      {rounds.length === 0 ? <p className="muted small-text">表示する対戦カードがありません。</p> : null}
      {rounds.map((round) => (
        <section key={round.title} className="round">
          <h3 className="section-mini">
            {round.title}
            {round.date && !round.title.includes(`${round.date.month}月`) ? ` (${round.date.month}/${round.date.day})` : ''}
          </h3>
          <ul className="match-list">
            {round.cards.map((entry) => (
              <li key={entry.key}>
                <CardRow card={entry} registered={registered} onOpen={() => setOpen(entry.key)} />
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

function CardRow({ card, registered, onOpen }: { card: MatchCard; registered: string[]; onOpen: () => void }): React.JSX.Element {
  const score = cardScore(card);
  return (
    <button type="button" className={`match-row state-${card.state}`} onClick={onOpen} data-testid="match-card">
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
}: {
  card: MatchCard;
  data: SeasonData;
  registered: string[];
  api: MatchesApi;
  onBack: () => void;
  onTeam: (teamId: string) => void;
}): React.JSX.Element {
  const [game, setGame] = useState<string | null>(null);
  const names: [string, string] = [card.teams[0].name, card.teams[1].name];
  const score = cardScore(card);
  return (
    <div className="match-center" data-testid="match-detail">
      <button type="button" className="btn ghost small" onClick={onBack}>
        <Icon name="chevronLeft" size={16} /> 一覧に戻る
      </button>
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
              n01 で開く
            </a>
          </>
        ) : null}
      </p>
      <ul className="game-list">
        {card.games.map((entry) => (
          <li key={entry.slot.schid}>
            <button
              type="button"
              className="game-row"
              aria-expanded={game === entry.slot.schid}
              disabled={!entry.game}
              onClick={() => setGame(game === entry.slot.schid ? null : entry.slot.schid)}
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
            {game === entry.slot.schid && entry.game ? (
              <GameView api={api} mid={entry.game.mid} cricket={entry.slot.matchType === 'cricket'} finished={entry.game.finished} names={names} flip={entry.flip} />
            ) : null}
          </li>
        ))}
      </ul>
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
  const games = data.season.slots.length;
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
        <h4>両チームの今季</h4>
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
          今季の直接対戦 (公式): {h2h.length ? h2h.map((row) => `${row.ours}-${row.theirs}`).join(' ・ ') : 'なし'}
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
