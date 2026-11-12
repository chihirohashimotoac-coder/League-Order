import { useEffect, useMemo, useState } from 'react';
import { Sheet } from '../../../components/ui';
import { describeN01Error } from '../../../integrations/n01/client';
import type { GameRow, LiveState } from '../parse';
import { LivePoller } from '../livePoller';
import type { LiveStatus } from '../livePoller';
import type { MatchesApi } from '../api';
import type { MatchesApiFactory } from '../environment';
import { GameView } from './GameView';
import { LiveSheet } from './LiveSheet';

/** What the live poller says, in the words shown beside the score. */
export function liveStatusText(status: LiveStatus, ended = false): { text: string; tone: 'ok' | 'paused' | 'error' | 'done' } {
  if (ended || status.kind === 'finished') return { text: '終了', tone: 'done' };
  if (status.kind === 'polling') return { text: '自動更新中', tone: 'ok' };
  if (status.kind === 'paused-hidden') return { text: '一時停止中 (非表示)', tone: 'paused' };
  if (status.kind === 'retrying') return { text: '取得失敗 (前回の値)', tone: 'error' };
  return { text: '接続中…', tone: 'paused' };
}

interface MatchDetailState {
  api: MatchesApi;
  row: GameRow | null;
  error: string | null;
  live: LiveState | null;
  status: LiveStatus;
}

/** One game by its `mid`: the row once, then the live poller while it is being played. */
function useMatchDetail(mid: string, factory: MatchesApiFactory): MatchDetailState {
  const api = useMemo(() => factory({ maxRequests: 100_000 }), [factory]);
  const [row, setRow] = useState<GameRow | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [live, setLive] = useState<LiveState | null>(null);
  const [status, setStatus] = useState<LiveStatus>({ kind: 'idle' });

  useEffect(() => {
    let alive = true;
    setRow(null);
    setError(null);
    setLive(null);
    api
      .game(mid)
      .then((found) => {
        if (!alive) return;
        if (found) setRow(found);
        else setError('この試合は見つかりませんでした (非公開・削除済みの可能性があります)。');
      })
      .catch((reason) => alive && setError(describeN01Error(reason)));
    return () => {
      alive = false;
    };
  }, [api, mid]);

  const inProgress = row !== null && !row.finished;
  useEffect(() => {
    if (!inProgress) return;
    const poller = new LivePoller(api, { mid }, { maxRequests: 20_000, onState: setLive, onStatus: setStatus });
    const onVisibility = (): void => poller.setHidden(document.visibilityState === 'hidden');
    document.addEventListener('visibilitychange', onVisibility);
    poller.setHidden(document.visibilityState === 'hidden');
    poller.start();
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      poller.stop();
    };
  }, [api, mid, inProgress]);
  return { api, row, error, live, status };
}

function MatchDetailBody({ mid, state }: { mid: string; state: MatchDetailState }): React.JSX.Element {
  const { api, row, error, live, status } = state;
  const inProgress = row !== null && !row.finished;
  const names: [string, string] = row ? [row.sides[0].members.map((m) => m.name).join(' / ') || row.sides[0].name, row.sides[1].members.map((m) => m.name).join(' / ') || row.sides[1].name] : ['—', '—'];
  const cricket = row?.matchType === 'cricket';
  const updated = live ? new Date(live.updateTime).toLocaleTimeString('ja-JP') : null;
  return (
    <div className="match-sheet" data-testid="match-sheet">
      {error ? (
        <p className="small-text" role="alert">
          取得エラー: {error}
        </p>
      ) : !row ? (
        <p className="muted small-text">読み込み中…</p>
      ) : (
        <>
          <header className="focus-head">
            <span>{names[0]}</span>
            <strong>
              {live ? `${live.legs[0]} - ${live.legs[1]}` : `${row.sides[0].legsWon ?? 0} - ${row.sides[1].legsWon ?? 0}`}
            </strong>
            <span>{names[1]}</span>
          </header>
          {live && !live.gameEnded ? (
            <LiveSheet key={live.mid} api={api} live={live} status={{ ...liveStatusText(status), updated }} />
          ) : (
            <GameView api={api} mid={mid} cricket={cricket} finished={row.finished} names={names} flip={false} />
          )}
          {inProgress ? (
            <p className={`small-text live-status ${status.kind}`} role="status">
              {status.kind === 'polling' ? '自動更新中' : status.kind === 'paused-hidden' ? '非表示のため一時停止中' : status.kind === 'retrying' ? `取得エラー: ${status.message}` : status.kind === 'finished' ? '終了しました' : '接続中…'}
              {updated ? ` ・ n01 更新 ${updated}` : ''}
            </p>
          ) : null}
        </>
      )}
    </div>
  );
}

/**
 * Any one n01 game — a tournament match, an n01 Online / Live game, a game opened from a
 * link: the scoreboard while it is played (followed by `mid`), then the full comparison and
 * score sheet of every leg. {@link MatchSheet} shows it in a sheet (phones, and wherever the
 * game is opened over another view); {@link MatchPane} shows it in place, beside a list.
 */
export function MatchSheet({ mid, factory, onClose, title }: { mid: string; factory: MatchesApiFactory; onClose: () => void; title?: string }): React.JSX.Element {
  const state = useMatchDetail(mid, factory);
  return (
    <Sheet title={title || state.row?.title || '試合'} onClose={onClose} className="sheet-wide">
      <MatchDetailBody mid={mid} state={state} />
    </Sheet>
  );
}

export function MatchPane({ mid, factory }: { mid: string; factory: MatchesApiFactory }): React.JSX.Element {
  const state = useMatchDetail(mid, factory);
  return <MatchDetailBody mid={mid} state={state} />;
}
