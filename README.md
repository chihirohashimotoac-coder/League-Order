# Darts League Order Optimizer

ダーツリーグの試合前に、**参加メンバー・Rating・ゲーム適性・出場条件・公平性**を考慮して
オーダー候補を自動生成し、会場でそのまま調整できるオフライン対応 Web アプリ (PWA)。

全自動で決め打ちするのではなく、**合理的な候補を提示し、最終判断はキャプテンが行う**設計です。

---

## 主な機能

| 分類 | 機能 |
|---|---|
| 管理 | チーム / メンバー (Rating 任意) / ゲーム適性 / ペア相性 / ゲームフォーマット |
| 当日設定 | 参加者選択・出場不可ゲーム / 種別・出場可能範囲 (遅刻早退)・最小 / 最大出場回数・最大連続出場・Rating 上書き |
| 生成 | 5 プリセット (勝利優先 / バランス / 公平性優先 / 育成重視 / 新ペア試行) ・最大 3 候補の比較 |
| 調整 | ロック (スロット単位 / ゲーム単位) ・手動編集 (リアルタイム再評価) ・Undo / Redo ・部分再最適化 |
| 説明 | ゲームごとの生成理由・評価内訳・警告・解が無い場合の原因と解決候補 |
| 共有 | 縦長オーダー画像 (PNG) ・テキスト・クリップボード・OS 共有シート |
| 保存 | IndexedDB (localStorage / メモリへ自動縮退) ・JSON Export / Import ・オーダー履歴・シーズン累計 |
| 動作 | PWA / オフライン動作 / モバイルファースト / iOS・Android・PC ブラウザ |

---

## 実行方法

```bash
npm install
npm run dev          # 開発サーバ (http://localhost:5173)
```

スマートフォンから試す場合は `npm run dev -- --host` で LAN に公開してください。

## ビルド方法

```bash
npm run build        # 型チェック + 本番ビルド (dist/)
npm run preview      # 本番ビルドをローカルで配信
```

`dist/` は静的ファイルのみです。任意の静的ホスティング (HTTPS) に配置すれば
PWA としてインストールでき、オフラインで動作します。

## 検証

```bash
npm run lint         # ESLint (アーキテクチャ境界ルールを含む)
npm test             # Vitest (ユニット / 統合 / コンポーネント)
npm run test:e2e     # Playwright (実ブラウザ・モバイル + デスクトップ)
npm run verify       # lint + test + build
npx tsx scripts/sample.ts   # 仕様 §38 のサンプル検証を出力
```

---

## アーキテクチャ

```
src/
  components/     再利用 UI
  pages/          画面 (HOME / PLAYERS / PAIRS / FORMATS / SETUP / RESULT / HISTORY / SETTINGS)
  state/          App ストア + オーダーセッション (Undo 付き reducer)
  domain/         エンティティと純粋なドメインロジック   ← React / DOM / Storage 非依存
    players/ games/ orders/
  optimizer/      最適化エンジン                        ← React / DOM / Storage 非依存
    constraints/  eligibility・Hard 制約の検証
    candidates/   ゲームごとの組合せ候補生成
    scoring/      評価関数と生成理由
    search/       Beam / Branch and Bound / 局所探索
    generateOrder.ts  diagnose.ts  runner.ts  order.worker.ts
  storage/        IndexedDB / フォールバック / Repository / JSON バックアップ
  utils/          汎用ヘルパー
```

`domain/` と `optimizer/` が React・DOM・Storage に依存しないことは、
ESLint の `no-restricted-imports` / `no-restricted-globals` で機械的に検査しています。

最適化は **Web Worker** 上で実行され、生成中も UI は固まりません
(Worker が使えない環境では同期実行へ自動縮退)。

---

## 設計の要点

### Hard Constraint は絶対に破らない

ゲーム必要人数・同一ゲーム内重複禁止・出場不可ゲーム / 種別・出場可能範囲・
最大出場回数・ロック済み配置・禁止ペアは Hard 制約です。
違反する配置は「スコアが低い候補」ではなく **無効** として扱い、探索空間から構造的に排除します。
返却前に独立した検証器 (`validateHardConstraints`) が再検査します。

解が存在しない場合は制約を勝手に緩めず、**どの制約が競合しているか**と
**どれを 1 つ変えれば成立するか**を提示します (実際に再探索して確認した候補のみ提示)。

### 公平性

総枠を参加者へ配分したときの **理想配分からの二乗偏差超過** を最小化します。
固定和の整数分配で二乗偏差を最小化する配分は `floor(T/N)` と `ceil(T/N)` の混合に一致するため、

- 5 名 / 10 枠 → 2,2,2,2,2 (最大差 0)
- 5 名 / 11 枠 → 3,2,2,2,2 (最大差 1)

が単一指標から自動的に導かれます。最大差・標準偏差は検品用に併記します。

### Rating 未入力 (Unknown)

`rating = null` を **0 として扱いません**。参加者の既知 Rating の**中央値**で補完し、
「ちょうど平均的な選手」として評価します (外れ値に頑健・不当な冷遇も優遇もしない)。
補完したことは集計表と生成理由に明示されます。Rating が 1 つも無い場合は戦力評価を使いません。
公平性は出場回数のみで決まるため、Unknown の選手が出場機会を失うことはありません。

詳細な設計判断の記録は [`docs/DESIGN.md`](docs/DESIGN.md) を参照してください。

---

## ライセンス / 注意

- 初期起動時にサンプルのチーム・メンバー・フォーマットを自動作成します (設定画面から全削除可能)。
- データはブラウザ内にのみ保存されます。機種変更時は **JSON エクスポート**で控えを取ってください。
