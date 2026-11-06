import { useEffect, useMemo, useState } from 'react';
import { Card, EmptyState } from '../../../components/ui';
import { Icon } from '../../../components/icons';
import { KNOWN_LEAGUES } from '../../../integrations/n01/leagueRegistry';
import { describeN01Error } from '../../../integrations/n01/client';
import { useAppStore } from '../../../state/appStore';
import type { Page } from '../../../navigation';
import type { MatchesApi } from '../api';
import type { CardGame, MatchCard } from '../cards';
import { CARD_STATE_LABELS, GAME_STATE_LABELS, cardScore, slotKindLabel } from '../cards';
import type { GameDetail, SeasonDocument } from '../parse';
import { checkReproduction, projectStandings } from '../standings';
import { headToHead, linkOrder, percent, playerForms, teamProfile } from '../insights';
import type { HeadToHeadRow } from '../insights';
import { useMatchesApiFactory } from '../environment';
import type { MatchScope, SeasonData } from './useMatchContext';
import { formatClock, formatRate, ownTeamIn, useOwnScope, useSeasonData, useSeasons } from './useMatchContext';

/**
 * MATCH RESULTS (試合結果) with MATCH INTELLIGENCE (分析).
 *
 * Own team first: an n01-linked team opens on its season with its own cards; the division and
 * league are one chip away, earlier seasons one select away. A card opens in place — no
 * extra screen — with its games, then League Order's own analysis under a separate heading.
 */

type Tab = 'results' | 'standings' | 'players';
type Filter = 'own' | 'all' | number;

const STRUCTURE_LABEL: Record<string, string> = { SINGLES: 'Singles', DOUBLES: 'Doubles', TRIOS: 'Trios', GALLON: 'Gallon', TEAM: 'Team', UNKNOWN: '不明' };

export default function MatchesPage({ onNavigate }: { onNavigate: (page: Page) => void }): React.JSX.Element {
  const own = useOwnScope();
  const factory = useMatchesApiFactory();
  const [leagueId, setLeagueId] = useState<string | null>(own?.leagueId ?? null);
  const [refresh, setRefresh] = useState(0);
  const api = useMemo(() => factory(), [factory, refresh]);
  const seasons = useSeasons(leagueId ? api : null, leagueId);
  const [tournamentId, setTournamentId] = useState<string | null>(own?.ownTournamentId ?? null);
  useEffect(() => {
    if (tournamentId === null && seasons.kind === 'ready' && seasons.value[0]) setTournamentId(seasons.value[0].tournamentId);
  }, [seasons, tournamentId]);
  const data = useSeasonData(tournamentId ? api : null, tournamentId);
  const [tab, setTab] = useState<Tab>('results');

  if (!leagueId) {
    return (
      <Card>
        <EmptyState kicker="MATCH RESULTS" title="リーグを選んでください" icon="trophy">
          <p className="small-text">n01 と連携したチームは自分のリーグが自動で開きます。</p>
          <div className="chip-row" style={{ justifyContent: 'center' }}>
            {KNOWN_LEAGUES.map((league) => (
              <button key={league.leagueId} type="button" className="chip" onClick={() => setLeagueId(league.leagueId)}>
                {league.title}
              </button>
            ))}
          </div>
          <button type="button" className="btn small" style={{ marginTop: 12 }} onClick={() => onNavigate('home')}>
            ホームに戻る
          </button>
        </EmptyState>
      </Card>
    );
  }

  const scope: MatchScope | null = own && own.leagueId === leagueId ? own : null;
  const seasonTitle = seasons.kind === 'ready' ? seasons.value.find((entry) => entry.tournamentId === tournamentId)?.title : undefined;

  return (
    <div className="matches" data-testid="matches-page">
      <div className="matches-bar">
        <label className="grow">
          <span className="sr-only">シーズン</span>
          <select
            aria-label="シーズン"
            value={tournamentId ?? ''}
            onChange={(event) => setTournamentId(event.target.value)}
            disabled={seasons.kind !== 'ready'}
          >
            {seasons.kind === 'ready' ? (
              seasons.value.map((entry) => (
                <option key={entry.tournamentId} value={entry.tournamentId}>
                  {entry.title}
                  {entry.status === 30 ? ' (開催中)' : ''}
                </option>
              ))
            ) : (
              <option value={tournamentId ?? ''}>{seasonTitle ?? '読み込み中…'}</option>
            )}
          </select>
        </label>
        <button type="button" className="btn small" onClick={() => setRefresh((n) => n + 1)} aria-label="最新の結果を取得">
          <Icon name="refresh" size={16} /> 更新
        </button>
      </div>
      <div className="segmented" role="tablist" aria-label="表示">
        {(
          [
            ['results', '試合結果'],
            ['standings', '順位'],
            ['players', '選手'],
          ] as const
        ).map(([key, label]) => (
          <button key={key} type="button" role="tab" aria-selected={tab === key} aria-pressed={tab === key} onClick={() => setTab(key)}>
            {label}
          </button>
        ))}
      </div>
      {seasons.kind === 'error' ? <ErrorNotice message={seasons.message} onRetry={() => setRefresh((n) => n + 1)} /> : null}
      {data.kind === 'loading' ? (
        <p className="muted small-text" role="status">
          <span className="spinner" aria-hidden="true" /> n01 から読み込み中…
        </p>
      ) : data.kind === 'error' ? (
        <ErrorNotice message={data.message} onRetry={() => setRefresh((n) => n + 1)} />
      ) : (
        <>
          <p className="muted small-text matches-meta">
            n01 公式データ ・ 取得 {formatClock(data.fetchedAt)}
            {data.value.season.url ? (
              <>
                {' ・ '}
                <a href={data.value.season.url} target="_blank" rel="noreferrer noopener">
                  n01 で開く
                </a>
              </>
            ) : null}
            {data.value.unreadableGames > 0 ? ` ・ 読めなかった試合 ${data.value.unreadableGames} 件 (集計に含めていません)` : ''}
            {data.value.truncated ? ' ・ 試合数が多いため一部のみ表示' : ''}
          </p>
          {tab === 'results' ? <ResultsTab data={data.value} scope={scope} api={api} /> : null}
          {tab === 'standings' ? <StandingsTab data={data.value} ownId={ownTeamIn(data.value.season, scope)} /> : null}
          {tab === 'players' ? <PlayersTab data={data.value} ownId={ownTeamIn(data.value.season, scope)} /> : null}
        </>
      )}
    </div>
  );
}

function ErrorNotice({ message, onRetry }: { message: string; onRetry: () => void }): React.JSX.Element {
  return (
    <div className="notice danger" role="alert">
      <Icon name="alert" size={18} />
      <span className="grow small-text">取得エラー: {message}</span>
      <button type="button" className="btn small" onClick={onRetry}>
        再試行
      </button>
    </div>
  );
}

function sortCards(cards: MatchCard[]): MatchCard[] {
  const rank = (card: MatchCard): number => (card.state === 'live' ? 0 : card.state === 'scheduled' ? 2 : 1);
  return [...cards].sort((a, b) => {
    if (rank(a) !== rank(b)) return rank(a) - rank(b);
    if (a.state === 'scheduled') return a.divisionIndex - b.divisionIndex || a.lsid.localeCompare(b.lsid);
    return (b.playedTo ?? 0) - (a.playedTo ?? 0);
  });
}

function ResultsTab({ data, scope, api }: { data: SeasonData; scope: MatchScope | null; api: MatchesApi }): React.JSX.Element {
  const ownId = ownTeamIn(data.season, scope);
  const [filter, setFilter] = useState<Filter>(ownId ? 'own' : 'all');
  const [open, setOpen] = useState<string | null>(null);
  const visible = sortCards(
    data.cards.filter((card) =>
      filter === 'own' ? card.teams.some((team) => team.id === ownId) : filter === 'all' ? true : card.divisionIndex === filter,
    ),
  );
  return (
    <>
      <div className="chip-row" role="radiogroup" aria-label="表示する対戦">
        {ownId ? (
          <button type="button" className="chip" role="radio" aria-checked={filter === 'own'} onClick={() => setFilter('own')}>
            自チーム
          </button>
        ) : null}
        {data.season.divisions.map((division) => (
          <button
            key={division.index}
            type="button"
            className="chip"
            role="radio"
            aria-checked={filter === division.index}
            onClick={() => setFilter(division.index)}
          >
            {division.title}
          </button>
        ))}
        <button type="button" className="chip" role="radio" aria-checked={filter === 'all'} onClick={() => setFilter('all')}>
          すべて
        </button>
      </div>
      {scope && !ownId ? <p className="muted small-text">このシーズンには、チーム名が一致する自チームが見つかりませんでした。</p> : null}
      {visible.length === 0 ? <p className="muted small-text">表示する対戦カードがありません。</p> : null}
      <ul className="match-list">
        {visible.map((card) => (
          <li key={card.key}>
            <CardRow card={card} ownId={ownId} open={open === card.key} onToggle={() => setOpen(open === card.key ? null : card.key)} />
            {open === card.key ? <CardDetail card={card} data={data} ownId={ownId} scope={scope} api={api} /> : null}
          </li>
        ))}
      </ul>
    </>
  );
}

function CardRow({ card, ownId, open, onToggle }: { card: MatchCard; ownId: string | null; open: boolean; onToggle: () => void }): React.JSX.Element {
  const score = cardScore(card);
  return (
    <button type="button" className={`match-row state-${card.state}`} aria-expanded={open} onClick={onToggle} data-testid="match-card">
      <span className="match-when muted small-text">
        {card.title || card.divisionTitle}
        {card.playedFrom ? ` ・ ${formatClock(card.playedFrom * 1000)}` : ''}
      </span>
      <span className="match-teams">
        <span className={card.teams[0].id === ownId ? 'own' : ''}>{card.teams[0].name}</span>
        <span className="match-score" aria-label={score ? `${score.score[0]} 対 ${score.score[1]}` : 'スコアなし'}>
          {score ? `${score.score[0]} - ${score.score[1]}` : 'vs'}
        </span>
        <span className={card.teams[1].id === ownId ? 'own' : ''}>{card.teams[1].name}</span>
      </span>
      <span className="match-tags">
        <span className={`tag state-${card.state}`}>{CARD_STATE_LABELS[card.state]}</span>
        {score?.source === 'counted' ? <span className="tag">ゲーム数は League Order の集計</span> : null}
        <span className="muted small-text">{card.divisionTitle}</span>
      </span>
    </button>
  );
}

function CardDetail({ card, data, ownId, scope, api }: { card: MatchCard; data: SeasonData; ownId: string | null; scope: MatchScope | null; api: MatchesApi }): React.JSX.Element {
  const ownSide = card.teams[0].id === ownId ? 0 : card.teams[1].id === ownId ? 1 : null;
  return (
    <div className="match-detail" data-testid="match-detail">
      <div className="row between wrap small-text">
        <span>
          {card.official ? (
            <>
              公式結果 {card.official[0]} - {card.official[1]}
              {card.officialAvg[0] !== null || card.officialAvg[1] !== null
                ? ` ・ 平均 ${formatRate(card.officialAvg[0])} / ${formatRate(card.officialAvg[1])}`
                : ''}
            </>
          ) : (
            CARD_STATE_LABELS[card.state]
          )}
        </span>
        <span className="muted">最終更新 {formatClock(card.updatedAt)}</span>
      </div>
      <div className="table-scroll">
        <table className="match-games">
          <thead>
            <tr>
              <th scope="col">ゲーム</th>
              <th scope="col">{card.teams[0].name}</th>
              <th scope="col">Leg</th>
              <th scope="col">{card.teams[1].name}</th>
            </tr>
          </thead>
          <tbody>
            {card.games.map((game) => (
              <GameLine key={game.slot.schid} game={game} api={api} />
            ))}
          </tbody>
        </table>
      </div>
      {ownSide !== null ? <Intelligence card={card} data={data} ownSide={ownSide} scope={scope} api={api} /> : null}
    </div>
  );
}

function GameLine({ game, api }: { game: CardGame; api: MatchesApi }): React.JSX.Element {
  const [detail, setDetail] = useState<{ kind: 'idle' } | { kind: 'loading' } | { kind: 'ready'; value: GameDetail } | { kind: 'error'; message: string }>({ kind: 'idle' });
  const cricket = game.slot.matchType === 'cricket';
  const side = (index: 0 | 1): React.JSX.Element => (
    <td className={game.winner === index ? 'won' : ''}>
      <span className="names">{game.members[index].join(' / ') || '—'}</span>
      <span className="muted small-text">
        {cricket ? 'MPR' : '平均'} {formatRate(game.rate[index])}
      </span>
    </td>
  );
  const load = (): void => {
    if (!game.game) return;
    setDetail({ kind: 'loading' });
    api
      .gameDetail(game.game.mid)
      .then((value) => setDetail({ kind: 'ready', value }))
      .catch((error) => setDetail({ kind: 'error', message: describeN01Error(error) }));
  };
  return (
    <>
      <tr>
        <th scope="row">
          <span>{game.slot.label}</span>
          <span className="muted small-text">{slotKindLabel(game.slot)}</span>
        </th>
        {game.state === 'notPlayed' ? (
          <td colSpan={3} className="muted small-text">
            {GAME_STATE_LABELS.notPlayed}
          </td>
        ) : (
          <>
            {side(0)}
            <td className="legs">
              <span>
                {game.legs[0] ?? '—'} - {game.legs[1] ?? '—'}
              </span>
              {game.state === 'live' ? <span className="tag state-live">進行中</span> : null}
              {detail.kind === 'idle' && game.game ? (
                <button type="button" className="btn ghost small" onClick={load}>
                  Leg
                </button>
              ) : null}
            </td>
            {side(1)}
          </>
        )}
      </tr>
      {detail.kind !== 'idle' ? (
        <tr className="leg-detail">
          <td colSpan={4}>
            {detail.kind === 'loading' ? <span className="muted small-text">読み込み中…</span> : null}
            {detail.kind === 'error' ? <span className="small-text">取得エラー: {detail.message}</span> : null}
            {detail.kind === 'ready' ? <LegList detail={detail.value} flip={game.flip} /> : null}
          </td>
        </tr>
      ) : null}
    </>
  );
}

function LegList({ detail, flip }: { detail: GameDetail; flip: boolean }): React.JSX.Element {
  const at = (pair: [number | null, number | null], side: 0 | 1): number | null => pair[flip ? 1 - side : side];
  const cricket = detail.matchType === 'cricket';
  return (
    <ol className="leg-list small-text">
      {detail.legs.map((leg) => {
        const winner = leg.winner === null ? null : flip ? 1 - leg.winner : leg.winner;
        const rate = (side: 0 | 1): string => {
          const darts = at(leg.darts, side);
          const scored = at(leg.scored, side);
          return darts && scored !== null ? ((scored / darts) * 3).toFixed(2) : '—';
        };
        return (
          <li key={leg.index}>
            Leg {leg.index + 1}: {winner === 0 ? '◯' : winner === 1 ? '×' : '−'} {rate(0)} / {rate(1)} {cricket ? 'MPR' : '平均'}
            {!cricket ? ` ・ ダーツ ${at(leg.darts, 0) ?? '—'} / ${at(leg.darts, 1) ?? '—'}` : ''}
            {!cricket && (at(leg.first9, 0) !== null || at(leg.first9, 1) !== null)
              ? ` ・ First9 ${at(leg.first9, 0) !== null ? ((at(leg.first9, 0)! / 9) * 3).toFixed(1) : '—'} / ${at(leg.first9, 1) !== null ? ((at(leg.first9, 1)! / 9) * 3).toFixed(1) : '—'}`
              : ''}
            {leg.bull ? ' ・ ブルで決着 (集計対象外)' : ''}
            {!leg.ended ? ' ・ 進行中' : ''}
          </li>
        );
      })}
    </ol>
  );
}

function Intelligence({ card, data, ownSide, scope, api }: { card: MatchCard; data: SeasonData; ownSide: 0 | 1; scope: MatchScope | null; api: MatchesApi }): React.JSX.Element {
  const store = useAppStore();
  const opp = (1 - ownSide) as 0 | 1;
  const link = useMemo(() => {
    for (const order of store.teamOrders) {
      const linked = linkOrder(order, card);
      if (linked) return linked;
    }
    return null;
  }, [store.teamOrders, card]);
  const ours = useMemo(() => teamProfile(data.season, data.cards, data.games, card.teams[ownSide].id), [data, card, ownSide]);
  const theirs = useMemo(() => teamProfile(data.season, data.cards, data.games, card.teams[opp].id), [data, card, opp]);
  const structures = [...new Set([...Object.keys(ours.byStructure), ...Object.keys(theirs.byStructure)])];
  return (
    <section className="intel" aria-label="League Order の分析">
      <h3 className="intel-title">
        <Icon name="spark" size={16} /> League Order の分析 <span className="muted small-text">(独自計算 ・ n01 公式値ではありません)</span>
      </h3>
      <div className="intel-block" data-testid="intel-prediction">
        <h4>試合前予測と実績</h4>
        {link ? (
          <>
            <p className="small-text">
              オーダー「{link.orderTitle}」 ・ 推定勝率 {link.matchWin !== null ? `${Math.round(link.matchWin * 100)}%` : '—'} → 実績{' '}
              {link.actual === 'W' ? '勝ち' : link.actual === 'L' ? '負け' : link.actual === 'D' ? '引き分け' : '未確定'}
            </p>
            <ul className="small-text">
              {link.games.map((game, index) => (
                <li key={index} className={game.surprise ? 'surprise' : ''}>
                  {game.slotLabel}: 予測 {game.predicted !== null ? `${Math.round(game.predicted * 100)}%` : '—'} / 実績 {game.actual === 'W' ? '勝ち' : game.actual === 'L' ? '負け' : '—'}
                  {game.surprise ? ' ・ 予測と大きく異なる' : ''}
                </li>
              ))}
            </ul>
            {link.hints.length ? (
              <ul className="small-text">
                {link.hints.map((hint) => (
                  <li key={hint}>{hint}</li>
                ))}
              </ul>
            ) : null}
          </>
        ) : (
          <p className="muted small-text">この対戦カード用に作成・保存されたオーダーがないため、予測との比較はありません (日付や相手名が近いだけのオーダーは結び付けません)。</p>
        )}
      </div>
      <div className="intel-block" data-testid="intel-opponent">
        <h4>対戦相手との比較 (このシーズン)</h4>
        <div className="table-scroll">
          <table className="compare small-text">
            <thead>
              <tr>
                <th scope="col" />
                <th scope="col">{ours.name}</th>
                <th scope="col">{theirs.name}</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <th scope="row">対戦成績 (公式)</th>
                <td>
                  {ours.cards.w}勝 {ours.cards.d}分 {ours.cards.l}敗
                </td>
                <td>
                  {theirs.cards.w}勝 {theirs.cards.d}分 {theirs.cards.l}敗
                </td>
              </tr>
              {structures.map((structure) => (
                <tr key={structure}>
                  <th scope="row">{STRUCTURE_LABEL[structure] ?? structure} 勝率</th>
                  <td>{percent(ours.byStructure[structure])}</td>
                  <td>{percent(theirs.byStructure[structure])}</td>
                </tr>
              ))}
              <tr>
                <th scope="row">Singles 01 平均</th>
                <td>
                  {formatRate(ours.singles01)} <span className="muted">({ours.singles01Games})</span>
                </td>
                <td>
                  {formatRate(theirs.singles01)} <span className="muted">({theirs.singles01Games})</span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <HeadToHead card={card} data={data} ownSide={ownSide} scope={scope} api={api} />
      </div>
      <WhatIf card={card} data={data} ownSide={ownSide} />
    </section>
  );
}

function HeadToHead({ card, data, ownSide, scope, api }: { card: MatchCard; data: SeasonData; ownSide: 0 | 1; scope: MatchScope | null; api: MatchesApi }): React.JSX.Element {
  const [rows, setRows] = useState<HeadToHeadRow[] | null>(null);
  const [state, setState] = useState<'idle' | 'loading' | 'error'>('idle');
  const opp = (1 - ownSide) as 0 | 1;
  const current = { tournamentId: card.tournamentId, ourId: card.teams[ownSide].id, theirId: card.teams[opp].id, ourName: card.teams[ownSide].name, theirName: card.teams[opp].name };
  const load = async (): Promise<void> => {
    if (!scope) return;
    setState('loading');
    try {
      const list = await api.seasons(scope.leagueId);
      const docs: SeasonDocument[] = [data.season];
      for (const entry of list.tournaments.slice(0, 8)) {
        if (entry.tournamentId === data.season.tournamentId) continue;
        try {
          docs.push(await api.season(entry.tournamentId));
        } catch {
          // A season that cannot be read is skipped, never counted as "no match".
        }
      }
      setRows(headToHead(docs, current));
      setState('idle');
    } catch {
      setState('error');
    }
  };
  const thisSeason = headToHead([data.season], current);
  const shown = rows ?? thisSeason;
  return (
    <div className="small-text" data-testid="intel-h2h">
      <p>
        直接対戦 (公式): {shown.length === 0 ? 'なし' : shown.map((row) => `${row.seasonTitle} ${row.ours}-${row.theirs}${row.matchedBy === 'name' ? ' (チーム名で照合)' : ''}`).join(' ・ ')}
      </p>
      {rows === null && scope ? (
        <button type="button" className="btn small" disabled={state === 'loading'} onClick={() => void load()}>
          {state === 'loading' ? '読み込み中…' : '過去のシーズンも見る (最大 8 シーズン)'}
        </button>
      ) : null}
      {state === 'error' ? <span> 取得エラー: 過去のシーズンを読み込めませんでした。</span> : null}
    </div>
  );
}

function WhatIf({ card, data, ownSide }: { card: MatchCard; data: SeasonData; ownSide: 0 | 1 }): React.JSX.Element | null {
  const group = data.standings?.find((entry) => entry.divisionIndex === card.divisionIndex);
  const games = data.season.slots.length;
  const [ours, setOurs] = useState(Math.ceil(games / 2));
  if (card.official) return null;
  if (!group) return <p className="muted small-text">順位表を取得できないため、順位シミュレーションは表示しません。</p>;
  const check = checkReproduction(data.season.pointRule, group, data.cards.filter((entry) => entry.divisionIndex === card.divisionIndex));
  if (!check.ok) {
    return (
      <div className="intel-block" data-testid="intel-whatif">
        <h4>順位シミュレーション</h4>
        <p className="muted small-text">{check.reason} (公式の順位計算規則を再現できる場合だけ表示します)</p>
      </div>
    );
  }
  const score: [number, number] = ownSide === 0 ? [ours, games - ours] : [games - ours, ours];
  const projected = projectStandings(data.season.pointRule, group, card, score);
  return (
    <div className="intel-block" data-testid="intel-whatif">
      <h4>この対戦の結果を仮定した順位 (予測)</h4>
      <label className="small-text row" style={{ gap: 8 }}>
        自チームの獲得ゲーム数
        <input
          type="range"
          min={0}
          max={games}
          value={ours}
          onChange={(event) => setOurs(Number(event.target.value))}
          aria-valuetext={`${ours} 対 ${games - ours}`}
        />
        <strong>
          {ours} - {games - ours}
        </strong>
      </label>
      <ol className="small-text projected">
        {projected.map((row) => (
          <li key={row.teamId} className={row.teamId === card.teams[ownSide].id ? 'own' : ''}>
            {row.tied ? `${row.projectedPosition}位タイ` : `${row.projectedPosition}位`} {row.name} {row.projectedPoints}点
            <span className="muted"> (公式 {row.officialRank > 0 ? `${row.officialRank}位` : '順位なし'} {row.officialPoints}点)</span>
          </li>
        ))}
      </ol>
      <p className="muted small-text">勝ち点は n01 の公式勝ち点を同じ規則で再現できることを確認済みです。同点の順位は n01 の順位決定規則によります (League Order では決めません)。</p>
    </div>
  );
}

function StandingsTab({ data, ownId }: { data: SeasonData; ownId: string | null }): React.JSX.Element {
  if (!data.standings) return <p className="small-text">順位表の取得エラー: {data.standingsError ?? '不明'}</p>;
  return (
    <>
      {data.standings.map((group) => {
        const check = checkReproduction(data.season.pointRule, group, data.cards.filter((card) => card.divisionIndex === group.divisionIndex));
        return (
          <Card key={group.divisionIndex} kicker="OFFICIAL" title={`${group.title} 順位 (n01 公式)`}>
            <div className="table-scroll">
              <table className="standings small-text">
                <thead>
                  <tr>
                    <th scope="col">順位</th>
                    <th scope="col">チーム</th>
                    <th scope="col">試合</th>
                    <th scope="col">勝</th>
                    <th scope="col">分</th>
                    <th scope="col">負</th>
                    <th scope="col">勝ち点</th>
                  </tr>
                </thead>
                <tbody>
                  {group.rows.map((row) => (
                    <tr key={row.teamId} className={row.teamId === ownId ? 'own' : ''}>
                      <td>{row.rank > 0 ? row.rank : '—'}</td>
                      <th scope="row">{row.name}</th>
                      <td>{row.played}</td>
                      <td>{row.won}</td>
                      <td>{row.drawn}</td>
                      <td>{row.lost}</td>
                      <td>{row.points}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="muted small-text">
              {check.ok ? '勝ち点の計算規則を確認済み: 各対戦カードの結果から順位シミュレーションができます。' : `順位シミュレーションなし: ${check.reason}`}
            </p>
          </Card>
        );
      })}
    </>
  );
}

function PlayersTab({ data, ownId }: { data: SeasonData; ownId: string | null }): React.JSX.Element {
  const [teamId, setTeamId] = useState<string | null>(ownId ?? data.season.divisions[0]?.teamIds[0] ?? null);
  const forms = useMemo(() => (teamId ? playerForms(data.season, data.games, teamId) : []), [data, teamId]);
  return (
    <>
      <label className="small-text">
        チーム{' '}
        <select value={teamId ?? ''} onChange={(event) => setTeamId(event.target.value)} aria-label="チーム">
          {data.season.divisions.flatMap((division) =>
            division.teamIds.map((id) => (
              <option key={id} value={id}>
                {data.season.teams.get(id) ?? id} ({division.title})
              </option>
            )),
          )}
        </select>
      </label>
      <p className="muted small-text">
        League Order の集計 (n01 の試合データから計算)。平均は本人だけが投げる Singles のみ。{'5'} 試合未満の勝率は参考値です。選手はこのシーズンのメンバー ID で区別し、名前だけで統合しません。
      </p>
      {forms.length === 0 ? <p className="small-text">このチームの終了した試合がありません。</p> : null}
      <div className="table-scroll">
        <table className="players-form small-text" data-testid="player-forms">
          <thead>
            <tr>
              <th scope="col">選手</th>
              <th scope="col">Singles 01 平均 (シーズン / 直近3)</th>
              <th scope="col">Cricket MPR</th>
              <th scope="col">種別別 勝率</th>
              <th scope="col">推移</th>
            </tr>
          </thead>
          <tbody>
            {forms.map((form) => (
              <tr key={form.oid}>
                <th scope="row">{form.name}</th>
                <td>
                  {formatRate(form.singles01.season)} / {formatRate(form.singles01.recent)} <span className="muted">({form.singles01.games})</span>
                </td>
                <td>
                  {formatRate(form.singlesCricket.season)} <span className="muted">({form.singlesCricket.games})</span>
                </td>
                <td>
                  {Object.entries(form.byStructure)
                    .map(([kind, record]) => `${STRUCTURE_LABEL[kind] ?? kind} ${percent(record)}`)
                    .join(' ・ ')}
                  {form.notes.map((note) => (
                    <span key={note} className="muted" style={{ display: 'block' }}>
                      {note}
                    </span>
                  ))}
                </td>
                <td>
                  <Trend values={form.singles01.trend} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

function Trend({ values }: { values: number[] }): React.JSX.Element {
  if (values.length < 2) return <span className="muted">—</span>;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const points = values.map((value, index) => `${(index / (values.length - 1)) * 60},${18 - ((value - min) / span) * 16}`).join(' ');
  return (
    <svg width="64" height="20" viewBox="0 0 64 20" role="img" aria-label={`Singles 01 平均の推移 ${values.map((v) => v.toFixed(1)).join('、')}`}>
      <polyline points={points} fill="none" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}
