# n01 Data Model

n01 連携のデータモデル。上位方針は [`N01_MASTER_DESIGN.md`](./N01_MASTER_DESIGN.md)。

## 1. 想定する n01 Read API 契約 (要ライブ検証)

> **重要**: 開発環境から n01 への通信がネットワークポリシーで拒否されたため、
> 以下の契約は MASTER SPEC に記載された操作名・フィールド名から組み立てた**想定**である。
> `npm run verify:n01` (read-only, CI 非必須) を n01 に到達できる環境で実行し、
> 差異があれば `src/integrations/n01/endpoints.ts` (URL) と
> `src/integrations/n01/validation.ts` (応答形) の 2 ファイルだけを修正する。

- Base URL: `https://n01darts.com/n01/api` (定数 `N01_API_BASE_URL`)
- 形式: `GET {base}/{operation}?{params}`、匿名 (`credentials: 'omit'`)、`cache: 'no-store'`
- 許可ホスト: `n01darts.com` / `www.n01darts.com` (https のみ、URL 内認証情報は拒否)
- 応答は JSON。`{ data: … }` / `{ result: … }` の包みは剥がす。`{ error: "…" }` はスキーマエラー扱い。

| 操作 | パラメータ | 読むフィールド |
|---|---|---|
| `league/search` | `q` | `list[].lgid`, `title` |
| `league/tournament/list` | `lgid` | `title`, `list[].tdid`, `title`, `status`, `start_date` |
| `tournament/get` | `tdid` | `title`, `lgid`, `status`, `softdarts`, `entry_list[].tpid/name`, `lg_table[].lg_title/list[].tpid`, `lg_setting.schedule[]`, `lg_setting.game_setting[].round/schedule[]`, `lg_result` |
| `team/player/list` | `tdid`, `tpid` | `list[].opid`, `oid`, `tpid`, `oname` |
| `tournament/stats` | `tdid` | `player_stats_list[].opid/oid/tpid/oname/score/darts/legs/win_legs/first9_score/first9_darts/high_out/best_leg/ton/ton40/ton70/ton80/matches` |
| `league/schedule/get` | `tdid` | `list[].lsid`, `title`, `tpid1`, `tpid2` (空 = bye), `date` |
| `team/order/list` | `tdid`, `tpid` | `list[].lsid`, `schid`, `position`, `players[].oid/opid/oname` |

`schedule[]` (試合形式の 1 ゲーム): `schid`, `num_part`, `subtitle`, `match_type`, `start_score`, `limit_leg_count`, `group`。

### 1.1 寛容な抽出と明示的な失敗 (`validation.ts`)

- 数値は number / 数値文字列のどちらも受け付ける。一覧は配列 / id キーのオブジェクトのどちらも受け付ける。
- id の無い行は読み飛ばす (1 行の不備で全体を捨てない)。
- **一覧そのものが無い、または全行が不正** → `N01SchemaError` (= `N01Error` kind `schema`)。
  空のロスターや空の成績を「本物のデータ」として返さない。
- 欠損した数値は `null`。**0 にしない**。

### 1.2 時刻・日付

- `start_date` / `date` は `YYYY-MM-DD` / `YYYY/MM/DD` / `YYYY年M月D日`、または月日のみ (`10/8`) を解釈する。
  月日のみの場合は注入された現在時刻に最も近い年を採る。解釈できない日付は `null` (推測しない)。
- `start_date` が無い場合、`league/tournament/list` は **n01 の並び順 = 新しい順** と仮定する (要ライブ検証)。

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
Team 4 (tournament list / tournament / roster / stats) + 日程 1 + 相手 roster・orders 2 + 過去 Season ごとに最大 3 (tournament / stats / 相手 orders)。
既定深さで最大 13。過去 Season の取得失敗は `notes` に記録し同期全体は失敗させない。

### 5.2 Position model

- 観測: 相手チームとしての過去オーダー (その Season に**そのチームで**出たもの) を `signature` に写像。
  Season 横断の写像は `schid` ではなく LogicalGameSignature (`SINGLES|01|2` 等)。
- 縮約: slot → structure (同じ構造の他 slot) → team (他の構造) → base (半分一様 + 半分強度比例)。
  各段は外側の観測だけで作り、同じ観測を二重に数えない。β = `POSITION_PRIOR_STRENGTH` (3) 試合分の席数。
- `probability` は席のシェア (名簿全体で和 1)。k 人ゲームの出場確率はおよそ `min(1, k·probability)`。
- `lineups`: 現名簿のみで構成された観測済みの組合せ (和 1)。
