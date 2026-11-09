import { useEffect, useMemo, useState } from 'react';
import { Card, Sheet } from '../../../components/ui';
import { Icon } from '../../../components/icons';
import { useAppStore } from '../../../state/appStore';
import type { WatchSettings } from '../../../domain/types';
import type { Page } from '../../../navigation';
import type { MatchesApi } from '../api';
import { checkReproduction, roundMovement } from '../standings';
import { percent, playerForms, teamProfile } from '../insights';
import { useMatchesApiFactory } from '../environment';
import type { MatchesApiFactory } from '../environment';
import type { PlayerLine, SeasonData } from './useMatchContext';
import { formatClock, formatRate, usePlayerStats, useRegisteredTeamMap, useSeasonData, useSeasons } from './useMatchContext';
import { LeaguePicker } from './LeaguePicker';
import { LiveTab } from './LiveTab';
import { ResultsTab } from './ResultsTab';
import { MatchSheet } from './MatchSheet';
import { NowView, TournamentHub } from './CompetitionViews';
import { PlayerCard } from './PlayerCard';

/**
 * 観戦 (WATCH): one page for any n01 league, with or without a team. Four tabs —
 * ライブ / 日程・結果 / 順位 / スタッツ — over one season's data, read once per visit.
 * Registered teams (登録チーム) are highlighted, sorted first and one chip away.
 */

export type WatchTab = 'live' | 'results' | 'standings' | 'stats';

interface PlayerRef {
  oid: string;
  name: string;
  teamId: string | null;
}

const TABS: [WatchTab, string][] = [
  ['live', 'ライブ'],
  ['results', '日程・結果'],
  ['standings', '順位'],
  ['stats', 'スタッツ'],
];

export default function WatchPage({ initialTab, onNavigate }: { initialTab: WatchTab; onNavigate?: (page: Page) => void }): React.JSX.Element {
  const store = useAppStore();
  const factory = useMatchesApiFactory();
  // What to watch: the last choice, else the active team's league.
  const fallback: WatchSettings | null = store.activeTeam?.n01 ? { kind: 'league', id: store.activeTeam.n01.leagueId, title: store.activeTeam.n01.leagueTitle } : null;
  const target = store.settings.watch ?? fallback;
  const league = target?.kind === 'league' ? target : null;
  const [refresh, setRefresh] = useState(0);
  const api = useMemo(() => factory(), [factory, refresh]);
  const seasons = useSeasons(league ? api : null, league?.id ?? null);
  const [tournamentId, setTournamentId] = useState<string | null>(null);
  useEffect(() => {
    setTournamentId(null);
  }, [target?.id]);
  const current = seasons.kind === 'ready' ? (seasons.value.find((entry) => entry.status === 30) ?? seasons.value[0])?.tournamentId ?? null : null;
  const tdid = league ? (tournamentId ?? current) : null;
  const data = useSeasonData(tdid ? api : null, tdid);
  const [tab, setTab] = useState<WatchTab>(initialTab);
  const [picking, setPicking] = useState(false);
  const [now, setNow] = useState(false);
  const [game, setGame] = useState<{ mid: string; title?: string } | null>(null);
  const [team, setTeam] = useState<string | null>(null);
  const season = data.kind === 'ready' ? data.value.season : null;
  const teamMap = useRegisteredTeamMap(season);
  const registered = useMemo(() => [...teamMap.keys()], [teamMap]);
  const [player, setPlayer] = useState<PlayerRef | null>(null);
  const openPlayer = (next: PlayerRef): void => {
    setTeam(null);
    setPlayer(next);
  };

  const pick = (next: WatchSettings): void => {
    store.updateSettings({ watch: next });
    setPicking(false);
    setNow(false);
  };
  const sheet = game ? <MatchSheet mid={game.mid} title={game.title} factory={factory} onClose={() => setGame(null)} /> : null;
  const pickerSheet = picking ? (
    <Sheet title="見るリーグ・大会" onClose={() => setPicking(false)}>
      <LeaguePicker
        onPick={pick}
        current={target?.id}
        onMatch={(mid) => {
          setPicking(false);
          setGame({ mid });
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
          <NowView
            factory={factory}
            onCompetition={(id, title) => pick({ kind: 'tournament', id, title })}
            onGame={(mid, title) => setGame({ mid, title })}
          />
        ) : (
          <Card kicker="WATCH" title="見るリーグ・大会を選んでください">
            <LeaguePicker onPick={pick} onMatch={(mid) => setGame({ mid })} onNow={() => setNow(true)} />
          </Card>
        )}
        {sheet}
      </div>
    );
  }

  const bar = (
    <div className="watch-bar">
      <button type="button" className="btn small" onClick={() => setPicking(true)} aria-label={`見るものを変更 (現在 ${target.title})`}>
        {target.title} <Icon name="chevronDown" size={14} />
      </button>
      {league ? (
        <select aria-label="シーズン" value={tdid ?? ''} onChange={(event) => setTournamentId(event.target.value)} disabled={seasons.kind !== 'ready'}>
          {seasons.kind === 'ready' ? (
            seasons.value.map((entry) => (
              <option key={entry.tournamentId} value={entry.tournamentId}>
                {entry.title}
                {entry.status === 30 ? ' (開催中)' : ''}
              </option>
            ))
          ) : (
            <option value="">{seasons.kind === 'error' ? '取得エラー' : '読み込み中…'}</option>
          )}
        </select>
      ) : (
        <span className="grow" />
      )}
      <button type="button" className="btn small icon" onClick={() => setRefresh((n) => n + 1)} aria-label="最新の情報を取得">
        <Icon name="refresh" size={16} />
      </button>
    </div>
  );
  const tabs = (
    <div className="segmented" role="tablist" aria-label="表示">
      {TABS.map(([key, label]) => (
        <button key={key} type="button" role="tab" aria-selected={tab === key} aria-pressed={tab === key} onClick={() => setTab(key)}>
          {key === 'results' && !league ? '試合' : label}
        </button>
      ))}
    </div>
  );

  if (target.kind === 'tournament') {
    return (
      <div className="watch" data-testid="watch-page">
        {bar}
        {tabs}
        <TournamentHub key={`${target.id}:${refresh}`} api={api} tdid={target.id} tab={tab} onGame={(mid, title) => setGame({ mid, title })} />
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
      {seasons.kind === 'error' ? <Retry message={seasons.message} onRetry={() => setRefresh((n) => n + 1)} /> : null}
      {data.kind === 'loading' && seasons.kind !== 'error' ? (
        <p className="muted small-text" role="status">
          <span className="spinner" aria-hidden="true" /> n01 から読み込み中…
        </p>
      ) : null}
      {data.kind === 'error' ? <Retry message={data.message} onRetry={() => setRefresh((n) => n + 1)} /> : null}
      {data.kind === 'ready' ? (
        <>
          <p className="muted small-text matches-meta">
            n01 公式データ ・ 取得 {formatClock(data.fetchedAt)}
            {registered.length ? ` ・ 登録チーム ${registered.map((id) => data.value.season.teams.get(id)).join('・')}` : ''}
            {data.value.unreadableGames > 0 ? ` ・ 読めなかった試合 ${data.value.unreadableGames} 件 (集計外)` : ''}
          </p>
          {tab === 'live' ? <LiveTab data={data.value} registered={registered} api={api} factory={factory} /> : null}
          {tab === 'results' ? <ResultsTab data={data.value} registered={registered} api={api} onTeam={setTeam} /> : null}
          {tab === 'standings' ? <StandingsTab data={data.value} registered={registered} onTeam={setTeam} /> : null}
          {tab === 'stats' ? <StatsTab data={data.value} registered={registered} api={api} onTeam={setTeam} onPlayer={openPlayer} /> : null}
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
        <td>—</td>
        <td>—</td>
      </>
    );
  }
  return (
    <>
      <td>{move.behind === 0 ? '—' : move.behind}</td>
      <td className={move.change > 0 ? 'move up' : move.change < 0 ? 'move down' : 'move'}>
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

function StandingsTab({ data, registered, onTeam }: { data: SeasonData; registered: string[]; onTeam: (teamId: string) => void }): React.JSX.Element {
  if (!data.standings) return <p className="small-text">順位表の取得エラー: {data.standingsError ?? '不明'}</p>;
  return (
    <div className="standings-tab" data-testid="standings-tab">
      {data.standings.map((group) => {
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
        return (
          <Card key={group.divisionIndex} kicker="OFFICIAL" title={`${group.title} (n01 公式)`}>
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
                    {movement ? (
                      <>
                        <th scope="col">首位差</th>
                        <th scope="col">前節比</th>
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
                      <td>{row.played}</td>
                      <td>{row.won}</td>
                      <td>{row.drawn}</td>
                      <td>{row.lost}</td>
                      <td>{row.points}</td>
                      {movement ? <MovementCells move={movement.rows.get(row.teamId)} /> : null}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <details className="small-text">
              <summary>星取表 (獲得ゲーム数)</summary>
              <div className="table-scroll">
                <table className="grid-table" data-testid="round-robin">
                  <thead>
                    <tr>
                      <th scope="col" />
                      {teams.map((id) => (
                        <th key={id} scope="col">
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
      })}
    </div>
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

function StatsTab({
  data,
  registered,
  api,
  onTeam,
  onPlayer,
}: {
  data: SeasonData;
  registered: string[];
  api: MatchesApi;
  onTeam: (teamId: string) => void;
  onPlayer: (player: PlayerRef) => void;
}): React.JSX.Element {
  const stats = usePlayerStats(api, data.season.tournamentId, true);
  const [sort, setSort] = useState<SortKey>('avg');
  const [division, setDivision] = useState<number | 'all'>('all');
  const [qualified, setQualified] = useState(true);
  if (stats.kind === 'loading') return <p className="muted small-text">選手成績を読み込み中…</p>;
  if (stats.kind === 'error') return <p className="small-text">取得エラー: {stats.message}</p>;
  const maxLegs = Math.max(0, ...stats.value.map((row) => row.line.leg ?? 0));
  const minLegs = Math.ceil(maxLegs * 0.3);
  const rows = stats.value
    .filter((row) => division === 'all' || row.divisionIndex === division || data.season.divisions[division as number]?.teamIds.includes(row.teamId ?? ''))
    .filter((row) => !qualified || (row.line.leg ?? 0) >= minLegs)
    .map((row) => ({ row, v: value(row.line, sort) }))
    .filter((entry) => entry.v !== null && (sort !== 'bestLeg' || (entry.v ?? 0) > 0))
    .sort((a, b) => (sort === 'bestLeg' ? a.v! - b.v! : b.v! - a.v!))
    .slice(0, 60);
  return (
    <div className="stats-tab" data-testid="stats-tab">
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
      <div className="table-scroll">
        <table className="rank-table small-text">
          <thead>
            <tr>
              <th scope="col">#</th>
              <th scope="col">選手</th>
              <th scope="col">{SORTS.find(([key]) => key === sort)![1]}</th>
              <th scope="col">平均</th>
              <th scope="col">Leg</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ row, v }, index) => (
              <tr key={row.oid} className={row.teamId && registered.includes(row.teamId) ? 'own' : ''}>
                <td>{index + 1}</td>
                <th scope="row">
                  <button type="button" className="linklike" onClick={() => onPlayer({ oid: row.oid, name: row.name, teamId: row.teamId })}>
                    {row.name}
                  </button>
                  {row.teamId ? (
                    <button type="button" className="linklike muted" onClick={() => onTeam(row.teamId!)}>
                      {data.season.teams.get(row.teamId) ?? ''}
                    </button>
                  ) : null}
                </th>
                <td className="num">{sort === 'legRate' || sort === 'break' ? `${v!.toFixed(1)}%` : sort === 'avg' || sort === 'f9' ? v!.toFixed(2) : v}</td>
                <td className="num">{formatRate(value(row.line, 'avg'))}</td>
                <td className="num">
                  {row.line.winLeg ?? 0}/{row.line.leg ?? 0}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="muted small-text">n01 公式のシーズン集計 (tournament/stats)。Break は後攻 Leg の取得率。</p>
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
        <h3 className="section-mini">メンバー (今季の試合から)</h3>
        <div className="table-scroll">
          <table className="players-form small-text" data-testid="player-forms">
            <thead>
              <tr>
                <th scope="col">選手</th>
                <th scope="col">Singles 01 平均 (今季/直近3)</th>
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
        <p className="muted small-text">League Order の集計 (5 試合未満は参考値)。選手は今季のメンバー ID で区別し、名前だけで統合しません。</p>
      </div>
    </Sheet>
  );
}
