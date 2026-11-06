import { useEffect, useMemo, useRef, useState } from 'react';
import { Card, EmptyState } from '../../../components/ui';
import { Icon } from '../../../components/icons';
import { KNOWN_LEAGUES } from '../../../integrations/n01/leagueRegistry';
import { describeN01Error } from '../../../integrations/n01/client';
import type { Page } from '../../../navigation';
import type { MatchesApi } from '../api';
import type { GameRow, LiveState, LiveThrow, SeasonDocument } from '../parse';
import { parseLeagueTmid } from '../parse';
import type { LiveStatus } from '../livePoller';
import { LivePoller, medianMs } from '../livePoller';
import { useMatchesApiFactory } from '../environment';
import type { MatchesApiFactory } from '../environment';
import { formatClock, formatRate, ownTeamIn, useOwnScope, useSeasons } from './useMatchContext';

/**
 * LIVE MATCH (ライブ観戦).
 *
 * The first screen answers, in this order: which cards are being played, which game of the
 * card is on, the score left / points and legs, who throws next. The throw history is one
 * tap away. One card is followed at a time (`match/live` by `tmid`), so a team match moves
 * on to its next game by itself.
 */

const LIST_REFRESH_MS = 20_000;

interface LiveCard {
  tmid: string;
  divisionIndex: number;
  teams: [{ id: string; name: string }, { id: string; name: string }];
  games: GameRow[];
  current: GameRow | null;
}

function groupLive(season: SeasonDocument, games: readonly GameRow[]): LiveCard[] {
  const byTmid = new Map<string, LiveCard>();
  for (const game of games) {
    const parts = parseLeagueTmid(game.tmid, season.tournamentId);
    if (!parts || !game.tmid) continue;
    const card = byTmid.get(game.tmid) ?? {
      tmid: game.tmid,
      divisionIndex: parts.divisionIndex,
      teams: [
        { id: parts.teamIds[0], name: season.teams.get(parts.teamIds[0]) ?? game.sides[0].name },
        { id: parts.teamIds[1], name: season.teams.get(parts.teamIds[1]) ?? game.sides[1].name },
      ] as LiveCard['teams'],
      games: [],
      current: null,
    };
    card.games.push(game);
    if (!game.finished) card.current = game;
    byTmid.set(game.tmid, card);
  }
  return [...byTmid.values()].filter((card) => card.current !== null);
}

export default function LivePage({ onNavigate }: { onNavigate: (page: Page) => void }): React.JSX.Element {
  const own = useOwnScope();
  const factory = useMatchesApiFactory();
  const [leagueId, setLeagueId] = useState<string | null>(own?.leagueId ?? null);
  const listApi = useMemo(() => factory({ maxRequests: 400 }), [factory]);
  const seasons = useSeasons(leagueId ? listApi : null, leagueId);
  const tournamentId = own?.leagueId === leagueId && own?.ownTournamentId ? own.ownTournamentId : seasons.kind === 'ready' ? (seasons.value.find((entry) => entry.status === 30) ?? seasons.value[0])?.tournamentId ?? null : null;
  const [season, setSeason] = useState<SeasonDocument | null>(null);
  const [cards, setCards] = useState<LiveCard[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [listedAt, setListedAt] = useState<number | null>(null);
  const [selected, setSelected] = useState<string | null>(null);

  // The list of cards being played: one `match/list?live=1` every 20 s while visible.
  useEffect(() => {
    if (!tournamentId) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const load = async (): Promise<void> => {
      if (document.visibilityState === 'hidden') {
        timer = setTimeout(() => void load(), LIST_REFRESH_MS);
        return;
      }
      try {
        const doc = await listApi.season(tournamentId);
        const rows = await listApi.seasonGames(tournamentId, { live: true });
        if (!live) return;
        setSeason(doc);
        setCards(groupLive(doc, rows.games));
        setListError(null);
        setListedAt(Date.now());
      } catch (error) {
        if (live) setListError(describeN01Error(error));
      }
      if (live) timer = setTimeout(() => void load(), LIST_REFRESH_MS);
    };
    void load();
    return () => {
      live = false;
      if (timer) clearTimeout(timer);
    };
  }, [listApi, tournamentId]);

  if (!leagueId) {
    return (
      <Card>
        <EmptyState kicker="LIVE MATCH" title="リーグを選んでください" icon="target">
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

  const ownId = season ? ownTeamIn(season, own?.leagueId === leagueId ? own : null) : null;
  const sorted = cards ? [...cards].sort((a, b) => Number(b.teams.some((t) => t.id === ownId)) - Number(a.teams.some((t) => t.id === ownId))) : null;
  const active = selected ?? (sorted && sorted.length > 0 && sorted[0].teams.some((t) => t.id === ownId) ? sorted[0].tmid : null);

  return (
    <div className="live" data-testid="live-page">
      <p className="muted small-text">
        {season?.title ?? '読み込み中…'} ・ 進行中の対戦 {cards ? `${cards.length} 件` : '—'} ・ 一覧の取得 {formatClock(listedAt)}
      </p>
      {listError ? (
        <div className="notice warn" role="status">
          <Icon name="alert" size={18} />
          <span className="grow small-text">一覧の取得エラー: {listError} (20 秒後に再試行します)</span>
        </div>
      ) : null}
      {sorted && sorted.length === 0 ? <p className="small-text">いま進行中の対戦はありません。</p> : null}
      {sorted ? (
        <ul className="live-cards">
          {sorted.map((card) => (
            <li key={card.tmid}>
              <button type="button" className="live-card-row" aria-pressed={active === card.tmid} onClick={() => setSelected(card.tmid)} data-testid="live-card">
                <span className={card.teams[0].id === ownId ? 'own' : ''}>{card.teams[0].name}</span>
                <span className="muted small-text">vs</span>
                <span className={card.teams[1].id === ownId ? 'own' : ''}>{card.teams[1].name}</span>
                <span className="tag state-live">{card.current?.title.split(' ').slice(-1)[0] ?? '進行中'}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {active ? <LiveBoard key={active} tmid={active} factory={factory} /> : null}
    </div>
  );
}

function LiveBoard({ tmid, factory }: { tmid: string; factory: MatchesApiFactory }): React.JSX.Element {
  // One API (and one request budget) per followed card.
  const api: MatchesApi = useMemo(() => factory({ maxRequests: 2400 }), [factory, tmid]);
  const [state, setState] = useState<LiveState | null>(null);
  const [status, setStatus] = useState<LiveStatus>({ kind: 'idle' });
  const [showThrows, setShowThrows] = useState(false);
  const ages = useRef<number[]>([]);
  const [lag, setLag] = useState<number | null>(null);
  const poller = useRef<LivePoller | null>(null);

  useEffect(() => {
    const instance = new LivePoller(api, { tmid }, {
      onState: setState,
      onStatus: setStatus,
      onSample: (sample) => {
        ages.current = [...ages.current.slice(-19), sample.ageMs];
        setLag(medianMs(ages.current));
      },
    });
    poller.current = instance;
    const onVisibility = (): void => instance.setHidden(document.visibilityState === 'hidden');
    document.addEventListener('visibilitychange', onVisibility);
    instance.setHidden(document.visibilityState === 'hidden');
    instance.start();
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      instance.stop();
    };
  }, [api, tmid]);

  if (!state) {
    return (
      <p className="muted small-text" role="status">
        {status.kind === 'retrying' ? `取得エラー: ${status.message} (${Math.round(status.retryInMs / 1000)} 秒後に再試行)` : 'ライブデータを取得中…'}
      </p>
    );
  }
  const cricket = state.matchType === 'cricket';
  const leg = state.leg;
  return (
    <section className="live-board" aria-label="ライブスコア" data-testid="live-board">
      {state.isSchedule ? (
        <div className="live-card-score">
          <span>{state.sides[0].name}</span>
          <strong aria-label={`対戦の獲得ゲーム ${state.sets[0]} 対 ${state.sets[1]}`}>
            {state.sets[0]} - {state.sets[1]}
          </strong>
          <span>{state.sides[1].name}</span>
          <span className="muted small-text">対戦全体 (獲得ゲーム){state.cardEnded ? ' ・ 対戦終了' : ''}</span>
        </div>
      ) : null}
      <div className="live-game-head">
        <strong>{state.title.split(' ').slice(-1)[0] || 'ゲーム'}</strong>
        <span className="muted small-text">
          {cricket ? 'Cricket' : `${state.startScore ?? ''} 01`} ・ Leg {(state.currentLeg ?? 0) + 1}
          {state.limitLeg ? ` (${state.limitLeg} Leg 先取)` : ''}
          {state.showSets && !state.isSchedule ? ` ・ Set ${(state.currentSet ?? 0) + 1}` : ''}
          {state.gameEnded ? ' ・ このゲームは終了' : ''}
        </span>
      </div>
      <div className="live-sides">
        {([0, 1] as const).map((side) => {
          const throwing = leg && !leg.ended && leg.thrower === side;
          return (
            <div key={side} className={`live-side${throwing ? ' throwing' : ''}${leg?.ended && leg.winner === side ? ' won' : ''}`}>
              <span className="live-name">{state.sides[side].members.join(' / ') || state.sides[side].name}</span>
              <span className="live-main" aria-label={cricket ? '点数' : '残り点数'}>
                {cricket ? (leg?.points?.[side] ?? '—') : (leg?.left?.[side] ?? '—')}
              </span>
              <span className="muted small-text">
                Leg {state.legs[side]} ・ {cricket ? 'MPR' : '平均'} {formatRate(state.sides[side].rate)}
              </span>
              {throwing ? (
                <span className="tag state-live" data-testid="next-thrower">
                  次: {leg?.member ?? state.sides[side].name}
                </span>
              ) : null}
            </div>
          );
        })}
      </div>
      {cricket && leg?.marks && leg.numbers ? (
        <div className="table-scroll">
          <table className="cricket-marks small-text" aria-label="クリケットのマーク">
            <tbody>
              {leg.numbers.map((number, index) => (
                <tr key={number}>
                  <td>{markText(leg.marks![0][index])}</td>
                  <th scope="row">{number === 25 ? 'BULL' : number}</th>
                  <td>{markText(leg.marks![1][index])}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      <LiveStatusLine status={status} lag={lag} updateTime={state.updateTime} />
      <button type="button" className="btn ghost small" aria-expanded={showThrows} onClick={() => setShowThrows(!showThrows)}>
        {showThrows ? 'スロー履歴を閉じる' : 'スロー履歴 (このLeg)'}
      </button>
      {showThrows && leg ? (
        <ol className="throws small-text" reversed>
          {[...leg.throws].reverse().slice(0, 12).map((entry, index) => (
            <li key={`${entry.side}-${entry.round}-${index}`}>{throwText(entry, state.sides)}</li>
          ))}
        </ol>
      ) : null}
      {status.kind === 'budget' ? (
        <button type="button" className="btn small" onClick={() => poller.current?.resume()}>
          更新を続ける
        </button>
      ) : null}
    </section>
  );
}

function formatSeconds(ms: number): string {
  const date = new Date(ms);
  return [date.getHours(), date.getMinutes(), date.getSeconds()].map((n) => String(n).padStart(2, '0')).join(':');
}

function markText(marks: number): string {
  return marks >= 3 ? 'Ⓧ' : marks === 2 ? 'X' : marks === 1 ? '/' : '';
}

function throwText(entry: LiveThrow, sides: LiveState['sides']): string {
  const who = entry.member ?? sides[entry.side].name;
  if (entry.kind === '01') return `R${entry.round} ${who}: ${entry.score}${entry.finish ? ' (上がり)' : ''} → 残り ${entry.left}`;
  const hits = entry.hits.map((hit) => `${hit.mark === 3 ? 'T' : hit.mark === 2 ? 'D' : 'S'}${hit.number === 25 ? 'BULL' : hit.number}`).join(' ');
  return `R${entry.round} ${who}: ${hits || 'ノーマーク'} (${entry.marks} マーク${entry.points ? ` ・ +${entry.points}点` : ''})`;
}

function LiveStatusLine({ status, lag, updateTime }: { status: LiveStatus; lag: number | null; updateTime: number }): React.JSX.Element {
  const text =
    status.kind === 'polling'
      ? '自動更新中'
      : status.kind === 'paused-hidden'
        ? '画面が非表示のため更新を一時停止中'
        : status.kind === 'retrying'
          ? `取得エラー: ${status.message} (${Math.round(status.retryInMs / 1000)} 秒後に再試行・表示は ${formatClock(updateTime)} 時点)`
          : status.kind === 'finished'
            ? '終了しました (更新を停止)'
            : status.kind === 'budget'
              ? `更新回数の上限 (${status.requests} 回) に達したため停止中`
              : '';
  return (
    <p className={`small-text live-status ${status.kind}`} role="status" data-testid="live-status">
      {text} ・ n01 更新 {formatSeconds(updateTime)}
      {lag !== null ? ` ・ 表示までの遅れ 約 ${(lag / 1000).toFixed(1)} 秒 (実測の中央値)` : ''}
    </p>
  );
}
