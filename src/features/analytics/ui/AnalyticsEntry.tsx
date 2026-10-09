import { Component } from 'react';
import type { ReactNode } from 'react';
import { EmptyState } from '../../../components/ui';
import type { Page } from '../../../navigation';
import AnalyticsPage from './AnalyticsPage';

/**
 * The only thing the app shell imports from analytics (lazily). A render error inside
 * analytics stops at this boundary and shows a message here; order generation, the roster
 * and every other screen are unaffected.
 */
class Boundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }
  override render(): ReactNode {
    if (this.state.failed) {
      return (
        <EmptyState kicker="ANALYTICS" title="分析画面を表示できませんでした" icon="alert">
          <p className="small-text">他の機能には影響しません。ホームに戻って、もう一度お試しください。</p>
        </EmptyState>
      );
    }
    return this.props.children;
  }
}

export default function AnalyticsEntry({ onNavigate }: { onNavigate: (page: Page) => void }): React.JSX.Element {
  return (
    <Boundary>
      <AnalyticsPage onNavigate={onNavigate} />
    </Boundary>
  );
}
