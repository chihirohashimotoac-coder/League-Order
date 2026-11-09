import { Component } from 'react';
import type { ReactNode } from 'react';
import { EmptyState } from '../../../components/ui';
import type { Page } from '../../../navigation';
import WatchPage from './WatchPage';

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

export default function MatchesEntry({ page, onNavigate }: { page: 'matches' | 'live'; onNavigate?: (page: Page) => void }): React.JSX.Element {
  return (
    <Boundary>
      <WatchPage initialTab={page === 'live' ? 'live' : 'results'} onNavigate={onNavigate} />
    </Boundary>
  );
}
