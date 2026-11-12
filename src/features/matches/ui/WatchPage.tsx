import { useEffect, useMemo, useRef, useState } from 'react';
import { Card, Sheet, onTabListKeyDown } from '../../../components/ui';
import { Icon } from '../../../components/icons';
import { SPLIT_QUERY, useMediaQuery } from '../../../components/useMediaQuery';
import { useAppStore } from '../../../state/appStore';
import type { WatchSettings } from '../../../domain/types';
import type { Page } from '../../../navigation';
import { KNOWN_LEAGUES } from '../../../integrations/n01/leagueRegistry';
import type { MatchesApi } from '../api';
import { checkReproduction, roundMovement } from '../standings';
import { percent, playerForms, slotUsage, teamProfile } from '../insights';
import { useMatchesApiFactory } from '../environment';
import type { MatchesApiFactory } from '../environment';
import { shortTitles } from '../titles';
import type { WatchLink } from '../watchLink';
import { closeWatchLink, pushWatchLink, replaceWatchLink, useWatchLink } from '../watchLink';
import type { PlayerLine, SeasonData } from './useMatchContext';
import { formatClock, formatRate, seasonStatsSource, usePlayerStats, useRegisteredTeamMap, useSeasonData, useSeasons } from './useMatchContext';
import { RankingFooter, RankingSearch, rankThenSearch, useShownCount } from './rankingList';
import { LeaguePicker } from './LeaguePicker';
import { LiveTab } from './LiveTab';
import type { PlayerRef } from './LiveTab';
import { ResultsTab } from './ResultsTab';
import { MatchSheet } from './MatchSheet';
import { NowView, TournamentHub } from './CompetitionViews';
import { PlayerCard } from './PlayerCard';
import { shortSlot } from './CardTrail';
import { ListCoverage } from './ListCoverage';

/**
 * 観戦 (WATCH): one page for any n01 league, with or without a team. Four tabs —
 * ライブ / 日程・結果 / 順位 / スタッツ — over one season's data, read once per visit.
 * Registered teams (登録チーム) are highlighted, sorted first and one chip away.
 *
 * What is open — a card, a game — is also in the address (`watchLink`): a copied link opens the
 * same card in a new tab or after a reload, and the browser's back button returns to the list.
 */

export type WatchTab = 'live' | 'results' | 'standings' | 'stats';


/** The tab last shown in this session (the 観戦 tab of the bottom bar reopens it). */
let rememberedTab: WatchTab = 'live';
export function lastWatchTab(): WatchTab {
  return rememberedTab;
}

/** A tab another screen asks 観戦 to open on (分析 → スタッツ). Used by the next mount only. */
let requestedTab: WatchTab | null = null;
export function requestWatchTab(tab: WatchTab): void {
  requestedTab = tab;
}

const TABS: [WatchTab, string][] = [
  ['live', 'ライブ'],
  ['results', '日程・結果'],
  ['standings', '順位'],
  ['stats', 'スタッツ'],
];

/** What the player ranking is filtered and sorted by: kept while the tabs are switched. */
export interface StatsView {
  query: string;
  sort: SortKey;
  division: number | 'all';
  qualified: boolean;
}
const STATS_VIEW: StatsView = { query: '', sort: 'avg', division: 'all', qualified: true };

export default function WatchPage({ initialTab, onNavigate }: { initialTab: WatchTab; onNavigate?: (page: Page) => void }): React.JSX.Element {
  const store = useAppStore();
  const factory = useMatchesApiFactory();
  const link = useWatchLink();
  // What to watch: an opened link, else the last choice, else the active team's league.
  const fallback: WatchSettings | null = store.activeTeam?.n01 ? { kind: 'league', id: store.activeTeam.n01.leagueId, title: store.activeTeam.n01.leagueTitle } : null;
  const stored = store.settings.watch ?? fallback;
  const [hubTitle, setHubTitle] = useState<{ id: string; title: string } | null>(null);
  const linkedId = link?.league ?? link?.tournament ?? null;
  const target = useMemo<WatchSettings | null>(() => {
    if (!linkedId || linkedId === stored?.id) return stored;
    if (link?.league) return { kind: 'league', id: link.league, title: KNOWN_LEAGUES.find((entry) => entry.leagueId === link.league)?.title ?? link.league };
    return { kind: 'tournament', id: linkedId, title: hubTitle?.id === linkedId ? hubTitle.title : '大会' };
  }, [linkedId, link?.league, stored, hubTitle]);
  const league = target?.kind === 'league' ? target : null;
  const [refresh, setRefresh] = useState(0);
  const api = useMemo(() => factory(), [factory, refresh]);
  const seasons = useSeasons(league ? api : null, league?.id ?? null);
  const [tournamentId, setTournamentId] = useState<string | null>(link?.season ?? null);
  // Another league: its own current season — unless a link names the season.
  const shownTarget = useRef(target?.id);
  useEffect(() => {
    if (shownTarget.current === target?.id) return;
    shownTarget.current = target?.id;
    setTournamentId(link?.season ?? null);
  }, [target?.id, link?.season]);
  useEffect(() => {
    if (link?.season) setTournamentId(link.season);
  }, [link?.season]);
  const current = seasons.kind === 'ready' ? (seasons.value.find((entry) => entry.status === 30) ?? seasons.value[0])?.tournamentId ?? null : null;
  const tdid = league ? (tournamentId ?? current) : null;
  const data = useSeasonData(tdid ? api : null, tdid);
  const [tab, setTabState] = useState<WatchTab>(() => (link?.card ? 'results' : (requestedTab ?? initialTab)));
  useEffect(() => {
    requestedTab = null;
  }, []);
  useEffect(() => {
    rememberedTab = tab;
  }, [tab]);
  // A link to a card (pasted into the address bar, or the browser's forward button) shows it.
  useEffect(() => {
    if (link?.card) setTabState('results');
  }, [link?.card]);
  const [picking, setPicking] = useState(false);
  const [now, setNow] = useState(false);
  const [team, setTeam] = useState<string | null>(null);
  const [statsView, setStatsView] = useState<StatsView>(STATS_VIEW);
  const season = data.kind === 'ready' ? data.value.season : null;
  // A league's event that is not played as a league table (an open tournament kept under a
  // league, as JDO's are: brackets, round robins): shown with the tournament views.
  const bracketEvent = league !== null && season !== null && season.divisions.length === 0 ? season : null;
  const teamMap = useRegisteredTeamMap(season);
  const registered = useMemo(() => [...teamMap.keys()], [teamMap]);
  const [player, setPlayer] = useState<PlayerRef | null>(null);
  const openPlayer = (next: PlayerRef): void => {
    setTeam(null);
    setPlayer(next);
  };
  // Team and member ids belong to one season: nothing chosen in another season is carried over.
  useEffect(() => {
    setTeam(null);
    setPlayer(null);
    setStatsView(STATS_VIEW);
  }, [tdid]);

  // Where a link made from this screen starts: the league and its season, or the tournament.
  const base = useMemo<WatchLink>(
    () => (now || !target ? {} : league ? { league: league.id, ...(tdid ? { season: tdid } : {}) } : { tournament: target.id }),
    [now, target, league, tdid],
  );
  const wide = useMediaQuery(SPLIT_QUERY);
  const hubShown = !now && target !== null && (target.kind === 'tournament' || bracketEvent !== null);
  // On a large screen a tournament's chosen match is shown beside the rounds, not in a sheet.
  const inlineMatch = wide && hubShown && tab === 'results';
  const titles = useRef(new Map<string, string>());
  const gameMid = link?.mid ?? null;
  const openGame = (mid: string, title?: string): void => {
    if (title) titles.current.set(mid, title);
    const next: WatchLink = { ...base, ...(link?.card ? { card: link.card, ...(link.game ? { game: link.game } : {}) } : {}), mid };
    if (gameMid) replaceWatchLink(next);
    else pushWatchLink(next);
  };
  const closeGame = (): void => closeWatchLink(link?.card ? { ...base, card: link.card, ...(link.game ? { game: link.game } : {}) } : Object.keys(base).length ? base : null);

  const setTab = (next: WatchTab): void => {
    // The chosen match belongs to the tab it was opened on.
    if (gameMid && inlineMatch) replaceWatchLink(base);
    setTabState(next);
  };
  const pick = (next: WatchSettings): void => {
    if (link) replaceWatchLink(null);
    store.updateSettings({ watch: next });
    setPicking(false);
    setNow(false);
  };
  const changeSeason = (next: string): void => {
    if (link) replaceWatchLink(league ? { league: league.id, season: next } : null);
    setTournamentId(next);
  };
  const sheet = gameMid && !inlineMatch ? <MatchSheet key={gameMid} mid={gameMid} title={titles.current.get(gameMid)} factory={factory} onClose={closeGame} /> : null;
  const pickerSheet = picking ? (
    <Sheet title="見るリーグ・大会" onClose={() => setPicking(false)}>
      <LeaguePicker
        onPick={pick}
        current={target?.id}
        onMatch={(mid) => {
          setPicking(false);
          openGame(mid);
        }}
        onNow={() => {
          setPicking(false);
          setNow(true);
        }}
      />
    </Sheet>
  ) : null;

  if (!target || now) {
    return (
      <div className="watch" data-testid="watch-page">
        {target ? (
          <button type="button" className="btn ghost small" onClick={() => setNow(false)}>
            <Icon name="chevronLeft" size={16} /> {target.title} に戻る
          </button>
        ) : null}
        {now ? (
          <NowView factory={factory} onCompetition={(id, title) => pick({ kind: 'tournament', id, title })} onGame={openGame} />
        ) : (
          <Card kicker="WATCH" title="見るリーグ・大会を選んでください">
            <LeaguePicker onPick={pick} onMatch={(mid) => openGame(mid)} onNow={() => setNow(true)} />
          </Card>
        )}
        {sheet}
      </div>
    );
  }

  const seasonTitles = seasons.kind === 'ready' ? shortTitles(seasons.value.map((entry) => entry.title)) : null;
  const chosenSeason = seasons.kind === 'ready' ? (seasons.value.find((entry) => entry.tournamentId === tdid) ?? null) : null;
  const bar = (
    <div className={`watch-bar${league ? ' has-season' : ''}`}>
      <button type="button" className="btn small watch-target" onClick={() => setPicking(true)} aria-label={`見るものを変更 (現在 ${target.title})`}>
        <span className="watch-target-name">{target.title}</span> <Icon name="chevronDown" size={14} />
      </button>
      {league ? (
        // The closed selector shows a short name (the part that tells the seasons apart); the
        // list it opens keeps every full title.
        <label className="season-pick">
          <span className="season-pick-label" aria-hidden="true" data-testid="season-label">
            {chosenSeason ? `${seasonTitles?.get(chosenSeason.title) ?? chosenSeason.title}${chosenSeason.status === 30 ? ' (開催中)' : ''}` : seasons.kind === 'error' ? '取得エラー' : seasons.kind === 'ready' ? (tdid ?? '—') : '読み込み中…'}
          </span>
          <Icon name="chevronDown" size={14} />
          <select aria-label="シーズン" value={tdid ?? ''} onChange={(event) => changeSeason(event.target.value)} disabled={seasons.kind !== 'ready'}>
            {seasons.kind === 'ready' ? (
              <>
                {tdid && !chosenSeason ? <option value={tdid}>{tdid}</option> : null}
                {seasons.value.map((entry) => (
                  <option key={entry.tournamentId} value={entry.tournamentId}>
                    {entry.title}
                    {entry.status === 30 ? ' (開催中)' : ''}
                  </option>
                ))}
              </>
            ) : (
              <option value="">{seasons.kind === 'error' ? '取得エラー' : '読み込み中…'}</option>
            )}
          </select>
        </label>
      ) : null}
      <button type="button" className="btn small icon watch-refresh" onClick={() => setRefresh((n) => n + 1)} aria-label="最新の情報を取得">
        <Icon name="refresh" size={16} />
      </button>
    </div>
  );
  const tabs = (
    <div className="segmented" role="tablist" aria-label="表示" onKeyDown={onTabListKeyDown}>
      {TABS.map(([key, label]) => (
        <button
          key={key}
          type="button"
          role="tab"
          id={`watch-tab-${key}`}
          aria-controls="watch-panel"
          aria-selected={tab === key}
          aria-pressed={tab === key}
          tabIndex={tab === key ? 0 : -1}
          onClick={() => setTab(key)}
        >
          {key === 'results' && (!league || bracketEvent) ? '試合' : label}
        </button>
      ))}
    </div>
  );
  const panel = { role: 'tabpanel', id: 'watch-panel', 'aria-labelledby': `watch-tab-${tab}`, className: 'watch-panel' } as const;

  if (target.kind === 'tournament') {
    return (
      <div className="watch" data-testid="watch-page">
        {bar}
        {tabs}
        <div {...panel}>
          <TournamentHub
            key={`${target.id}:${refresh}`}
            api={api}
            factory={factory}
            tdid={target.id}
            tab={tab}
            onGame={openGame}
            selectedMid={inlineMatch ? gameMid : null}
            inline={inlineMatch}
            onCloseMatch={closeGame}
            link={{ tournament: target.id }}
            onTitle={(title) => setHubTitle((held) => (held?.id === target.id && held.title === title ? held : { id: target.id, title }))}
          />
        </div>
        <button type="button" className="btn ghost small" onClick={() => setNow(true)}>
          いま n01 で進行中の試合を見る
        </button>
        {sheet}
        {pickerSheet}
      </div>
    );
  }

  return (
    <div className="watch" data-testid="watch-page">
      {bar}
      {tabs}
      <div {...panel}>
        {seasons.kind === 'error' ? <Retry message={seasons.message} onRetry={() => setRefresh((n) => n + 1)} /> : null}
        {data.kind === 'loading' && seasons.kind !== 'error' ? (
          <p className="muted small-text" role="status">
            <span className="spinner" aria-hidden="true" /> n01 から読み込み中…
          </p>
        ) : null}
        {data.kind === 'error' ? <Retry message={data.message} onRetry={() => setRefresh((n) => n + 1)} /> : null}
        {bracketEvent ? (
          <TournamentHub
            key={`${bracketEvent.tournamentId}:${refresh}`}
            api={api}
            factory={factory}
            tdid={bracketEvent.tournamentId}
            tab={tab}
            onGame={openGame}
            selectedMid={inlineMatch ? gameMid : null}
            inline={inlineMatch}
            onCloseMatch={closeGame}
            link={base}
          />
        ) : data.kind === 'ready' ? (
          <>
            {tab !== 'live' ? (
              <p className="muted small-text matches-meta">
                n01 公式データ ・ 取得 {formatClock(data.fetchedAt)}
                {registered.length ? ` ・ 登録チーム ${registered.map((id) => data.value.season.teams.get(id)).join('・')}` : ''}
              </p>
            ) : null}
            <ListCoverage state={{ truncated: data.value.truncated, unreadable: data.value.unreadableGames, unsure: data.value.unsureGames }} kind="season" />
            {tab === 'live' ? <LiveTab data={data.value} registered={registered} api={api} factory={factory} onPlayer={openPlayer} /> : null}
            {tab === 'results' ? <ResultsTab data={data.value} registered={registered} api={api} onTeam={setTeam} link={link} base={base} /> : null}
            {tab === 'standings' ? <StandingsTab data={data.value} registered={registered} onTeam={setTeam} /> : null}
            {tab === 'stats' ? <StatsTab data={data.value} registered={registered} api={api} onTeam={setTeam} onPlayer={openPlayer} view={statsView} onView={setStatsView} /> : null}
            {team ? <TeamSheet teamId={team} data={data.value} registered={registered} factory={factory} onClose={() => setTeam(null)} onPlayer={openPlayer} /> : null}
            {player ? (
              <PlayerCard
                key={player.oid}
                oid={player.oid}
                name={player.name}
                teamId={player.teamId}
                data={data.value}
                api={api}
                orderTeamName={player.teamId && teamMap.has(player.teamId) && onNavigate ? (data.value.season.teams.get(player.teamId) ?? null) : null}
                onOrder={() => {
                  const own = player.teamId ? teamMap.get(player.teamId) : undefined;
                  if (!own || !onNavigate) return;
                  if (store.activeTeamId !== own) store.setActiveTeam(own);
                  onNavigate('setup');
                }}
                onTeam={(id) => {
                  setPlayer(null);
                  setTeam(id);
                }}
                onClose={() => setPlayer(null)}
              />
            ) : null}
          </>
        ) : null}
      </div>
      <button type="button" className="btn ghost small" onClick={() => setNow(true)}>
        いま n01 で進行中の試合を見る (大会・個別の試合)
      </button>
      {sheet}
      {pickerSheet}
    </div>
  );
}

function MovementCells({ move }: { move: { change: number; behind: number } | undefined }): React.JSX.Element {
  if (!move) {
    return (
      <>
        <td className="own-calc">—</td>
        <td className="own-calc">—</td>
      </>
    );
  }
  return (
    <>
      <td className="own-calc">{move.behind === 0 ? '—' : move.behind}</td>
      <td className={`own-calc ${move.change > 0 ? 'move up' : move.change < 0 ? 'move down' : 'move'}`}>
        <span aria-hidden="true">{move.change > 0 ? `▲${move.change}` : move.change < 0 ? `▼${-move.change}` : '−'}</span>
        <span className="sr-only">{move.change > 0 ? `${move.change} 上昇` : move.change < 0 ? `${-move.change} 下降` : '変わらず'}</span>
      </td>
    </>
  );
}

function Retry({ message, onRetry }: { message: string; onRetry: () => void }): React.JSX.Element {
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

// ---------------------------------------------------------------------------
// 順位: n01's official table per division, and the round robin (星取表)
// ---------------------------------------------------------------------------

type StandingsGroup = NonNullable<SeasonData['standings']>[number];

function StandingsTab({ data, registered, onTeam }: { data: SeasonData; registered: string[]; onTeam: (teamId: string) => void }): React.JSX.Element {
  // A large screen: every division's summary on the left, the chosen division's official table
  // and round robin beside it. A phone keeps the divisions one under another.
  const wide = useMediaQuery(SPLIT_QUERY);
  const narrow = useMediaQuery('(max-width: 520px)');
  const groups = data.standings ?? [];
  const own = groups.find((group) => group.rows.some((row) => registered.includes(row.teamId)));
  const [chosen, setChosen] = useState<number | null>(null);
  const shown = groups.find((group) => group.divisionIndex === chosen) ?? own ?? groups[0] ?? null;
  if (!data.standings) return <p className="small-text">順位表の取得エラー: {data.standingsError ?? '不明'}</p>;
  if (wide && groups.length > 1 && shown) {
    return (
      <div className="standings-tab standings-split" data-testid="standings-tab">
        <nav className="standings-summary" aria-label="ディビジョンの要約">
          {groups.map((group) => (
            <button key={group.divisionIndex} type="button" className="division-summary" aria-pressed={group.divisionIndex === shown.divisionIndex} onClick={() => setChosen(group.divisionIndex)} data-testid="division-summary">
              <span className="division-summary-title">{group.title}</span>
              <span className="division-summary-rows">
                {group.rows.map((row) => (
                  <span key={row.teamId} className={`division-summary-row${registered.includes(row.teamId) ? ' own' : ''}`}>
                    <span className="r">{row.rank > 0 ? row.rank : '—'}</span>
                    <span className="n">{row.name}</span>
                    <span className="p">{row.points}</span>
                  </span>
                ))}
              </span>
              <span className="sr-only">{group.divisionIndex === shown.divisionIndex ? '表示中' : 'この組の順位表を表示'}</span>
            </button>
          ))}
          <p className="muted small-text">順位・勝ち点は n01 公式。組を選ぶと右に順位表と星取表を表示します。</p>
        </nav>
        <DivisionStandings key={shown.divisionIndex} group={shown} data={data} registered={registered} onTeam={onTeam} narrow={false} openGrid />
      </div>
    );
  }
  return (
    <div className="standings-tab" data-testid="standings-tab">
      {groups.map((group) => (
        <DivisionStandings key={group.divisionIndex} group={group} data={data} registered={registered} onTeam={onTeam} narrow={narrow} />
      ))}
    </div>
  );
}

/**
 * One division: n01's official table with League Order's two own columns (首位差・前節比) under
 * their own heading, and the round robin. On a narrow phone 試合・勝・分・負 share one column, so
 * rank, team, points and the movement are all on the first screen without scrolling sideways.
 */
function DivisionStandings({
  group,
  data,
  registered,
  onTeam,
  narrow,
  openGrid = false,
}: {
  group: StandingsGroup;
  data: SeasonData;
  registered: string[];
  onTeam: (teamId: string) => void;
  narrow: boolean;
  openGrid?: boolean;
}): React.JSX.Element {
  const cards = data.cards.filter((card) => card.divisionIndex === group.divisionIndex);
  const check = checkReproduction(data.season.pointRule, group, cards);
  const movement = check.ok ? roundMovement(data.season.pointRule, group, cards) : null;
  const teams = group.rows.map((row) => row.teamId);
  const cell = (a: string, b: string): string => {
    const scores = cards
      .filter((card) => card.official && card.teams.some((t) => t.id === a) && card.teams.some((t) => t.id === b))
      .map((card) => (card.teams[0].id === a ? `${card.official![0]}-${card.official![1]}` : `${card.official![1]}-${card.official![0]}`));
    return scores.join(' ');
  };
  const officialColumns = narrow ? 4 : 7;
  return (
    <Card kicker="STANDINGS" title={group.title} className="division-card">
      <div className="table-scroll">
        <table className={`standings small-text${narrow ? ' is-narrow' : ''}`} data-testid="standings-table">
          <thead>
            <tr className="source-row">
              <th scope="colgroup" colSpan={officialColumns} className="source official">
                n01 公式
              </th>
              {movement ? (
                <th scope="colgroup" colSpan={2} className="source own-calc" data-testid="own-columns">
                  League Order 計算
                </th>
              ) : null}
            </tr>
            <tr>
              <th scope="col">順位</th>
              <th scope="col">チーム</th>
              {narrow ? (
                <th scope="col">
                  試合
                  <span className="th-sub">勝-分-負</span>
                </th>
              ) : (
                <>
                  <th scope="col">試合</th>
                  <th scope="col">勝</th>
                  <th scope="col">分</th>
                  <th scope="col">負</th>
                </>
              )}
              <th scope="col">勝ち点</th>
              {movement ? (
                <>
                  <th scope="col" className="own-calc">
                    首位差
                  </th>
                  <th scope="col" className="own-calc">
                    前節比
                  </th>
                </>
              ) : null}
            </tr>
          </thead>
          <tbody>
            {group.rows.map((row) => (
              <tr key={row.teamId} className={registered.includes(row.teamId) ? 'own' : ''}>
                <td>{row.rank > 0 ? row.rank : '—'}</td>
                <th scope="row">
                  <button type="button" className="linklike" onClick={() => onTeam(row.teamId)}>
                    {row.name}
                  </button>
                </th>
                {narrow ? (
                  <td>
                    {row.played}
                    <span className="td-sub" aria-label={`${row.won} 勝 ${row.drawn} 分 ${row.lost} 敗`}>
                      {row.won}-{row.drawn}-{row.lost}
                    </span>
                  </td>
                ) : (
                  <>
                    <td>{row.played}</td>
                    <td>{row.won}</td>
                    <td>{row.drawn}</td>
                    <td>{row.lost}</td>
                  </>
                )}
                <td className="points">{row.points}</td>
                {movement ? <MovementCells move={movement.rows.get(row.teamId)} /> : null}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <details className="small-text round-robin" open={openGrid}>
        <summary>星取表 (獲得ゲーム数 ・ n01 公式結果)</summary>
        <div className="table-scroll">
          <table className="grid-table" data-testid="round-robin">
            <thead>
              <tr>
                <th scope="col" />
                {teams.map((id) => (
                  <th key={id} scope="col" title={data.season.teams.get(id) ?? id}>
                    {(data.season.teams.get(id) ?? id).slice(0, 6)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {teams.map((a) => (
                <tr key={a} className={registered.includes(a) ? 'own' : ''}>
                  <th scope="row">{data.season.teams.get(a) ?? a}</th>
                  {teams.map((b) => (
                    <td key={b} className={a === b ? 'self' : ''}>
                      {a === b ? '' : cell(a, b)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
      <p className="muted small-text">{check.ok ? '勝ち点の計算規則を確認済み: 試合中は「このまま終わった場合の順位」を表示します。' : `順位予測なし: ${check.reason}`}</p>
      {movement ? (
        <p className="muted small-text">
          首位差・前節比: League Order が公式勝ち点の式で計算。前節比は {movement.round} の結果を除いた順位との比較で、勝ち点だけで並べた順位 (同点は同順位) です。
        </p>
      ) : null}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// スタッツ: n01's own player figures, ranked
// ---------------------------------------------------------------------------

type SortKey = 'avg' | 'f9' | 'legRate' | 'ton80' | 'ton40' | 'highOut' | 'bestLeg' | 'break';

const SORTS: [SortKey, string][] = [
  ['avg', '平均'],
  ['f9', 'First 9'],
  ['legRate', 'Leg率'],
  ['ton80', '180'],
  ['ton40', '140+'],
  ['highOut', 'High Out'],
  ['bestLeg', 'Best Leg'],
  ['break', 'Break'],
];

function value(line: PlayerLine['line'], key: SortKey): number | null {
  const ratio = (n: number | null, d: number | null, scale = 1): number | null => (n !== null && d ? (n / d) * scale : null);
  switch (key) {
    case 'avg':
      return ratio(line.score, line.darts, 3);
    case 'f9':
      return ratio(line.f9Score, line.f9Darts, 3);
    case 'legRate':
      return ratio(line.winLeg, line.leg, 100);
    case 'ton80':
      return line.ton80;
    case 'ton40':
      return line.ton40;
    case 'highOut':
      return line.highOut;
    case 'bestLeg':
      return line.bestLeg;
    case 'break':
      return ratio(line.breakWins, line.breakLegs, 100);
  }
}

export function StatsTab({
  data,
  registered,
  api,
  onTeam,
  onPlayer,
  view,
  onView,
}: {
  data: SeasonData;
  registered: string[];
  api: MatchesApi;
  onTeam: (teamId: string) => void;
  onPlayer: (player: PlayerRef) => void;
  /** The search and filters, owned by the page so they survive a visit to another tab. */
  view?: StatsView;
  onView?: (next: StatsView) => void;
}): React.JSX.Element {
  const source = useMemo(() => seasonStatsSource(data.season), [data.season]);
  const stats = usePlayerStats(api, data.season.tournamentId, true, source);
  const [local, setLocal] = useState<StatsView>(STATS_VIEW);
  const current = view ?? local;
  const change = (patch: Partial<StatsView>): void => (onView ?? setLocal)({ ...current, ...patch });
  const { sort, division, qualified, query } = current;
  const setSort = (next: SortKey): void => change({ sort: next });
  const setDivision = (next: number | 'all'): void => change({ division: next });
  const setQualified = (next: boolean): void => change({ qualified: next });
  const setQuery = (next: string): void => change({ query: next });
  const [shown, setShown] = useShownCount(`${sort}|${division}|${qualified}|${query}`);
  if (stats.kind === 'loading') return <p className="muted small-text">選手成績を読み込み中…</p>;
  if (stats.kind === 'error') return <p className="small-text" role="alert">取得エラー: {stats.message}</p>;
  const maxLegs = Math.max(0, ...stats.value.map((row) => row.line.leg ?? 0));
  const minLegs = Math.ceil(maxLegs * 0.3);
  // Rank under the filters and the sort first, then search: a searched player keeps their real place.
  const sorted = stats.value
    .filter((row) => division === 'all' || row.divisionIndex === division || data.season.divisions[division as number]?.teamIds.includes(row.teamId ?? ''))
    .filter((row) => !qualified || (row.line.leg ?? 0) >= minLegs)
    .map((row) => ({ row, v: value(row.line, sort) }))
    .filter((entry) => entry.v !== null && (sort !== 'bestLeg' || (entry.v ?? 0) > 0))
    .sort((a, b) => (sort === 'bestLeg' ? a.v! - b.v! : b.v! - a.v!));
  const matched = rankThenSearch(sorted, query, (entry) => entry.row.name);
  const empty = stats.value.length === 0;
  return (
    <div className="stats-tab" data-testid="stats-tab">
      <RankingSearch value={query} onChange={setQuery} label={stats.unit === 'entry' ? '名前で検索' : '選手名で検索'} />
      <div className="chip-row" role="radiogroup" aria-label="並べ替え">
        {SORTS.map(([key, label]) => (
          <button key={key} type="button" className="chip" role="radio" aria-checked={sort === key} onClick={() => setSort(key)}>
            {label}
          </button>
        ))}
      </div>
      <div className="row wrap" style={{ gap: 8 }}>
        <select aria-label="ディビジョン" value={String(division)} onChange={(event) => setDivision(event.target.value === 'all' ? 'all' : Number(event.target.value))}>
          <option value="all">全ディビジョン</option>
          {data.season.divisions.map((entry) => (
            <option key={entry.index} value={entry.index}>
              {entry.title}
            </option>
          ))}
        </select>
        <label className="small-text">
          <input type="checkbox" checked={qualified} onChange={(event) => setQualified(event.target.checked)} /> 規定 Leg 数以上 ({minLegs} Leg)
        </label>
      </div>
      {empty ? <p className="small-text muted">このシーズンの選手別成績はまだありません。</p> : null}
      {matched.length > 0 ? (
        <div className="table-scroll">
          <table className="rank-table small-text">
            <thead>
              <tr>
                <th scope="col" className="rank-head" data-testid="rank-head">
                  {SORTS.find(([key]) => key === sort)![1]}
                  <span className="th-sub">順位</span>
                </th>
                <th scope="col">{stats.unit === 'entry' ? 'エントリー' : '選手'}</th>
                <th scope="col">{SORTS.find(([key]) => key === sort)![1]}</th>
                <th scope="col">平均</th>
                <th scope="col">Leg</th>
              </tr>
            </thead>
            <tbody>
              {matched.slice(0, shown).map(({ rank, item: { row, v } }) => (
                <tr key={row.oid} className={row.teamId && registered.includes(row.teamId) ? 'own' : ''}>
                  <td>{rank}</td>
                  <th scope="row">
                    {stats.unit === 'entry' ? (
                      // An individual season: the row is an entry — its sheet is the entry's results.
                      <button type="button" className="linklike" onClick={() => onTeam(row.oid)}>
                        {row.name}
                      </button>
                    ) : (
                      <>
                        <button type="button" className="linklike" onClick={() => onPlayer({ oid: row.oid, name: row.name, teamId: row.teamId })}>
                          {row.name}
                        </button>
                        {row.teamId ? (
                          <button type="button" className="linklike muted" onClick={() => onTeam(row.teamId!)}>
                            {data.season.teams.get(row.teamId) ?? ''}
                          </button>
                        ) : null}
                      </>
                    )}
                  </th>
                  <td className="num">{sort === 'legRate' || sort === 'break' ? `${v!.toFixed(1)}%` : sort === 'avg' || sort === 'f9' ? v!.toFixed(2) : v}</td>
                  <td className="num">{formatRate(value(row.line, 'avg'))}</td>
                  <td className="num">
                    {row.line.winLeg ?? '—'}/{row.line.leg ?? '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      {!empty ? <RankingFooter shown={shown} matched={matched.length} total={sorted.length} query={query} onMore={setShown} noun={stats.unit === 'entry' ? 'エントリー' : '選手'} /> : null}
      <p className="muted small-text">
        n01 公式のシーズン集計 (tournament/stats)。左端は選んだ指標 ({SORTS.find(([key]) => key === sort)![1]}) で並べた順位です (リーグの公式順位とは別)。Break は後攻 Leg の取得率。
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Team sheet: members' form, results, strong kinds
// ---------------------------------------------------------------------------

const STRUCTURE_LABEL: Record<string, string> = { SINGLES: 'Singles', DOUBLES: 'Doubles', TRIOS: 'Trios', GALLON: 'Gallon', TEAM: 'Team', UNKNOWN: '不明' };

function TeamSheet({
  teamId,
  data,
  registered,
  onClose,
  onPlayer,
}: {
  teamId: string;
  data: SeasonData;
  registered: string[];
  factory: MatchesApiFactory;
  onClose: () => void;
  onPlayer: (player: PlayerRef) => void;
}): React.JSX.Element {
  const profile = teamProfile(data.season, data.cards, data.games, teamId);
  const forms = playerForms(data.season, data.games, teamId);
  const cards = data.cards.filter((card) => card.teams.some((t) => t.id === teamId));
  return (
    <Sheet title={profile.name} onClose={onClose}>
      <div className="team-sheet" data-testid="team-sheet">
        <p className="sheet-season" data-testid="team-sheet-season">
          <span className="kicker">対象シーズン</span>
          <strong>{data.season.title}</strong>
          <span className="tag">{data.season.status === 30 ? '開催中' : data.season.status === 40 ? '終了' : 'シーズン'}</span>
        </p>
        <p className="small-text">
          {registered.includes(teamId) ? '登録チーム ・ ' : ''}
          {profile.cards.w}勝 {profile.cards.d}分 {profile.cards.l}敗 (公式) ・{' '}
          {Object.entries(profile.byStructure)
            .map(([kind, record]) => `${STRUCTURE_LABEL[kind] ?? kind} ${percent(record)}`)
            .join(' ・ ')}
        </p>
        <h3 className="section-mini">対戦</h3>
        <ul className="plain small-text">
          {cards.map((card) => {
            const side = card.teams[0].id === teamId ? 0 : 1;
            const other = card.teams[1 - side];
            return (
              <li key={card.key}>
                {card.title}: vs {other.name} {card.official ? `${card.official[side]}-${card.official[1 - side]}` : card.state === 'scheduled' ? '未開催' : '集計中'}
              </li>
            );
          })}
        </ul>
        <h3 className="section-mini">メンバー ({data.season.title} の試合から)</h3>
        <div className="table-scroll">
          <table className="players-form small-text" data-testid="player-forms">
            <thead>
              <tr>
                <th scope="col">選手</th>
                <th scope="col">Singles 01 平均 (このシーズン通算 / 直近3)</th>
                <th scope="col">種別別 勝率</th>
              </tr>
            </thead>
            <tbody>
              {forms.map((form) => (
                <tr key={form.oid}>
                  <th scope="row">
                    <button type="button" className="linklike" onClick={() => onPlayer({ oid: form.oid, name: form.name, teamId })}>
                      {form.name}
                    </button>
                  </th>
                  <td>
                    {formatRate(form.singles01.season)} / {formatRate(form.singles01.recent)} <span className="muted">({form.singles01.games})</span>
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
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="muted small-text">League Order が {data.season.title} の試合記録から集計 (5 試合未満は参考値)。選手はこのシーズンのメンバー ID で区別し、名前だけで統合しません。</p>
        <UsageTable teamId={teamId} data={data} onPlayer={onPlayer} />
      </div>
    </Sheet>
  );
}

function UsageTable({ teamId, data, onPlayer }: { teamId: string; data: SeasonData; onPlayer: (player: PlayerRef) => void }): React.JSX.Element | null {
  const usage = useMemo(() => slotUsage(data.season, data.games, teamId), [data, teamId]);
  if (usage.cards === 0 || usage.rows.length === 0) return null;
  return (
    <section className="usage" aria-label="起用傾向" data-testid="slot-usage">
      <h3 className="section-mini">
        起用傾向 ({data.season.title} ・ {usage.cards} 試合)
      </h3>
      <div className="table-scroll">
        <table className="usage-table small-text">
          <caption className="sr-only">選手ごとに、各ゲームに出場した試合 (対戦カード) の数</caption>
          <thead>
            <tr>
              <th scope="col">選手</th>
              {usage.slots.map((slot) => (
                <th key={slot.schid} scope="col" title={slot.label}>
                  {shortSlot(slot.label)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {usage.rows.map((row) => (
              <tr key={row.oid}>
                <th scope="row">
                  <button type="button" className="linklike" onClick={() => onPlayer({ oid: row.oid, name: row.name, teamId })}>
                    {row.name}
                  </button>
                </th>
                {row.counts.map((count, i) => {
                  const share = count / usage.cards;
                  return (
                    <td
                      key={usage.slots[i].schid}
                      className={share >= 0.6 ? 'strong' : undefined}
                      style={count ? { background: `color-mix(in srgb, var(--color-accent) ${Math.round(share * 55)}%, var(--color-surface-1))` } : undefined}
                    >
                      {count || <span className="muted">·</span>}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="muted small-text">n01 の試合記録 (実際に出場した選手) から League Order が集計。提出オーダーではありません。色が濃いほど、その枠に出る回数が多い選手です。</p>
    </section>
  );
}
