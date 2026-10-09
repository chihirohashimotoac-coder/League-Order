# n01 Data Model

n01 連携のデータモデル。上位方針は [`N01_MASTER_DESIGN.md`](./N01_MASTER_DESIGN.md)。

## 1. n01 Read API 契約

出典: n01 External Integration API Manual (<https://push.n01darts.com/api/v1/n01_api_manual_en.html>)。
オーナーが公式マニュアルと実データで以下を確認済み (PR #5 `15e467e` のレビュー):
**Base URL・公開 Read API は認証不要・CORS 有効**、および下表の `lg_table` / `lg_title` / `lg_result` のキー /
`league/list` / stats のフィールド名。開発環境からは n01 に接続できない (ネットワークポリシー) ため、
それ以外の細部は `npm run verify:n01` (read-only, CI 非必須) で確認する。差異があれば
`src/integrations/n01/endpoints.ts` (URL) と `src/integrations/n01/validation.ts` (応答形) だけを修正する。

- Base URL: `https://push.n01darts.com/api/v1` (定数 `N01_API_BASE_URL`)。公開 Read API は認証不要、CORS 有効
- 形式: `GET {base}/{operation}?{params}`、匿名 (`credentials: 'omit'`)、`cache: 'no-store'`
- 許可ホスト: `push.n01darts.com` (API) / `n01darts.com` / `www.n01darts.com` (貼り付けられたリーグ URL)。
  https のみ、URL 内認証情報は拒否
- 応答は JSON。`{ data: … }` / `{ result: … }` の包みは剥がす。`{ error: "…" }` はスキーマエラー扱い。
- 応答形は **n01 の実際の形 (第一級) と、当初想定のフラットな形の両方**を受け付ける
  (フィクスチャは ATDO-like / TDO-like が実際の形、TDA-like が当初形)。

| 操作 | パラメータ | 読むフィールド |
|---|---|---|
| `league/list` | `keyword` | `{ result: 0, list: [{ lgid, title }] }` |
| `league/tournament/list` | `lgid` | `title`, `list[].tdid`, `title`, `status` (20 受付 / 25 組み合わせ作成中 / 30 開催中 / 40 終了)、`t_date` (開催日。未設定は `0`)、`createTime` (作成日時。当初形は `start_date`)。一覧は**作成順**なので、Season の新旧は「有効な `t_date` (> 0) → `start_date` 等 → `createTime`」の最初の日時で決める |
| `tournament/get` | `tdid` | (`{ result: 0, tournament: {…} }` の `tournament`) `title`, `lgid`, `status`, `softdarts`, `entry_list[].tpid/name`, `lg_table[division][]` (tpid の配列。`"empty"` は bye でチームではない)、`lg_title[division]` (無ければ `Division N`)、`lg_setting.schedule[]`, `lg_setting.game_setting[].round/schedule[]` (`round` = Division 番号)、`lg_result` (キー `<division>_<lsid>`、例 `0_rqbd` → `rqbd` に正規化し Division は別に保持)。当初形の `lg_table[].lg_title/list[].tpid` と素の `lsid` キーも読む |
| `team/player/list` | `tdid`, `tpid` (省略すると**全チーム**の名簿。`opid` が 1 人を指すかの判定に Season ごとに 1 回使う) | `list[].opid`, `oid`, `tpid`, `oname` |
| `tournament/stats` | `tdid`, `kind=player_stats_list` (団体戦で個人行を得る) | `player_stats_list[]`: `opid`, `tpid`, `oname`, `score`, `darts`, `leg`, `winLeg`, `match`, `f9Score`, `f9Darts`, `highOut`, `best`, `ton00`, `ton40`, `ton70`, `ton80` (`set` / `winSet` / `worst` は未使用)。当初形の snake_case (`legs`, `win_legs`, `first9_score`, `best_leg`, `ton` …) も読む。PPR = `score / darts × 3`、欠損は `null` |
| `league/schedule/get` | `tdid` | マニュアル: `schedule[division][]` = `{ p: [tpid1, tpid2], lsid, t }`。当初形: `list[].lsid`, `title`, `tpid1`, `tpid2`, `date`。空の tpid = bye。`t` は日付文字列またはエポック (秒 / ミリ秒、JST の日付に変換) |
| `team/order/list` | `tdid`, `tpid` | マニュアル: `list[].tmid`, `position`, `order[]` (選手)。当初形: `list[].lsid`, `schid`, `position`, `players[]`。選手は `oid/opid/oname` のオブジェクトか `oid` 文字列。`schid` が無ければ `position` でゲームに対応付ける |

`schedule[]` (試合形式の 1 ゲーム): `schid`, `num_part`, `subTitle`, `match_type`, `startScore`, `limit_leg_count`, `group`
(n01 の名前は `startScore` / `subTitle`。当初形の `start_score` / `subtitle` も読む)。

### 1.1 寛容な抽出と明示的な失敗 (`validation.ts`)

- 数値は number / 数値文字列のどちらも受け付ける。一覧は配列 / id キーのオブジェクトのどちらも受け付ける。
- id の無い行は読み飛ばす (1 行の不備で全体を捨てない)。
- **一覧そのものが無い、または全行が不正** → `N01SchemaError` (= `N01Error` kind `schema`)。
  空のロスターや空の成績を「本物のデータ」として返さない。
- 欠損した数値は `null`。**0 にしない**。

### 1.3 必須でない応答の扱い (Phase 6)

| 応答 | 取得できない (404 / 読めない形) | オフライン / タイムアウト |
|---|---|---|
| `tournament/get`, `team/player/list` | 同期失敗 (`schema` / `notFound`)、何も保存しない | 同期失敗、前回データはそのまま |
| `tournament/stats` | **同期は続行**。PPR は前回値のまま (名簿の照合で対応付いた選手。`opid` が無く Season をまたいで名前で対応付いた選手も含む)、初回なら `null`。変更要約に「n01 の成績データを取得できなかったため…」 | 同期失敗 (成績だけ欠けた中途半端な保存はしない) |
| `league/schedule/get` | 次戦なし (`notes` に記録)、勝利優先で生成 | 同上 |
| 過去 Season の各応答 | その Season を除外 (`notes`) | 同上 |
| 全チームの名簿 (`team/player/list` を `tpid` なしで、今季と各過去 Season に 1 回) | **同期は続行**。その Season は `opid` を証明できない扱いにし、`opid` による Season 間の結合をしない (同一 Season の `oid` 照合は維持。履歴の無い選手は低信頼)。`notes` に記録。**取得できても大会登録チームの一部しか含まない応答 (不完全) も同じ扱い**。登録外のチーム ID が追加で含まれるだけでは不完全としない | 同上 |
| 相手の名簿・オーダー (次戦の分析) | 名簿・形式・PPR は保存し、**前回の分析は削除**する (古い相手を最新として使わない)。次戦は勝利優先で生成、変更要約に注記 | 同上 |

### 1.2 時刻・日付

- `t_date` / `start_date` / `date` / `createTime` は `YYYY-MM-DD` / `YYYY/MM/DD` / `YYYY年M月D日`、月日のみ (`10/8`)、またはエポック (秒 / ミリ秒、数値文字列も可) を解釈する。
  `t_date = 0` (と 0 以下のエポック) は日付として扱わない (実 ATDO では多くの Season が `0`)。
  月日のみの場合は注入された現在時刻に最も近い年を採る。解釈できない日付は `null` (推測しない)。
- `league/tournament/list` の並びは作成順で開催順とは限らないため、Season は上記の日時 (`t_date` → `start_date` 等 → `createTime`) の新しい順に並べる。
  日付が無い Season に限り n01 の並び順を使う。

## 2. 正規化型 (`src/integrations/n01/types.ts`)

`N01LeagueSummary`, `N01TournamentSummary`, `N01Tournament` (`entries` / `divisions` / `schedule` / `gameSettings` / `results`),
`N01RosterPlayer`, `N01PlayerStats`, `N01Fixture`, `N01OrderEntry`。
これ以外の層は生応答を読まない。

## 3. バインディング (`src/domain/n01/types.ts`)

| 型 | 置き場所 | 内容 |
|---|---|---|
| `N01TeamBinding` | `Team.n01` | leagueId/Title, stableIdentity, lastTournamentId/Title, lastTeamId (tpid), lastTeamName, lastDivisionIndex/Title, discipline, managedFormatId, linkedAt, lastSuccessfulSyncAt |
| `N01PlayerBinding` | `Player.n01` | opid, currentOid, currentTpid, sourceName, rosterActive, lastSeenTournamentId, lastSeenAt, stats (`N01PprStats`) |
| `PprSource` | `Player.pprSource` | `n01` / `manual` (未設定 = リンク済みなら n01) |
| `N01FormatSource` | `LeagueFormat.source` | 管理フォーマットの出所 (league / tournament / division / syncedAt) |
| `N01GameMeta` | `GameSlotDef.n01` | schid, numPart, matchType, startScore, limitLegCount, group, subtitle |

すべて**任意フィールド**。既存データ・旧バックアップはそのまま読める (手動チームとして扱う)。

### 3.1 実効 PPR (`domain/n01/effectivePpr.ts`)

| pprSource | n01 PPR | 手動 PPR | 実効値 (origin) |
|---|---|---|---|
| manual | — | x | x (`manual`) |
| n01 (既定) | y | — | y (`n01`) |
| n01 (既定) | なし | x | x (`manual-fallback`) |
| n01 (既定) | なし | なし | `null` (`none`) |

## 4. 永続化

- IndexedDB `darts-league-order` を **v3** に更新し、ストア `n01Cache` を追加 (既存ストアは不変、在置アップグレード)。
- `n01Cache` のレコード: `N01SyncSnapshot` (`sync:<teamId>`) と `N01MatchIntelligenceSnapshot` (`intel:<teamId>`)。
- 同期結果の保存は `StorageBackend.writeBatch` による**単一トランザクション** (IndexedDB)。
  `put` が同期的に失敗した場合もトランザクションを明示的に中止し、半端な保存を残さない。
- JSON バックアップ: バインディング・`pprSource`・`source`・`GameSlotDef.n01` を含める。
  **キャッシュは含めない** (n01 から再取得できる派生データ)。不完全なバインディングは取り込まず手動扱いにする。
- 互換性: v3 の DB を旧ビルド (v2) が開くと VersionError になり、旧ビルドは localStorage フォールバックで起動する
  (ダウングレード時のみ。PWA の通常更新では発生しない)。

## 5. Match Intelligence (Phase 2)

`N01MatchIntelligenceSnapshot` (`src/domain/n01/intelligence.ts`) — 同期のたびに再構築する。

| 項目 | 内容 |
|---|---|
| `nextMatchStatus` / `nextMatch` / `nextMatchOptions` | 次戦 (`resolved` / `ambiguous` / `none`)。`lsid`, raw title, date (解析できた時のみ), our / opponent tpid, 相手名 |
| `games` | 自チームの管理フォーマット (gameId, LogicalGameSignature, 人数, cricket, limitLegCount) |
| `ourPlayers` / `ourStats` | 自チーム名簿と、opid で Season 横断した成績 (`HistoricalPlayerStats`) |
| `opponent` | 相手名簿・成績・`OpponentPositionModel` |
| `leagueMeanPpr` | 全 Season の stats 行の recency 加重 darts 加重平均 (shrinkage の事前分布) |
| `seasons` / `historyDepth` | 使用した Season と重み、取得深さ |
| `orderConfidence` | 相手オーダーモデルの信頼度 |

### 5.1 取得範囲とリクエスト数

既定 `current + 2 previous`。1 同期のリクエスト上限:
Team 4 (tournament list / tournament / roster / stats) + 日程 1 + 相手 roster・orders 2 + 今季の全チーム名簿 1 +
過去 Season ごとに最大 4 (tournament / stats / 全チーム名簿 / 相手 orders)。
既定深さで最大 16。過去 Season の取得失敗は `notes` に記録し同期全体は失敗させない。
実測 (フィクスチャ、`src/integrations/n01/n01Requests.test.ts`): 「次戦のオーダーを作る」の再同期 1 回 = **16 GET、重複 0**
(Season 解決 2 + 名簿・成績 2 + 分析 12)。過去 Season 1 つあたりの追加数は一定。チーム情報 (名簿・成績・形式) だけなら 4。
(全名簿導入前は 13。+3 は今季と過去 2 Season の全チーム名簿。)

### 5.2 Position model

- 観測: 相手チームとしての過去オーダー (その Season に**そのチームで**出たもの) を `signature` に写像。
  Season 横断の写像は `schid` ではなく LogicalGameSignature (`SINGLES|01|2` 等)。
- 縮約: slot → structure (同じ構造の他 slot) → team (他の構造) → base (半分一様 + 半分強度比例)。
  各段は外側の観測だけで作り、同じ観測を二重に数えない。β = `POSITION_PRIOR_STRENGTH` (3) 試合分の席数。
- `probability` は席のシェア (名簿全体で和 1)。k 人ゲームの出場確率はおよそ `min(1, k·probability)`。
- `lineups`: 現名簿のみで構成された観測済みの組合せ (和 1)。
