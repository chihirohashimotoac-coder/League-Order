import type { OrderDiff } from '../domain/orders/lifecycle';

/**
 * Game-level difference between two orders (追加要件 §9).
 *
 * Only changed games are shown by default: a captain checking what moved should not have
 * to scan past the rows that did not.
 */
export function VersionDiff({
  diff,
  beforeLabel,
  afterLabel,
  showUnchanged = false,
}: {
  diff: OrderDiff;
  beforeLabel: string;
  afterLabel: string;
  showUnchanged?: boolean;
}): React.JSX.Element {
  const rows = showUnchanged ? diff.rows : diff.changes;

  if (rows.length === 0) {
    return (
      <p className="small-text muted" style={{ margin: 0 }}>
        {beforeLabel} から変更はありません。
      </p>
    );
  }

  return (
    <>
      <p className="tiny dim" style={{ marginTop: 0 }}>
        {beforeLabel} → {afterLabel} ・ 変更 {diff.changes.length} 件
      </p>
      <ul className="diff-list">
        {rows.map((row) => (
          <li key={row.gameId} className={row.kind === 'unchanged' ? 'unchanged' : undefined}>
            <div className="row" style={{ gap: 8, marginBottom: 4 }}>
              <span className="badge accent">G{row.order}</span>
              <strong className="grow small-text">{row.gameName}</strong>
              {row.kind === 'added' ? <span className="badge ok">追加</span> : null}
              {row.kind === 'removed' ? <span className="badge danger">削除</span> : null}
              {row.kind === 'changed' ? <span className="badge warn">変更</span> : null}
            </div>
            {row.kind === 'unchanged' ? (
              <p className="small-text muted" style={{ margin: 0 }}>
                {row.afterNames.join(' / ') || '(未配置)'}
              </p>
            ) : (
              <div className="diff-change">
                <span className="before">
                  {row.kind === 'added' ? '(追加)' : row.beforeNames.join(' / ') || '(未配置)'}
                </span>
                <span className="arrow" aria-label="から">
                  ↓
                </span>
                <span className="after">
                  {row.kind === 'removed' ? '(削除)' : row.afterNames.join(' / ') || '(未配置)'}
                </span>
              </div>
            )}
          </li>
        ))}
      </ul>
    </>
  );
}
