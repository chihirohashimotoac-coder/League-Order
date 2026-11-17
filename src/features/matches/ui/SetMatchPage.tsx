import { useEffect, useMemo, useRef, useState } from 'react';
import { describeN01Error } from '../../../integrations/n01/client';
import type { MatchesApi } from '../api';
import type { MatchesApiFactory } from '../environment';
import type { GameRow, LiveState } from '../parse';
import { gameRowOfLive } from '../parse';
import { LivePoller } from '../livePoller';
import type { LiveStatus, LiveTarget } from '../livePoller';
import { matchSetsView } from '../matchSets';
import type { MatchSet } from '../matchSets';
import { GameView } from './GameView';
import { LiveSheet } from './LiveSheet';
import { liveStatusText } from './MatchSheet';
import { LiveReturn, MatchBar, MatchHead, UnitChips, UnitHead, shortUnit } from './MatchParts';
import type { MatchUnit } from './MatchParts';
import { useScreenWakeLock } from './useScreenWakeLock';

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

type SetSource = 'archive' | 'live';
interface SourceState {
  rows: GameRow[] | null;
  error: string | null;
  loading: boolean;
}
const NO_SOURCE: SourceState = { rows: null, error: null, loading: false };

/** Both sources by `mid`, the archive first (it is the record once a set is in it); `null` while neither was read. */
export function mergeSources(archive: readonly GameRow[] | null, live: readonly GameRow[] | null): GameRow[] | null {
  if (archive === null && live === null) return null;
  const byMid = new Map<string, GameRow>();
  for (const game of archive ?? []) byMid.set(game.mid, game);
  for (const game of live ?? []) if (!byMid.has(game.mid)) byMid.set(game.mid, game);
  return [...byMid.values()];
}

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
  // The list of sets, from two sources kept apart (see MatchesApi.matchSetsFrom): `rows` is the
  // last successful read (`[]` = read, none), `null` = never read; `error` = the last read failed.
  const [archive, setArchive] = useState<SourceState>(NO_SOURCE);
  const [liveList, setLiveList] = useState<SourceState>(NO_SOURCE);
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
  // One read per source at a time: a new read of a source drops the one before it, and nothing
  // arrives after the page (this match) is gone.
  const reads = useRef<Record<SetSource, AbortController | null>>({ archive: null, live: null });
  useEffect(
    () => () => {
      reads.current.archive?.abort();
      reads.current.live?.abort();
    },
    [],
  );
  const readSources = (sources: readonly SetSource[]): void => {
    if (!scid) return;
    for (const source of sources) {
      reads.current[source]?.abort();
      const controller = new AbortController();
      reads.current[source] = controller;
      const set = source === 'archive' ? setArchive : setLiveList;
      set((held) => ({ ...held, loading: true }));
      api
        .matchSetsFrom(scid, source, controller.signal)
        .then((rows) => {
          if (!controller.signal.aborted) set({ rows, error: null, loading: false });
        })
        .catch((reason) => {
          // A failed read keeps the rows of the last one that worked.
          if (!controller.signal.aborted) set((held) => ({ rows: held.rows, error: describeN01Error(reason), loading: false }));
        })
        .finally(() => {
          if (reads.current[source] === controller) reads.current[source] = null;
        });
    }
  };
  useEffect(() => {
    readSources(['archive', 'live']);
  }, [api, scid, liveMid, liveEnded, matchOver, setsTick]);
  useEffect(() => {
    if (!scid || matchOver) return;
    const timer = setInterval(() => {
      if (document.visibilityState !== 'hidden') setSetsTick((n) => n + 1);
    }, SETS_REFRESH_MS);
    return () => clearInterval(timer);
  }, [scid, matchOver]);

  const sets = useMemo(() => mergeSources(archive.rows, liveList.rows), [archive.rows, liveList.rows]);
  const failed: SetSource[] = [...(archive.error ? (['archive'] as const) : []), ...(liveList.error ? (['live'] as const) : [])];
  const setsError = failed.length ? `${failed.map((source) => (source === 'archive' ? '終了したセット' : '進行中のセット')).join('・')}の一覧を取得できませんでした (${(archive.error ?? liveList.error)!})` : null;
  // Again: only what failed (both when nothing did).
  const retrySets = (): void => readSources(failed.length ? failed : ['archive', 'live']);
  return { api, row, rowError, live, status, sets, setsError, setsLoading: archive.loading || liveList.loading, retrySets };
}

const legsText = (set: MatchSet): string => (set.legs ? `${set.legs[0]} - ${set.legs[1]}` : '— - —');


function Inner({ initialMid, requestedMid, factory, onBack, onShown, knownMids, backLabel, shareUrl, extra }: { initialMid: string; requestedMid: string; factory: MatchesApiFactory; onBack: () => void; onShown: (mid: string) => void; knownMids: React.MutableRefObject<Set<string>>; backLabel: string; shareUrl?: (mid: string) => string; extra?: React.ReactNode }): React.JSX.Element {
  const followed = useFollowedMatch(initialMid, factory);
  const { api, row, rowError, live, status, sets, setsError, setsLoading, retrySets } = followed;
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
    const extra: GameRow[] = seenOnly.map(gameRowOfLive);
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
  useScreenWakeLock(!ended && (live !== null || (row !== null && !row.finished)));
  const updated = live ? new Date(live.updateTime).toLocaleTimeString('ja-JP') : null;
  const statusLine = liveStatusText(status, ended);
  const names: [string, string] = shown?.names ?? (row ? [row.sides[0].members.map((m) => m.name).join(' / ') || row.sides[0].name, row.sides[1].members.map((m) => m.name).join(' / ') || row.sides[1].name] : ['—', '—']);

  const bar = <MatchBar backLabel={backLabel} onBack={onBack} link={shareUrl?.(shownMid)} backTestId="set-page-back" />;
  if (rowError) {
    return (
      <div className="set-page match-center" data-testid="set-page">
        {bar}
        <p className="small-text" role="alert">
          取得エラー: {rowError}
        </p>
      </div>
    );
  }
  if (!row) {
    return (
      <div className="set-page match-center" data-testid="set-page">
        {bar}
        <p className="muted small-text" role="status">
          読み込み中…
        </p>
      </div>
    );
  }

  const showSetList = scid !== null && view.sets.length > 0;
  const backToLive = chosen != null && latest !== null && chosen !== latest.mid;
  const liveOn = following && live !== null && !live.gameEnded;
  // The match's two sides (teams, or the players of a single game) and its score: sets won for a
  // set-format match, legs for a single game.
  const teams: [string, string] = scid ? [live?.sides[0].name ?? row.sides[0].name, live?.sides[1].name ?? row.sides[1].name] : names;
  const total = scid ? (view.setsWon ? `${view.setsWon[0]} - ${view.setsWon[1]}` : 'vs') : shown ? legsText(shown) : `${row.sides[0].legsWon ?? 0} - ${row.sides[1].legsWon ?? 0}`;
  const units: MatchUnit[] = view.sets.map((set) => ({ key: set.mid, label: set.label, short: shortUnit(set.label), legs: set.legs, winner: set.winner, live: set.live && !set.finished, playable: true }));

  return (
    <div className="set-page match-center" data-testid="set-page">
      {bar}
      <MatchHead
        sides={teams}
        score={total}
        scoreLabel={scid ? `獲得セット (通算) ${total}` : `Leg ${total}`}
        scoreTestId={scid ? 'sets-won' : 'set-legs'}
        note={
          <>
            <span data-testid="set-page-title">{scid ? view.matchTitle : (live?.title ?? row.title)}</span>
            {' ・ '}
            <span className={`live-status ${status.kind}`} role="status" data-testid="set-page-status">
              {statusLine.text}
              {updated ? ` ・ n01 更新 ${updated}` : ''}
              {status.kind === 'retrying' ? ` ・ ${status.message}` : ''}
            </span>
          </>
        }
      />
      {showSetList ? (
        <>
          <UnitChips label="セット" names={teams} selected={shownMid} onPick={pick} units={units} testId="set-list" itemTestId="set-item" />
          {setsError ? (
            <p className="small-text" role="alert" data-testid="sets-error">
              {setsError}。取得できたセットは表示しています。最新のスコアは更新を続けています。{' '}
              <button type="button" className="btn small" onClick={retrySets}>
                再取得
              </button>
            </p>
          ) : setsLoading && view.sets.length <= 1 ? (
            <p className="muted small-text" role="status">
              セット一覧を読み込み中…
            </p>
          ) : null}
        </>
      ) : null}
      {backToLive && liveSet && !liveSet.finished && live ? (
        <LiveReturn onReturn={() => setChosen(null)} text={`${liveSet.label} ・ Leg ${(live.leg?.index ?? live.currentLeg ?? 0) + 1} ・ ${live.legs[0]}-${live.legs[1]}`} />
      ) : backToLive ? (
        <button type="button" className="btn small" onClick={() => setChosen(null)} data-testid="back-to-live">
          最後のセットへ
        </button>
      ) : null}
      <section className="set-score game-panel" aria-label={shown ? `${shown.label} のスコア` : 'スコア'} data-testid="set-score">
        {scid && shown ? (
          <UnitHead
            label={shown.label}
            state={shown.live && !shown.finished ? 'live' : betweenSets && following ? 'waiting' : 'finished'}
            sides={shown.names}
            legs={shown.legs}
            winner={shown.winner}
            testId="shown-set"
            legsTestId="set-legs"
            hidden={liveOn}
          />
        ) : null}
        {betweenSets && following ? (
          <p className="set-wait small-text" role="status" data-testid="set-wait">
            このセットは終了しました。次のセットの開始を待っています (始まると自動で切り替わります)。
          </p>
        ) : null}
        {liveOn && live ? (
          <LiveSheet key={live.mid} api={api} live={live} title={scid && shown ? shown.label : undefined} status={{ ...statusLine, updated }} />
        ) : (
          <GameView key={shownMid} api={api} mid={shownMid} cricket={shown?.cricket ?? row.matchType === 'cricket'} finished={shown?.finished ?? row.finished} names={names} flip={false} openPlayedLeg />
        )}
      </section>
      {extra}
    </div>
  );
}

/**
 * The page. The game in the address may change from here (the set shown) or from the browser
 * (back / forward, a pasted link): another set of the same match is shown in place; any other
 * game starts the page afresh.
 */
export function SetMatchPage({ mid, factory, onBack, onShown, backLabel = '進行中の試合一覧に戻る', shareUrl, extra }: { mid: string; factory: MatchesApiFactory; onBack: () => void; onShown: (mid: string) => void; backLabel?: string; /** The link of a game shown here (リンクをコピー). */ shareUrl?: (mid: string) => string; /** Shown under the score (a competition's 勝ち上がり). */ extra?: React.ReactNode }): React.JSX.Element {
  const [root, setRoot] = useState(mid);
  const knownMids = useRef<Set<string>>(new Set([mid]));
  // Opened over a list that is now hidden: the keyboard focus comes to the page (not to the body).
  const page = useRef<HTMLDivElement>(null);
  useEffect(() => {
    page.current?.focus({ preventScroll: true });
  }, [root]);
  useEffect(() => {
    if (mid !== root && !knownMids.current.has(mid)) {
      knownMids.current = new Set([mid]);
      setRoot(mid);
    }
  }, [mid, root]);
  return (
    <div ref={page} tabIndex={-1} className="match-page">
      <Inner key={root} initialMid={root} requestedMid={mid} factory={factory} onBack={onBack} onShown={onShown} knownMids={knownMids} backLabel={backLabel} shareUrl={shareUrl} extra={extra} />
    </div>
  );
}
