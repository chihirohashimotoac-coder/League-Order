import { CHANGELOG } from '../data/changelog';
import { Sheet } from './ui';

/** Bottom sheet listing the update history, one entry per change. Works offline: the data is bundled. */
export function ChangelogSheet({ onClose }: { onClose: () => void }): React.JSX.Element {
  return (
    <Sheet title="更新履歴" onClose={onClose}>
      {/* The list is long enough to scroll; a focusable region lets keyboard users scroll it. */}
      <div
        role="region"
        aria-label="更新履歴の一覧"
        tabIndex={0}
        style={{ paddingBottom: 'env(safe-area-inset-bottom, 0px)' }}
      >
        {CHANGELOG.map((entry) => (
          <article key={entry.id} data-entry={entry.id} style={{ marginBottom: 24 }}>
            <div className="row between" style={{ marginBottom: 4 }}>
              <h3 className="small-text" style={{ fontWeight: 600, margin: 0 }}>
                {entry.title}
              </h3>
              <span className="tiny muted" style={{ whiteSpace: 'nowrap', flexShrink: 0 }}>
                {entry.date}
              </span>
            </div>
            {entry.version || entry.internal ? (
              <div className="row" style={{ gap: 6, marginBottom: 6 }}>
                {entry.version ? (
                  <span className="badge" data-version={entry.version}>
                    v{entry.version}
                  </span>
                ) : null}
                {entry.internal ? <span className="badge">内部改善</span> : null}
              </div>
            ) : null}
            <ul style={{ margin: 0, paddingLeft: 20 }}>
              {entry.items.map((item) => (
                <li key={item} className="small-text" style={{ marginBottom: 4 }}>
                  {item}
                </li>
              ))}
            </ul>
          </article>
        ))}
      </div>
    </Sheet>
  );
}
