import { useState } from 'react';
import { Card, EmptyState, useToast } from '../components/ui';
import { Icon } from '../components/icons';
import { useAppStore } from '../state/appStore';
import type { Page } from '../navigation';

/**
 * The screens a viewer without a team reaches from the bottom bar (the same five tabs as with a
 * team, in the same places). Watching and settings work as they are; what needs a team says so
 * once and offers the next step there — register a team, or try the sample — never a dead end.
 */

/** Registers a team (the start screen's flows) or loads the sample. */
export interface ViewerActions {
  onRegister: () => void;
  onNavigate: (page: Page) => void;
}

function SampleButton(): React.JSX.Element {
  const store = useAppStore();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  return (
    <button
      type="button"
      className="btn"
      disabled={busy}
      onClick={() => {
        setBusy(true);
        void store
          .loadSample()
          .then(() => toast.show('サンプルデータを読み込みました', 'ok'))
          .finally(() => setBusy(false));
      }}
    >
      <Icon name="spark" size={18} />
      サンプルで試す
    </button>
  );
}

/** ホーム: what is being watched, and what a team adds. */
export function ViewerHome({ onRegister, onNavigate }: ViewerActions): React.JSX.Element {
  const store = useAppStore();
  const watch = store.settings.watch;
  return (
    <div className="viewer-home" data-testid="viewer-home">
      <Card kicker="WATCH" title="観戦中">
        <p className="small-text" style={{ marginTop: 0 }}>
          <strong>{watch?.title ?? '—'}</strong>
        </p>
        <button type="button" className="btn primary" onClick={() => onNavigate('watch')}>
          <Icon name="trophy" size={18} />
          観戦を開く
        </button>
      </Card>
      <Card kicker="TEAM" title="チームを登録すると">
        <ul className="plain-list small-text">
          <li>オーダーの作成・保存・確定</li>
          <li>メンバー・フォーマット・ペア相性の管理</li>
          <li>n01 と連携したチームの選手・チーム分析</li>
        </ul>
        <div className="row wrap" style={{ gap: 8 }}>
          <button type="button" className="btn primary" onClick={onRegister}>
            <Icon name="users" size={18} />
            チームを登録
          </button>
          <SampleButton />
        </div>
      </Card>
    </div>
  );
}

/** オーダー: needs a team. */
export function ViewerOrder({ onRegister }: ViewerActions): React.JSX.Element {
  return (
    <EmptyState
      kicker="ORDER"
      title="オーダー作成にはチームが必要です"
      icon="target"
      action={
        <div className="row wrap" style={{ gap: 8, justifyContent: 'center' }}>
          <button type="button" className="btn primary" onClick={onRegister}>
            チームを登録
          </button>
          <SampleButton />
        </div>
      }
    >
      n01 からの取り込みでも、手入力でも登録できます。
    </EmptyState>
  );
}
