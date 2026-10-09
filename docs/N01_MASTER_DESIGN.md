# n01 Native Integration + Opponent-Aware Match Optimizer — Master Design

本書は MASTER IMPLEMENTATION SPEC (以下「MASTER SPEC」) を本リポジトリの構造に写像し、
Phase 1〜6 の実装が従う**固定アーキテクチャ**を記録する (Phase 0 成果物)。
以降の Phase で本書と矛盾する実装をしてはならない。変更が必要になった場合は
本書を先に改訂し、その理由を「改訂履歴」に残す。

- 版: 1.0 (Phase 0 — architecture lock)
- 基点: `main` @ `e3e1b88` (PR #4 以降の修正を含む最新 main)
- 既存設計: `docs/DESIGN.md` (v1.0〜v1.4)。本書はその追補であり、既存の判断記録 (D-01〜D-23) を覆さない。

---

## 0. Baseline (Phase 0 時点)

| 項目 | 結果 |
|---|---|
| SHA | `e3e1b88` |
| lint (`eslint .`) | 0 error / 0 warning |
| typecheck (`tsc -p tsconfig.app.json --noEmit` + `tsconfig.node.json`) | 0 error |
| unit / integration / component (Vitest) | 22 files / **332 tests passed** |
| build (`tsc -b && vite build`) | 成功 (precache 14 entries, 539.47 KiB) |
| E2E mobile + desktop (Playwright) | **206 passed** (mobile 103 / desktop 103, 8.4 min) |

注: 既存の `npm run typecheck` (`tsc -b --noEmit false …`) は `tsconfig` の `noEmit` を打ち消し、
`src/**/*.js` を**ソースの隣に出力する**。Vite / Vitest は拡張子解決で `.js` を `.ts` より先に
選ぶため、出力された古い `.js` が編集後の `.ts` を覆い隠す (テスト・ビルドが古いコードで走る)。
Phase 0 ではスクリプトを「出力しない型検査」に修正する (本番挙動は不変)。

### 0.1 既存アーキテクチャの要点 (Phase 1 以降が依存する箇所)

| 領域 | ファイル | 本統合での扱い |
|---|---|---|
| ドメイン型 | `src/domain/types.ts` | `Team` / `Player` / `LeagueFormat` / `GameSlotDef` / `OrderInput` / `OrderSolution` に**任意フィールドのみ**追加。既存フィールドの意味は変えない |
| 読込時アップグレード | `src/domain/normalise.ts` | 新フィールドの既定値はここで補う (保存データは書き換えない, D-23) |
| 戦力 | `src/domain/players/strength.ts` | Rating/PPR の参加者内正規化ブレンド (D-19)。**変更しない**。n01 PPR は OrderInput 構築時に `player.ppr` へ「実効 PPR」として写す |
| 最適化 | `src/optimizer/**` | 3 段探索 (Beam → DFS B&B → Polish)、Combo 単位の加法スコア + 上界。新しい項 `opponentWin` を**加法項として**追加し、最終順位のみ Match 勝率で再評価 |
| プリセット | `src/domain/orders/presets.ts` | `OPPONENT_OPTIMIZED` を追加。既存 5 プリセットの重みは不変 (新項の重み 0) |
| ライフサイクル | `src/domain/orders/lifecycle.ts` | 指紋は配置・ゲーム定義・試合情報のみ。n01 メタは指紋に入れない (共有内容が変わらないため) |
| 版 | `OrderVersion` (deep copy) | 不変。n01 同期は過去の `SavedOrder` / `OrderVersion` を一切書き換えない |
| 永続化 | `src/storage/{db,repository,backup}.ts` | IndexedDB v2 → **v3** (ストア `n01Cache` を追加)。既存ストアのスキーマは不変 |
| 状態 | `src/state/appStore.tsx` | 永続エンティティの唯一の書き込み口。n01 同期結果もここ経由で原子的に保存 |
| 画面 | `src/pages/**` | HOME / Welcome / Players / Formats / Setup / Result / Settings を拡張 |
| 層境界 | `eslint.config.js` | `domain` / `optimizer` は React・DOM・storage・UI・share・**integrations** を import 禁止 (本書で integrations を追加) |

---

## 1. 実行環境上の制約 (Phase 0 で判明)

1. **n01 ホストへの通信がこの開発環境のネットワークポリシーで拒否される**
   (`CONNECT n01darts.com:443 → 403`)。よってライブ API の応答形を本環境で検証できない。
2. n01 の公開 Read API に公開仕様書は見当たらない。本実装は MASTER SPEC に記載された
   **操作名とフィールド名** (`league/tournament/list`, `entry_list`, `lg_table`, `lg_title`,
   `lg_setting.schedule`, `lg_setting.game_setting[].round`, `num_part`, `subtitle`, `match_type`,
   `schid`, `softdarts`, `team/player/list` の `opid/oid/tpid/oname`, `tournament/stats` の
   `player_stats_list` の `score/darts/legs`, `league/schedule/get` の `lsid`, `lg_result`,
   `team/order/list` の `schid/position/players`, `status 20/30/40`) を契約として採用する。
3. したがって以下を設計上の要件とする:
   - **HTTP の具体的な URL 写像は 1 ファイル (`src/integrations/n01/endpoints.ts`) に隔離**する。
     ライブ検証で差異が出た場合の修正範囲をそこと `validation.ts` に限定する。
   - 応答の検証は**寛容な抽出 + 明示的な失敗**: 既知の別名を許容し、必須項目が欠けたら
     `N01SchemaError` を返す (黙って 0 や空で埋めない)。
   - `npm run verify:n01` (read-only ライブ契約テスト、CI 非必須) を用意する。
   - 単体・E2E は**フィクスチャのみ**で完結させる (MASTER SPEC TEST STRATEGY)。
4. ブラウザ (GitHub Pages) から n01 への直接 fetch は n01 側の CORS 応答に依存する。
   公式マニュアルで CORS 有効と確認済み (オーナー、PR #5 レビュー)。通信失敗時はオフライン経路 (前回データ) へ確実に落とす。

---

## 2. Data Ownership (Non-negotiable 1)

| 情報 | 所有者 | 保存先 | 同期時の扱い |
|---|---|---|---|
| League / Season / Division / Format / Schedule / Opponent / Past Orders / Stats / PPR(n01) | **n01** | `n01Cache` ストア (スナップショット) + 下記バインディング | 毎同期で再解決・上書き |
| Roster (登録選手の集合・n01 上の名前) | **n01** | `Player.n01` バインディング | 追加・更新・不在は `rosterActive=false` (削除しない) |
| Rating / ゲーム適性 / ペア相性 / メモ / 当日参加 / 出場不可 / 最大出場 / ロック / キャプテン方針 / 手動 PPR | **League Order (local)** | 既存フィールド | **同期で決して上書き・削除しない** |
| 保存済みオーダー・確定版 | **League Order** | `orders` (immutable versions) | **同期で決して書き換えない** |

- n01 由来の値は `n01` 名前空間 (`Team.n01`, `Player.n01`, `LeagueFormat.source`, `GameSlotDef.n01`) に
  置き、ローカル値と同じフィールドを共有しない。唯一の例外は `Player.name` で、
  名簿は n01 所有のため同期で n01 名に更新する (過去オーダーは自分のスナップショット名を保持)。
- **実効 PPR 規則** (`domain/n01/effectivePpr.ts`):
  1. `player.pprSource === 'manual'` → `player.ppr` (手動値)。
  2. それ以外で n01 リンク済み → n01 の PPR (`score / darts * 3`) が数値ならそれ。
  3. n01 PPR が無い (`darts <= 0` / stats 無し) → 手動値 `player.ppr` があればそれ (フォールバック明示)、無ければ `null`。
  4. `null` は Unknown。**0 として扱わない** (D-06/D-19 と同じ)。
  - リンクしていない選手の既定ソースは `manual`、リンク済みは `n01`。
  - オーダー生成時は `OrderInput.players[].ppr` に実効 PPR を書いて snapshot する
    (最適化エンジンは無変更で、保存オーダーは生成時の値で再現できる)。

---

## 3. Source Identity

### 3.1 League
`N01LeagueRef { leagueId: 'lg_…', title }`。既知リーグ (Quick Choice):

| 表示 | leagueId |
|---|---|
| ATDO | `lg_l3hI_3397` |
| TDO | `lg_3qgW_6619` |
| TDA | `lg_Ev9v_7379` |

**League identity のみを定数化**する。Tournament (Season) ID・Team ID は定数化禁止。
その他のリーグは League 検索 (`league/list?keyword=`) または n01 の URL / ID 貼り付け (厳格に検証) で追加する。

### 3.2 Season (Tournament)
毎同期で `league/tournament/list` から再解決する:
`status 30 (開催中)` → `status 25 (組み合わせ作成中)` → `status 20 (受付/準備)` → `status 40 (終了) の最新`。
Season の新旧は「有効な `t_date` (> 0) → `start_date` 等 → `createTime`」の日時で判断する (`league/tournament/list` の並びは作成順のため。`t_date = 0` は未設定)。
`status 25 / 20` は**最新の終了 Season より新しい場合だけ**現 Season の候補とする。古いまま残った大会 (例: 事務局の検証用大会が 25 のまま) が
最新の終了 Season を隠さないため。どちらかの日時が分からない場合は古いと判断できないので候補に残す。`status 30` は従来どおり最優先。
同順位が複数ならチーム所属 (entry_list にチームの同一性が一致するもの) で絞る。それでも複数ならユーザーが選ぶ。
タイトル文字列からは判断しない。
**時間を遡らない**: 連携済みチームが前回同期した Season より古い Season にしか見つからない場合
(多くはチーム名の変更) は「チームが見つかりません」とし、古い Season へ黙って同期し直さない。

### 3.3 Team
- `tpid` は Season スコープ。**永続 ID にしない**。
- `stableIdentity`: n01 の安定 ID が応答にあればそれ (`{kind:'n01', value}`)、
  無ければ `{kind:'name', value: normalizeName(teamName)}` (League 内スコープ)。
- `normalizeName`: NFKC → 前後空白除去 → 連続空白を 1 つ → 英字小文字化。**それ以上の曖昧化はしない**。
- 自動の fuzzy remap は禁止。一致しなければ「チームが見つかりません」→ ユーザーが選び直す。

### 3.4 Player
- `opid` は n01 の安定 ID だが、**常に 1 人を指すとは限らない** (実 ATDO 2026 3rd 名簿で別人 2 名が `02-0111`、
  過去の「助っ人」は 1 つの `opid` を多数が共有)。判定は `domain/n01/identity.ts`:
  1. **同一 Season の中では `oid` が最優先**。`oid` は同じ Tournament の中でその行 (名簿・成績・オーダー) を指す手掛かりで、
     同じ行同士を結ぶのに使う。ただし「1 人に `oid` が 1 つ」とは確認できていない (下記 2 の例)。
  2. `opid` で Season をつなぐのは、**関わるすべての Season の行の中で 1 人を指す `opid` だけ**。
     「1 人」とは、同じ Season の行 (成績・名簿・オーダー) で、同じ `opid` に付く正規化名が 1 つであること。
     名前が異なる行が同じ `opid` を持てば共有。共有ラベル (助っ人 / ゲスト / guest …) は常に共有。
     **名前が同じでも、同じ Season の行で同じ `opid` に別の `oid` が付けば共有**扱い (同姓同名の別人か、同一人物かを
     行だけでは区別できないため、結合しない)。公開データで確認できた事実は次の範囲に限る: 実 ATDO 2026 3rd の
     `team/player/list` に、同じ表示名「西俣 太陽」・同じ `opid` `02-0109` で `oid` が異なる 2 行 (`alpp` = HsGD、
     `gm3v` = WpZb) があり、`player_stats_list` の成績行は `gm3v` の 1 行だけ。**この 2 行が同一人物かどうかは未確認**
     (所属変更・兼務・同姓同名のいずれとも断定しない)。現実装では `oid` ごとにその Season の行だけを使い、`opid` による
     Season 間の履歴結合・別 `oid` の行の流用はしない。このため `alpp` 側には `gm3v` の成績・履歴が使われず、
     Unknown / LOW になる (他人の成績を渡さない代わりに、同一人物だった場合の成績・履歴が使えなくなる損失)。
     **「その Season の行」には全チームの名簿を含める。** 成績・オーダーは出場した人しか示さないため、片方の `oid` にしか
     成績が無くても、全名簿に同じ `opid` の別 `oid` があれば共有と判定できる。全名簿は今季と参照する過去 Season ごとに
     1 回だけ取得する (`team/player/list` を `tpid` なしで)。
     **全名簿は「大会登録チームをすべて含む」ときだけ証拠として使う** (`rosterCoverage`、`domain/n01/identity.ts`)。
     形式が正しく HTTP が成功しても、登録チームの一部しか返らない応答では、欠けたチームに同じ `opid` の別 `oid` の
     未出場者がいても見えないため。登録チーム ID が 1 つでも欠ければ不完全として扱う。応答に**登録外のチーム ID**が
     含まれることは問題にしない (ライブ応答では ATDO・TDO・TDA のすべてで 1・3・5 件含まれるが、理由は不明)。
     登録チームが 0 件の大会は照合先が無いため、完全とは扱わない。
     **取得に失敗した Season、または不完全な応答だった Season は `opid` を証明できない**ものとして、その Season では
     `opid` を一切信用しない (Season 間の結合なし)。同一 Season の `oid` 照合は維持し、履歴の無い選手は低信頼の
     フォールバック (自分の現在値) に落ちる。今季の応答が不完全なら、全選手の過去 Season への結合が保留される。
     失敗・不完全は `notes` に記録し、同期全体は失敗させない。残存リスク: メンバーが 0 人の登録チームがあると、
     その Season は不完全として扱われる (安全側)。
  3. 共有 `opid` の人は、その Season の `oid` で区別するだけ。過去 Season の行は誰にも渡さず Unknown / LOW。
  4. 異なる Season で名前が変わるのは改名として、`opid` が一意なら追う。チーム変更も、Season ごとに `oid` が1つなら同じ。
     (同じ Season 内で `oid` が複数になる場合は上記のとおり結合しない。将来結び付けるなら、本人確認を経た特定の
     レコードだけを対象にする。`opid` 単位や条件の一括解除はしない。)
  5. 選手キー (`playerKey`) は一意な `opid`、でなければ `oid:<tdid>:<oid>`。旧キャッシュで共有 `opid` を 1 人に
     まとめていたものは、複数の選手が 1 つの履歴を取り合うため**誰にも渡さない** (自分の PPR のみ・LOW)。
- `opid` が無い応答: 同一 Tournament 内の `oid`、次に**正規化名の完全一致** (チーム内)。
  曖昧 (同名複数) なら自動対応付けしない。
- 既存 (手動) チームの n01 接続時: `opid` → 正規化名完全一致 → 手動解決。fuzzy merge 禁止。
- 手動で追加したメンバー (次戦確認の「次回から参加するメンバーを追加」) との照合は §4.2。

---

## 4. Sync Architecture

```
src/integrations/n01/        ← ネットワーク境界 (React / storage 非依存)
  endpoints.ts      操作名 → URL 写像 (唯一の HTTP 契約箇所)
  client.ts         N01Client: transport 注入可能 (fetch / fixture)、timeout、エラー分類
  types.ts          生応答の型 (未検証) と正規化後の型
  validation.ts     生応答 → 正規化型 (寛容な抽出・明示的失敗)
  leagueRegistry.ts 既知リーグ + URL/ID 解析 (URL 検証)
  seasonResolver.ts / teamResolver.ts / divisionResolver.ts / formatResolver.ts
  statsResolver.ts / rosterResolver.ts / scheduleResolver.ts
  history.ts        過去 Season の取得 (depth 上限)
  sync.ts           オーケストレーション: client + clock を注入、段階進捗を通知
src/domain/n01/              ← 純粋ドメイン (バインディング型・実効 PPR・ロスター差分・変更検知)
src/domain/prediction/       ← 純粋な予測モデル (Phase 3)
src/state/n01Session.ts      ← React 側: 同期の起動・進捗・キャッシュ読込 (appStore 経由で保存)
```

- React から fetch を直接呼ばない。UI は `state/` のフックだけを使う。
- Optimizer / domain は `integrations/` を import しない (ESLint で強制)。Optimizer から HTTP は不可能。
- 時刻は `now: () => number` を注入。テストは固定時刻。乱数は使わない。
- 書き込みは Read のみ。n01 の write 系 API・認証・トークンは一切使わない。
- 同期 1 回のリクエスト数は上限を持つ (Season 1 + Tournament 1 + 自チーム roster 1 + stats 1 +
  schedule 1 + 相手 roster 1 + 相手 orders 1 + 今季の全チーム名簿 1 + 履歴 (depth×(Tournament+stats+全チーム名簿))。
  重複は 1 同期内でメモ化)。

### 4.1 同期結果の適用 (原子的)

`planN01Sync(current, fetched) → N01SyncPlan` (純関数) が
`{ team, upsertPlayers[], managedFormat, cache, changes: N01ChangeSummary }` を作り、
`appStore.applyN01Sync(plan)` が 1 回の操作で保存する。プレビュー (Team 作成) は plan を表示してから確定する。

### 4.2 Roster 同期規則
| n01 | ローカル | 動作 |
|---|---|---|
| 新規 | 無し | Player を追加 (Rating=null, PPR source=n01) |
| 既存 | 有り | `n01` バインディング・名前を更新。**ローカル項目は保持** |
| 不在 | 有り | `rosterActive=false`。削除しない。参加者の既定 include を false |
| 新規 | 手動メンバー (n01 未連携) | 下記。確実なときだけ自動で結び付け、迷うときは作業者に確認 |

照合の順: 作業者の明示選択 → `opid` (n01 名簿と手元のどちらでも 1 人を指すときだけ) → 同一 Season の `oid` →
正規化完全一致の名前 (n01 側・ローカル側とも一意のときだけ)。それより曖昧なものは自動で結び付けない。

**手動メンバーとの照合 (`deferAmbiguous`、次戦フロー・再同期)**: 上の順で結び付けられない n01 選手のうち、
手動メンバー (n01 未連携・休止でない) かもしれないものは、**追加せず `pending` として保留**する。
同名の候補が複数ある、綴りの違い (空白など) がある、別名かもしれない、のいずれも同じ扱い。
作業者は候補を見て「同一人物 / 別の人」を選ぶ (初期選択なし)。同一人物なら手動メンバーが n01 に結び付き、
**ローカル ID・Rating・適性・シーズン累計・手動 PPR の方針は維持**されて名前だけ n01 のものになる。別人なら新規追加。
「あとで」なら保留のまま: **手動メンバーは今回の参加候補に残り** (n01 未連携のまま、n01 の成績は使わない)、保留した n01 の行は新規作成も結び付けもせず今回の候補にも出ない (次の同期で再度確認)。誤マージ・別名の黙認・二重作成をしない。
既存のウィザード (チームを n01 と接続) は従来どおり全員を作業者が対応付けるため保留を使わない。

---

## 5. Snapshot Model (Non-negotiable 2, 3, 4)

| スナップショット | 内容 | 保存先 | 寿命 |
|---|---|---|---|
| `N01SyncSnapshot` | Season / Division / Format / 自チーム roster+stats / 取得時刻 | `n01Cache` (`sync:<teamId>`) | 次の同期で置換 |
| `N01MatchIntelligenceSnapshot` | 次戦・相手 roster/stats・過去成績・相手の位置分布・形式・サンプル数・generatedAt | `n01Cache` (`intel:<teamId>`) | 次の同期で置換 |
| `OrderInput.opponent` (`OpponentContext`) | **最適化と再現に必要な最小限**: ゲームごとの相手分布 (強さ・確率)、自選手の予測強度・信頼度、Match ルール、生成時刻 | `orders` (SavedOrder 内) | 不変 |

- `SavedOrder` に live cache 全体を埋め込まない。
- キャッシュは JSON バックアップに含めない (n01 から再取得できる派生データ)。バインディングは含める。
- **鮮度表示**: キャッシュの `fetchedAt` と現在時刻から経過時間を出す。
  `STALE_WARN_MS = 24h` で注意、`STALE_DANGER_MS = 48h` で警告。
  通信失敗時は「前回: 10/6 20:15」を明示し、ユーザーが [前回データで続ける] を選んだ場合のみ使う。
  古いキャッシュを「最新」と表示しない (`n01 ✓ 最新` は今回の同期が成功した時だけ)。
  具体的には、**このアプリセッション内で同期が成功してから `LATEST_WINDOW_MS` (30 分) 以内**だけ。
  再起動後に読み戻したキャッシュは、取得直後であっても経過時間で表示する (セッション時刻は永続化しない)。

### 5.1 次戦フロー (Phase 5)

HOME の NEXT MATCH カード → [次戦のオーダーを作る] の 1 操作で:

1. 同期 (設定「次戦のオーダーを作る前に n01 と同期する」が既定 ON): Season → Team → Roster → PPR →
   Format → 相手 → 分析 → 1 バッチで保存。相手分析だけが失敗した場合は残りを保存し、変更要約に注記する。
2. 重要な変更 (メンバー追加/登録外・フォーマット・Division・相手) があれば要約を出し、確認後に進む。
3. Season が複数・次戦が複数 → 選択。次戦なし → 手動フローへ。Team が見つからない → 再リンク。
4. 参加確認: n01 登録中かつ未アーカイブの選手のみ。初期値は作業中オーダー (同じチームのもの) →
   最後に保存したオーダー → 全員 の順。推測で外さない。
5. 生成: 相手データあり → 対戦相手最適化 (4 案比較)、なし → 勝利優先。SETUP と同じ入力を作るので、
   SETUP に戻って調整できる。
6. 通信失敗: 「前回: 日時 (経過)」と「このデータは最新ではありません」を出し、
   [前回データで続ける] を選んだ時だけ前回データを使う。

---

## 6. Phase Boundaries

| Phase | 追加するもの | してはいけないこと |
|---|---|---|
| 1 | n01 provider・League/Season/Team/Division/Roster/PPR/Discipline/Format 同期・managed format・Team 作成 / 既存接続 UI | 予測・最適化の変更 |
| 2 | 次戦解決・相手 snapshot・過去 Season・opid 横断・recency・過去オーダー→位置分布・信頼度・Intelligence snapshot | Optimizer への入力 |
| 3 | `domain/prediction/*` (純粋): 強度・shrinkage・logistic・pair/team・相手不確実性・Poisson-binomial・信頼度・説明・backtest | Optimizer 依存 |
| 4 | `OPPONENT_OPTIMIZED`・`opponentWin` 項・Match 勝率による再評価・候補比較・低信頼時の重み減衰・フォールバック | Hard 制約の変更・既存プリセットの挙動変更 |
| 5 | HOME 次戦カード・ワンボタンフロー・進捗・変更要約・参加確認・オフライン/鮮度・Team/Format/Settings | 過剰な設定画面 |
| 6 | 時系列 backtest・較正・感度・疎データ・エラーケース・性能・a11y・PWA・最終 docs | 「念のため」の機能追加 |

---

## 7. Opponent Model (Phase 2)

- **次戦**: `league/schedule/get` の現 Division の試合のうち自チーム tpid を含み、`lg_result` で終了しておらず、
  bye でない最初の試合。曖昧 (同順位に複数) ならユーザーが選ぶ。保存: `lsid / raw title / date (解析できた時のみ) / our tpid / opponent tpid`。
- **履歴深さ**: 既定 `current + previous 2 seasons` (`HISTORY_DEPTH_DEFAULT = 2`、設定で 0〜4)。全履歴は取得しない。
- **Recency weight** (定数・較正可能): current `1.0` / previous `0.6` / two ago `0.35` / それ以前 `0.2`。
- **opid 横断**: 選手成績は opid で Season をまたいで集計 (移籍しても同一人物)。
  チームのオーダー分析は「その Season にそのチームで出たオーダー」だけを使う。
- **LogicalGameSignature**: `STRUCTURAL|MATCHTYPE|ordinal` (例 `SINGLES|01|1`, `DOUBLES|01|2`, `TEAM|01|1`)。
  `schid` は Season で変わるため Season 横断比較に使わない。subtitle は補助情報のみ。
- **OpponentPositionModel**: signature ごとに `{playerId(opid), appearanceCount(weighted), sampleCount, probability}`。
  サンプル不足は**チーム全体の出場率**と**選手強度**の事前分布へ shrinkage
  (`POSITION_PRIOR_STRENGTH = 3` 試合相当)。分布は常に和 1。未来のオーダーを断定しない。
- **Confidence** (定数): Player = legs/darts/matches/seasons、Order model = past orders/position samples から LOW/MEDIUM/HIGH。

## 8. Probability Model (Phase 3)

すべて `src/domain/prediction/` の純関数。ブラックボックス ML は使わない。

1. **選手強度** (3DA = PPR 尺度): Season ごとの `score/darts*3` を recency 重み付き darts で加重平均し、
   リーグ平均へ shrink: `adj = (n·x + k·μ) / (n + k)`、`n` = 実効 legs、`k = PRIOR_LEGS = 30`。
   First9 / leg 勝率は**取得できた場合のみ**小さな補正 (上限付き)。欠損は無視 (0 にしない)。
2. **1 対 1**: `P_leg = 1 / (1 + exp(-K_LEG · (S_A − S_B)))`、`K_LEG = 0.09` / PPR 点。
   `limitLegCount` (先取レッグ数) が分かれば `P_game = P(先に m レッグ取る)` (負の二項)。不明なら 1 レッグ相当。
   Cricket は PPR 相関が弱いため `K_CRICKET_FACTOR = 0.6` を掛け、信頼度を 1 段下げる。
3. **Doubles / Trios / Team / Gallon**: 構成員強度の平均 (5 名以上は両端を除く trimmed mean) + ペア相性補正
   (VERY_GOOD +1.5 / GOOD +0.75 / NEUTRAL 0 / DISCOURAGED −1.5 PPR 点)。
4. **相手不確実性**: `E[P_game] = Σ_lineup q(lineup) · P(our vs lineup)`。
   Singles は分布の厳密混合、Doubles は観測組合せ (十分なら) または周辺分布の積から作るペア分布、
   3 名以上は平均場近似 (期待強度)。
5. **Match 勝率**: 各ゲーム勝率 `p1..pn` から **Poisson-binomial DP** で `P(W ≥ need)`。
   `need = floor(n/2)+1`、`n` 偶数なら `P(draw)=P(W=n/2)`。単純平均は使わない。
   ゲームは独立と近似する (同一選手が複数ゲームに出るため厳密には独立でない — UI/docs に明記)。
   ゲーム勝率ベクトル → 結果分布の計算は差し替え可能なインターフェース (`MatchOutcomeModel`) とし、
   将来 Monte Carlo (シード固定) へ交換できる。
6. **表示**: 「推定勝率」「参考値 (データ不足)」「信頼度 高/中/低」。「確実」「必勝」等は使わない。
   %表示は整数 (過剰な精度を出さない)。

## 9. Optimizer Integration (Phase 4)

- `ScoreWeights.opponentWin` (旧データは 0 で補完)。Combo ごとに
  `winProb = E[P_game]` を前計算し、`OpponentWin = mean_g winProb_g` (= 期待勝ちゲーム数 / n) を
  他の加法項と同様に Score・上界 (suffix max)・説明に使う。既存プリセットは重み 0 で**数値も探索も不変**。
- `OPPONENT_OPTIMIZED` 重み (基準): opponentWin 2.4 / strength 0.3 / gameFit 0.45 / pairFit 0.35 /
  fairness 0.9 / roleFairness 0.3 / consecutive 0.5 / season 0.05。fairness・roleFairness・consecutive は
  バランスと同水準の Soft として残す (v1.1 で改訂、理由は `OPPONENT_OPTIMIZER.md` §3)。
- **ロバスト化**: `effectiveOpponentWeight = base × confidenceFactor`
  (HIGH 1.0 / MEDIUM 0.7 / LOW 0.35)。減らした分は strength へ移す (不確かな推定に全体を賭けない)。
- **最終順位**: 探索で得た完全解の候補プール (beam 解 + B&B 最良 + polish) のうち、
  重み付きスコアが最良から許容幅 (`RERANK_SCORE_TOLERANCE`) 内のものを **Match 勝率** (+ 引分 0.5) で再評価して選ぶ。
  公平性は許容幅で担保される (公平性を大きく犠牲にした解はプールに入らない)。
- **候補比較**: OPPONENT_OPTIMIZED 選択時は `対戦相手最適化 / 勝利優先 / バランス / 公平性優先` の 4 案。
  相手情報がある限り全候補に `prediction` (推定 Match 勝率・期待勝ちゲーム数・信頼度・ゲーム別) を付ける。
- **Hard 制約**: 既存の候補生成・`canPlace`・`validateHardConstraints` をそのまま通る。新項は Soft のみ。
- **フォールバック**: 相手情報が無い → プリセット非表示。stats 不足 → 「対戦データ不足」を表示し通常最適化 (勝利優先の重み)。

## 10. Offline Behavior

- アプリ本体・最適化・共有は従来どおり完全オフライン (PWA)。
- n01 同期失敗 (ネットワーク / CORS / タイムアウト / スキーマ) は分類して表示し、
  キャッシュがあれば「前回: 日時」と [前回データで続ける] [再試行] を出す。自動で前回データを使わない。
- キャッシュが無く同期もできない場合、n01 チームでも手動フロー (既存の SETUP) はそのまま使える。
- Service Worker は n01 応答をキャッシュしない (古いデータを最新と誤認させないため)。

## 11. 定数一覧 (較正対象)

| 定数 | 値 | 場所 |
|---|---|---|
| `RECENCY_WEIGHTS` | [1.0, 0.6, 0.35, 0.2] | `domain/n01/recency.ts` |
| `HISTORY_DEPTH_DEFAULT` | 2 | 同上 |
| `PRIOR_LEGS` | 30 | `domain/prediction/playerStrength.ts` |
| `K_LEG` | 0.09 | `domain/prediction/matchup.ts` |
| `K_CRICKET_FACTOR` | 0.6 | 同上 |
| `PAIR_AFFINITY_PPR_BONUS` | +1.5 / +0.75 / 0 / −1.5 | `domain/prediction/teamMatchup.ts` |
| `POSITION_PRIOR_STRENGTH` | 3 | `domain/n01/positionModel.ts` |
| `CONFIDENCE_THRESHOLDS` | 下記 (Phase 2) | `domain/prediction/confidence.ts` |
| `CONFIDENCE_WEIGHT_FACTOR` | HIGH 1.0 / MEDIUM 0.7 / LOW 0.35 | `domain/orders/presets.ts` |
| `SKEW_GAIN_THRESHOLD` | 2pt × steps² (MEDIUM ×1.5、LOW は偏りなし) — provisional | `optimizer/skewGate.ts` |
| `STALE_WARN_MS` / `STALE_DANGER_MS` | 24h / 48h | `domain/n01/freshness.ts` |
| `LATEST_WINDOW_MS` | 30 分 (セッション内のみ) | 同上 |

## 12. 改訂履歴

| 版 | 内容 |
|---|---|
| 1.0 | Phase 0: アーキテクチャ固定 |
| 1.1 | Phase 4: 対戦相手最適化の公平性の重みをバランス水準へ改訂 (fairness 0.3 では退化解になることをテストで確認したため) |
| 1.2 | Phase 6: 成績 (stats) の欠落を同期失敗にしない (PPR は前回値)、連携チームを古い Season へ戻さない (§3.2)、4 案比較をスマホで 2 × 2 表示 |
| 1.3 | レビュー対応: API オリジン `push.n01darts.com/api/v1`、実 n01 の応答形 (`lg_table` / `lg_title`、`lg_result` キー正規化、`league/list`、stats camelCase、日程・オーダー行、`format` の `startScore` / `subTitle`) に対応。Season の新旧を `t_date` で判断 (一覧は作成順)、`status 25` (組み合わせ作成中) を現 Season の候補に追加、成績欠落時の PPR 保持を名簿照合の結果に合わせる (名前で対応付いた選手も保持) |
| 1.4 | オーナーの実データ確認: `t_date = 0` は未設定として `createTime` で代替、最新の終了 Season より古い `status 25 / 20` は現 Season にしない (§3.2) |

## 13. Phase 6 検証の対応表

| 仕様 | 確認しているテスト |
|---|---|
| §1–2 時系列 backtest・指標・較正 | `src/domain/prediction/calibration.test.ts` (3 リーグ、過信の検出)、`npm run backtest` |
| §3 Optimizer backtest | `src/optimizer/orderBacktest.test.ts` (時間旅行リプレイ 40 試合) |
| §4 感度 | 同上 (8 通りの変更) + `calibration.test.ts` (27 通りの格子) |
| §5 疎データ (0 試合・1 試合・少 legs・新選手) | `src/optimizer/sparsity.test.ts` |
| §6 エラー: API 停止 / 途中停止 / 不正 JSON・スキーマ変更 / 成績欠落 / 日程欠落 / 同名 / opid 欠落 / チーム改名 / Season 重複 / Division 移動 / 不戦 / 次戦なし | `src/integrations/n01/n01ErrorCases.test.ts` (各 1 件)、不正 JSON は `n01Sync.test.ts` |
| §7 性能・リクエスト数 | `src/integrations/n01/n01Requests.test.ts`、`npm run backtest` §4 |
| §8 a11y (320 / 375 / 390 / 412 / 768 / 1280) | `e2e/n01.spec.ts` (axe WCAG 2.1 AA + 横スクロールなし) |
| §9 PWA (offline / update / cache / install) | `e2e/n01Pwa.spec.ts` (SW 有効時のオフライン、n01 応答を SW がキャッシュしない)、`src/pwa.dom.test.ts` (更新は明示操作のみ)、既存 `e2e/vnext.spec.ts` (manifest) |
| §10 画面確認 | `SCREENSHOTS=<dir> npx playwright test e2e/screenshots.spec.ts --project=mobile` (15 画面) |
| §11 セキュリティ | `src/security.test.ts` (危険な HTML・資格情報・GET 以外・URL 検証) |

### 13.1 既知の制約

- **公式マニュアルで確認済み (オーナー)**: Base URL `https://push.n01darts.com/api/v1`、公開 Read API は認証不要、CORS 有効。
  実データとの照合で見つかった差 (`lg_table` / `lg_title`、`lg_result` のキー、`league/list`、stats の camelCase) は反映済み。
- **開発環境からはライブ API を呼べない** (ネットワークポリシーで 403)。上記以外の細部 (例: `team/order/list` の行の形、
  日程の `t` の形式) は実データでの再確認が望ましい (`npm run verify:n01`)。当初想定の形も引き続き受け付ける。
- 予測と対戦相手最適化の数値は合成データでのみ検証済み (PREDICTION_MODEL.md §9)。
