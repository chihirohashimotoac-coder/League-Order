# Darts League Order Optimizer — 設計記録 (Design Record)

本書は実装前フェーズ (要件整理 → 設計 → 判断記録) の成果物である。
仕様で「設計してから実装せよ」と指示された項目、および
「合理的な Default を決定し、その判断を記録せよ」と指示された項目をすべて記載する。

- 版: 1.0
- 対象: MVP (仕様 §33) + 完了条件 (仕様 §39)
- 作成: 実装開始前

---

## 1. 要件整理 (Requirement Summary)

### 1.1 プロダクトの目的

ダーツリーグの試合直前に、キャプテンがスマートフォンで

1. 参加メンバーを選ぶ
2. 当日の出場条件 (欠席・遅刻・早退・出場不可ゲーム) を入れる
3. 方針 (プリセット) を選ぶ

だけで、**実戦に投入できるオーダー候補**を得る。

重要な設計方針は「**全自動確定ではなく、合理的候補の提示 + キャプテンによる最終判断**」である。
したがって以下は同格の必須機能として扱う。

- 自動生成
- 手動編集
- ロック
- 部分再最適化
- Undo
- 生成理由の提示

### 1.2 利用シナリオ (当日運用)

| # | シナリオ | 必要機能 |
|---|---|---|
| S1 | 事前にメンバー / Rating / 適性を登録 | Players, Teams |
| S2 | リーグのゲーム構成を登録 | Formats |
| S3 | 当日の参加者を確定し生成 | Order Setup → 生成 |
| S4 | 「この枠は A で行く」と決め打ち | Lock |
| S5 | 生成後に 1 枠だけ差し替え | 手動編集 + リアルタイム再評価 |
| S6 | 1 名が急に欠席 | 参加者から外し → 部分再最適化 |
| S7 | 1 名が遅刻 (Game 4 以降のみ出場可) | 出場可能範囲 |
| S8 | 操作ミス | Undo |
| S9 | LINE にオーダーを流す | 縦長画像 / テキスト / クリップボード |
| S10 | 会場が圏外 | オフライン動作 (PWA + IndexedDB) |

### 1.3 非目標 (初期版で作らないも— 仕様 §37)

- バックエンド / 認証 / クラウド同期
- 相手チーム情報・推定勝率・Expected Wins 最大化
- n01 連携・戦績自動取得
- 外部最適化 Solver (OR-Tools 等) の導入
- マイクロサービス化

ただし拡張点は型と層で用意する (§9 将来拡張)。

---

## 2. Domain Model

### 2.1 エンティティ関係

```
Team 1 --- * Player
Team 1 --- * PairSetting      (Player x Player の相性)
Team 1 --- * LeagueFormat     (Format は Team 固有 / 共有の両方を許可)
LeagueFormat 1 --- * GameSlotDef
Team 1 --- * SavedOrder       (履歴)
SavedOrder 1 --- 1 OrderInput  (再現用に入力条件を同梱)
SavedOrder 1 --- 1 OrderSolution
```

チームごとに Player / Pair / Format / Season History を分離する (仕様 §24)。
`teamId` を全エンティティに持たせ、Repository 層でスコープする。

### 2.2 主要型 (抜粋 / 正式定義は `src/domain/types.ts`)

```ts
type Rating = number | null;            // null = Unknown (0 ではない)
type SkillLevel = 1 | 2 | 3 | 4 | 5;    // 未設定は undefined (0 ではない)

type GameKind =
  | 'G501' | 'CRICKET' | 'SINGLES' | 'DOUBLES' | 'TRIOS'
  | 'GALLON' | 'TEAM' | 'CUSTOM';

interface Player {
  id; teamId; name;
  rating: Rating;                        // null 可
  skills: Partial<Record<GameKind, SkillLevel>>;
  note?: string;
  seasonAppearances: number;             // シーズン累計
  seasonAppearancesByKind: Partial<Record<GameKind, number>>;
  archived: boolean;
}

interface GameSlotDef {
  id; order: number; name;
  kinds: GameKind[];                     // 複数種別 (例: Doubles 501 = [DOUBLES, G501])
  playerCount: number;
}

interface LeagueFormat { id; teamId: TeamId | null; name; games: GameSlotDef[]; }

type PairAffinity = 'VERY_GOOD' | 'GOOD' | 'NEUTRAL' | 'DISCOURAGED' | 'FORBIDDEN';
interface PairSetting { id; teamId; a; b; affinity; pastTogetherCount: number; }
```

#### 判断記録 D-01: ゲーム種別を配列 `kinds` にした理由

仕様の例に `Singles 501` / `Doubles Cricket` が存在する一方、
適性は `501 / Cricket / Singles / Doubles / Trios` と直交する軸で定義されている。
単一 `kind` では「Doubles 501」が Doubles 適性と 501 適性の両方を参照できない。
よって `kinds: GameKind[]` とし、

- 出場不可 (種別指定) … `kinds` のいずれかが禁止なら出場不可 (Hard)
- GameFit … `kinds` に対応する適性の平均
- シーズン種別別集計 … `kinds` の全要素をインクリメント

と統一的に扱う。`playerCount` は `kinds` から推論せず独立保持する (仕様が必要人数の明示入力を要求)。

#### 判断記録 D-02: Rating と適性は完全に別概念

`rating` は数値 (ダーツの Rating)、`skills` は 1..5 の適性。
相互に補完・代入しない。Rating 未入力でも適性は使える。適性未設定でも Rating は使える。

---

## 3. Hard / Soft Constraint 分類

### 3.1 Hard Constraint (違反候補は「低スコア」ではなく**無効**)

| # | 制約 | 判定箇所 |
|---|---|---|
| H1 | ゲーム必要人数と一致 | 候補生成時に構造的に保証 |
| H2 | 同一ゲーム内の同一選手重複禁止 | 組合せ生成 (重複なし組合せ) で構造的に保証 |
| H3 | 出場不可ゲーム (ゲーム ID 指定) | eligibility 前計算 |
| H4 | 出場不可種別 (Singles 不可 / Cricket 不可 等) | eligibility 前計算 |
| H5 | 出場可能範囲 (Game N〜M のみ) | eligibility 前計算 |
| H6 | 最大出場回数 | 探索中インクリメンタル検査 |
| H7 | ロック済み配置 | 該当ゲームを固定し探索対象から除外 |
| H8 | 禁止ペア (FORBIDDEN) | 候補組合せ生成時に除去 |
| H9 | 参加者フラグ (include=false は一切配置しない) | eligibility 前計算 |
| H10 | 最小出場回数 | 既定で Hard。設定で Soft 化可能 (D-03) |
| H11 | 最大連続出場 | 既定で Soft。設定で Hard 化可能 (D-04) |

H1..H9 は仕様 §9 の必須 Hard Constraint。実装上、H1/H2/H3/H4/H5/H8/H9 は
**候補集合の構築段階で物理的に表現不能**にする (後段で検査すら不要)。
H6/H7/H10/H11 は探索中に検査する。

最終的に `validateSolution()` が全 Hard Constraint を独立再検査し、
違反があれば解を破棄する (二重の安全網。テストでも直接使用)。

#### 判断記録 D-03: 最小出場回数は既定 Hard

仕様 §9 の列挙に最小出場回数は含まれないが、§7 で設定可能とされている。
キャプテンが「この選手は最低 2 回出す」と入れた場合、それが
スコア調整で破られるのは運用上の事故である。よって既定 Hard。
ただし容易に実行不能化するため、

- 設定 `minAppearanceMode: 'hard' | 'soft'` (既定 `'hard'`)
- Hard のまま解なしになった場合、診断エンジンが
  「誰の最小出場回数を何回に下げれば成立するか」を提示する

を併設する。探索中は「残枠 ≥ Σ未達分」「各選手の残り出場可能ゲーム数 ≥ 未達分」
を枝刈りに用いる (実行可能性先読み)。

#### 判断記録 D-04: 最大連続出場は既定 Soft

仕様 §13 は「Hard / Soft を設定可能な設計が望ましい」とする。
既定は Soft (ペナルティ) とした。理由は、少人数チーム (例: 5 名 / 11 枠) では
連続出場を Hard にすると実行不能になりやすく、かつ「原則避ける」という
仕様の文言が Soft を示唆するため。設定 `consecutiveMode: 'hard' | 'soft'` で切替。

### 3.2 Soft Constraint / 最適化対象

Strength (Rating) / GameFit (適性) / PairFit (ペア相性) /
Fairness (今回の出場回数均等) / SeasonBalance (シーズン累計均等) /
PairNovelty (新ペア) / ConsecutivePenalty (連続出場)

---

## 4. 公平性の定義 (Fairness)

### 4.1 用語

- `T` = 総枠数 = Σ(各ゲームの必要人数)
- `N` = 参加者数
- `c_p` = 選手 p の今回出場回数
- `b_p` = 選手 p のシーズン累計出場回数 (season スコープ時のみ使用)
- `base_p` = スコープに応じ `0` (today) または `b_p` (season)
- `tot_p` = `base_p + c_p`
- `mean` = (Σ base_p + T) / N

### 4.2 採用指標: 理想配分からの二乗偏差和 (SSD) の「超過分」

```
SSD      = Σ_p (tot_p - mean)^2
minSSD   = 同じ T を制約なしで最も均等に配ったときの SSD (water-filling で厳密計算)
excess   = max(0, SSD - minSSD)
Fairness = 1 / (1 + excess / 2)        ∈ (0, 1]
```

#### なぜ SSD か (仕様 §8 の要求との対応)

固定和 `T` を整数で分配する場合、SSD を最小化する配分は
`floor(T/N)` と `ceil(T/N)` の混合に厳密に一致する。したがって

- `T % N == 0` → 全員同数 (最大差 0)
- `T % N != 0` → 最大差 1

が SSD 最小化から**自動的に**導かれる。「最大差を最小化」という要求を
別項として足す必要がない。例:

- 5 名 / 10 枠 → 2,2,2,2,2 (SSD=0, excess=0, Fairness=1.0)
- 5 名 / 11 枠 → 3,2,2,2,2 (minSSD と一致, excess=0, Fairness=1.0)

さらに SSD は最大差だけを見る指標と違い、
「3,1,2,2,2 と 3,2,2,2,2」のような同じ最大差内の優劣も区別できる
(最大差指標では区別できない)。分散・標準偏差は SSD の単調変換なので
同じ順序を与える。よって**単一指標 SSD で足りる**と判断した。

`minSSD` は閉形式 `r(N-r)/N` (r = T mod N, base 一律のとき) で検証できるが、
`base_p` がばらつく season スコープでは閉形式にならないため、
実装では water-filling (毎回最小の `tot` に 1 を加える貪欲法) で厳密に求める。
分離凸最小化なので貪欲法が最適解を与える。

`excess/2` の `2` は感度調整。1 枠を「理想より多い選手」から
「理想より少ない選手」へ移す操作 1 回分の SSD 差がおよそ 2 であるため、
「理想から 1 手ずれ = Fairness 0.5」という解釈しやすい尺度になる。

### 4.3 表示用の補助指標 (比較画面で提示)

- 最大出場差 `max(c) - min(c)`
- 標準偏差 `sqrt(SSD/N)`
- 各選手の `今回 / Season / 理想との差`

最大出場差は「人間が検品する指標」として必ず表示するが、
**最適化の主指標は SSD** とする。

### 4.4 スコープ切替 (仕様 §20)

`fairnessScope: 'today' | 'season'`

- `today` … Fairness 項は今回のみ。別途 SeasonBalance 項 (重み小) でシーズンも考慮。
- `season` … Fairness 項がシーズン累計込み。二重計上を避けるため
  SeasonBalance 項の重みを 0 に上書きする。

---

## 5. Rating Unknown 仕様 (仕様 §30)

### 5.1 禁止事項の明示

`rating == null` を `0` として扱わない。型レベルで `number | null` とし、
数値変換は唯一の関数 `resolveRating()` 経由に限定する。

### 5.2 比較した方式

| 方式 | 内容 | 評価 |
|---|---|---|
| A: Strength から除外 | Unknown 選手を強さ平均の母数から外す | ✗ 候補間でStrengthの母数が変わり比較不能。Unknown だけのゲームは Strength 計算不能 |
| B: チーム平均で補完 | 既知 Rating の平均を代入 | △ 外れ値 (突出した 1 名) に平均が引っ張られる |
| C: チーム中央値で補完 | 既知 Rating の中央値を代入 | ◎ 外れ値に頑健。Unknown は「平均的な選手」として評価される |
| D: Unknown 専用評価 | Unknown に独自スコアを与える | ✗ 恣意的。優遇/冷遇のどちらにも倒れ、根拠を説明できない |

### 5.3 採用: C (参加者の既知 Rating の中央値で補完)

```
knowns = 参加者のうち rating != null の値
median = median(knowns)
effectiveRating(p) = p.rating ?? median      // isImputed = true を併記
既知 Rating が 1 つも無い場合 → 全員 NEUTRAL_RATING(=0.5 正規化値) として
                                Strength 項は実質フラット (= 無視) になる
```

採用理由:

1. **0 扱いにならない** — Unknown 選手が構造的に弱者扱いされない。
2. **不当な優遇にもならない** — 中央値 = ちょうど平均的な評価。
3. **外れ値に頑健** — 平均ではなく中央値。1 名の高 Rating で全体が歪まない。
4. **候補間で比較可能** — 常に全選手に数値が入るので Strength の母数が安定。
5. **公平性に影響しない** — Fairness は出場回数のみで決まり Rating を参照しない。
   よって Unknown 選手が出場機会を失うことはない。
6. **説明可能** — 生成理由に「Rating 未入力のため暫定値 (中央値 X) で評価」と明示する。

### 5.4 正規化

```
rmin = min(effectiveRating over participants)
rmax = max(effectiveRating over participants)
normRating(r) = rmax > rmin ? (r - rmin) / (rmax - rmin) : 0.5
```

全員同 Rating / 全員 Unknown のとき 0.5 (= 中立) に縮退する。

---

## 6. Optimization 方式 (仕様 §29)

### 6.1 探索空間の規模見積り

典型的なダーツリーグ: 参加 5〜12 名、ゲーム数 6〜16、1 ゲーム 1〜3 名。

1 ゲームあたりの組合せ数 `C(N, k)`:

| N | k=1 | k=2 | k=3 |
|---:|---:|---:|---:|
| 5 | 5 | 10 | 10 |
| 8 | 8 | 28 | 56 |
| 12 | 12 | 66 | 220 |
| 16 | 16 | 120 | 560 |

単純な直積は `Π C(N,k)`。12 名 / 9 ゲームで ~10^15 と爆発するため全探索は不可。
一方 1 ゲームあたりの候補数は最大でも数百に収まる = **枝刈りが効く構造**。

### 6.2 方式比較

| 方式 | 長所 | 短所 | 判定 |
|---|---|---|---|
| Random 生成 | 実装容易 | 品質保証なし。仕様で明示的に禁止 | ✗ 禁止 |
| 全探索 | 最適保証 | 10^15 規模で破綻 | ✗ |
| Backtracking (枝刈りのみ) | Hard 制約と相性良。実行可能解を確実に得る | 最適性の保証なし | △ 基盤として採用 |
| **Branch and Bound** | 上界で大量枝刈り。小規模では最適性を保証 | 上界設計が必要 | ◎ **主方式** |
| Beam Search | 大規模でも時間内に良解 | 最適性なし | ◎ **補助/フォールバック** |
| Constraint Programming (外部 Solver) | 表現力 | 依存増・バンドル肥大・オフライン PWA に不適 | ✗ (§29「本当に必要な場合のみ」) |

### 6.3 採用アーキテクチャ: 3 段構成 (すべて Pure Function、決定的)

```
Stage 0  前処理   eligibility 行列 + 実行可能性事前診断 + ゲーム別候補組合せ生成
Stage 1  DFS B&B  ゲーム順に深さ優先 + 上界枝刈り + Anytime (時間/ノード上限)
Stage 2  Beam     幅優先ビーム探索 (Stage 1 が時間切れ / 解なし時の保険 & 多様性確保)
Stage 3  Polish   近傍局所探索 (置換/交換) による山登り。Hard 制約を保ったまま改善
```

#### Stage 0: 候補組合せ生成 (Candidate Pruning)

各ゲームについて、eligible 選手から `playerCount` 個の**重複なし組合せ**を列挙し、
禁止ペアを含むものを除去する。これにより H1/H2/H8 は構造的に成立する。

候補数が `maxCombosPerGame` (既定 400) を超える場合のみ剪定する。剪定は
「局所スコア上位」だけでは公平性が死ぬため、以下 2 系統を併合する。

1. 局所スコア (Strength + GameFit + PairFit) 上位 `K/2`
2. 「含まれる選手の出場余力が大きい順」上位 `K/2` (公平性のための多様性確保)

#### Stage 1: DFS Branch and Bound

- 探索順: ゲームは `order` 昇順 (連続出場の評価が前向きに確定するため)
- 各ノードで候補を動的ヒューリスティック順に試す
  (未達 min を持つ選手を含む候補 → 理想未満の選手を含む候補 → 局所スコア降順)
- **上界 (Upper Bound)**: 「残りゲームで達成可能な最良値」を楽観的に見積もる
  - Strength / GameFit / PairFit / Novelty … 各ゲームの候補内最大値を前計算し合計
  - Fairness … 現在の出場数から残枠を water-filling した「理想配分」での値 (達成可能上限)
  - ConsecutivePenalty … 0 (楽観)
  - `partial + optimisticRest <= best` なら枝刈り
- **実行可能性枝刈り**: Σ未達min ≤ 残枠、各選手の残 eligible 枠 ≥ 未達min、
  max 出場超過、連続出場 Hard 違反
- Anytime: `timeLimitMs` (既定 1200ms) / `nodeLimit` (既定 300k) で打ち切り、
  その時点の最良解を返す。打ち切り有無は `OrderSolution.meta.exhaustive` で報告

#### Stage 2: Beam Search

幅 `beamWidth` (既定 48) で層ごとに部分解を保持。
DFS が時間内に解を得られなかった場合、および
複数候補の多様性確保のために使用する。

#### Stage 3: 局所探索 (決定的山登り)

近傍操作: (a) 1 枠の選手を別の eligible 選手へ置換、(b) 2 枠の選手を交換。
Hard 制約を満たす改善手がある限り適用。走査順は固定 (ゲーム順 → スロット順 →
選手 ID 昇順) で**乱数を一切使わない**。改善が無くなるか時間上限で終了。

### 6.4 決定性 (Determinism)

`Math.random` / `Date.now` を最適化エンジン内の判断に使用しない
(時間上限の計測のみ `performance.now` を使い、その値は解の内容に影響させない
= 時間切れ時も「それまでの最良解」という決定的な前提で同一入力なら同一出力)。
同点時のタイブレークは明示キーの辞書順で決める (§7.4)。

### 6.5 複数候補 (仕様 §18)

同一入力に対して 3 つの重みセット (勝利優先 / バランス / 公平性優先) で
それぞれ最適化し、重複配置を除去して最大 3 案を返す。
各案に総合評価・戦力・公平性・最大出場差・最大連続・平均Rating・適性評価を付す。

---

## 7. 評価関数 (Scoring Function)

### 7.1 構造 (仕様 §10 の形を踏襲)

```
Score = w_strength    * Strength
      + w_gameFit     * GameFit
      + w_pairFit     * PairFit
      + w_fairness    * Fairness
      + w_novelty     * PairNovelty
      - w_consecutive * ConsecutivePenalty
      - w_season      * SeasonImbalance
```

### 7.2 各項のレンジと正規化 (すべて [0, 1] に正規化)

| 項 | 定義 | レンジ |
|---|---|---|
| Strength | 各ゲームの出場選手の `normRating` 平均を、全ゲームで平均 | [0,1] |
| GameFit | 各選手の該当 `kinds` の適性 `(level-1)/4` の平均を、ゲーム平均 | [0,1] |
| PairFit | 2 名以上のゲーム内の全ペアの相性値の平均 (該当ゲーム無しは 0.5) | [0,1] |
| Fairness | `1/(1+excess/2)` (§4.2) | (0,1] |
| PairNovelty | 全ペアの `1/(1+pastTogetherCount)` 平均 (該当ゲーム無しは 0.5) | (0,1] |
| ConsecutivePenalty | `Σ_p Σ_run max(0, runLen - maxConsec_p)` を `1 - 1/(1+v)` で正規化 | [0,1) |
| SeasonImbalance | シーズン累計込みの `excess` を `1 - 1/(1+excess/2)` で正規化 | [0,1) |

相性値: VERY_GOOD 1.0 / GOOD 0.75 / NEUTRAL 0.5 / DISCOURAGED 0.15 / FORBIDDEN → Hard 除外。
適性未設定は `level 3` 相当 = 0.5 (中立) として扱う (0 にしない)。

### 7.3 表示用総合評価

```
posW = w_strength + w_gameFit + w_pairFit + w_fairness + w_novelty
negW = w_consecutive + w_season
総合評価(0-100) = 100 * (Score + negW) / (posW + negW)
```

Score の取り得る範囲 `[-negW, posW]` を線形に 0-100 へ写す。単調なので
順位は Score と一致する。

### 7.4 タイブレーク (決定的)

同スコア時は以下の順で比較する。

1. Score 降順 (10^-9 を同値とみなす)
2. 最大出場差 昇順
3. 最大連続出場 昇順
4. Fairness 降順
5. 配置を `gameOrder` 順に並べた playerId 列の辞書順 昇順

### 7.5 プリセット重み (仕様 §11)

| プリセット | strength | gameFit | pairFit | fairness | novelty | consecutive | season | scope |
|---|---:|---:|---:|---:|---:|---:|---:|---|
| 勝利優先 | 1.00 | 0.80 | 0.35 | 0.40 | 0.00 | 0.40 | 0.10 | today |
| バランス | 0.60 | 0.50 | 0.40 | 0.90 | 0.05 | 0.50 | 0.25 | today |
| 公平性優先 | 0.20 | 0.20 | 0.25 | 2.00 | 0.05 | 0.60 | 0.50 | today |
| 育成重視 | 0.15 | 0.25 | 0.30 | 1.20 | 0.10 | 0.50 | 1.40 | season |
| 新ペア試行 | 0.40 | 0.40 | 0.30 | 0.80 | 1.20 | 0.50 | 0.20 | today |

「勝利優先」でも fairness を 0 にしない (仕様 §11 の明示要求)。
加えて Hard な最大出場回数と合わせ、強豪への無制限な偏りを防ぐ。
ユーザーはプリセットを選んだ後に個別重みを微調整できる (Custom)。

---

## 8. 生成理由 (Explanation) の設計 (仕様 §19)

後付けの推測文は禁止。**スコアラと同一の Pure Function** に
`collect: true` を渡して構造化された根拠を収集する。

```ts
interface ExplanationFactor {
  key: 'strength'|'gameFit'|'pairFit'|'fairness'|'novelty'|'consecutive'|'constraint'|'lock';
  label: string;        // 日本語ラベル
  value?: number;       // 正規化値
  detail: string;       // 「合計Rating 28 (平均14.0)」等の具体値
  tone: 'positive'|'neutral'|'negative';
}
interface GameExplanation { gameId; slot: PlayerId[]; factors: ExplanationFactor[]; }
interface OrderExplanation { games: GameExplanation[]; overall: ExplanationFactor[]; }
```

探索中はコスト削減のため収集しない。最終解に対して 1 度だけ
`evaluate(solution, { collect: true })` を呼ぶ。数値は探索時と完全に同一
(同じ関数・同じ入力) なので、説明と評価が乖離しない。

---

## 9. UI 画面構成 (仕様 §26 / §27)

```
HOME       新規オーダー / 過去オーダー / チーム / フォーマット / 設定
PLAYERS    メンバー管理 (Rating 任意・適性・メモ・Season)
PAIRS      ペア相性 (禁止含む)
FORMATS    ゲームフォーマット管理 (複数保存)
SETUP      参加者 / 出場不可 / 出場範囲 / 最小最大 / 連続 / プリセット / スコープ
RESULT     オーダー / 集計 / 評価 / 理由 / ロック / 手動編集 / 再最適化 / 別案 / 共有
HISTORY    過去オーダー (再読込・複製)
SETTINGS   重み微調整 / 制約モード / Import / Export / チーム切替
```

モバイル UX の方針:

- 下部固定のタブバー + 画面下部にプライマリ操作 (片手操作)
- タップ領域 44px 以上
- 横スクロールを避け、結果表はカード型に切替 (縦積み)
- Undo は常時アクセス可能 (結果画面のヘッダに固定)
- 破壊的操作 (削除・全消去) は確認ダイアログ
- 状態変更はトースト + 色/アイコンで即時可視化
- Hard 制約違反は赤、警告は黄で明示

---

## 10. Storage 設計 (仕様 §23)

IndexedDB (DB 名 `darts-league-order`, version 1) に以下のストアを持つ。

| Store | key | index |
|---|---|---|
| teams | id | — |
| players | id | teamId |
| formats | id | teamId |
| pairs | id | teamId, pairKey |
| orders | id | teamId, createdAt |
| settings | key | — |
| meta | key | — |

- ブラウザが IndexedDB を使えない場合は **localStorage フォールバック** →
  それも不可なら **インメモリ** に自動縮退する (同一 Repository インターフェース)。
- JSON Export / Import: 全ストアを 1 つの `BackupFile { schemaVersion, exportedAt, data }`
  にまとめる。Import は `replace` (全置換) / `merge` (ID 衝突は上書き) を選択可能。
- Import 時はスキーマ検証を行い、不正なら明示エラー (部分適用しない)。

---

## 11. Test Strategy (仕様 §32)

| 層 | 道具 | 対象 |
|---|---|---|
| Unit | Vitest | 公平性計算 / 正規化 / Rating Unknown / 制約判定 / 候補生成 / 診断 |
| Property 的 | Vitest (網羅ループ) | ランダム生成した多数の入力で Hard 制約不変条件を検査 |
| Integration | Vitest | `generateOrder` の E2E 相当 (生成 → 検証 → 再最適化 → 説明) |
| Component | Vitest + Testing Library | Reducer / Undo / 手動編集の再評価 |
| Storage | Vitest + fake-indexeddb | Repository CRUD / Export-Import ラウンドトリップ |
| E2E | Playwright (Chromium 同梱) | 実ブラウザで登録→生成→編集→Undo→共有→リロード永続 |

必須テスト項目 (仕様 §32):

- 出場不可が配置されない / 最大出場超過なし / Lock 保持 / 同一 Game 重複なし /
  必要人数一致 / 禁止ペアなし
- 割り切れる場合は全員同数、割り切れない場合は最大差 1
- 強い選手に無制限に偏らない
- Unknown Rating が 0 扱いされない
- 再最適化で Lock 済み配置が変わらない
- 解なしを正しく検出し理由を提示

**テストを通すためのハードコード・特定 Fixture 専用分岐・条件無効化は禁止** (§36)。

---

## 12. アーキテクチャ (仕様 §28)

```
src/
  components/      再利用 UI (Reactに依存)
  pages/           画面 (Reactに依存)
  state/           Context + Reducer + Undo (Reactに依存)
  domain/          エンティティ・純粋なドメインロジック (React非依存)
    players/ games/ orders/
  optimizer/       最適化エンジン (React非依存・Pure)
    constraints/ scoring/ candidates/ generateOrder.ts diagnose.ts
  storage/         IndexedDB / Export-Import (React非依存)
  utils/           汎用 (React非依存)
```

`src/optimizer/**` と `src/domain/**` は React / DOM / IndexedDB を import しない。
この依存方向は lint ルール (`no-restricted-imports`) とテストで機械的に検査する。

---

## 13. 判断記録インデックス (Defaults 一覧)

| ID | 判断 | 既定値 | 根拠 |
|---|---|---|---|
| D-01 | ゲーム種別は配列 | `kinds: GameKind[]` | Doubles 501 等の複合種別に対応 (§2.2) |
| D-02 | Rating と適性は別概念 | 相互補完しない | 仕様 §3 の明示要求 |
| D-03 | 最小出場回数 | Hard (切替可) | 運用事故防止 + 診断で救済 (§3.1) |
| D-04 | 最大連続出場 | Soft (切替可) | 少人数で実行不能化しやすい (§3.1) |
| D-05 | 公平性指標 | 超過 SSD | 最大差最小化を内包し同一最大差内も識別 (§4.2) |
| D-06 | Unknown Rating | 参加者既知 Rating の中央値で補完 | 0 扱い回避 + 外れ値頑健 + 比較可能 (§5.3) |
| D-07 | 適性未設定 | level 3 相当 (0.5 中立) | 0 にすると未設定者が不当に不利 |
| D-08 | 最適化方式 | DFS Branch&Bound + Beam + 局所探索 | 規模見積りと §29 の比較結果 (§6.2) |
| D-09 | 時間上限 | 1200ms (設定可) | 会場でのスマホ操作における体感許容 |
| D-10 | 候補上限/ゲーム | 400 (設定可) | 12名 Trios = 220 を無剪定で扱える |
| D-11 | Beam 幅 | 48 | 品質と速度の実測均衡 |
| D-12 | 最大連続出場 既定値 | 2 | 仕様 §13 の例に準拠 |
| D-13 | 複数候補 | 3 案 (勝利/バランス/公平) | 仕様 §18 |
| D-14 | Undo 深度 | 30 | 「少なくとも 1 つ前」の要求を十分に満たす |
| D-15 | 共有画像 | Canvas 2D で縦長 PNG を自前描画 | 外部依存を増やさず LINE 向き縦長を確実に出す (§22) |
| D-16 | Storage | IndexedDB → localStorage → memory の自動縮退 | PWA / Private Mode 耐性 (§10) |
| D-17 | スコープ既定 | `today` (育成重視のみ `season`) | 当日運用が主目的 |
| D-18 | 外部 Solver | 導入しない | §29「本当に必要な場合のみ」/ バンドル・オフライン性 |

---

# 追補 v1.1 — 共有 (Share) 機能 設計記録

本章は「オーダー共有・LINE共有機能」追加要件の設計記録である。
**最適化エンジン (`src/optimizer/**`) および制約・公平性の挙動は一切変更しない。**
共有は Presentation 層として `src/share/**` に新設し、Optimizer から完全に分離する。

## S1. 画像生成方式の比較 (要件 §8)

| 方式 | 描画の安定性 | 日本語フォント | モバイル互換性 | 高DPI | 長いオーダー | PWA/Offline | 判定 |
|---|---|---|---|---|---|---|---|
| DOM to Canvas (html2canvas 等) | △ CSS の再実装に依存 | △ Web フォント読込が必要 | ✗ iOS Safari で崩れやすい | ○ | △ | ✗ フォント取得で通信が要る | **不採用** |
| SVG → Image → Canvas | △ | ✗ フォント埋込が必要 (CJK は数MB) | ✗ Safari で `foreignObject` が canvas 化できない | ○ | △ 自動折返し無し | ✗ | **不採用** |
| **Canvas 2D API 直描画** | ◎ 自前制御 | ◎ 端末内蔵フォントを直接指定 | ◎ 全モバイルブラウザで安定 | ◎ `scale()` で任意倍率 | ◎ 計測して分割可能 | ◎ 通信不要 | **採用** |

### 判断記録 S-01: Canvas 2D 直描画を採用 (外部ライブラリなし)

採用理由:

1. **DOM to Canvas は本アプリでは特に不適**。本アプリの CSS は `color-mix()` /
   `backdrop-filter` / CSS 変数を多用しており、html2canvas 系はこれらを再現できない。
   共有画像が画面と違う見た目になる。
2. **日本語フォント**。DOM to Canvas / SVG 方式は Web フォントの取得が前提になりやすく、
   オフライン (要件 §12) で文字化けまたは描画失敗を起こす。Canvas 2D は
   `ctx.font` に端末内蔵の CJK フォントスタックを指定するだけでよく、**通信が不要**。
3. **依存ゼロ**。バンドルサイズを増やさず、PWA のプリキャッシュ容量にも影響しない。
4. **`measureText` による正確なレイアウト**。文字切れ・重なりを「起きないように組む」のではなく
   「計測して組む」ことができる。長い名前の折返しとページ分割を厳密に制御できる。

フォントスタック (CJK を先頭に置き、Latin 優先の `system-ui` に食われないようにする):

```
"Hiragino Sans", "Hiragino Kaku Gothic ProN", "Yu Gothic", "Noto Sans JP",
"Noto Sans CJK JP", Meiryo, system-ui, -apple-system, sans-serif
```

## S2. 解像度と DPI (要件 §9)

- 論理幅 `540px` 固定。出力倍率 `scale = clamp(round(devicePixelRatio), 2, 3)`。
  → 実出力幅 **1080〜1620px**。要件の「表示幅 1080px 相当」を満たす。
- 1 ページあたりの総画素数が約 1,200 万を超える場合は `scale` を 2 へ落とす
  (iOS Safari の canvas 面積上限と、共有時のファイルサイズ肥大を避けるため)。
- `ctx.scale(scale, scale)` で描画し、論理座標のみでレイアウトする。

## S3. 長いオーダーの扱い (要件 §10)

**横幅を縮めて文字を小さくすることはしない。** 以下の順で対応する。

1. まず縦方向に伸ばす。
2. 1 ページの高さが `MAX_PAGE_HEIGHT` (論理 1400px、縦横比およそ 1:2.6) を超えたら
   **複数ページへ分割**する。各ページにヘッダー (チーム名・対戦相手・日付) を再掲し、
   右下に `1 / 2` のページ表示を入れる。
3. 1 行が単独で上限を超える場合はそのページに単独配置する (切り捨てない)。

分割の計算 (`paginate`) は純関数で、計測済みの高さ配列だけを受け取るため単体テスト可能。

## S4. Compact / Detail の切り分け (要件 §3, §4)

| 項目 | Compact | Detail |
|---|---|---|
| リーグ名 / チーム名 / 対戦相手 / 試合日 | ✅ | ✅ |
| Game 番号 / Game 名 / 出場プレイヤー | ✅ (大きめの文字) | ✅ |
| 出場回数 (今回 / Season) | ✖ | ✅ |
| Rating | ✖ | ✅ |
| オーダータイプ (プリセット名) | ✖ | ✅ |
| 注記 (Rating 未入力の扱い等) | ✖ | ✅ |
| **Optimization Score / Pair Score / 評価関数 / アルゴリズム情報** | ✖ | **✖ (明示的に出さない)** |

### 判断記録 S-02: 共有物に内部評価値を出さない

総合評価・戦力 %・公平性 %・探索ノード数などは「キャプテンが画面で検品するための値」であり、
チームメンバーへ共有する画像・テキストには含めない (要件 §4)。
画面上の ORDER RESULT では従来どおり表示する (元仕様 §21 の要件を維持)。

## S5. テキスト形式 (要件 §6)

- `line` — LINE 向け。先頭に 1 つだけ絵文字 (🎯)、区切りに全角 `｜`。過度な装飾はしない。
- `simple` — 絵文字なし、1 ゲーム 1 行。狭い画面や他アプリ向け。
- `detail` — キャプテン控え用。出場回数表とオーダータイプ、注記を含む。評価値は含まない。

## S6. Player View (要件 §5)

`buildPlayerSchedules()` が、オーダーを「プレイヤー → 出場ゲーム (+ パートナー)」へ
転置した純粋なデータを返す。画面表示・個人別テキスト・全員分テキストの 3 用途で共有する。
初期版では自動送信は行わない (要件どおり)。

## S7. 試合情報 (リーグ名・対戦相手・試合日)

- `MatchInfo { leagueName, teamName, opponentName, matchDate }` を `domain/types.ts` に追加。
  **`OrderInput` には入れない** — 最適化の入力を変えないため。
- 入力は ORDER SETUP の「試合情報」カードと SHARE 画面の両方から行える
  (対戦相手は会場で判明することがあるため)。
- `Team.leagueName` を追加し、リーグ名はチームに紐づけて記憶する。
- 生成したオーダーを履歴保存すると `SavedOrder.match` として一緒に保存される。

## S8. Web Share API とフォールバック (要件 §1)

| 状況 | 動作 |
|---|---|
| `navigator.canShare({files})` が true | 端末標準の共有メニューへ PNG を渡す (LINE / Messenger / Discord / AirDrop 等) |
| ファイル共有不可だがテキスト共有可 | テキストのみ標準共有へ |
| Web Share API 非対応 | 画像は **ダウンロード保存**、テキストは **クリップボードへコピー**。UI にその旨を表示 |
| 共有シートをユーザーが閉じた (`AbortError`) | 失敗扱いにせず、何もしない |
| クリップボード API 不可 / 非セキュアコンテキスト | `textarea` + `execCommand('copy')` へフォールバック |

Web Share API の対応状況は起動時に判定して UI へ反映する
(非対応端末では「標準共有」ボタンを出さず、保存 / コピーを主アクションにする)。

## S9. 層の分離 (要件 §15)

```
src/share/
  types.ts     共有用の型 (レイアウトモデル)
  layout.ts    純関数: レイアウトモデル構築 / 文字折返し / ページ分割 / Player View
  text.ts      純関数: LINE / シンプル / 詳細 / プレイヤー別テキスト
  canvas.ts    Canvas 2D レンダラ (DOM 依存はここだけ)
  webShare.ts  Web Share API・クリップボード・ダウンロード
```

`src/share/**` は `src/optimizer/**` を **import しない**。
共有は「生成済みの `OrderSolution` を読む」だけで、制約・最適化・Lock・再最適化・公平性の
挙動には一切関与しない。この依存方向も ESLint で機械的に検査する。

---

# 追補 v1.2 — オーダー確定・バージョン・シーズン反映の安全化

本章は「オーダー確定・バージョン管理・共有整合性・シーズン二重反映防止」追加要件の設計記録である。
**最適化エンジン (`src/optimizer/**`) の評価関数・候補生成・探索は一切変更しない。**
責務は Order Lifecycle / Versioning / Sharing Consistency / Season Commit Safety に限定する。

## L1. State Model (要件 §2)

状態は `DRAFT` / `FINALIZED` / `UPDATED` の 3 つ。

**重要な設計判断 (L-01): 状態は保存せず、純関数で導出する。**

```
state(versions, currentFingerprint) =
    versions が空                                → DRAFT
    versions の最新.fingerprint === current      → FINALIZED
    それ以外                                      → UPDATED
```

フラグを持たないため、

- 「確定したのに UPDATED のまま」「変更したのに FINALIZED のまま」という不整合が原理的に起きない
- SHARE 画面を開く・画像を再生成するなどの**閲覧操作では状態が変わらない** (要件 §8 後段)
- 変更を Undo すると自動的に FINALIZED へ戻る (余分な実装なしで正しく振る舞う)

### L-02: fingerprint に何を含めるか

含める: **配置 (assignments)**・**ゲーム定義 (id/順序/名称/種別/必要人数)**・**試合情報 (リーグ/チーム/対戦相手/日付)**。

含めない: **ロック**・**参加者の制約設定**。

理由: この状態が存在する目的は「**メンバーが見ている共有内容と現在の内容がずれている**」ことの検知である (要件 §1)。
最適化結果が変わらないロックの付け外しや、配置に影響しない制約の微調整では、
共有済みの画像・テキストは依然として正しい。これを UPDATED にすると
「意味のない再確定要求」が頻発し、キャプテンが警告を無視するようになる。

要件 §8 は変更対象に「Lock 変更」を挙げているが、
§2 が「より適切な State Model があれば改善してよい。ただし状態遷移を曖昧にしないこと」
としているため、**判定基準を「共有内容の差分」に一本化**した。
純関数 1 つで決まるため遷移は完全に一意である。
なお、ロック変更を伴う再最適化で配置が変われば当然 UPDATED になる。

## L2. Version 管理 (要件 §4)

- `SavedOrder.versions: OrderVersion[]` に確定スナップショットを追記していく。
- 版番号は `最新.version + 1`。初回確定 = v1、再確定 = v2, v3 …。
- 版は**追記のみ**。過去の版を書き換える API を持たない。
- 確定は `SavedOrder` の永続化も兼ねる (確定したオーダーは必ず履歴に残る)。

## L3. Immutable Snapshot (要件 §5)

`OrderVersion` は確定時点の
`assignments / games / players / participants / match / tallies / appearances / label`
を**全て deep copy** で保持する。

これにより、確定後に

- 選手を改名・削除した
- フォーマットのゲーム名を変えた・ゲームを増減した
- 試合情報を書き換えた

としても、過去の版の表示・再共有内容は一切変わらない。
Diff の表示名も**各版が自分の players スナップショットから解決**するため、
「v1 の表示が後からの改名で書き換わる」ことがない。

## L4. 確定時の再検証 (要件 §3)

`validateHardConstraints(input, assignments)` を確定直前にもう一度実行する
(生成時・手動編集時に続く 3 度目)。必要人数・同一ゲーム内重複・出場不可・
出場可能範囲・最大/最小出場・ロック整合性・禁止ペアのいずれかに違反があれば**確定できない**。
UI 上も違反がある間は確定ボタンを無効化する。

## L5. Diff (要件 §9)

`diffOrders(before, after)` がゲーム単位で
`unchanged | changed | added | removed` を判定する。

- 比較は**スロット順を保ったまま**行う。`A / B` と `B / A` は共有テキストの見え方が変わるため「変更」とみなす。
- 変更のあるゲームのみを既定で表示する。
- 表示名は前述のとおり各版自身のスナップショットから解決する。

## L6. Share への Version 反映 (要件 §6, §7, §10)

- 画像ヘッダーに小さなバッジを 1 行:`ORDER v1` / `ORDER v2 · 更新版` / `未確定 (DRAFT)`。
  通常時に邪魔にならないよう、色は控えめ・フォントは 13px。
- テキストはヘッダー 3 行目に同じ文字列を入れる。
- **DRAFT でも共有は禁止しない**。ただし SHARE 画面上部に警告を出し、
  画像・テキストにも「未確定」を明示する (要件 §7)。
- UPDATED のまま共有しようとした場合は「確定版 v1 から変更されています」と警告する。
- v2 以降では「変更点のみ」「変更点＋全文」の 2 形式を追加で提供する (要件 §10)。

## L7. Season Commit (要件 §11–§13)

### L-03: 採用方式は **B (差分のみ反映)**

台帳 `SeasonCommit { id=orderId, teamId, committedVersion, committedAt, appearances[] }`
に「**そのオーダーが現在シーズン累計へ加えている量**」を記録する。
再反映時は `delta = 新しい版の出場数 − 台帳の出場数` を適用する。

A (v1 を Rollback してから v2 を適用) と**最終的な数値は完全に一致する**が、B を採った理由:

1. **書き込みが 1 回で済む。** A は「全部引く → 全部足す」の間に累計が一時的に誤った値になる。
   途中でアプリが閉じられると不整合が残る。
2. **構造的に冪等。** 同じ版を再反映すると delta が全て 0 になり、何も起きない。
   確認ダイアログに依存しない (要件 §11 の必須条件)。
3. **選手の増減が特別扱い不要。** v2 で外れた選手は delta が負になるだけ。

### 不変条件 (要件 §16)

```
base + v1 + (v2 − v1) = base + v2
```

すなわち「v1 反映 → v2 へ変更 → 再反映」の結果は
「最初から v2 を 1 回だけ反映した場合」と**完全に一致する**。
これは単体テストと E2E の両方で直接検証している。

補足: 種別別内訳 (`seasonAppearancesByKind`) も 0 になったキーを削除して正規化する。
これを怠ると、数値は一致しても「v1 由来の 0 のキーが残る」差が出てエクスポート結果が履歴依存になる。

### 安全装置

- **確定済み (FINALIZED) のオーダーのみ反映できる。** DRAFT / UPDATED では反映ボタンを無効化する。
- **反映の取り消し**を用意し、台帳の分を丸ごと差し戻せる。
- 手作業で累計を減らしていた場合に備え、負になる値は 0 で丸め、丸めた人数を警告する。

## L8. Storage

- IndexedDB を v2 へ。ストア `seasonCommits` を追加 (既存 DB は欠けているストアのみ作成されて在置アップグレード)。
- `SavedOrder.versions` が無い旧データは**空配列 = DRAFT** として読み込む。
- JSON バックアップにも `versions` と `seasonCommits` を含める。旧形式のバックアップも読める。

## L9. 層の分離 (要件 §17)

| 層 | 追加物 | 依存 |
|---|---|---|
| `domain/orders/lifecycle.ts` | fingerprint / 状態導出 / 版生成 / Diff | 純関数 |
| `domain/orders/seasonLedger.ts` | 差分計算 / 冪等コミット | 純関数 |
| `share/` | Version バッジ / 変更通知テキスト | optimizer 非依存 (ESLint で強制) |
| `state/appStore` | 台帳の永続化と適用 | — |

`optimizer/` のファイルは 1 行も変更していない。
