import type { CSSProperties } from 'react';
import { BREADCRUMB_LABELS, MENU_GROUPS, breadcrumbTrail, type Page } from '../navigation';
import { Icon } from './icons';
import { KineticText } from './motion';
import { Sheet, StatusBadge, STATE_META } from './ui';
import type { OrderLifecycleState } from '../domain/types';

/**
 * Breadcrumb trail under the header (WAI-ARIA APG breadcrumb): every ancestor is a button
 * back to it, the current screen is plain text marked `aria-current="page"`. Not shown on
 * HOME, where it would only repeat the header.
 */
export function Breadcrumbs({ page, onNavigate }: { page: Page; onNavigate: (page: Page) => void }): React.JSX.Element | null {
  const trail = breadcrumbTrail(page);
  if (trail.length < 2) return null;
  return (
    <nav className="breadcrumbs" aria-label="パンくずリスト">
      <ol>
        {trail.map((entry, index) => {
          const last = index === trail.length - 1;
          return (
            <li key={entry} style={{ '--i': index } as CSSProperties}>
              {last ? (
                <span aria-current="page" className="crumb current">
                  {BREADCRUMB_LABELS[entry]}
                </span>
              ) : (
                <>
                  <button type="button" className="crumb" onClick={() => onNavigate(entry)}>
                    {entry === 'home' ? <Icon name="home" size={14} /> : null}
                    {BREADCRUMB_LABELS[entry]}
                  </button>
                  <Icon name="chevronRight" size={14} className="crumb-sep" />
                </>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

/** Hamburger button; the three bars fold into a cross while the menu is open. */
export function MenuButton({ open, onClick }: { open: boolean; onClick: () => void }): React.JSX.Element {
  return (
    <button
      type="button"
      className="btn icon ghost header-menu"
      onClick={onClick}
      aria-label="メニューを開く"
      aria-haspopup="dialog"
      aria-expanded={open}
    >
      <span className="burger" aria-hidden="true">
        <span />
        <span />
        <span />
      </span>
    </button>
  );
}

/**
 * The app menu (hamburger drawer): every screen in one place, grouped, with the current
 * one marked. The bottom tab bar keeps the five everyday screens one tap away; this is
 * where the rest (pairs, analytics, settings, the change log) are found from anywhere.
 */
export function MenuDrawer({
  page,
  teamName,
  leagueName,
  showAnalytics,
  working,
  onNavigate,
  onNewOrder,
  onShowChangelog,
  onClose,
}: {
  page: Page;
  teamName: string;
  leagueName?: string;
  showAnalytics: boolean;
  /** The working order's state, or null when none is open. */
  working: { lifecycle: OrderLifecycleState; version: number } | null;
  onNavigate: (page: Page) => void;
  onNewOrder: () => void;
  onShowChangelog: () => void;
  onClose: () => void;
}): React.JSX.Element {
  let stagger = 0;
  const go = (target: Page): void => {
    onClose();
    onNavigate(target);
  };
  return (
    <Sheet title="メニュー" onClose={onClose} variant="drawer">
      <div className="drawer-team">
        <span className="kicker">ACTIVE TEAM</span>
        <strong className="drawer-team-name">
          <KineticText text={teamName} step={22} />
        </strong>
        {leagueName ? <span className="drawer-league">{leagueName}</span> : null}
      </div>

      <button
        type="button"
        className="btn primary drawer-cta"
        onClick={() => {
          onClose();
          onNewOrder();
        }}
      >
        <Icon name="plus" size={20} strokeWidth={2.6} />
        新しいオーダーを作る
      </button>

      <nav aria-label="メニュー">
        <button
          type="button"
          className="drawer-item"
          aria-current={page === 'home' ? 'page' : undefined}
          onClick={() => go('home')}
          style={{ '--i': stagger++ } as CSSProperties}
        >
          <span className="lead" aria-hidden="true">
            <Icon name="home" size={18} />
          </span>
          <span className="grow">
            <span className="title">ホーム</span>
          </span>
        </button>
        {MENU_GROUPS.map((group) => {
          const entries = group.entries.filter(
            (entry) => (entry.page !== 'analytics' || showAnalytics) && (entry.page !== 'result' || working),
          );
          return (
            <div className="drawer-group" key={group.kicker}>
              <h3 className="drawer-group-title">
                <span className="kicker" aria-hidden="true">
                  {group.kicker}
                </span>
                {group.title}
              </h3>
              <ul>
                {entries.map((entry) => (
                  <li key={entry.page}>
                    <button
                      type="button"
                      className="drawer-item"
                      aria-current={page === entry.page ? 'page' : undefined}
                      onClick={() => go(entry.page)}
                      style={{ '--i': stagger++ } as CSSProperties}
                    >
                      <span className="lead" aria-hidden="true">
                        <Icon name={entry.icon} size={18} />
                      </span>
                      <span className="grow">
                        <span className="title">{entry.label}</span>
                        <span className="meta">{entry.note}</span>
                      </span>
                      {entry.page === 'result' && working ? (
                        <StatusBadge tone={STATE_META[working.lifecycle].tone} icon={STATE_META[working.lifecycle].icon}>
                          {working.lifecycle === 'DRAFT' ? 'DRAFT' : `v${working.version}`}
                        </StatusBadge>
                      ) : (
                        <Icon name="chevronRight" size={16} className="chevron" />
                      )}
                    </button>
                  </li>
                ))}
                {group.kicker === 'APP' ? (
                  <li>
                    <button
                      type="button"
                      className="drawer-item"
                      onClick={() => {
                        onClose();
                        onShowChangelog();
                      }}
                      style={{ '--i': stagger++ } as CSSProperties}
                    >
                      <span className="lead" aria-hidden="true">
                        <Icon name="info" size={18} />
                      </span>
                      <span className="grow">
                        <span className="title">更新履歴</span>
                        <span className="meta">v{__APP_VERSION__} ・ アプリの変更点</span>
                      </span>
                      <Icon name="chevronRight" size={16} className="chevron" />
                    </button>
                  </li>
                ) : null}
              </ul>
            </div>
          );
        })}
      </nav>
    </Sheet>
  );
}
