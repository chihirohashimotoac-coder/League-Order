# ハリマル実装 引き継ぎ文書

最終更新：2026-11-19（PR3 = n01 観戦リアクションを実装。PR3 ドラフト・ユーザー確認待ち）。秘密情報は記載しない。

> **本番未反映。** ハリマルは main・gh-pages のどちらにも入っていない。本番公開は PR1〜PR3 の最終検証・ユーザー承認のあと、統合ブランチから main 向けの最終 PR で行う。
>
> **PR2 はユーザー指示 (2026-11-19) により実装完了扱い。** ただし GitHub 上は PR #59 がドラフト・未マージのまま (統合ブランチ `feat/harimaru-integration` は `fd6c147` で、PR2 は未取り込み)。ブランチへのマージはユーザーの明示指示に従う。

## 0. 新しいセッションの開始手順（最初に読む）

### 現在の状態（2026-11-19）

| 項目 | 値 |
|---|---|
| main | `71bc8ad`（ハリマル未反映。変更しない） |
| gh-pages | `ca31842`（71bc8ad の公開分。変更しない） |
| PR1 | [#58](https://github.com/chihirohashimotoac-coder/League-Order/pull/58) `feat/harimaru-pr1-base` → main、HEAD `fd6c147`。**承認済み・マージしない・閉じない** |
| 統合ブランチ | `feat/harimaru-integration` = `fd6c147` |
| PR2 | [#59](https://github.com/chihirohashimotoac-coder/League-Order/pull/59)（ドラフト）`feat/harimaru-pr2-behavior` → `feat/harimaru-integration`、HEAD `05032a4`。**実装完了扱い（ユーザー指示）・未マージ・統合ブランチへ未取り込み** |
| PR3 | [#60](https://github.com/chihirohashimotoac-coder/League-Order/pull/60)（ドラフト）`feat/harimaru-pr3-n01-reactions` → `feat/harimaru-pr2-behavior`（PR2 が未統合のため積み重ね）。SHA は `git log` と PR を参照。**ユーザー確認待ち・未マージ** |
| プレビュー | PR3：https://claude.ai/artifact/TtVuLMEMsNztchm91FYMwL（バージョン 3 = `1f99a1e` のビルド）／ PR2：https://claude.ai/artifact/6hwBYyRTvLNYcH6bGK23GX（バージョン 4 = `05032a4` のビルド。バージョン 3 は誤って PR3 のビルドを上書きしたもので、4 で戻した）／ PR1：https://claude.ai/artifact/VBPWXXm1Vi9BCDSAQPfYfB（いずれも非公開の claude.ai Artifact、n01 は架空データ） |
| Codex 監査の回数 | PR1：3 / 3（上限）、PR2：3 / 3（上限。3 回目の反映 `62386fb` と、v0.9 の組み込みは未監査）、PR3：4 回（0 から数え直し。4 回目はユーザー承認済み）、§7 の PR3 を参照。PR3 の 4 回目の反映は未監査。PR3 の 5 回目、PR1・PR2 の 4 回目は、新たなユーザー承認が必要 |

### ユーザーの判断待ち（勝手に進めない）

1. PR3（#60）のプレビュー・動きの確認と承認。PR2・PR3 を統合ブランチへ取り込むか（取り込みはユーザーの明示指示があってから）
2. 追加素材 v0.9（PR2）と観戦リアクション素材 v0.5（PR3）の採用承認
3. 動きの頻度・速さの見え方（`params.ts` の暫定値、観戦リアクションは `controller.ts` の `DEFAULT_LIVE`）
4. PWA のプリキャッシュ増加（PR2 で約 +931 KiB、PR3 で約 +633 KiB、§6）の扱い
5. Codex 監査の追加（PR3 の 5 回目、PR1・PR2 の 4 回目は、新たなユーザー承認が必要）

### 作業前の確認

```
git fetch origin
git log --oneline -3 origin/feat/harimaru-pr2-behavior origin/feat/harimaru-integration origin/main
```

- 上の表の SHA と違えば、差異を報告してから進める（他の人・セッションの変更を上書きしない。force push 禁止）。
- 依存は `npm ci`（ロックファイルどおり。無断で更新しない）。コンテナを作り直すと node_modules がない。
- Codex CLI：`codex --version`（0.167.0 固定）、`codex login status`。未ログインなら、ユーザーの依頼があるときだけ `codex login --device-auth` を実行し、URL とコードを伝える。
- Codex の実行は **`< /dev/null` を付ける**（付けないと標準入力の待ちで止まる）：`codex exec --sandbox read-only "<依頼文>" < /dev/null > ログ 2>&1`
- Codex の監査環境では Vitest が `EROFS` で起動できないことがある。単体テストは Claude 側で実行して結果を伝える。

### 作業のコツ・注意

- E2E は `npx playwright test <spec> --trace off`。webServer は `npm run build && vite preview` を使い、起動中のサーバーを再利用する。コードを変えたら `pkill -f "vite preview"` してから実行する（古いビルドで走らないように）。E2E の実行中に `npm run verify`（build を含む）を走らせると、配信中の `dist/` が置き換わるので避ける。
- 既存 E2E の回帰一式（約 20 分）：harimaru・browse・setMatch・matches・liveFollow・n01・a11y・order・share・analyticsViewports・start・themes・teamHeader・viewerNav・people。
- プレビューの Artifact 更新：`PREVIEW_DEMO_N01=1 npm run build:preview` → `dist-preview/index.html` の head から charset・viewport・title を除き、`<title>` を付けて本文に `<div id="root"></div>` だけのページにする → `assets/*` とアイコンを `files` で同じ Artifact に publish（古いハッシュのファイルは `null` で消す）。index.html をダブルクリックで開く（file://）と真っ白になる（モジュールが読めない）のは仕様。
- サンプル読み込み後、アプリはホームを少し下へスクロールする（既存の動作）。E2E では `scrollTo(0, 0)` してから確かめる。
- `page.clock` を使うと CSS アニメーションは実時間のまま進む。入場アニメーションの終了は実時間で待つ（1.5 秒）。
- 動作を狙って再生する確認：開発サーバー（`npx vite`）では `window.__harimaru`（`HarimaruController`）が出る（`import.meta.env.DEV` のときだけ。本番ビルドには含まれない）。`__harimaru.trigger('slip')` などで、いつもと同じ安全の確かめを通して動作を始められる（できなければ `false`）。`__harimaru.snapshot()` で状態を読む。E2E は本番ビルドで動くので使えない。



| 資料 | 場所 | 備考 |
|---|---|---|
| マスタープロンプト（PR1〜PR3 共通） | ユーザーが Claude Code に渡す指示文 | リポジトリには未収録。次セッションでもユーザーから受け取る |
| 確定仕様（ユーザー回答 11 項目） | [`HARIMARU_SPEC_v1.md`](./HARIMARU_SPEC_v1.md) | 素材 ZIP 同梱の写し |
| Work 調査・設計 | ユーザー添付の `Harimaru-League-Order-Design.md` | 未収録。要点は本書 §5 |
| 素材 v0.2 | `src/features/harimaru/assets/harimaru_atlas@{1x,2x,3x}.png` | ZIP の atlas を無加工で収録（可逆最適化でも縮まず） |
| 追加素材の制作依頼 | [`ASSET_REQUESTS.md`](./ASSET_REQUESTS.md) | PR2 の素材待ちの動作と、納品規格。ChatGPT にそのまま渡せる形 |
| 動作と素材の対応表 | `src/features/harimaru/clips.ts` | 素材が届いたら `available: true` にする |

素材 v0.2 で承認済みなのは **待機・歩行・睡眠の 3 動作だけ**。他の動作の素材は未承認・未制作。

## 2. 進捗とブランチ方式

### 方針（2026-11-18 ユーザー決定）

- PR1 の実装内容は**承認済み**。ただし PR1 は **main へマージしない**（実装・監査の履歴として残す）。
- PR2 完成時も main へマージしない。**本番公開は PR3 の完成・最終検証・ユーザー承認のあと**。
- 統合ブランチ方式：`feat/harimaru-integration` に各 PR をユーザー承認後に取り込み、PR3 完成後に統合ブランチから main 向けの最終 PR を作る。最終 PR のマージはユーザーの明示承認が必要。
- 禁止：main・gh-pages への push、本番デプロイ、workflow_dispatch による公開、deploy.yml の変更、PR1 を閉じる・マージする、force push。
- 旧方針「PR1 を main へマージしてから PR2 へ進む」は廃止。

| PR | ブランチ (head → base) | 状態 | ユーザー承認 |
|---|---|---|---|
| PR1 基本実装（ホーム・待機/歩行/睡眠・ON/OFF・休止） | `feat/harimaru-pr1-base` → `main`（マージしない） | [PR #58](https://github.com/chihirohashimotoac-coder/League-Order/pull/58)。最終 `fd6c147`（ホバー修正を含む） | **承認済み**（2026-11-18）。実機確認は未 |
| 統合ブランチ | `feat/harimaru-integration` | `fd6c147` から作成（main 71bc8ad + PR1 の 7 コミットだけ） | ― |
| PR2 気まぐれさ・アスレチック・触れ合い・全画面 | `feat/harimaru-pr2-behavior` → `feat/harimaru-integration` | [PR #59](https://github.com/chihirohashimotoac-coder/League-Order/pull/59)（ドラフト：素材待ちの動作あり）。統合ブランチへの取り込みはユーザー承認待ち | 未 |
| PR3 n01 観戦連動 | 未作成 | 未着手（PR2 の統合ブランチへの取り込み後に分岐） | 未 |

承認履歴が確認できないときは、承認されたと推定して次段階へ進まない。

## 3. PR1 の構成

| ファイル | 役割 |
|---|---|
| `src/features/harimaru/params.ts` | 調整用の暫定値（重み・時間・速度・余白）。確定値ではない |
| `behavior.ts` | 行動選択（純関数、重み付き抽選・連続抑制・無操作で睡眠、乱数差し替え可） |
| `terrain.ts` | 足場の判定（純関数。足場の結合・障害物の除外・可視判定） |
| `terrainDom.ts` | 実 DOM の計測（足場＝登録セレクターの上辺、障害物＝操作部品・色付き要素・文字の矩形） |
| `controller.ts` | 動作エンジン（transform と background-position のみ更新。休止・再計測・破棄） |
| `sprite.ts` | スプライトシートの定義と画素密度別の素材選択 |
| `preference.ts` | 表示 ON/OFF（localStorage `league-order:harimaru`、初期 ON、バックアップ対象外） |
| `HarimaruLayer.tsx` / `harimaru.css` | body 直下の描画レイヤー（portal、`aria-hidden`、`pointer-events: none`、z-index 10） |
| `src/App.tsx` | チーム登録済みシェルに `<HarimaruLayer page={page} />` を 1 行追加 |
| `src/pages/SettingsPage.tsx` | 設定に「ハリマル」アコーディオン（表示する／しない） |
| テスト | `src/features/harimaru/*.test.ts(x)`、`e2e/harimaru.spec.ts` |

足場を持つ画面は `HARIMARU_PLATFORMS`（`HarimaruLayer.tsx`）に登録する。PR1 は `home` だけ。PR2 で全画面（チーム登録済み・閲覧専用の両方）に広げた。

### PR2 で追加・変更したもの

| ファイル | 役割 |
|---|---|
| `clips.ts`（新規） | 動作と素材の対応表。素材のない動作は `available: false`（抽選・反応の対象外） |
| `interaction.ts`（新規） | 触れ合いの判定（純関数）：短いタップの採用条件、体のどこに触れたか、反応、カーソルへの反応 |
| `behavior.ts` | 行動を 11 種に拡張（待機・休む・周囲を見る・歩く・駆け足・跳ねる・ジャンプ・隠れる・眠る・毛づくろい・伸び）。動いたあとは静かな行動を選びやすく、動く行動は 3 回続かない |
| `terrain.ts` | ジャンプの経路（放物線）・経路の安全判定・候補、上辺の差 3px 以内は同じ列 |
| `terrainDom.ts` | 範囲を指定した障害物の収集、固定・sticky・内側スクロールの中の足場は使わない、スクロール領域は箱全体を障害物に |
| `controller.ts` | 新しい行動・触れ合い・入力中の休止・DOM 変化の確認を 1 フレーム 1 回に。素材待ちの動作は発生条件だけ動かして記録 |
| `HarimaruLayer.tsx` | 全画面の足場（`.card` など共通のカード部品） |
| `src/App.tsx` | 閲覧専用シェルにも `<HarimaruLayer page={viewerPage} />` |

### PR2 で追加素材 v0.9 を組み込んだもの（2026-11-19）

| ファイル | 役割 |
|---|---|
| `assets/v09/*.png`（新規 42 枚） | 素材 ZIP の `clips/` を無加工で収録（14 動作 × 1x/2x/3x）。`source/`・GIF・プレビュー・`frames/` は入れない。v0.2 のアトラスは変更なし |
| `sprite.ts` | `CLIPS`（manifest の写し：コマ数・時間・基準点・横のずれ・ループ）、`clipUrlFor`（画素密度別）、`clipOffset`（基準点と左右反転の計算） |
| `clips.ts` | 全動作 `available: true`。v0.9 の動作は画像を読み込めたときだけ選ぶ |
| `controller.ts` | v0.9 の再生（`playClip`・`loopClip`・画像の切り替え）、滑る→しがみつく→よじ登る（`trySlip`）、転ぶ、寝ぼける、毛づくろい・伸び、驚く・喜ぶ・見上げる・首をかしげる・じゃれる、カーソルにぶら下がる。カードの内側の安全判定（`edgeClear`）。足場の外に体が出ている途中の休止は、出直し扱い。デバッグ・テスト用の `trigger()` と `setSheet()` |
| `terrainDom.ts` | `collectObstacles` に `seeThrough`（調べるカード自身は数えない）、`topCornerRadius` |
| `interaction.ts` | 近くの余白へのタップで首をかしげる、カーソルへの反応に首をかしげる・跳びつけるか（`canHang`）・頭の上か |
| `params.ts` | `slipChance`・`sleepyFallChance`・`hangMs`・`cursorHangMs`・`cursorLeapMs`・`nearTiltChance`・`cursorReleaseMove` |
| `HarimaruLayer.tsx` | 登場のあとで画素密度に合う 14 枚だけを読み込み、デコード後に `setSheet`。開発サーバーだけ `window.__harimaru` |

### PR3 で追加・変更したもの（n01 観戦リアクション、2026-11-19）

| ファイル | 役割 |
|---|---|
| `liveReactions.ts`（新規） | 判定（`LiveReactionTracker`、純粋なクラス）。味方の側、01 の得点の分類、勝敗・逆転、重複・訂正・後着・取りこぼしの除外、優先度 `LIVE_PRIORITY` |
| `liveFeed.ts`（新規） | 観戦画面 → ハリマルの購読（`claimLive`・`publishLive`・`rebaseLive`）。流せるのは最後に権利を取った観戦画面だけ。聞き手がいなければ何もしない |
| `useHarimaruLive.ts`（新規） | 観戦画面から呼ぶフック。味方 = 選択中の登録チームの n01 紐付けがこのシーズンの `tpid` を指すとき（リーグ・大会・チーム ID の一致）だけ。`WatchShown` が false（試合ページの下に隠して保持）・`source` null では流さない。ポーラーの再試行・取得上限・非表示のあと基準化 |
| `src/features/matches/ui/LiveTab.tsx`・`ResultsTab.tsx` | `useHarimaruLive(...)` を 1 行ずつ（FocusCard は 2 カード表示の左だけ・ユーザーが別のゲームを選んでいない間、MatchCenter はリンクで別のゲームを開いていない間）。取得・表示は変えない |
| `controller.ts` | `reactLive`（優先順位・得点のクールダウン・休止中は捨てる・足場の外や shift 休止では重要な出来事だけ最大 3 秒待つ）、`playReaction`（本体とエフェクトのコマ）、`reactionRoom`（エフェクトの範囲の安全判定、足元より下は `cardBelowClear`）、`cancelLive`、`setReactionSheets`、要素の `data-live`（最後の結果。E2E 用） |
| `sprite.ts` | `REACTIONS`（manifest の写しと、1x/2x/3x のアルファ > 0 を包む `effectBox`、180 の `textShift` = 7） |
| `HarimaruLayer.tsx`・`harimaru.css` | エフェクトの要素（52×42、`pointer-events: none`、演出の間だけ表示、前後の重ね順）、購読・判定・画像の遅延読み込み、対象の変更で `cancelLive` |
| `terrainDom.ts`（PR2 の判定の調整） | スクロール領域は実際にはみ出しているときだけ箱全体を障害物に。`containersOf` / `collectObstacles(..., containers)`：足場を包む入れ物（操作部品以外、重なる範囲をすべて包むとき、実際にスクロールしない）は箱を数えない。理由：観戦のライブ画面に立てる場所がなかった（本日の対戦の帯・ゲームの切り替えの列がスクロール領域扱い、スコア表が白いカードの中） |
| `HarimaruLayer.tsx` の足場 | `.n01-sheet`（ライブのスコア表の枠）を追加（同じ理由） |
| `assets/pr3/body`・`assets/pr3/effect` | 素材 v0.5 の `atlas/body`・`atlas/effect` を無加工で収録（36 枚）。合成済み・GIF・制作元・プレビュー・frames は入れない |
| テスト | `liveReactions.test.ts`・`controller.live.dom.test.ts`・`liveFeed.dom.test.tsx`、`terrainDom.dom.test.ts` 追加分、E2E `e2e/harimaruLive.spec.ts`（架空の n01・本番ビルド） |

## 4. PR1 の完了条件（作成時点の自己判定）

| # | 条件 | 判定 | 根拠 |
|---|---|---|---|
| 1 | ホームに 1 体だけ | OK | E2E・単体テスト（レイヤー 1 つ・スプライト 1 つ） |
| 2 | 全高 20 CSS px | OK | 表示枠 30×20、素材の可視高さ最大 20.0px（実測） |
| 3 | 安全な余白のみ | OK | 足場判定＋E2E で移動中 80 回の重なり検査、幅 320〜1440・テーマ 3 種で重なり 0 |
| 4 | 待機・歩行・睡眠が自然に切替 | 要相談 | 3 動作の遷移は実装・テスト済み。「自然さ」はユーザーのプレビュー確認が必要 |
| 5 | 実際に移動する | OK | E2E（x 座標が複数に変化） |
| 6 | UI を隠さない | OK | 固定ヘッダー・下部ナビ・シートより下の z-index、帯に障害物があれば立たない |
| 7 | タップ・クリックが既存と同じ | OK | pointer-events: none、elementFromPoint 検査、既存 E2E |
| 8 | 安全領域がなければ非表示 | OK | 単体テスト・E2E（PC 低画面のスクロール位置） |
| 9 | 初期 ON、OFF 可能 | OK | 設定画面、E2E |
| 10 | 設定の保持 | OK | localStorage、再読み込み後も OFF（E2E） |
| 11 | reduced-motion で非表示 | OK | 描画自体を止める（React）＋ CSS、変更に追従（E2E） |
| 12 | サイズ変更・ズームに追従 | OK | resize・ResizeObserver で再計測、画素密度で素材を切替。200% 相当で確認 |
| 13 | 停止時に処理を残さない | OK | destroy・休止でタイマー/フレーム 0（単体テスト） |
| 14 | レイアウトシフトなし | OK | body 直下の absolute・幅高さ 0 のレイヤー、transform のみ。横スクロール 0 |
| 15 | 既存機能の回帰なし | 報告参照 | `npm run verify`・関連 E2E の結果は PR 本文と作業報告 |
| 16 | 新規依存なし | OK | package.json / package-lock.json 変更なし |

## 5. 設計上の判断（PR2 以降の前提）

- 足場の帯（上辺から 20px＋余白 3px）に、ボタン・リンク・入力・色/枠付き要素の箱、または文字の矩形が少しでも入る x 範囲は使わない。カード間 14px の隙間には立てないため、ホームで実際に使えるのは主に「観戦・分析」タイル列の上（見出し文字の右）と、上が空いたカードの上辺。
- ページは window スクロール。レイヤーは body 直下 absolute のため、スクロールに JavaScript なしで追従する。足場が見えない位置では出ず、スクロール停止時に見える足場があれば移る。
- 休止：タブ非表示・モーダル/シート（`[aria-modal="true"]`, `.sheet-backdrop`）・画面外。モーダル検出は MutationObserver（`.app` の childList）。
- 足場 (タイル・カード) がホバーなどで動くときは、消さずに真下の足場の上辺に合わせて一緒に動く (毎フレーム追従)。足場以外の要素がキャラクターの周りで動くときだけ隠す。上辺の差 3px 以内は同じ列として扱う (`rowTolerance`)。ユーザーのプレビュー確認で「ボタンにホバーすると消える」と指摘され、隠す方式から変更した (2026-11-18)。
- 横スクロールするカルーセルは足場にしない（スクロールイベントが window に届かず位置が追えないため）。
- 入場アニメーション中は計測しない（有限の Web Animations が動いている間は待つ。最大 3 秒）。
- サンプル読み込み後、アプリは既存の動作でホームを少し下にスクロールする。PC の低い画面（1280×720）ではその位置に足場がなく、ハリマルが出ないのは正しい動作。

## 6. 未解決・要相談

- 動作の自然さ（速さ・頻度・休む時間）はすべて暫定値（`params.ts`）。プレビューで調整。
- 素材待ちだった動作は、追加素材 v0.9 ですべて実装済み（2026-11-19）。v0.9 の画像を読み込めなかった動作だけは選ばない（背後から触れたときは「振り向く」に戻る）。
- 素材 3 枚（計約 198KB）は PNG のため PWA のプリキャッシュ対象（端末が使うのは 1 枚）。3x 単体 118KB が試作目標 100KB を超過。
- 足場の余白がない画面（大会のボード・分析の多く・オーダー生成直後のダイアログ等）では出ない（仕様どおり）。
- 縁にしがみつく・寝ぼけるは、足場のカードそのものがボタン・リンク（ホームの「観戦・分析」タイルなど）の上では起きない（ボタンの面に体を重ねないため）。カードの中の縁の下 10.5px に文字・操作部品・色の付いた要素があるカード、角丸の上、カードの高さが足りない場所でも起きない。
- 観戦リアクション（PR3）は、エフェクトの範囲（本体より広い）に文字・操作部品があると演出しない。立ち位置はランダムなので、同じ画面でも出る・出ないが変わる。200% ズーム相当（640×450）の観戦ライブ画面では立てる場所がなく出ない（安全判定どおり）。
- 観戦リアクションは、セット形式・単独の試合のページ（`SetMatchPage`）にも接続済み（監査 3 回目の反映 `dd69da2` から）。閲覧者が前のセットを選んで表示している間（`chosen` が null 以外）は状態を渡さず、反応しない（ライブに戻ると、その時点の状態を基準にし直す）。このページには大会のシーズン情報がないため、味方は状態の大会 ID（`tdid`）が登録チームの紐付けの大会 ID（`lastTournamentId`）と一致し、紐付けのチーム ID（`lastTeamId`）が状態の片方の側の `teamId` と一意に一致するときだけ確定する（`useHarimaruLive.ts` の `allyTeamIdByTournament` と、判定の `allySide`）。確定できなければ中立で、反応しない。（作成時点の記録では「未接続」としていたが、`dd69da2` で接続した。）
- 観戦画面の Leg のタブで終わった Leg を表示している間（`LiveSheet` の `past`）は、その画面の観戦対象（source）の状態だけを流さない（`liveFeed.ts` の `holdLive(source)`）。表示を始めたときにその観戦対象の演出中・待っている出来事を取り消し、進行中へ戻すと次の状態を基準にし直す（監査 4 回目の反映から）。停止は source ごとに数え、すべて解けたときだけ再開する。状態を流していない画面（2 カード表示の右、別のゲームを開いている間、隠れて保持されている間）の LiveSheet は何も止めない（`useHarimaruLive` の返り値を LiveSheet の `harimaruSource` に渡す）。作成時点（`7d996cd`）は停止が全体共通で、右のカード・隠れた画面の過去の Leg が、ほかの観戦対象まで止めていた（2026-11-19 に修正）。
- 演出中にスクロール・リサイズ・見えている範囲（`visualViewport`）が変わったら、エフェクトをすぐにやめる（動いている間は重なりを確かめられないため。止まったあとに出し直さない）。スクロールの途中に届いた得点は捨て、勝敗・180 などの重要な出来事は止まってから（待てる時間内なら）演出する。演出中は速いスクロールのあとでも「転ぶ」を始めない（監査 4 回目の反映から）。
- 味方の判定は、登録チームの n01 紐付け（`lastTournamentId`・`lastTeamId`）がいまのシーズンを指しているときだけ。新しいシーズンで紐付けを再同期していなければ中立（チーム名では推測しない）。
- PR3 の素材（本体・エフェクト 36 枚、約 624KB）も PWA のプリキャッシュ対象。ビルドのプリキャッシュは 61 件 2560 KiB → 89 件 3193 KiB（約 +633 KiB）。
- 追加素材 v0.9 の PNG 42 枚（約 916KB）も PWA のプリキャッシュ対象。ビルドのプリキャッシュは 19 件 1629 KiB → 61 件 2560 KiB（約 +931 KiB）。端末が実際に表示に使うのは 1 解像度の 14 枚（1x 約 89KB・2x 約 286KB・3x 約 541KB）。2x/3x のプリキャッシュ除外は `vite.config.ts` の変更になるため未対応（要相談）。
- 更新履歴（`src/data/changelog.ts`）・バージョン番号は未更新。
- 実機（iPhone Safari / Android Chrome）は未確認。

## 7. 検証・監査・PR の記録

### PR1

- コミット：`6ae322c`（実装）→ `56ba81a`（監査 1 回目の反映）→ `000fac5`（2 回目）→ 監査 3 回目の反映コミット（`git log` 参照）
- 検証：`npm run verify`（lint・単体 1671 件・build）成功、`npm run typecheck` 成功。ハリマル専用：単体 54 件、E2E `e2e/harimaru.spec.ts` 13 件（PC 専用のホバー検査は 12 回連続合格）
- 表示確認（Chromium・エミュレーション）：幅 320 / 375 / 390 / 430、タブレット縦横、1024、1440、200% ズーム相当（720×450 @2x）、テーマ 3 種（マッチシート・スタジアム・クリーン）。実時間で 60 秒間の重なり 0 件、横スクロール 0
- Codex 監査（CLI `codex exec --sandbox read-only`、上限 3 回を使用）

| 回 | 指摘（高/中/低） | 反映 | 反映しなかったもの |
|---|---|---|---|
| 1 | 1 / 4 / 2 | ホバーで浮くタイル、フェードの残像、ピンチズーム（縦）、休止中の補助タイマー、画像要求の競合、E2E の弱い検証 | 素材の可視高さ（2x 19.5 / 3x 19.67px）：確定仕様「最大 20px」を満たし、承認済み素材を無断加工しないため |
| 2 | 1 / 4 / 1 | 歩行先の位置変化、プロパティ別の開始/終了の対応、ピンチズーム（横）、画像要求の世代番号、休止中の予約・計測、E2E の検証 | なし |
| 3 | 1 / 2 / 1 | DOM 変化時の即時確認（描画前に消える）、ピンチズーム中の行動範囲、休止の重なり時の見張り解除 | 素材の可視高さ（同上） |

3 回目の反映後の再監査は、上限（3 回）に達したため未実施（4 回目にはユーザー承認が必要）。
- CI（PR #58）：Backtest baseline check 成功、Build and check the preview page 成功。プレビュー成果物は Actions の run 44254366262 の `preview-site`（14 日保持）

### PR2

- ブランチ：`feat/harimaru-pr2-behavior` → base `feat/harimaru-integration`（`fd6c147`）。コミット `10135ff`（実装）→ `c6eec62` / `ec055c4` / `62386fb`（監査 1〜3 回目の反映）→ 本書の更新
- 検証：`npm run verify`（lint・単体 137 ファイル 1728 件・build）成功、`npm run typecheck` 成功。ハリマル専用の単体 111 件
- E2E：`10135ff` のビルドで既存 14 spec + harimaru 計 281 件合格・失敗 0（スキップ 19 は既存の指定）。最終 `62386fb` のビルドで harimaru・a11y・start・themes・viewerNav・people・teamHeader 計 74 件合格・失敗 0
- 画面ごとの確認（Chromium エミュレーション、PC 1440×900・スマホ 390×844、各 14 秒）：ホーム・観戦の選択・n01 一覧・オーダー設定・メンバー・フォーマット・ペア相性・履歴・設定・その他で表示、重なり 0、エラー 0。大会のボード・分析 (サンプルは n01 未連携)・オーダー生成の確認ダイアログでは出ない (安全な余白なし・モーダル)
- Codex 監査（CLI、読み取り専用、PR2 の上限 3 回を使用）

| 回 | 指摘（高/中/低） | 反映 | 反映しなかったもの |
|---|---|---|---|
| 1 | 2 / 3 / 1 | 段差のあるジャンプの頂点と掃いた範囲の判定、空中でのスクロール・リサイズ・DOM 変化の中断、本文のタップ、ジャンプ判定の負荷、テストの踏切の高さ、focus の passive | なし |
| 2 | 1 / 2 / 0 | 空中での足場の動きの中断、判定点に頂点を加える、体の枠の外のタップに余白判定 | なし |
| 3 | 1 / 2 / 0 | 踏切前から動いている足場では跳ばない、跳ねている途中の画面変化で降りる、跳ねている間のタップを無視 | なし |

3 回目の反映（`62386fb`）は再監査していない（4 回目にはユーザー承認が必要）。GitHub の Codex 自動レビューは PR 作成後に別途確認する。
- プレビュー：claude.ai の Artifact（非公開）https://claude.ai/artifact/6hwBYyRTvLNYcH6bGK23GX （`62386fb` のビルド、n01 は架空データ）。PR1 のプレビューは https://claude.ai/artifact/VBPWXXm1Vi9BCDSAQPfYfB

#### 追加素材 v0.9 の組み込み（2026-11-19、`989bf03`）

- 素材の検品（スクリプト、素材 ZIP に対して）：14 動作・68 コマ、全アトラスと `frames/` の全コマが 1x/2x/3x で一致、`slip` 最後 = `hang` 最初、`hang` 最後 = `climb` 最初、`climb` 最後 = v0.2 の待機 1、manifest の `sources`（v0.2・再利用コマ）と一致、可視高さは全コマ 20px 以下。v0.9 の `reference/` は収録済みの v0.2 アトラスとバイト一致。GIF のコマ数は一致、コマ時間は最大 8ms 差（GIF の丸め）
- 検証：`npm run verify`（lint・単体 1759 件・build）成功、`npm run typecheck` 成功。ハリマルの単体 143 件（v0.9 用に `sprite.test.ts`・`controller.v09.dom.test.ts` を追加）
- E2E：`npm run test:e2e` 499 件合格・失敗 0（スキップ 23 は既存の指定。harimaru に v0.9 の読み込み範囲の検査を追加）、`npm run test:e2e:preview` 38 件合格・失敗 0（スキップ 2）
- 実ブラウザ（Chromium、開発サーバーの `__harimaru.trigger`。スマホ = Pixel 5 相当・PC = 1280×900）：14 動作すべてを再生し、コマ順を記録。しがみつく間の前足（基準点）のずれ 0px、clip-path なし。ホーム・メンバー・フォーマット・履歴・設定・その他・観戦・オーダーで、滑る／寝ぼけるの途中の重なり 0。しがみつき中の足場の消失（`display:none`）・スクロール・リサイズ・モーダルで即座に隠れ、出直す。カーソルにぶら下がる（PC）：先端に前足を合わせ、動かすと放して戻る。エラー 0
- この確認で見つけて直した不具合：(1) ホームの「観戦・分析」タイルはボタンそのもので、縁の下に体がボタンの面に重なった → 足場が操作部品なら縁の下に体を出さない。(2) スタイルだけで足場が消えると、しがみついたまま残った → 毎フレーム掴んでいるカードを確かめる
- Codex 監査：**未実施**（PR2 は上限 3 回を使用済み。4 回目はユーザー承認が必要）
- CI（`989bf03`）：Backtest baseline check 成功、Build and check the preview page 成功

#### PR2 の完了条件（自己判定）

| # | 条件 | 判定 | 根拠・残り |
|---|---|---|---|
| 1 | 日常・移動・操作の全必須動作 | OK | v0.9 で全動作を実装（2026-11-19）。自然さ・頻度はプレビュー確認待ち |
| 2 | 発生条件をテストできる | OK | 乱数・時刻・素材の有無・計測を差し替える単体テスト |
| 3 | 機械的に連続しない | OK | 同じ行動の抑制、動く行動は 3 回続かない（単体テスト） |
| 4 | 静かな時間がある | OK | 長時間の抽選で静かな時間が 75% 超（単体テスト）。自然さはプレビュー確認待ち |
| 5 | カード間移動で UI を隠さない | OK | 経路全体の判定、経路がなければ隠れて移る、空中の中断（単体テスト）。画面での重なり 0（エミュレーション） |
| 6 | カード裏への隠れ方が自然 | 要相談 | 上辺の線で切り取るマスク。自然さはプレビュー確認待ち |
| 7 | ぶら下がっても操作を阻害しない | OK | pointer-events: none のまま、カーソルを捕捉しない。押す・動かす・ウィンドウの外で放す（単体・実ブラウザ）。実機は未確認 |
| 8 | スマホ操作で誤反応しない | OK | 短いタップだけ・余白だけ（単体・E2E）。実機は未確認 |
| 9 | スクロール・画面遷移で破綻しない | OK | スクロール中の中断、画面ごとに作り直す（単体・E2E） |
| 10 | 既存の全画面操作に回帰がない | OK | 既存 E2E 281 件・最終 74 件で失敗 0 |
| 11 | キャラクターなしで従来どおり | OK | 表示 OFF・動きを減らす設定の E2E |
| 12 | 素材不足による未完成動作がない | OK | 全動作の素材あり。画像を読み込めなかった動作は選ばない |

### PR3

- ブランチ：`feat/harimaru-pr3-n01-reactions`（PR2 の `05032a4` から分岐）→ base `feat/harimaru-pr2-behavior`（PR2 が統合ブランチに未取り込みのため積み重ね）。PR：[#60](https://github.com/chihirohashimotoac-coder/League-Order/pull/60)（ドラフト）
- コミット：`a91771f`（実装）→ `f9d0c4d`（監査 1 回目の反映）→ `6cc3e11`（2 回目）→ `dd69da2`（3 回目）→ `b90cec6`（本書の SetMatchPage の記述の矛盾を修正）→ 監査 4 回目の反映（`git log` 参照）
- 素材：`HARIMARU_PR3_REACTIONS_v05`（6 種・49 コマ）の `atlas/body`・`atlas/effect` を無加工で収録。開始・終了のコマは v0.2 の待機と一致（検品スクリプト）。effectBox は 1x/2x/3x のアルファ > 0 を包む範囲（Codex も一致を確認）
- 判定の前提の確認：公開されている実際の n01 の終了済み試合 1 件（9 Leg・113 投てき）で、`(p, r)` が Leg の中で一意、ラウンドは Leg・側ごとに 1 から、バストは `score: 0`、上がりは `finish: 1` を確認（n01 の読み取り 2 回、アプリの通信とは無関係）
- 検証（`7d996cd`、監査 4 回目の反映後）：`npm run verify`（lint・単体 142 ファイル 1827 件・build）成功、`npm run typecheck` 成功。ハリマルの単体 12 ファイル 209 件。`npm run test:e2e` 503 件合格・失敗 0（スキップ 23 は既存の指定。`e2e/harimaruLive.spec.ts` 4 件を含む）、`npm run test:e2e:preview` 38 件合格・失敗 0（スキップ 2）。プリキャッシュ 89 件 3197.33 KiB（`dd69da2` と同じ件数）
- CI（`7d996cd`）：Backtest matches the committed baseline 成功、Build and check the preview page 成功
- 実画面（`7d996cd`、プレビューのビルド・架空の n01・Chromium）：スマホ（Pixel 5 相当）・PC（1280×900）× ライト / ダーク（スタジアム）の 4 通りで、cheer・panic・legWin を演出し、エフェクトは文字・操作部品に重ならない。演出中のスクロール・リサイズでエフェクトがすぐ消える（`stopped:view`）。200% ズーム相当（640×450）は出ず、届いた出来事は捨てる。表示 OFF・動きを減らす設定ではレイヤーがない。架空のライブは Leg 1 だけなので、過去の Leg のタブの実画面確認はできていない（`LiveSheet` を描画する単体テストで確認）。この回の実画面では 180・victory・anxious の演出・frustrated は起きなかった（180・victory・anxious は E2E、frustrated は単体テストで確認）
- プレビュー（架空の n01）で反応を見る手順：「n01から作成」→ ATDO → kalavinka でチームを作る → 観戦 → ライブ。架空のライブは 4 秒ごとに投てきが進み、約 96 秒で同じ Leg をやり直す（やり直した 2 周目は同じラウンドの繰り返しなので反応しない。再読み込みで基準からやり直せる）
- 実画面（本番ビルド・架空の n01・Chromium）：スマホ（Pixel 5 相当）・PC（1280×900）・ライト / ダーク（スタジアム）で、味方の高得点・180・勝利を演出（スコア表の枠の上。180 のボードは正しい向き、右向きの cheer はエフェクトも反転）。立ち位置の上に文字があると見送り（スマホのダークでは 3 種とも見送り）。200% ズーム相当（640×450）は立てる場所がなく出ない
- Codex 監査（CLI、読み取り専用、PR3 から 0 回として数え直し）

| 回 | 指摘（高/中/低） | 反映 | 反映しなかったもの |
|---|---|---|---|
| 1 | 4 / 4 / 0 | 新しい mid・通信失敗後の基準化、勝数の訂正、対戦・味方の切替での取り消し、余白の範囲（1x のにじみ・足元より下）、unitDone の持ち越し、後着・欠損ラウンド、別ゲーム選択中・隠れた画面からの配信、180 の右向き | なし（SetMatchPage は 1 回目では「味方を決められない」として未接続 → 3 回目で接続） |
| 2 | 4 / 3 / 0 | 左右の入れ替わり、終了と合う確定・古い Leg、最大を超えたときだけ、投てきの連続性、終了後の状態、中立での取り消し、1 px のはみ出し | なし |
| 3 | 3 / 2 / 0 | 決着済みのゲーム・Leg の訂正、古い Leg 付きの対戦終了、消えた・変わった投てき、足場消失での待ちの破棄、SetMatchPage の接続 | なし |
| 4（ユーザー承認済み） | 4 / 3 / 0 | 1 ゲームの対戦で古い Leg 付きの終了から勝敗を決めない、Leg の飛び越しの勝数、残り点・フィニッシュの訂正と残り 0 の点、スクロール・リサイズ・ズームでエフェクトを止める、過去の Leg の表示中は流さない、同じ対戦の次のゲーム（mid）で取り消す、演出中は転ばない | なし（**4 回目の反映は再監査していない**。5 回目は新たなユーザー承認が必要） |

- GitHub の自動レビュー（Codex のレビューボット等）は CLI の監査とは別。PR #60 の画面で確認する
- 監査 4 回目のあとの修正（ユーザー指示、Codex 未監査）：過去の Leg の表示による停止を観戦対象（source）ごとにした
  - 再現：単体（`LiveSheet` を描画する reaudit.test.tsx の 4 件）が修正前に失敗。実ブラウザー（開発サーバー・架空の n01 の 2 カードの夜・Chromium PC）で、修正前は右のカードの過去の Leg で左のカードの状態が 0 件（止まる）、修正後は流れる。隠れて保持された一覧の過去の Leg は、修正前は試合のページを開いても停止が残り、修正後は隠れたときに解ける（戻ると再び止める）
  - 試合のページ自身の状態がハリマルへ流れることは、この架空データでは実ブラウザーで確認できていない（単体で確認）
  - 検証（`1f99a1e`）：`npm run verify`（単体 142 ファイル 1831 件）・`npm run typecheck` 成功。`npm run test:e2e` は 502 件合格・失敗 1（PR2 の `harimaru.spec.ts:336` カーソルの動作。立ち止まるのを待つところで時間切れ。同じテストを `1f99a1e` と修正前の `b2e4192` で各 5 回実行して全て合格。変更した経路を通らないため、動きの乱数による時間の揺れと判断）、`npm run test:e2e:preview` 38 件合格。実画面（プレビューのビルド・架空の n01）：スマホ・PC × ライト・ダークで cheer・panic・anxious・legWin を演出、重なりなし、スクロール・リサイズで停止

## 8. 次に進める工程

1. ユーザーが PR3（#60）のプレビュー・動きを確認し、修正事項を指示する（PR2 は実装完了扱い）。
2. ユーザーの明示指示があれば、PR2 → PR3 の順に統合ブランチ `feat/harimaru-integration` へ取り込む（Claude は指示なしに取り込まない）。PR2 をスカッシュで取り込んだ場合は、PR3 の差分が重複しないよう、統合ブランチから新しいブランチを作って PR3 のコミットだけを載せ直す（既存ブランチの force push はしない）。
3. 統合ブランチで PR1〜PR3 の最終検証（全 E2E・実機）をして、ユーザー承認のあと main 向けの最終 PR を作る（本番公開はそのマージで行われる。Claude は承認なしにマージしない）。
4. 追加の Codex 監査は、PR3 の 5 回目、PR1・PR2 の 4 回目とも新たなユーザー承認が必要（PR3 の 4 回目の反映は未監査）。
