import { useEffect, useMemo, useState } from 'react';
import { Sheet } from '../../../components/ui';
import { describeN01Error } from '../../../integrations/n01/client';
import type { GameRow, LiveState } from '../parse';
import { LivePoller } from '../livePoller';
import type { LiveStatus } from '../livePoller';
import type { MatchesApiFactory } from '../environment';
import { GameView } from './GameView';
import { LiveSheet } from './LiveSheet';

/**
 * Any one n01 game in a sheet — a tournament match, an n01 Online / Live game, a game opened
 * from a link: the scoreboard while it is played (followed by `mid`), then the full
 * comparison and score sheet of every leg.
 */
export function MatchSheet({ mid, factory, onClose, title }: { mid: string; factory: MatchesApiFactory; onClose: () => void; title?: string }): React.JSX.Element {
  const api = useMemo(() => factory({ maxRequests: 100_000 }), [factory]);
  const [row, setRow] = useState<GameRow | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [live, setLive] = useState<LiveState | null>(null);
  const [status, setStatus] = useState<LiveStatus>({ kind: 'idle' });

  useEffect(() => {
    let alive = true;
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

  const names: [string, string] = row ? [row.sides[0].members.map((m) => m.name).join(' / ') || row.sides[0].name, row.sides[1].members.map((m) => m.name).join(' / ') || row.sides[1].name] : ['—', '—'];
  const cricket = row?.matchType === 'cricket';
  return (
    <Sheet title={title || row?.title || '試合'} onClose={onClose} className="sheet-wide">
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
              <LiveSheet key={live.mid} api={api} live={live} />
            ) : (
              <GameView api={api} mid={mid} cricket={cricket} finished={row.finished} names={names} flip={false} />
            )}
            {inProgress ? (
              <p className={`small-text live-status ${status.kind}`} role="status">
                {status.kind === 'polling' ? '自動更新中' : status.kind === 'paused-hidden' ? '非表示のため一時停止中' : status.kind === 'retrying' ? `取得エラー: ${status.message}` : status.kind === 'finished' ? '終了しました' : '接続中…'}
                {live ? ` ・ n01 更新 ${new Date(live.updateTime).toLocaleTimeString('ja-JP')}` : ''}
              </p>
            ) : null}
          </>
        )}
      </div>
    </Sheet>
  );
}
