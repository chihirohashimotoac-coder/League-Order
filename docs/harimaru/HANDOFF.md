# ハリマル実装 引き継ぎ文書

最終更新：2026-11-19（PR2 に追加素材 v0.9 を組み込み。PR2 ドラフト・ユーザー確認待ち）。秘密情報は記載しない。

> **本番未反映。** ハリマルは main・gh-pages のどちらにも入っていない。本番公開は PR3 の完成・最終検証・ユーザー承認のあと、統合ブランチから main 向けの最終 PR で行う。

## 0. 新しいセッションの開始手順（最初に読む）

### 現在の状態（2026-11-19）

| 項目 | 値 |
|---|---|
| main | `71bc8ad`（ハリマル未反映。変更しない） |
| gh-pages | `ca31842`（71bc8ad の公開分。変更しない） |
| PR1 | [#58](https://github.com/chihirohashimotoac-coder/League-Order/pull/58) `feat/harimaru-pr1-base` → main、HEAD `fd6c147`。**承認済み・マージしない・閉じない** |
| 統合ブランチ | `feat/harimaru-integration` = `fd6c147` |
| PR2 | [#59](https://github.com/chihirohashimotoac-coder/League-Order/pull/59)（ドラフト）`feat/harimaru-pr2-behavior` → `feat/harimaru-integration`。追加素材 v0.9 の組み込みコミットまで（SHA は `git log` と PR を参照）。**ユーザー確認待ち・統合ブランチへ未取り込み** |
| PR3 | 未着手（ブランチ未作成） |
| プレビュー | PR2：https://claude.ai/artifact/6hwBYyRTvLNYcH6bGK23GX ／ PR1：https://claude.ai/artifact/VBPWXXm1Vi9BCDSAQPfYfB（どちらも非公開の claude.ai Artifact） |
| Codex 監査の回数 | PR1：3 / 3（上限）、PR2：3 / 3（上限。3 回目の反映 `62386fb` と、v0.9 の組み込みは未監査。4 回目はユーザー承認が必要） |

### ユーザーの判断待ち（勝手に進めない）

1. PR2 のプレビュー確認と、統合ブランチへの取り込みの承認（承認があれば PR #59 を統合ブランチへマージし、そこから `feat/harimaru-pr3-n01` を分岐して PR3 へ）
2. 追加素材 v0.9 の採用承認（manifest は `EXTRA_ASSETS_PENDING_USER_ACCEPTANCE`）と、組み込んだ動きの見え方
3. 動きの頻度・速さ・隠れ方の見え方（`params.ts` の暫定値。滑る `slipChance` 0.05、寝ぼける `sleepyFallChance` 0.3 など）
4. PR2 の Codex 4 回目の監査の要否（v0.9 の組み込みは未監査）
5. PWA のプリキャッシュ増加（約 +931 KiB、§6）の扱い

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

#### PR2 の完了条件（自己判定）

| # | 条件 | 判定 | 根拠・残り |
|---|---|---|---|
| 1 | 日常・移動・操作の全必須動作 | 要相談 | 素材のある動作は実装。毛づくろい・伸び・滑る/しがみつく/よじ登る・寝ぼけて落ちそう・転ぶ/復帰・驚く・見上げる・首をかしげる・じゃれる・ぶら下がるは素材待ち（発生条件のみ実装） |
| 2 | 発生条件をテストできる | OK | 乱数・時刻・素材の有無・計測を差し替える単体テスト |
| 3 | 機械的に連続しない | OK | 同じ行動の抑制、動く行動は 3 回続かない（単体テスト） |
| 4 | 静かな時間がある | OK | 長時間の抽選で静かな時間が 75% 超（単体テスト）。自然さはプレビュー確認待ち |
| 5 | カード間移動で UI を隠さない | OK | 経路全体の判定、経路がなければ隠れて移る、空中の中断（単体テスト）。画面での重なり 0（エミュレーション） |
| 6 | カード裏への隠れ方が自然 | 要相談 | 上辺の線で切り取るマスク。自然さはプレビュー確認待ち |
| 7 | ぶら下がっても操作を阻害しない | 要相談 | ぶら下がりは素材待ち。描画レイヤーは pointer-events: none のまま |
| 8 | スマホ操作で誤反応しない | OK | 短いタップだけ・余白だけ（単体・E2E）。実機は未確認 |
| 9 | スクロール・画面遷移で破綻しない | OK | スクロール中の中断、画面ごとに作り直す（単体・E2E） |
| 10 | 既存の全画面操作に回帰がない | OK | 既存 E2E 281 件・最終 74 件で失敗 0 |
| 11 | キャラクターなしで従来どおり | OK | 表示 OFF・動きを減らす設定の E2E |
| 12 | 素材不足による未完成動作がない | OK | 素材のない動作は選ばない・描かない（代わりの見た目で埋めない） |

## 8. 次に進める工程

1. ユーザーが PR2 のプレビュー（PC・スマホ）を確認し、修正事項を指示する。
2. ユーザー承認後、PR2 を統合ブランチ `feat/harimaru-integration` に取り込む（Claude は承認なしに取り込まない）。
3. 取り込み後、統合ブランチから `feat/harimaru-pr3-n01` を分岐して PR3（n01 観戦連動）に着手する。
4. 追加素材が届いたら、`clips.ts` の対応表とスプライトを更新し、描画処理を足す（別 PR か、ユーザーが指定する段階で）。
