import { Component } from 'react';
import type { ReactNode } from 'react';
import { EmptyState } from '../../../components/ui';
import type { Page } from '../../../navigation';
import WatchPage, { lastWatchTab } from './WatchPage';

/**
 * The only thing the app shell imports from the match screens (lazily). A render error stops
 * at this boundary: order generation and every other screen are unaffected.
 */
class Boundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }
  override render(): ReactNode {
    if (this.state.failed) {
      return (
        <EmptyState kicker="MATCH" title="試合画面を表示できませんでした" icon="alert">
          <p className="small-text">他の機能には影響しません。ホームに戻って、もう一度お試しください。</p>
        </EmptyState>
      );
    }
    return this.props.children;
  }
}

/**
 * `live` and `matches` open their own tab (links from HOME and the menu); the 観戦 tab of the
 * bottom bar (`watch`) returns to the tab last used in this session.
 */
export default function MatchesEntry({ page, onNavigate }: { page: 'matches' | 'live' | 'watch'; onNavigate?: (page: Page) => void }): React.JSX.Element {
  const initialTab = page === 'live' ? 'live' : page === 'matches' ? 'results' : lastWatchTab();
  return (
    <Boundary>
      <WatchPage initialTab={initialTab} onNavigate={onNavigate} />
    </Boundary>
  );
}
