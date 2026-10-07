import { useRef, useState } from 'react';
import type { AppSettings, ScoreWeights } from '../domain/types';
import { DEFAULT_OPTIMIZER_SETTINGS, DEFAULT_WEIGHTS } from '../domain/orders/presets';
import { parseBackup, serialiseBackup } from '../storage/backup';
import { downloadText } from '../share';
import { useAppStore } from '../state/appStore';
import { Card, ConfirmDialog, Field, Stepper, useToast } from '../components/ui';

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

  const settings = store.settings;

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
      <Card title="保存とバックアップ" kicker="DATA">
        <p className="small-text muted" style={{ marginTop: 0 }}>
          保存先: {store.backendKind === 'indexeddb' ? 'IndexedDB' : store.backendKind === 'localstorage' ? 'localStorage' : 'メモリ (非永続)'}
        </p>
        <div className="row wrap" style={{ gap: 8 }}>
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
          <button type="button" className="btn small" onClick={() => fileInput.current?.click()}>
            JSON インポート
          </button>
          <button type="button" className="btn small danger" onClick={() => setConfirmReset(true)}>
            全データ削除
          </button>
        </div>
        <input
          ref={fileInput}
          type="file"
          accept="application/json,.json"
          className="visually-hidden"
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = '';
            if (file) void handleFile(file);
          }}
        />
      </Card>

      <Card title="カスタムウェイト" kicker="WEIGHTS">
        <p className="tiny muted" style={{ marginTop: 0 }}>
          プリセット「カスタム」を選んだときに使用します。0 にするとその項目を無視します。
        </p>
        {WEIGHT_LABELS.map(({ key, label, hint }) => (
          <div key={key} style={{ marginBottom: 12 }}>
            <div className="row between">
              <span className="small-text">{label}</span>
              <span className="badge">{settings.customWeights[key].toFixed(2)}</span>
            </div>
            <input
              type="range"
              min={0}
              max={2}
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
      </Card>

      <Card title="最適化エンジン" kicker="ENGINE">
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

        <Field label="既定の公平性範囲">
          <select
            value={settings.optimizer.fairnessScope}
            onChange={(event) =>
              update({
                optimizer: {
                  ...settings.optimizer,
                  fairnessScope: event.target.value as AppSettings['optimizer']['fairnessScope'],
                },
              })
            }
          >
            <option value="today">今回のみ</option>
            <option value="season">シーズン込み</option>
          </select>
        </Field>

        <button
          type="button"
          className="btn small"
          onClick={() => update({ optimizer: { ...DEFAULT_OPTIMIZER_SETTINGS } })}
        >
          既定値に戻す
        </button>
      </Card>

      <Card title="このアプリについて" kicker="ABOUT">
        <p className="small-text muted" style={{ marginTop: 0 }}>
          Darts League Order Optimizer — オフライン対応の PWA です。ネットワークが無くても、登録済みデータの参照・オーダー生成・編集ができます。
        </p>
        <p className="tiny muted" style={{ marginBottom: 0 }}>
          Rating 未入力は 0 として扱わず、参加者の既知 Rating の中央値を暫定値として評価します。出場不可・最大出場回数・ロック・禁止ペアは絶対条件であり、違反する配置は生成しません。
        </p>
      </Card>

      {pendingImport ? (
        <ConfirmDialog
          title="JSON をインポート"
          message={`既存データをすべて置き換えます。チーム ${pendingImport.snapshot.teams.length} 件 / メンバー ${pendingImport.snapshot.players.length} 名 / フォーマット ${pendingImport.snapshot.formats.length} 件。${
            pendingImport.warnings.length > 0 ? ` 注意: ${pendingImport.warnings[0]}` : ''
          }`}
          confirmLabel="置き換える"
          destructive
          onCancel={() => setPendingImport(null)}
          onConfirm={() => {
            void store.replaceEverything(pendingImport.snapshot).then(() => {
              toast.show('インポートしました', 'ok');
              setPendingImport(null);
            });
          }}
        />
      ) : null}

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
