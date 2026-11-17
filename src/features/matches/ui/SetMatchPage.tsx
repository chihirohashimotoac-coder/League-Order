import { useEffect, useMemo, useRef, useState } from 'react';
import { onRadioGroupKeyDown, rovingTabIndex } from '../../../components/ui';
import { Icon } from '../../../components/icons';
import { SPLIT_QUERY, useMediaQuery } from '../../../components/useMediaQuery';
import { describeN01Error } from '../../../integrations/n01/client';
import type { MatchesApi } from '../api';
import type { MatchesApiFactory } from '../environment';
import type { GameRow, LiveState } from '../parse';
import { LivePoller } from '../livePoller';
import type { LiveStatus, LiveTarget } from '../livePoller';
import { matchSetsView } from '../matchSets';
import type { MatchSet } from '../matchSets';
import { GameView } from './GameView';
import { LiveSheet } from './LiveSheet';
import { liveStatusText } from './MatchSheet';

/**
 * One n01 match opened from 「いま n01 で進行中」 (個別の試合・注目選手), on a page of its own — the
 * way a league card is watched — instead of a sheet over the list.
 *
 * A set-format match (`scid`) is followed as a whole: `match/live` by `scid` moves to the next
 * set by itself (manual §2), so ダブルス1 → 次のセット待ち → ダブルス2 is shown without reopening,
 * and the page only stops at `end_schedule`. The published sets (`match/list` by `scid`) are
 * listed from the first screen, in n01's order (`currentSet`), each with its own result; any set
 * opens its legs and visits (`GameView`) while the live set keeps being followed, and
 * 「ライブに戻る」 is one tap back to it. A game without `scid` is followed by its `mid`, as before.
 *
 * Everything shown for a set — its name, players, legs, sheet — comes from that set's own `mid`.
 */

/** How often the list of sets is read again while the match is on (the live set is polled every 1.5 s). */
export const SETS_REFRESH_MS = 20_000;

interface Followed {
  api: MatchesApi;
  row: GameRow | null;
  rowError: string | null;
  live: LiveState | null;
  status: LiveStatus;
  sets: GameRow[] | null;
  setsError: string | null;
  setsLoading: boolean;
  retrySets: () => void;
}

/** The game the page was opened on, then the match it belongs to (by `scid`), or the game alone. */
function useFollowedMatch(mid: string, factory: MatchesApiFactory): Followed {
  const api = useMemo(() => factory({ maxRequests: 100_000 }), [factory]);
  const [row, setRow] = useState<GameRow | null>(null);
  const [rowError, setRowError] = useState<string | null>(null);
  const [live, setLive] = useState<LiveState | null>(null);
  const [status, setStatus] = useState<LiveStatus>({ kind: 'idle' });
  const [sets, setSets] = useState<GameRow[] | null>(null);
  const [setsError, setSetsError] = useState<string | null>(null);
  const [setsLoading, setSetsLoading] = useState(false);
  const [setsTick, setSetsTick] = useState(0);

  useEffect(() => {
    let alive = true;
    api
      .game(mid)
      .then((found) => {
        if (!alive) return;
        if (found) setRow(found);
        else setRowError('この試合は見つかりませんでした (非公開・削除済みの可能性があります)。');
      })
      .catch((reason) => alive && setRowError(describeN01Error(reason)));
    return () => {
      alive = false;
    };
  }, [api, mid]);

  const scid = row?.scid ?? null;
  // Followed until n01 says the match (or the single game) is over; the poller decides that.
  const follow = row !== null && (scid !== null || !row.finished);
  useEffect(() => {
    if (!follow || !row) return;
    const target: LiveTarget = scid ? { scid } : { mid: row.mid };
    const poller = new LivePoller(api, target, { maxRequests: 20_000, onState: setLive, onStatus: setStatus });
    const onVisibility = (): void => poller.setHidden(document.visibilityState === 'hidden');
    document.addEventListener('visibilitychange', onVisibility);
    poller.setHidden(document.visibilityState === 'hidden');
    poller.start();
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      poller.stop();
    };
    // `row` is read once per page; the poller is bound to what it says.
  }, [api, follow, scid, row?.mid]);

  // The sets list: read at once, again when the live set changes or ends, and every
  // SETS_REFRESH_MS while the match is on (not while the page is hidden). A late answer is dropped.
  const liveMid = live?.mid ?? null;
  const liveEnded = live?.gameEnded ?? false;
  const matchOver = status.kind === 'finished' || (live?.cardEnded ?? false);
  useEffect(() => {
    if (!scid) return;
    const controller = new AbortController();
    setSetsLoading(true);
    api
      .matchSets(scid, controller.signal)
      .then((list) => {
        if (controller.signal.aborted) return;
        setSets(list);
        setSetsError(null);
      })
      .catch((reason) => {
        if (!controller.signal.aborted) setSetsError(describeN01Error(reason));
      })
      .finally(() => {
        if (!controller.signal.aborted) setSetsLoading(false);
      });
    return () => controller.abort();
  }, [api, scid, liveMid, liveEnded, matchOver, setsTick]);
  useEffect(() => {
    if (!scid || matchOver) return;
    const timer = setInterval(() => {
      if (document.visibilityState !== 'hidden') setSetsTick((n) => n + 1);
    }, SETS_REFRESH_MS);
    return () => clearInterval(timer);
  }, [scid, matchOver]);

  return { api, row, rowError, live, status, sets, setsError, setsLoading, retrySets: () => setSetsTick((n) => n + 1) };
}

const legsText = (set: MatchSet): string => (set.legs ? `${set.legs[0]} - ${set.legs[1]}` : '— - —');

function resultText(set: MatchSet): string {
  if (!set.finished) return set.live ? '進行中' : '未終了';
  if (set.winner === -1) return '引き分け';
  if (set.winner === null) return '終了';
  return `${set.names[set.winner]} の勝ち`;
}

function SetList({ sets, shownMid, onPick, loading, error, onRetry }: { sets: MatchSet[]; shownMid: string; onPick: (mid: string) => void; loading: boolean; error: string | null; onRetry: () => void }): React.JSX.Element {
  const any = sets.some((set) => set.mid === shownMid);
  return (
    <nav className="set-nav" aria-label="セット">
      <div className="set-list" role="radiogroup" aria-label="セットを選ぶ" onKeyDown={onRadioGroupKeyDown} data-testid="set-list">
        {sets.map((set, index) => {
          const chosen = set.mid === shownMid;
          return (
            <button
              key={set.mid}
              type="button"
              role="radio"
              aria-checked={chosen}
              tabIndex={rovingTabIndex(chosen, index, any)}
              className={`set-item${chosen ? ' is-chosen' : ''}${set.live && !set.finished ? ' is-live' : ''}`}
              onClick={() => onPick(set.mid)}
              data-testid="set-item"
              data-mid={set.mid}
            >
              <span className="set-item-name">
                {set.live && !set.finished ? <span className="tag state-live">LIVE</span> : null}
                {set.label}
              </span>
              <span className="set-item-score" aria-label={`Leg ${legsText(set)}`}>
                {legsText(set)}
              </span>
              <span className="set-item-result muted small-text">{resultText(set)}</span>
            </button>
          );
        })}
      </div>
      {error ? (
        <p className="small-text" role="alert" data-testid="sets-error">
          セット一覧を更新できませんでした ({error})。最新のスコアは更新を続けています。{' '}
          <button type="button" className="btn small" onClick={onRetry}>
            再取得
          </button>
        </p>
      ) : loading && sets.length === 0 ? (
        <p className="muted small-text" role="status">
          セット一覧を読み込み中…
        </p>
      ) : null}
    </nav>
  );
}

function Inner({ initialMid, requestedMid, factory, onBack, onShown, knownMids, backLabel }: { initialMid: string; requestedMid: string; factory: MatchesApiFactory; onBack: () => void; onShown: (mid: string) => void; knownMids: React.MutableRefObject<Set<string>>; backLabel: string }): React.JSX.Element {
  const followed = useFollowedMatch(initialMid, factory);
  const { api, row, rowError, live, status, sets, setsError, setsLoading, retrySets } = followed;
  const wide = useMediaQuery(SPLIT_QUERY);
  /**
   * The set chosen by the viewer; `null` = the live set (followed as the match moves on);
   * `undefined` until the first live state says whether the page was opened on the set in play.
   */
  const [chosen, setChosen] = useState<string | null | undefined>(undefined);
  // Opened on a set that is over while the match has moved on (a shared link, a reload): that
  // set stays shown. Opened on the set being played: the live set is followed. Decided in the
  // render the live state first arrives in, so the address never jumps to the live set first.
  const decided = chosen !== undefined || (row !== null && !row.scid);
  if (chosen === undefined && row && (live || (row.scid && status.kind === 'finished'))) {
    setChosen(live && live.mid !== row.mid && row.finished ? row.mid : null);
  }

  // The game the page was opened on stays in the list even while the list lags behind (or
  // has not been read): what is shown for it always comes from its own mid.
  // The last live state of each set the poller has left (a set seen ending stays ended while
  // the list lags or fails). Kept per page, one entry per set.
  const [held, setHeld] = useState<ReadonlyMap<string, LiveState>>(() => new Map());
  const [heldFrom, setHeldFrom] = useState<LiveState | null>(null);
  if (live !== heldFrom) {
    setHeldFrom(live);
    if (live && row?.scid) setHeld((map) => (map.get(live.mid) === live ? map : new Map(map).set(live.mid, live)));
  }
  const view = useMemo(() => {
    const listed = sets ?? [];
    const rows = row && !listed.some((entry) => entry.mid === row.mid) ? [...listed, row] : listed;
    // A held set the list does not hold at all is shown from what was seen of it.
    const seenOnly = [...held.values()].filter((state) => state.mid !== live?.mid && !rows.some((entry) => entry.mid === state.mid));
    const extra: GameRow[] = seenOnly.map((state) => ({
      mid: state.mid,
      tmid: state.tmid,
      schid: state.schid,
      scid: state.scid,
      matchType: state.matchType,
      title: state.title,
      startTime: null,
      updateTime: null,
      finished: state.gameEnded,
      cardFinished: state.cardEnded,
      currentSet: state.currentSet,
      sides: [0, 1].map((i) => ({ teamId: state.sides[i].teamId ?? '', name: state.sides[i].name, members: state.sides[i].members.map((name) => ({ oid: null, opid: null, name })), legsWon: state.legs[i], setsWon: null, score: null, darts: null, marks: null })) as GameRow['sides'],
    }));
    return matchSetsView([...rows, ...extra], live, row?.title ?? '', held);
  }, [sets, row, live, held]);
  useEffect(() => {
    knownMids.current = new Set(view.sets.map((set) => set.mid));
  }, [view, knownMids]);

  const liveSet = view.sets.find((set) => set.live) ?? null;
  const latest = liveSet ?? view.sets[view.sets.length - 1] ?? null;
  const shownMid = chosen ?? (decided ? liveSet?.mid : undefined) ?? row?.mid ?? initialMid;
  const shown = view.sets.find((set) => set.mid === shownMid) ?? null;

  // The address follows what is shown (a reload or a copied link opens the same set).
  const written = useRef<string | null>(null);
  useEffect(() => {
    if (shownMid === requestedMid) return;
    written.current = shownMid;
    onShown(shownMid);
  }, [shownMid]);
  // Back / forward to another set of this match: show it.
  useEffect(() => {
    // The address this page just wrote, coming back: nothing to do (once — a later visit to the
    // same set by the browser's back / forward is the viewer's).
    if (requestedMid === written.current) {
      written.current = null;
      return;
    }
    if (requestedMid === shownMid || !knownMids.current.has(requestedMid)) return;
    setChosen(requestedMid === liveSet?.mid ? null : requestedMid);
  }, [requestedMid]);

  const pick = (mid: string): void => setChosen(mid === liveSet?.mid ? null : mid);
  const scid = row?.scid ?? null;
  const following = live !== null && live.mid === shownMid;
  const betweenSets = scid !== null && live !== null && live.gameEnded && !live.cardEnded && status.kind !== 'finished';
  const ended = status.kind === 'finished' || (live?.cardEnded ?? false) || (!scid && (row?.finished ?? false));
  const updated = live ? new Date(live.updateTime).toLocaleTimeString('ja-JP') : null;
  const statusLine = liveStatusText(status, ended);
  const names: [string, string] = shown?.names ?? (row ? [row.sides[0].members.map((m) => m.name).join(' / ') || row.sides[0].name, row.sides[1].members.map((m) => m.name).join(' / ') || row.sides[1].name] : ['—', '—']);

  const back = (
    <button type="button" className="btn ghost small set-page-back" onClick={onBack} data-testid="set-page-back">
      <Icon name="chevronLeft" size={16} /> {backLabel}
    </button>
  );
  if (rowError) {
    return (
      <div className="set-page" data-testid="set-page">
        {back}
        <p className="small-text" role="alert">
          取得エラー: {rowError}
        </p>
      </div>
    );
  }
  if (!row) {
    return (
      <div className="set-page" data-testid="set-page">
        {back}
        <p className="muted small-text" role="status">
          読み込み中…
        </p>
      </div>
    );
  }

  const showSetList = scid !== null && view.sets.length > 0;
  const backToLive = chosen != null && latest !== null && chosen !== latest.mid;
  const score = (
    <section className="set-score" aria-label={shown ? `${shown.label} のスコア` : 'スコア'} data-testid="set-score">
      <header className="set-score-head">
        <h3 className="set-score-title" data-testid="shown-set">
          {scid ? (shown?.label ?? '—') : (live?.title ?? row.title)}
          {shown && !following && shown.finished ? <span className="muted small-text"> ・ {resultText(shown)}</span> : null}
        </h3>
        {backToLive ? (
          <button type="button" className="btn small primary" onClick={() => setChosen(null)} data-testid="back-to-live">
            {ended ? '最後のセットへ' : 'ライブに戻る'}
          </button>
        ) : null}
      </header>
      {betweenSets && following ? (
        <p className="set-wait small-text" role="status" data-testid="set-wait">
          このセットは終了しました。次のセットの開始を待っています (始まると自動で切り替わります)。
        </p>
      ) : null}
      {/* The live scoreboard names the players and the legs itself: said once, not twice. */}
      <div className={`focus-head${following && live && !live.gameEnded ? ' visually-hidden' : ''}`}>
        <span>{names[0]}</span>
        <strong data-testid="set-legs">{shown ? legsText(shown) : `${row.sides[0].legsWon ?? 0} - ${row.sides[1].legsWon ?? 0}`}</strong>
        <span>{names[1]}</span>
      </div>
      {following && live && !live.gameEnded ? (
        <LiveSheet key={live.mid} api={api} live={live} status={{ ...statusLine, updated }} />
      ) : (
        <GameView key={shownMid} api={api} mid={shownMid} cricket={shown?.cricket ?? row.matchType === 'cricket'} finished={shown?.finished ?? row.finished} names={names} flip={false} />
      )}
    </section>
  );

  return (
    <div className={`set-page${wide && showSetList ? ' is-split' : ''}`} data-testid="set-page">
      <div className="set-page-top">
        {back}
        <div className="set-page-heading">
          <h2 className="set-page-title" data-testid="set-page-title">
            {scid ? view.matchTitle : (live?.title ?? row.title)}
          </h2>
          <p className={`small-text live-status ${status.kind}`} role="status" data-testid="set-page-status">
            {statusLine.text}
            {updated ? ` ・ n01 更新 ${updated}` : ''}
            {status.kind === 'retrying' ? ` ・ ${status.message}` : ''}
          </p>
        </div>
        {scid && view.setsWon ? (
          <p className="set-total" data-testid="sets-won">
            <span className="muted small-text">獲得セット (通算)</span>
            <strong>
              {view.setsWon[0]} - {view.setsWon[1]}
            </strong>
          </p>
        ) : null}
      </div>
      <div className="set-page-body">
        {showSetList ? <SetList sets={view.sets} shownMid={shownMid} onPick={pick} loading={setsLoading} error={setsError} onRetry={retrySets} /> : null}
        {score}
      </div>
    </div>
  );
}

/**
 * The page. The game in the address may change from here (the set shown) or from the browser
 * (back / forward, a pasted link): another set of the same match is shown in place; any other
 * game starts the page afresh.
 */
export function SetMatchPage({ mid, factory, onBack, onShown, backLabel = '進行中の試合一覧に戻る' }: { mid: string; factory: MatchesApiFactory; onBack: () => void; onShown: (mid: string) => void; backLabel?: string }): React.JSX.Element {
  const [root, setRoot] = useState(mid);
  const knownMids = useRef<Set<string>>(new Set([mid]));
  useEffect(() => {
    if (mid !== root && !knownMids.current.has(mid)) {
      knownMids.current = new Set([mid]);
      setRoot(mid);
    }
  }, [mid, root]);
  return <Inner key={root} initialMid={root} requestedMid={mid} factory={factory} onBack={onBack} onShown={onShown} knownMids={knownMids} backLabel={backLabel} />;
}
