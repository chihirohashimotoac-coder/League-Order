import { useRef, useState } from 'react';
import type { AppSettings, ScoreWeights } from '../domain/types';
import { DEFAULT_N01_SETTINGS } from '../domain/types';
import { HISTORY_DEPTH_MAX } from '../domain/n01/recency';
import { DEFAULT_OPTIMIZER_SETTINGS, DEFAULT_WEIGHTS } from '../domain/orders/presets';
import { parseBackup, serialiseBackup } from '../storage/backup';
import { downloadText } from '../share';
import { useAppStore } from '../state/appStore';
import { Accordion, Card, ConfirmDialog, RadioCards, Stepper, useToast } from '../components/ui';
import { BarChart } from '../components/motion';
import { ChangelogSheet } from '../components/ChangelogSheet';

// The opponent term is not a custom weight: it only means something with opponent data,
// which the opponent-optimised preset brings along.
const WEIGHT_LABELS: { key: Exclude<keyof ScoreWeights, 'opponentWin'>; label: string; hint: string }[] = [
  { key: 'strength', label: '戦力 (Rating / PPR)', hint: '高いほど Rating・PPR の高い選手を優先' },
  { key: 'gameFit', label: 'ゲーム適性', hint: '高いほど得意なゲームに配置' },
  { key: 'pairFit', label: 'ペア相性', hint: '高いほど相性の良いペアを優先' },
  { key: 'fairness', label: '出場回数の公平性', hint: '高いほど出場回数を均等化' },
  {
    key: 'roleFairness',
    label: '役割の分散 (Singles 等)',
    hint: '高いほど Singles・Doubles などを同じ選手に集中させない',
  },
  { key: 'novelty', label: '新ペア度', hint: '高いほど未経験のペアを優先' },
  { key: 'consecutive', label: '連続出場ペナルティ', hint: '高いほど連続出場を避ける' },
  { key: 'season', label: 'シーズン不均衡ペナルティ', hint: '高いほどシーズン累計を均等化' },
];

/** Upper end of each custom-weight slider (unchanged range; also the chart's full scale). */
const WEIGHT_MAX = 2;

/** SETTINGS screen: custom weights, engine budget, JSON import/export (spec §23, §26). */
export function SettingsPage(): React.JSX.Element {
  const store = useAppStore();
  const toast = useToast();
  const fileInput = useRef<HTMLInputElement>(null);
  const [pendingImport, setPendingImport] = useState<{
    snapshot: Parameters<typeof store.replaceEverything>[0];
    warnings: string[];
  } | null>(null);
  const [confirmReset, setConfirmReset] = useState(false);
  const [showChangelog, setShowChangelog] = useState(false);

  const settings = store.settings;
  const n01 = settings.n01 ?? DEFAULT_N01_SETTINGS;

  const update = (change: Partial<AppSettings>): void => store.saveSettings({ ...settings, ...change });

  const handleFile = async (file: File): Promise<void> => {
    const raw = await file.text();
    const result = parseBackup(raw);
    if (!result.ok) {
      toast.show(result.errors[0], 'error');
      return;
    }
    setPendingImport({ snapshot: result.snapshot, warnings: result.warnings });
  };

  return (
    <>
      <Card title="バックアップと移行" kicker="DATA" className="backup-card">
        <div className="backup-grid">
          <div className="backup-actions">
            <section aria-labelledby="backup-export-title">
              <h3 className="section-mini" id="backup-export-title">書き出し (JSON)</h3>
              <p className="small-text">この端末にある<strong>全チーム分</strong>のデータを 1 つの JSON ファイルに保存します。後任の方や別の端末へは、このファイルを渡してください。</p>
              <button
                type="button"
                className="btn small"
                onClick={() => {
                  const stamp = new Date().toISOString().slice(0, 10);
                  downloadText(serialiseBackup(store.snapshot()), `darts-order-backup-${stamp}.json`);
                  toast.show('JSON をエクスポートしました', 'ok');
                }}
              >
                JSON エクスポート
              </button>
            </section>
            <section aria-labelledby="backup-import-title">
              <h3 className="section-mini" id="backup-import-title">復元 (JSON)</h3>
              <p className="small-text">
                ファイルの内容で<strong>この端末のデータをすべて置き換えます</strong> (追加ではありません)。ファイルを選ぶと、置き換える前に件数を確認でき、キャンセルできます。
              </p>
              <button type="button" className="btn small" onClick={() => fileInput.current?.click()}>
                JSON インポート
              </button>
            </section>
          </div>
          <BackupContents title="この端末のデータ (書き出しの対象)" snapshot={store.snapshot()} />
        </div>
        <p className="small-text muted" style={{ marginBottom: 0 }}>
          保存先: {store.backendKind === 'indexeddb' ? 'IndexedDB (このブラウザ内)' : store.backendKind === 'localstorage' ? 'localStorage (このブラウザ内)' : 'メモリ (非永続・タブを閉じると消えます)'}
        </p>
        <input
          ref={fileInput}
          type="file"
          accept="application/json,.json"
          className="visually-hidden"
          // Opened by the 「JSON インポート」 button above; out of the Tab order, but named.
          aria-label="インポートする JSON ファイル"
          tabIndex={-1}
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = '';
            if (file) void handleFile(file);
          }}
        />
      </Card>

      {/* One open at a time: the long settings stay out of the way until needed. */}
      <Accordion
        group="settings"
        kicker="N01"
        icon="refresh"
        title="n01 連携"
        note={`自動同期 ${n01.autoSync ? 'オン' : 'オフ'} ・ 推定勝率 ${n01.showPredictions ? '表示' : '非表示'} ・ 過去 ${n01.historyDepth} シーズン`}
      >
        <label className="check-row">
          <input
            type="checkbox"
            checked={n01.autoSync}
            onChange={(event) => update({ n01: { ...n01, autoSync: event.target.checked } })}
          />
          <span className="small-text">「次戦のオーダーを作る」の前に n01 と同期する</span>
        </label>
        <label className="check-row">
          <input
            type="checkbox"
            checked={n01.showPredictions}
            onChange={(event) => update({ n01: { ...n01, showPredictions: event.target.checked } })}
          />
          <span className="small-text">推定勝率を表示する (共有画像には表示されません)</span>
        </label>
        <div className="row between" style={{ marginTop: 8 }}>
          <span className="small-text">過去シーズンの取得数 (相手分析)</span>
          <Stepper
            label="過去シーズンの取得数"
            value={n01.historyDepth}
            min={0}
            max={HISTORY_DEPTH_MAX}
            onChange={(next) => update({ n01: { ...n01, historyDepth: next } })}
          />
        </div>
        <p className="tiny muted" style={{ marginBottom: 0 }}>
          多いほど相手の傾向を広く見ますが、同期に時間がかかります (既定 {DEFAULT_N01_SETTINGS.historyDepth})。
        </p>
      </Accordion>

      <Accordion
        group="settings"
        kicker="WEIGHTS"
        icon="sliders"
        title="カスタムウェイト"
        note="プリセット「カスタム」で使う評価の重み"
      >
        <p className="tiny muted" style={{ marginTop: 0 }}>
          プリセット「カスタム」を選んだときに使用します。0 にするとその項目を無視します。
        </p>
        <div className="weight-chart">
          <span className="kicker">BALANCE</span>
          <BarChart
            label="ウェイトの配分"
            data={WEIGHT_LABELS.map(({ key, label }) => ({
              key,
              label,
              ratio: settings.customWeights[key] / WEIGHT_MAX,
              display: settings.customWeights[key].toFixed(2),
              muted: settings.customWeights[key] === 0,
            }))}
          />
        </div>
        {WEIGHT_LABELS.map(({ key, label, hint }) => (
          <div key={key} style={{ marginBottom: 12 }}>
            <div className="row between">
              <span className="small-text">{label}</span>
              <span className="badge">{settings.customWeights[key].toFixed(2)}</span>
            </div>
            <input
              type="range"
              min={0}
              max={WEIGHT_MAX}
              step={0.05}
              value={settings.customWeights[key]}
              aria-label={label}
              onChange={(event) =>
                update({
                  customWeights: { ...settings.customWeights, [key]: Number(event.target.value) },
                })
              }
              style={{ width: '100%', minHeight: 44 }}
            />
            <span className="tiny muted">{hint}</span>
          </div>
        ))}
        <button
          type="button"
          className="btn small"
          onClick={() => update({ customWeights: { ...DEFAULT_WEIGHTS } })}
        >
          既定値に戻す
        </button>
      </Accordion>

      <Accordion
        group="settings"
        kicker="ENGINE"
        icon="spark"
        title="最適化エンジン"
        note={`探索 ${settings.optimizer.timeLimitMs} ms ・ Beam ${settings.optimizer.beamWidth}`}
      >
        <div className="field">
          <span>探索時間の上限 (ミリ秒)</span>
          <div className="row between">
            <span className="tiny muted">短いほど速く、長いほど高品質</span>
            <Stepper
              label="探索時間の上限"
              value={settings.optimizer.timeLimitMs / 100}
              min={2}
              max={60}
              format={(value) => `${value * 100}`}
              onChange={(next) =>
                update({ optimizer: { ...settings.optimizer, timeLimitMs: next * 100 } })
              }
            />
          </div>
        </div>

        <div className="field">
          <span>Beam 幅</span>
          <div className="row between">
            <span className="tiny muted">候補保持数。大きいほど高品質・低速</span>
            <Stepper
              label="Beam 幅"
              value={settings.optimizer.beamWidth}
              min={4}
              max={256}
              onChange={(next) => update({ optimizer: { ...settings.optimizer, beamWidth: next } })}
            />
          </div>
        </div>

        <RadioCards
          label="既定の公平性範囲"
          columns={2}
          value={settings.optimizer.fairnessScope}
          options={[
            { key: 'today', label: '今回のみ' },
            { key: 'season', label: 'シーズン込み' },
          ]}
          onChange={(next: AppSettings['optimizer']['fairnessScope']) =>
            update({ optimizer: { ...settings.optimizer, fairnessScope: next } })
          }
        />

        <button
          type="button"
          className="btn small"
          onClick={() => update({ optimizer: { ...DEFAULT_OPTIMIZER_SETTINGS } })}
        >
          既定値に戻す
        </button>
      </Accordion>

      <Card title="このアプリについて" kicker="ABOUT">
        <p className="small-text muted" style={{ marginTop: 0 }}>
          Darts League Order Optimizer — オフライン対応の PWA です。ネットワークが無くても、登録済みデータの参照・オーダー生成・編集ができます。
        </p>
        <p className="tiny muted">
          Rating 未入力は 0 として扱わず、参加者の既知 Rating の中央値を暫定値として評価します。出場不可・最大出場回数・ロック・禁止ペアは絶対条件であり、違反する配置は生成しません。
        </p>
        <div className="row between" style={{ marginTop: 8 }}>
          <span className="small-text muted">アプリバージョン</span>
          <span className="small-text" data-testid="app-version">v{__APP_VERSION__}</span>
        </div>
        <div style={{ marginTop: 8 }}>
          <button
            type="button"
            className="btn small ghost"
            style={{ padding: '10px 0', minHeight: 44, width: '100%', textAlign: 'left' }}
            onClick={() => setShowChangelog(true)}
            aria-label="更新履歴を見る"
          >
            <span className="row between" style={{ width: '100%' }}>
              <span className="small-text">更新履歴を見る</span>
              <span aria-hidden="true">›</span>
            </span>
          </button>
        </div>
        <p className="tiny muted" style={{ marginTop: 8, marginBottom: 0, textAlign: 'right' }}>
          © 2026 Chihiro Hashimoto
        </p>
      </Card>

      <Card title="全データの削除" kicker="DANGER" className="danger-card">
        <p className="small-text">
          この端末のチーム・メンバー・フォーマット・ペア設定・履歴をすべて削除し、最初の画面に戻ります。取り消せません。引き継ぐ場合は、先に上の「JSON エクスポート」で書き出してください。
        </p>
        <button type="button" className="btn small danger" onClick={() => setConfirmReset(true)}>
          全データ削除
        </button>
      </Card>

      {pendingImport ? (
        <ConfirmDialog
          title="JSON をインポート"
          message={`この端末のデータをすべて、ファイルの内容に置き換えます (追加ではありません)。チーム ${pendingImport.snapshot.teams.length} 件 / メンバー ${pendingImport.snapshot.players.length} 名 / フォーマット ${pendingImport.snapshot.formats.length} 件。${
            pendingImport.warnings.length > 0 ? ` 注意: ${pendingImport.warnings[0]}` : ''
          }`}
          confirmLabel="置き換える"
          destructive
          children={
            <div className="restore-compare" data-testid="restore-compare">
              <BackupContents title="いまの端末のデータ (消えます)" snapshot={store.snapshot()} />
              <BackupContents title="ファイルの内容 (置き換え後)" snapshot={pendingImport.snapshot} />
            </div>
          }
          onCancel={() => setPendingImport(null)}
          onConfirm={() => {
            void store.replaceEverything(pendingImport.snapshot).then(() => {
              toast.show('インポートしました', 'ok');
              setPendingImport(null);
            });
          }}
        />
      ) : null}

      {showChangelog ? <ChangelogSheet onClose={() => setShowChangelog(false)} /> : null}

      {confirmReset ? (
        <ConfirmDialog
          title="全データを削除"
          message="すべてのチーム・メンバー・フォーマット・ペア設定・履歴を削除し、最初の画面に戻ります。この操作は取り消せません。必要なら先に JSON エクスポートしてください。"
          confirmLabel="削除する"
          destructive
          onCancel={() => setConfirmReset(false)}
          onConfirm={() => {
            void store
              .replaceEverything({
                teams: [],
                players: [],
                formats: [],
                pairs: [],
                orders: [],
                seasonCommits: [],
                settings: { ...settings, activeTeamId: null },
              })
              .then(() => {
                toast.show('すべてのデータを削除しました', 'ok');
                setConfirmReset(false);
              });
          }}
        />
      ) : null}
    </>
  );
}

type BackupSnapshot = Parameters<ReturnType<typeof useAppStore>['replaceEverything']>[0];

/** What a backup holds, in counts: the data on this device, or the data in a chosen file. */
function BackupContents({ title, snapshot }: { title: string; snapshot: BackupSnapshot }): React.JSX.Element {
  const rows: [string, number, string][] = [
    ['チーム', snapshot.teams.length, '件'],
    ['メンバー (助っ人を除く)', snapshot.players.filter((player) => !player.guest).length, '名'],
    ['フォーマット', snapshot.formats.length, '件'],
    ['ペア設定', snapshot.pairs.length, '件'],
    ['保存・確定したオーダー', snapshot.orders.length, '件'],
  ];
  return (
    <table className="backup-contents small-text" data-testid="backup-contents">
      <caption>{title}</caption>
      <tbody>
        {rows.map(([label, count, unit]) => (
          <tr key={label}>
            <th scope="row">{label}</th>
            <td className="num">
              {count} {unit}
            </td>
          </tr>
        ))}
        <tr>
          <th scope="row">チーム名</th>
          <td>{snapshot.teams.map((team) => team.name).join('、') || '—'}</td>
        </tr>
      </tbody>
    </table>
  );
}
