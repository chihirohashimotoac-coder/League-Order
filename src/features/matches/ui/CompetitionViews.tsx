import { useEffect, useMemo, useRef, useState } from 'react';
import { onRadioGroupKeyDown, rovingTabIndex } from '../../../components/ui';
import { describeN01Error } from '../../../integrations/n01/client';
import type { MatchesApi } from '../api';
import type { CompetitionDoc, CompetitionMatch, StandingGroup } from '../competition';
import { TTYPE_LABELS, bracketLinks, groupMatches, matchesOfPlayer, stageLabel } from '../competition';
import type { WatchLink } from '../watchLink';
import { watchLinkUrl } from '../watchLink';
import type { GameRow } from '../parse';
import type { MatchesApiFactory } from '../environment';
import type { PlayerLine, StatsSource } from './useMatchContext';
import { formatClock, formatRate, useFollowed, usePlayerStats } from './useMatchContext';
import { RankingFooter, RankingSearch, matchesQuery, rankThenSearch } from './rankingList';
import { CopyLink } from './CopyLink';
import { MatchPane } from './MatchSheet';
import { ListCoverage, listIncomplete } from './ListCoverage';
import type { ListCoverageState } from './ListCoverage';

/** Refresh of a competition's games: while a game is on, and while it is running but between games. */
export const HUB_LIVE_MS = 10_000;
export const HUB_IDLE_MS = 60_000;
export const HUB_ERROR_MS = 20_000;
/** n01 tournament status 40 = finished (manual): no more games will start. */
const FINISHED = 40;

/**
 * Tournaments and events of any kind (brackets, round robins, single-match events), and the
 * games being played anywhere on n01 right now. The same four views as a league where n01 has
 * the data: live, matches by stage, standings (round robins and leagues), player stats.
 */

export type HubTab = 'live' | 'results' | 'standings' | 'stats';

function MatchRow({ match, onOpen, selected = false }: { match: CompetitionMatch; onOpen: () => void; selected?: boolean }): React.JSX.Element {
  return (
    <button
      type="button"
      className={`match-row duel-row state-${match.finished ? 'official' : 'live'}`}
      aria-current={selected ? 'true' : undefined}
      onClick={onOpen}
      data-testid="competition-match"
      data-match-key={match.key}
    >
      <span className="match-teams">
        <span>{match.names[0]}</span>
        <span className="match-score">
          {match.score[0]} - {match.score[1]}
        </span>
        <span>{match.names[1]}</span>
      </span>
      <span className="match-tags">
        <span className={`tag state-${match.finished ? 'official' : 'live'}`}>{match.finished ? '終了' : '進行中'}</span>
        {match.games.length > 1 ? <span className="muted small-text">{match.games.length} ゲーム</span> : null}
        <span className="muted small-text">{match.startTime ? `開始 ${formatClock(match.startTime * 1000)}` : '開始時刻 未取得'}</span>
      </span>
    </button>
  );
}

/** A match row was tapped: one game opens straight away, a team card lists its games. */
function CardGames({ match, onGame }: { match: CompetitionMatch; onGame: (game: GameRow) => void }): React.JSX.Element {
  return (
    <ul className="game-list">
      {match.games.map((game) => (
        <li key={game.mid}>
          <button type="button" className="game-row" onClick={() => onGame(game)}>
            <span className="game-name">{game.title.split(' ').slice(-1)[0] || 'ゲーム'}</span>
            <span className="side">{game.sides[0].members.map((m) => m.name).join(' / ') || game.sides[0].name}</span>
            <span className="legs">
              {game.sides[0].legsWon ?? 0} - {game.sides[1].legsWon ?? 0}
              {game.finished ? '' : ' ・ 進行中'}
            </span>
            <span className="side right">{game.sides[1].members.map((m) => m.name).join(' / ') || game.sides[1].name}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

/** The names a match is found by: both entries and every player of its games. */
function matchNames(match: CompetitionMatch): string {
  return [...match.names, ...match.games.flatMap((game) => game.sides.flatMap((side) => [side.name, ...side.members.map((member) => member.name)]))].join(' ');
}

/** Who a ranking row is, for following them to their matches: the public id, never the name alone. */
export interface PickedPlayer {
  oid: string;
  name: string;
  unit: 'entry' | 'member';
  rank: number;
}

export function TournamentHub({
  api,
  factory,
  tdid,
  tab,
  onGame,
  selectedMid = null,
  inline = false,
  onCloseMatch,
  link,
  onTitle,
}: {
  api: MatchesApi;
  /** For the match shown in place on a large screen. */
  factory?: MatchesApiFactory;
  tdid: string;
  tab: HubTab;
  onGame: (mid: string, title?: string) => void;
  /** The match shown beside the rounds (large screens); `null` = none chosen. */
  selectedMid?: string | null;
  /** True when the chosen match is shown in place (`selectedMid`), not in a sheet. */
  inline?: boolean;
  onCloseMatch?: () => void;
  /** The league / season or tournament a copied link starts from. */
  link?: WatchLink;
  /** Reports the competition's title once it is read. */
  onTitle?: (title: string) => void;
}): React.JSX.Element {
  const [doc, setDoc] = useState<CompetitionDoc | null>(null);
  const [rows, setRows] = useState<GameRow[] | null>(null);
  const [coverage, setCoverage] = useState<ListCoverageState>({ truncated: false, unreadable: 0 });
  const [standings, setStandings] = useState<StandingGroup[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fetchedAt, setFetchedAt] = useState<number | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  // What is searched and chosen is the hub's, not a tab's: it is still there after a visit to
  // another tab of the same competition.
  const [matchQuery, setMatchQuery] = useState('');
  const [stage, setStage] = useState<string>('all');
  const [statsQuery, setStatsQuery] = useState('');
  const [picked, setPicked] = useState<PickedPlayer | null>(null);
  const reportTitle = useRef(onTitle);
  reportTitle.current = onTitle;
  useEffect(() => {
    if (doc) reportTitle.current?.(doc.title);
  }, [doc]);

  // The document once; the games now, then every 10 s while a game is in progress, every 60 s
  // while the event runs with nothing on (before the first game, between rounds) — a game that
  // starts later appears without a manual refresh — and not at all once the event is finished
  // with nothing in progress. Hidden: no request; visible again: read at once.
  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const controller = new AbortController();
    const load = async (): Promise<void> => {
      timer = null;
      let delay = HUB_LIVE_MS;
      if (document.visibilityState !== 'hidden') {
        try {
          const [first, games] = await Promise.all([api.competition(tdid), api.competitionGames(tdid, { signal: controller.signal })]);
          if (!alive) return;
          // Nothing in progress: read the status again (the event may have finished since the page opened).
          const competition = games.games.some((game) => !game.finished) ? first : await api.competitionNow(tdid, controller.signal).catch(() => first);
          if (!alive) return;
          setDoc(competition);
          setRows(games.games);
          setCoverage({ truncated: games.truncated, unreadable: games.unreadable, unsure: games.unsure });
          setFetchedAt(Date.now());
          setError(null);
          const live = games.games.some((game) => !game.finished);
          if (!live && competition.status === FINISHED) return;
          delay = live ? HUB_LIVE_MS : HUB_IDLE_MS;
        } catch (reason) {
          if (!alive) return;
          setError(describeN01Error(reason));
          delay = HUB_ERROR_MS;
        }
      }
      if (alive) timer = setTimeout(() => void load(), delay * (0.8 + Math.random() * 0.4));
    };
    const onVisible = (): void => {
      if (document.visibilityState !== 'visible' || !alive || timer === null) return;
      clearTimeout(timer);
      void load();
    };
    document.addEventListener('visibilitychange', onVisible);
    void load();
    api
      .allStandings(tdid)
      .then((groups) => alive && setStandings(groups))
      .catch(() => alive && setStandings([]));
    return () => {
      alive = false;
      controller.abort();
      document.removeEventListener('visibilitychange', onVisible);
      if (timer) clearTimeout(timer);
    };
  }, [api, tdid]);

  const matches = useMemo(() => (rows && doc ? groupMatches(rows, doc.entries, doc.tdid) : []), [rows, doc]);
  const source = useMemo<StatsSource | null>(() => (doc ? (doc.teamGames ? { teamGames: true } : { teamGames: false, entries: doc.entries }) : null), [doc]);
  const stats = usePlayerStats(api, tdid, tab === 'stats', source);

  if (error && !rows) return <p className="small-text" role="alert">取得エラー: {error}</p>;
  if (!rows || !doc) return <p className="muted small-text">読み込み中…</p>;

  const labelOf = (match: CompetitionMatch): string => (match.place ? stageLabel(match.place, { rrGroups: doc.rrGroups, divisions: doc.divisions, rounds: doc.rounds }) : 'その他');
  const stages = new Map<string, CompetitionMatch[]>();
  for (const match of matches) {
    const label = labelOf(match);
    stages.set(label, [...(stages.get(label) ?? []), match]);
  }
  // The latest round first, as before.
  const stageList = [...stages.entries()].reverse();
  const shownStage = stage !== 'all' && stages.has(stage) ? stage : 'all';
  const visibleStages = stageList
    .filter(([label]) => shownStage === 'all' || label === shownStage)
    .map(([label, list]) => [label, [...list].reverse().filter((match) => matchesQuery(matchNames(match), matchQuery))] as const)
    .filter(([, list]) => list.length > 0);
  const visibleCount = visibleStages.reduce((sum, [, list]) => sum + list.length, 0);
  const liveMatches = matches.filter((match) => !match.finished);
  const opened = open ? matches.find((match) => match.key === open) ?? null : null;
  const titleOf = (match: CompetitionMatch): string => `${match.names[0]} vs ${match.names[1]}`;
  const openMatch = (match: CompetitionMatch): void => {
    if (match.games.length === 1) onGame(match.games[0].mid, titleOf(match));
    else setOpen(match.key === open ? null : match.key);
  };
  const selectedMatch = selectedMid ? (matches.find((match) => match.games.some((game) => game.mid === selectedMid)) ?? null) : null;
  const links = selectedMatch ? bracketLinks(selectedMatch, matches) : null;
  const pickedMatches = picked ? matchesOfPlayer(matches, picked) : [];
  const rowOf = (match: CompetitionMatch): React.JSX.Element => (
    <li key={match.key}>
      <MatchRow match={match} onOpen={() => openMatch(match)} selected={inline && selectedMatch?.key === match.key} />
      {opened?.key === match.key ? <CardGames match={match} onGame={(game) => onGame(game.mid, titleOf(match))} /> : null}
    </li>
  );
  const pathRow = (label: string, match: CompetitionMatch): React.JSX.Element => (
    <li key={`${label}:${match.key}`}>
      <button type="button" className="path-row" onClick={() => openMatch(match)}>
        <span className="path-label">{label}</span>
        <span className="path-match">
          {match.names[0]} <strong>{match.score[0]} - {match.score[1]}</strong> {match.names[1]}
        </span>
        <span className="muted small-text">{labelOf(match)}</span>
      </button>
    </li>
  );

  return (
    <div className="competition" data-testid="tournament-hub">
      <p className="muted small-text">
        {doc.title} ・ 取得 {formatClock(fetchedAt)}
        {doc.url ? (
          <>
            {' ・ '}
            <a href={doc.url} target="_blank" rel="noreferrer noopener">
              n01 の大会ページを開く
            </a>
          </>
        ) : null}
        {error ? ' ・ 更新エラー (前回の値を表示中)' : ''}
      </p>
      <ListCoverage state={coverage} kind="competition" />
      {tab === 'live' ? (
        liveMatches.length === 0 ? (
          <p className="small-text" data-testid="competition-live-empty">
            {listIncomplete(coverage) ? '取得できた試合の中に進行中のものはありません (一覧の一部は未取得)。' : 'いま進行中の試合はありません。'}
            {doc.status === FINISHED ? 'この大会は終了しています。' : '始まると自動で表示します。'}「試合」タブで結果を見られます。
          </p>
        ) : (
          <ul className="match-list">{liveMatches.map(rowOf)}</ul>
        )
      ) : null}
      {tab === 'results' ? (
        <div className={`rounds${inline ? ' is-split' : ''}`} data-testid="rounds">
          <div className="rounds-list">
            <RankingSearch value={matchQuery} onChange={setMatchQuery} label={doc.teamGames ? 'チーム名・選手名で試合を検索' : '選手名で試合を検索'} />
            {stageList.length > 1 ? (
              <div className="chip-row round-chips" role="radiogroup" aria-label="ラウンド" onKeyDown={onRadioGroupKeyDown} data-testid="round-chips">
                <button type="button" className="chip" role="radio" aria-checked={shownStage === 'all'} tabIndex={rovingTabIndex(shownStage === 'all', 0, true)} onClick={() => setStage('all')}>
                  すべて <span className="badge">{matches.length}</span>
                </button>
                {stageList.map(([label, list]) => (
                  <button key={label} type="button" className="chip" role="radio" aria-checked={shownStage === label} tabIndex={rovingTabIndex(shownStage === label, 1, true)} onClick={() => setStage(label)}>
                    {label} <span className="badge">{list.length}</span>
                  </button>
                ))}
              </div>
            ) : null}
            <p className="muted small-text" aria-live="polite" data-testid="rounds-count">
              {matchQuery.trim() !== ''
                ? visibleCount === 0
                  ? `「${matchQuery.trim()}」に一致する試合はありません (取得済み ${matches.length} 試合)`
                  : `「${matchQuery.trim()}」に一致 ${visibleCount} 試合 (取得済み ${matches.length} 試合)`
                : `${visibleCount} / ${matches.length} 試合を表示`}
              {listIncomplete(coverage) ? ' ・ 一覧の一部は未取得' : ''}
            </p>
            {visibleStages.map(([label, list]) => (
              <section key={label} className="round">
                <h3 className="section-mini">{label}</h3>
                <ul className="match-list">{list.map(rowOf)}</ul>
              </section>
            ))}
          </div>
          {inline ? (
            <div className="rounds-pane" data-testid="rounds-pane">
              {selectedMid && factory ? (
                <>
                  <div className="rounds-pane-bar">
                    <strong>{selectedMatch ? `${labelOf(selectedMatch)} ・ ${titleOf(selectedMatch)}` : '選択した試合'}</strong>
                    <span className="row" style={{ gap: 8 }}>
                      {link ? <CopyLink url={watchLinkUrl({ ...link, mid: selectedMid })} label="リンクをコピー" /> : null}
                      {onCloseMatch ? (
                        <button type="button" className="btn small ghost" onClick={onCloseMatch}>
                          閉じる
                        </button>
                      ) : null}
                    </span>
                  </div>
                  {links ? (
                    <section className="bracket-path" aria-label="勝ち上がり" data-testid="bracket-path">
                      <h3 className="section-mini">勝ち上がり (この試合の前後)</h3>
                      <ul className="plain">
                        {links.before.map((before, side) => (before && selectedMatch ? pathRow(`${selectedMatch.names[side]} の前の試合`, before) : null))}
                        {links.after ? pathRow('勝者の次の試合', links.after) : null}
                      </ul>
                      <p className="muted small-text">同じエントリー ID が前後のラウンドに 1 試合だけある場合に表示します (n01 の公開データ)。</p>
                    </section>
                  ) : null}
                  <MatchPane key={selectedMid} mid={selectedMid} factory={factory} />
                </>
              ) : (
                <p className="muted small-text rounds-pane-empty">左の一覧から試合を選ぶと、ここにスコアと Leg ごとの記録を表示します。ラウンドと選んだ試合を並べて確認できます。</p>
              )}
            </div>
          ) : null}
        </div>
      ) : null}
      {tab === 'standings' ? (
        standings && standings.length > 0 ? (
          standings.map((group) => (
            <section key={`${group.kind}${group.index}`}>
              <h3 className="section-mini">
                {TTYPE_LABELS[group.kind] ?? group.kind} {group.title} (n01 公式)
              </h3>
              <div className="table-scroll">
                <table className="standings small-text">
                  <thead>
                    <tr>
                      <th scope="col">順位</th>
                      <th scope="col">名前</th>
                      <th scope="col">試合</th>
                      <th scope="col">勝</th>
                      <th scope="col">負</th>
                      <th scope="col">差</th>
                      <th scope="col">勝ち点</th>
                    </tr>
                  </thead>
                  <tbody>
                    {group.rows.map((row) => (
                      <tr key={row.teamId}>
                        <td>{row.rank > 0 ? row.rank : '—'}</td>
                        <th scope="row">{row.name}</th>
                        <td>{row.played}</td>
                        <td>{row.won}</td>
                        <td>{row.lost}</td>
                        <td>{row.diff ?? '—'}</td>
                        <td>{row.points ?? '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          ))
        ) : (
          <p className="small-text muted">
            この大会には順位表がありません (トーナメント形式)。大会の最終順位は「試合」タブの勝ち上がりで確認できます。「スタッツ」の 01 平均順位は成績の並びで、大会の順位ではありません。
          </p>
        )
      ) : null}
      {tab === 'stats' ? (
        <div className={`stats-split${picked ? ' has-pick' : ''}`}>
          <PlayerRanking state={stats} entries={doc.entries} teamGames={doc.teamGames} query={statsQuery} onQuery={setStatsQuery} picked={picked} onPick={setPicked} />
          {picked ? (
            <section className="picked-player" aria-label={`${picked.name} の試合`} data-testid="picked-player">
              <header className="picked-head">
                <span>
                  <span className="kicker">選択中の{picked.unit === 'entry' ? 'エントリー' : '選手'}</span>
                  <strong>{picked.name}</strong>
                  <span className="muted small-text"> 01 平均順位 {picked.rank} 位</span>
                </span>
                <button type="button" className="btn small ghost" onClick={() => setPicked(null)}>
                  選択を解除
                </button>
              </header>
              {pickedMatches.length > 0 ? (
                <>
                  <p className="muted small-text">この大会の試合 {pickedMatches.length} 件 (新しいラウンド順)。試合を選ぶとスコアと Leg の記録を開きます。</p>
                  <ul className="match-list">
                    {[...pickedMatches].reverse().map((match) => (
                      <li key={match.key}>
                        <span className="muted small-text">{labelOf(match)}</span>
                        <MatchRow match={match} onOpen={() => openMatch(match)} />
                        {opened?.key === match.key ? <CardGames match={match} onGame={(game) => onGame(game.mid, titleOf(match))} /> : null}
                      </li>
                    ))}
                  </ul>
                </>
              ) : (
                <p className="small-text" data-testid="picked-unmatched">
                  この{picked.unit === 'entry' ? 'エントリー' : '選手'}の試合を、公開データの ID では特定できませんでした。同じ名前の別人を取り違えないよう、名前だけでは照合しません。「試合」タブの検索で名前から探せます。
                </p>
              )}
            </section>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function PlayerRanking({
  state,
  entries,
  teamGames,
  query,
  onQuery,
  picked,
  onPick,
}: {
  state: ReturnType<typeof usePlayerStats>;
  entries: Map<string, string>;
  teamGames: boolean;
  query: string;
  onQuery: (next: string) => void;
  picked: PickedPlayer | null;
  onPick: (next: PickedPlayer | null) => void;
}): React.JSX.Element {
  if (state.kind === 'loading') return <p className="muted small-text">成績を読み込み中…</p>;
  if (state.kind === 'error') return <p className="small-text" role="alert">取得エラー: {state.message}</p>;
  const avg = (row: PlayerLine): number | null => (row.line.score !== null && row.line.darts ? (row.line.score / row.line.darts) * 3 : null);
  const nameOf = (row: PlayerLine): string => (row.name !== '(名前なし)' ? row.name : entries.get(row.oid) ?? row.oid);
  const sorted = [...state.value].filter((row) => avg(row) !== null).sort((a, b) => avg(b)! - avg(a)!);
  if (sorted.length === 0) {
    return (
      <p className="small-text muted">
        {state.value.length === 0
          ? 'この大会の選手別成績はまだありません。'
          : `01 の成績がある${teamGames ? '選手' : 'エントリー'}はいません (Cricket の成績はこの一覧では未対応です)。`}
      </p>
    );
  }
  const matched = rankThenSearch(sorted, query, nameOf);
  const unit: PickedPlayer['unit'] = state.unit ?? (teamGames ? 'member' : 'entry');
  return (
    <div className="ranking" data-testid="player-ranking">
      <RankingSearch value={query} onChange={onQuery} label={teamGames ? '選手名で検索' : '名前で検索'} />
      {matched.length > 0 ? (
        <div className="table-scroll">
          <table className="rank-table small-text">
            <thead>
              <tr>
                <th scope="col" className="rank-head" data-testid="rank-head">
                  01 平均
                  <span className="th-sub">順位</span>
                </th>
                <th scope="col">{teamGames ? '選手' : 'エントリー'}</th>
                <th scope="col">01 平均</th>
                <th scope="col">180</th>
                <th scope="col">High Out</th>
                <th scope="col">Leg</th>
              </tr>
            </thead>
            <tbody>
              {matched.map(({ rank, item: row }) => (
                <tr key={row.oid} className={picked?.oid === row.oid ? 'me' : ''} aria-current={picked?.oid === row.oid ? 'true' : undefined}>
                  <td>{rank}</td>
                  <th scope="row">
                    <button type="button" className="linklike" aria-pressed={picked?.oid === row.oid} onClick={() => onPick(picked?.oid === row.oid ? null : { oid: row.oid, name: nameOf(row), unit, rank })}>
                      {nameOf(row)}
                    </button>
                    {row.teamId && entries.get(row.teamId) && entries.get(row.teamId) !== row.name ? <span className="muted"> {entries.get(row.teamId)}</span> : null}
                  </th>
                  <td className="num">{formatRate(avg(row))}</td>
                  <td className="num">{row.line.ton80 ?? '—'}</td>
                  <td className="num">{row.line.highOut ?? '—'}</td>
                  <td className="num">
                    {row.line.winLeg ?? '—'}/{row.line.leg ?? '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      <RankingFooter matched={matched.length} total={sorted.length} query={query} noun={teamGames ? '選手' : 'エントリー'} />
      <p className="muted small-text">
        n01 公式の集計 ({teamGames ? '選手単位 player_stats_list' : 'エントリー単位 stats_list'})。左端は 01 平均で並べた順位です (大会の最終順位とは別)。名前を選ぶと、その{teamGames ? '選手' : 'エントリー'}の試合を表示します。
      </p>
    </div>
  );
}

const formatTime = (ms: number): string => new Date(ms).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

/** Everything in progress on n01 now: competitions (open their hub) and single games. */
export function NowView({ factory, onCompetition, onGame }: { factory: MatchesApiFactory; onCompetition: (tdid: string, title: string) => void; onGame: (mid: string, title?: string) => void }): React.JSX.Element {
  const api = useMemo(() => factory({ maxRequests: 100_000 }), [factory]);
  const [rows, setRows] = useState<GameRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fetchedAt, setFetchedAt] = useState<number | null>(null);
  const [filter, setFilter] = useState('');
  const followed = useFollowed();
  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const load = async (): Promise<void> => {
      if (document.visibilityState !== 'hidden') {
        try {
          const list = await api.nowLive();
          if (!alive) return;
          setRows(list);
          setFetchedAt(Date.now());
          setError(null);
        } catch (reason) {
          if (alive) setError(describeN01Error(reason));
        }
      }
      if (alive) timer = setTimeout(() => void load(), 15_000 * (0.8 + Math.random() * 0.4));
    };
    void load();
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
  }, [api]);
  if (!rows) return error ? <p className="small-text">取得エラー: {error}</p> : <p className="muted small-text">n01 の進行中の試合を確認中…</p>;
  const who = (row: GameRow): string[] =>
    [...new Set(row.sides.flatMap((side) => [side.name, ...side.members.map((member) => member.name)]).map((name) => name.trim()))].filter((name) => followed.names.has(name));
  const starred = rows.map((row) => ({ row, names: who(row) })).filter((entry) => entry.names.length > 0);
  const needle = filter.trim().toLowerCase();
  const match = (row: GameRow): boolean => !needle || `${row.title} ${row.sides.map((side) => `${side.name} ${side.members.map((m) => m.name).join(' ')}`).join(' ')}`.toLowerCase().includes(needle);
  const competitions = new Map<string, { title: string; rows: GameRow[] }>();
  const singles: GameRow[] = [];
  for (const row of rows.filter(match)) {
    const tdid = row.tmid?.split('_').slice(0, 3).join('_') ?? null;
    if (tdid && /^t_[A-Za-z0-9]+_\d+$/u.test(tdid)) {
      const entry = competitions.get(tdid) ?? { title: row.title.replace(/\s+\S+$/u, '') || tdid, rows: [] };
      entry.rows.push(row);
      competitions.set(tdid, entry);
    } else singles.push(row);
  }
  return (
    <div className="now" data-testid="now-view">
      <p className="muted small-text">
        n01 全体で進行中 {rows.length} 試合{rows.length >= 100 ? ' (新しい順に 100 件まで)' : ''} ・ 取得 {formatClock(fetchedAt)}
      </p>
      <input value={filter} onChange={(event) => setFilter(event.target.value)} placeholder="大会名・選手名で絞り込み" aria-label="大会名・選手名で絞り込み" />
      {starred.length ? (
        <section className="followed-now" aria-label="注目選手" data-testid="followed-now">
          <h3 className="section-mini">
            <span aria-hidden="true">★</span> 注目選手が出場中
          </h3>
          <ul className="plain">
            {starred.map(({ row, names }) => (
              <li key={row.mid}>
                <button type="button" className="followed-row is-live" onClick={() => onGame(row.mid, `${row.sides[0].name} vs ${row.sides[1].name}`)}>
                  <strong>{names.join('・')}</strong>
                  <span>
                    {row.sides[0].name} {row.sides[0].legsWon ?? 0} - {row.sides[1].legsWon ?? 0} {row.sides[1].name}
                  </span>
                  <span className="muted small-text">
                    {row.title} ・ {row.startTime ? `開始 ${formatClock(row.startTime * 1000)}` : '開始時刻 未取得'}
                  </span>
                </button>
              </li>
            ))}
          </ul>
          <p className="muted small-text">選手名で照合しています (同姓同名は区別できません)。</p>
        </section>
      ) : null}
      <h3 className="section-mini">大会・リーグ</h3>
      <ul className="match-list">
        {[...competitions.entries()].map(([tdid, entry]) => (
          <li key={tdid}>
            <button type="button" className="match-row" onClick={() => onCompetition(tdid, entry.title)}>
              <span className="match-teams">
                <span>{entry.title}</span>
              </span>
              <span className="match-tags">
                <span className="tag state-live">進行中 {entry.rows.length}</span>
              </span>
            </button>
          </li>
        ))}
      </ul>
      <h3 className="section-mini">個別の試合 (n01 Online / Live など)</h3>
      <ul className="match-list">
        {singles.slice(0, 40).map((row) => (
          <li key={row.mid}>
            <button type="button" className="match-row" onClick={() => onGame(row.mid, `${row.sides[0].name} vs ${row.sides[1].name}`)} data-testid="now-single">
              <span className="match-teams">
                <span>{row.sides[0].name}</span>
                <span className="match-score">
                  {row.sides[0].legsWon ?? 0} - {row.sides[1].legsWon ?? 0}
                </span>
                <span>{row.sides[1].name}</span>
              </span>
              <span className="match-tags">
                <span className="muted small-text">{row.matchType === 'cricket' ? 'Cricket' : '01'}</span>
                <span className="muted small-text" data-testid="now-times">
                  {row.startTime ? `開始 ${formatClock(row.startTime * 1000)}` : '開始時刻 未取得'} ・ {row.updateTime ? `最終更新 ${formatTime(row.updateTime)}` : '更新時刻 未取得'}
                </span>
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
