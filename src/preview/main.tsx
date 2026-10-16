import { StrictMode, useMemo, useReducer, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ResultPage } from '../pages/ResultPage';
import { AppStoreProvider } from '../state/appStore';
import { ToastProvider } from '../components/ui';
import { createUndoable, undoableReducer } from '../state/orderSession';
import { generateOrder } from '../optimizer/generateOrder';
import { createMatchInfo, type OrderInput } from '../domain/types';
import { previewScenarios } from './scenarios';
import '../styles/app.css';

/**
 * Non-production test page for the throw-order model and the underdog plan
 * (docs/THROW_ORDER_MODEL.md §10). It renders the real result screen with the real engine on
 * synthetic, fictional scenarios. It talks to no server, stores nothing that matters (only the
 * app's local settings) and is never part of the production build or GitHub Pages.
 */

declare const __PREVIEW_COMMIT__: string;
declare const __PREVIEW_APP_LINK__: boolean;

function ScenarioView({ input }: { input: OrderInput }): React.JSX.Element {
  const result = useMemo(() => generateOrder(input, { timeLimitMs: 4000 }), [input]);
  const [session, dispatch] = useReducer(
    undoableReducer,
    result.ok ? undoableReducer(createUndoable(input), { type: 'generated', candidates: result.candidates, underdog: result.underdog ?? null }) : createUndoable(input),
  );
  if (!result.ok) return <p className="notice danger">このシナリオではオーダーを生成できませんでした。</p>;
  return (
    <ResultPage
      session={session}
      dispatch={dispatch}
      games={input.games}
      diagnostics={[]}
      generating={false}
      match={{ ...createMatchInfo('架空チーム A', 'プレビュー (合成データ)'), opponentName: input.opponent?.opponentName ?? '', matchDate: '' }}
      onMatchChange={() => undefined}
      onRegenerate={() => undefined}
      onReoptimise={() => undefined}
      record={null}
      lifecycle="DRAFT"
      seasonStatus="none"
      onFinalize={() => undefined}
      onSaveDraft={() => undefined}
      onCommitSeason={() => undefined}
      onWithdrawSeason={() => undefined}
    />
  );
}

function Preview(): React.JSX.Element {
  const scenarios = useMemo(() => previewScenarios(), []);
  const [active, setActive] = useState(scenarios[0].id);
  const scenario = scenarios.find((entry) => entry.id === active) ?? scenarios[0];
  return (
    <div className="preview-shell">
      <header className="preview-header">
        <p className="kicker">PREVIEW · 非本番 · 合成データ</p>
        <h1>投順モデルと格上対策の確認ページ</h1>
        <p className="small-text">
          本番とは別の確認用ページです。実在しない架空のデータで、本物の結果画面と最適化エンジンを動かしています。表示される勝率はすべて
          モデルの推定値で、実戦での勝率改善を示すものではありません。n01 には接続しません。
        </p>
        <p className="tiny muted">
          ビルド: {__PREVIEW_COMMIT__}
          {__PREVIEW_APP_LINK__ ? (
            <>
              {' ・ '}
              <a href="./index.html">アプリ本体 (サンプルデータで操作できます)</a>
            </>
          ) : null}
        </p>
        {__PREVIEW_APP_LINK__ ? (
          <details className="disclosure preview-ui" data-testid="preview-ui-guide">
            <summary>
              <span className="grow">
                <span className="summary-title">v{__APP_VERSION__} の UI 確認ポイント</span>
                <span className="summary-note">アプリ本体のサンプルチームで確認できます</span>
              </span>
            </summary>
            <div className="disclosure-body">
              <ul className="small-text preview-ui-list">
                <li>ハンバーガーメニュー: ヘッダー右の「≡」。全画面・更新履歴・新規オーダー</li>
                <li>パンくずリスト: ホーム以外の画面上部 (例: ホーム › オーダー設定 › オーダー結果)</li>
                <li>カルーセル: ホームの「はじめかた」、オーダー保存後は「最近のオーダー」</li>
                <li>モーダル: ホームの「メンバーの戦力分布」と各確認ダイアログ</li>
                <li>アコーディオン: 設定の n01 連携・カスタムウェイト・最適化エンジン (同時に 1 つ)</li>
                <li>ラジオボタン: オーダー設定の「詳細条件」とプリセット (矢印キーで移動)</li>
                <li>プルダウン: 履歴の「表示」「並び順」</li>
                <li>モーション: 端末の「視差効果を減らす」をオフにすると再生されます</li>
              </ul>
              <a className="btn small" href="./index.html">
                アプリ本体を開く
              </a>
            </div>
          </details>
        ) : null}
      </header>
      <nav className="preview-tabs" aria-label="シナリオ">
        {scenarios.map((entry) => (
          <button key={entry.id} type="button" className="btn small" aria-pressed={entry.id === scenario.id} onClick={() => setActive(entry.id)}>
            {entry.title}
          </button>
        ))}
      </nav>
      <p className="preview-summary small-text" data-testid="preview-summary">
        {scenario.summary}
      </p>
      <main className="page preview-page" key={scenario.id}>
        <ScenarioView input={scenario.input} />
      </main>
    </div>
  );
}

const container = document.getElementById('root');
if (!container) throw new Error('#root not found');
createRoot(container).render(
  <StrictMode>
    <ToastProvider>
      <AppStoreProvider>
        <Preview />
      </AppStoreProvider>
    </ToastProvider>
  </StrictMode>,
);
