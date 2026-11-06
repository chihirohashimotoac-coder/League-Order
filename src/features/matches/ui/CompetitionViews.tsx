import { useEffect, useMemo, useState } from 'react';
import { describeN01Error } from '../../../integrations/n01/client';
import type { MatchesApi } from '../api';
import type { CompetitionDoc, CompetitionMatch, StandingGroup } from '../competition';
import { TTYPE_LABELS, groupMatches, stageLabel } from '../competition';
import type { GameRow } from '../parse';
import type { MatchesApiFactory } from '../environment';
import type { PlayerLine } from './useMatchContext';
import { formatClock, formatRate, usePlayerStats } from './useMatchContext';

/**
 * Tournaments and events of any kind (brackets, round robins, single-match events), and the
 * games being played anywhere on n01 right now. The same four views as a league where n01 has
 * the data: live, matches by stage, standings (round robins and leagues), player stats.
 */

export type HubTab = 'live' | 'results' | 'standings' | 'stats';

function MatchRow({ match, onOpen }: { match: CompetitionMatch; onOpen: () => void }): React.JSX.Element {
  return (
    <button type="button" className={`match-row state-${match.finished ? 'official' : 'live'}`} onClick={onOpen} data-testid="competition-match">
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
        <span className="muted small-text">{formatClock(match.startTime ? match.startTime * 1000 : null)}</span>
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

export function TournamentHub({
  api,
  tdid,
  tab,
  onGame,
}: {
  api: MatchesApi;
  tdid: string;
  tab: HubTab;
  onGame: (mid: string, title?: string) => void;
}): React.JSX.Element {
  const [doc, setDoc] = useState<CompetitionDoc | null>(null);
  const [rows, setRows] = useState<GameRow[] | null>(null);
  const [standings, setStandings] = useState<StandingGroup[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fetchedAt, setFetchedAt] = useState<number | null>(null);
  const [open, setOpen] = useState<string | null>(null);

  // The document once; the games now, and every 10 s while any is in progress and visible.
  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const controller = new AbortController();
    const load = async (): Promise<void> => {
      try {
        if (document.visibilityState !== 'hidden') {
          const [competition, games] = await Promise.all([api.competition(tdid), api.competitionGames(tdid, { signal: controller.signal })]);
          if (!alive) return;
          setDoc(competition);
          setRows(games.games);
          setFetchedAt(Date.now());
          setError(null);
          if (!games.games.some((game) => !game.finished)) return;
        }
      } catch (reason) {
        if (alive) setError(describeN01Error(reason));
      }
      if (alive) timer = setTimeout(() => void load(), 10_000 * (0.8 + Math.random() * 0.4));
    };
    void load();
    api
      .allStandings(tdid)
      .then((groups) => alive && setStandings(groups))
      .catch(() => alive && setStandings([]));
    return () => {
      alive = false;
      controller.abort();
      if (timer) clearTimeout(timer);
    };
  }, [api, tdid]);

  const matches = useMemo(() => (rows && doc ? groupMatches(rows, doc.entries, doc.tdid) : []), [rows, doc]);
  const stats = usePlayerStats(api, tdid, tab === 'stats');

  if (error && !rows) return <p className="small-text" role="alert">取得エラー: {error}</p>;
  if (!rows || !doc) return <p className="muted small-text">読み込み中…</p>;

  const stages = new Map<string, CompetitionMatch[]>();
  for (const match of matches) {
    const label = match.place ? stageLabel(match.place, { rrGroups: doc.rrGroups, divisions: doc.divisions, rounds: doc.rounds }) : 'その他';
    stages.set(label, [...(stages.get(label) ?? []), match]);
  }
  const liveMatches = matches.filter((match) => !match.finished);
  const opened = open ? matches.find((match) => match.key === open) ?? null : null;
  const openMatch = (match: CompetitionMatch): void => {
    if (match.games.length === 1) onGame(match.games[0].mid, `${match.names[0]} vs ${match.names[1]}`);
    else setOpen(match.key === open ? null : match.key);
  };

  return (
    <div className="competition" data-testid="tournament-hub">
      <p className="muted small-text">
        {doc.title} ・ 取得 {formatClock(fetchedAt)}
        {doc.url ? (
          <>
            {' ・ '}
            <a href={doc.url} target="_blank" rel="noreferrer noopener">
              n01 で開く
            </a>
          </>
        ) : null}
        {error ? ' ・ 更新エラー (前回の値を表示中)' : ''}
      </p>
      {tab === 'live' ? (
        liveMatches.length === 0 ? (
          <p className="small-text">いま進行中の試合はありません。「試合」タブで結果を見られます。</p>
        ) : (
          <ul className="match-list">
            {liveMatches.map((match) => (
              <li key={match.key}>
                <MatchRow match={match} onOpen={() => openMatch(match)} />
                {opened?.key === match.key ? <CardGames match={match} onGame={(game) => onGame(game.mid)} /> : null}
              </li>
            ))}
          </ul>
        )
      ) : null}
      {tab === 'results'
        ? [...stages.entries()].reverse().map(([label, list]) => (
            <section key={label} className="round">
              <h3 className="section-mini">{label}</h3>
              <ul className="match-list">
                {[...list].reverse().map((match) => (
                  <li key={match.key}>
                    <MatchRow match={match} onOpen={() => openMatch(match)} />
                    {opened?.key === match.key ? <CardGames match={match} onGame={(game) => onGame(game.mid)} /> : null}
                  </li>
                ))}
              </ul>
            </section>
          ))
        : null}
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
          <p className="small-text muted">この大会には順位表がありません (トーナメント形式)。「試合」タブで勝ち上がりを見られます。</p>
        )
      ) : null}
      {tab === 'stats' ? <PlayerRanking state={stats} entries={doc.entries} /> : null}
    </div>
  );
}

function PlayerRanking({ state, entries }: { state: ReturnType<typeof usePlayerStats>; entries: Map<string, string> }): React.JSX.Element {
  if (state.kind === 'loading') return <p className="muted small-text">成績を読み込み中…</p>;
  if (state.kind === 'error') return <p className="small-text">取得エラー: {state.message}</p>;
  const avg = (row: PlayerLine): number | null => (row.line.score !== null && row.line.darts ? (row.line.score / row.line.darts) * 3 : null);
  const rows = [...state.value].filter((row) => avg(row) !== null).sort((a, b) => avg(b)! - avg(a)!).slice(0, 60);
  if (rows.length === 0) return <p className="small-text muted">この大会の選手別成績はありません。</p>;
  return (
    <div className="table-scroll">
      <table className="rank-table small-text">
        <thead>
          <tr>
            <th scope="col">#</th>
            <th scope="col">選手</th>
            <th scope="col">平均</th>
            <th scope="col">180</th>
            <th scope="col">High Out</th>
            <th scope="col">Leg</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={row.oid}>
              <td>{index + 1}</td>
              <th scope="row">
                {row.name !== '(名前なし)' ? row.name : entries.get(row.oid) ?? row.oid}
                {row.teamId && entries.get(row.teamId) && entries.get(row.teamId) !== row.name ? <span className="muted"> {entries.get(row.teamId)}</span> : null}
              </th>
              <td className="num">{formatRate(avg(row))}</td>
              <td className="num">{row.line.ton80 ?? 0}</td>
              <td className="num">{row.line.highOut ?? '—'}</td>
              <td className="num">
                {row.line.winLeg ?? 0}/{row.line.leg ?? 0}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Everything in progress on n01 now: competitions (open their hub) and single games. */
export function NowView({ factory, onCompetition, onGame }: { factory: MatchesApiFactory; onCompetition: (tdid: string, title: string) => void; onGame: (mid: string, title?: string) => void }): React.JSX.Element {
  const api = useMemo(() => factory({ maxRequests: 100_000 }), [factory]);
  const [rows, setRows] = useState<GameRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fetchedAt, setFetchedAt] = useState<number | null>(null);
  const [filter, setFilter] = useState('');
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
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
