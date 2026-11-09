import type { GameLegs } from './useGameLegs';

/** Short and true to the state: reading, waiting to read again, stopped, or (a finished game) incomplete — with a retry. */
export function LegsStatusLine({ history }: { history: GameLegs }): React.JSX.Element {
  const { status, sync, missing, error, retry } = history;
  const legs = missing.map((index) => `L${index + 1}`).join('・');
  const stopped = status === 'error' || sync === 'stopped';
  const text =
    status === 'loading'
      ? 'このゲームの記録を取得中… (平均などは記録がそろってから表示します)'
      : status === 'error'
        ? `このゲームの記録を取得できませんでした${error ? ` (${error})` : ''}。平均などは表示していません。`
        : sync === 'stopped'
          ? `終わった Leg (${legs}) の記録を取得できていません。平均・予測は表示していません。`
          : sync === 'idle'
            ? `この試合の記録に欠けている Leg があります (${legs})。平均・予測は表示していません。`
            : sync === 'waiting'
              ? `終わった Leg (${legs}) の記録がまだありません。少し待って再取得します。平均・予測はそろってから表示します。`
              : `終わった Leg (${legs}) の記録を取得中… 平均・予測はそろってから表示します。`;
  return (
    <p className={`small-text legs-status ${stopped ? 'error' : status}`} role={stopped ? 'alert' : 'status'} data-testid="legs-status" data-sync={sync}>
      {text}
      {status === 'error' || (status === 'ready' && sync !== 'syncing') ? (
        <>
          {' '}
          <button type="button" className="btn small" onClick={retry}>
            再取得
          </button>
        </>
      ) : null}
    </p>
  );
}
