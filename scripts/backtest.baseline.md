# League Order — backtest report (fixture leagues)

Simulated data: validates the pipeline, not real-world accuracy.

## 1. Prediction backtest (strictly earlier days only)

| League | Level | n | Brier | Brier (50%) | Log loss | Log loss (50%) | ECE |
|---|---|---|---|---|---|---|---|
| ATDO | game | 312 | 0.2312 | 0.2500 | 0.6549 | 0.6931 | 0.121 |
| ATDO | match | 52 | 0.2104 | 0.2500 | 0.6127 | 0.6931 | 0.247 |
| TDO | game | 35 | 0.2446 | 0.2500 | 0.6822 | 0.6931 | 0.118 |
| TDO | match | 7 | 0.2354 | 0.2500 | 0.6638 | 0.6931 | 0.201 |
| TDA | game | 21 | 0.2498 | 0.2500 | 0.6927 | 0.6931 | 0.110 |
| TDA | match | 3 | 0.2525 | 0.2500 | 0.6981 | 0.6931 | 0.161 |

Calibration, games, all three leagues pooled:

| 予測帯 | 件数 | 平均予測 | 実績 |
|---|---|---|---|
| 30.0%–40.0% | 5 | 36.3% | 0.0% |
| 40.0%–50.0% | 116 | 47.5% | 44.8% |
| 50.0%–60.0% | 228 | 52.9% | 68.0% |
| 60.0%–70.0% | 17 | 63.2% | 88.2% |
| 70.0%–80.0% | 2 | 76.3% | 100.0% |

Calibration, matches (ATDO):

| 予測帯 | 件数 | 平均予測 | 実績 |
|---|---|---|---|
| 30.0%–40.0% | 2 | 34.7% | 0.0% |
| 40.0%–50.0% | 14 | 47.2% | 35.7% |
| 50.0%–60.0% | 26 | 54.5% | 84.6% |
| 60.0%–70.0% | 10 | 62.9% | 90.0% |

## 2. Parameter grid (ATDO games; defaults in bold)

| priorLegs | k | recency | Brier | Log loss | ECE |
|---|---|---|---|---|---|
| 20 | 0.07 | 1 / 0.8 / 0.6 | 0.2292 | 0.6506 | 0.125 |
| 20 | 0.07 | 1 / 0.6 / 0.35 | 0.2310 | 0.6546 | 0.127 |
| 20 | 0.07 | 1 / 0.4 / 0.2 | 0.2331 | 0.6590 | 0.128 |
| 20 | 0.09 | 1 / 0.8 / 0.6 | 0.2250 | 0.6414 | 0.115 |
| 20 | 0.09 | 1 / 0.6 / 0.35 | 0.2270 | 0.6459 | 0.116 |
| 20 | 0.09 | 1 / 0.4 / 0.2 | 0.2294 | 0.6510 | 0.119 |
| 20 | 0.11 | 1 / 0.8 / 0.6 | 0.2214 | 0.6334 | 0.113 |
| 20 | 0.11 | 1 / 0.6 / 0.35 | 0.2235 | 0.6381 | 0.117 |
| 20 | 0.11 | 1 / 0.4 / 0.2 | 0.2260 | 0.6438 | 0.117 |
| 30 | 0.07 | 1 / 0.8 / 0.6 | 0.2329 | 0.6584 | 0.138 |
| 30 | 0.07 | 1 / 0.6 / 0.35 | 0.2348 | 0.6623 | 0.129 |
| 30 | 0.07 | 1 / 0.4 / 0.2 | 0.2368 | 0.6664 | 0.143 |
| 30 | 0.09 | 1 / 0.8 / 0.6 | 0.2291 | 0.6504 | 0.128 |
| **30** | **0.09** | **1 / 0.6 / 0.35** | **0.2312** | **0.6549** | **0.121** |
| 30 | 0.09 | 1 / 0.4 / 0.2 | 0.2336 | 0.6599 | 0.136 |
| 30 | 0.11 | 1 / 0.8 / 0.6 | 0.2258 | 0.6431 | 0.118 |
| 30 | 0.11 | 1 / 0.6 / 0.35 | 0.2281 | 0.6482 | 0.115 |
| 30 | 0.11 | 1 / 0.4 / 0.2 | 0.2307 | 0.6538 | 0.128 |
| 45 | 0.07 | 1 / 0.8 / 0.6 | 0.2364 | 0.6657 | 0.133 |
| 45 | 0.07 | 1 / 0.6 / 0.35 | 0.2382 | 0.6693 | 0.137 |
| 45 | 0.07 | 1 / 0.4 / 0.2 | 0.2400 | 0.6730 | 0.150 |
| 45 | 0.09 | 1 / 0.8 / 0.6 | 0.2332 | 0.6591 | 0.126 |
| 45 | 0.09 | 1 / 0.6 / 0.35 | 0.2353 | 0.6634 | 0.130 |
| 45 | 0.09 | 1 / 0.4 / 0.2 | 0.2374 | 0.6678 | 0.145 |
| 45 | 0.11 | 1 / 0.8 / 0.6 | 0.2303 | 0.6529 | 0.118 |
| 45 | 0.11 | 1 / 0.6 / 0.35 | 0.2326 | 0.6578 | 0.124 |
| 45 | 0.11 | 1 / 0.4 / 0.2 | 0.2350 | 0.6629 | 0.139 |

## 3. Optimizer backtest (time-travel replays, model estimates only)

| Date | Team | vs | 信頼度 | 推奨 (対戦相手最適化) | 勝利優先 | 実際のオーダー | 差 | 実際の勝ちゲーム |
|---|---|---|---|---|---|---|---|---|
| 2026-09-10 | GpiQ | BEyE | LOW | 50.9% | 50.9% | 49.0% | +1.9 pt | 5 / 7 |
| 2026-09-10 | BEyE | GpiQ | LOW | 50.8% | 50.7% | 51.9% | -1.1 pt | 2 / 7 |
| 2026-09-10 | 68wv | N9dt | MEDIUM | 68.4% | 67.4% | 64.4% | +4.0 pt | 6 / 7 |
| 2026-09-10 | N9dt | 68wv | MEDIUM | 41.2% | 41.0% | 38.7% | +2.5 pt | 1 / 7 |
| 2026-09-10 | Rbrl | HtTk | LOW | 51.4% | 51.2% | 51.5% | -0.1 pt | 5 / 5 |
| 2026-09-10 | HtTk | Rbrl | LOW | 49.7% | 49.6% | 50.4% | -0.7 pt | 0 / 5 |
| 2026-09-10 | Phnx | DbTp | LOW | 50.7% | 50.7% | 50.7% | +0.0 pt | 4 / 5 |
| 2026-09-10 | DbTp | Phnx | LOW | 50.3% | 50.3% | 50.3% | +0.0 pt | 1 / 5 |
| 2026-09-17 | GpiQ | N9dt | MEDIUM | 59.1% | 55.5% | 56.2% | +2.9 pt | 4 / 7 |
| 2026-09-17 | N9dt | GpiQ | LOW | 43.4% | 43.3% | 43.4% | -0.1 pt | 3 / 7 |
| 2026-09-17 | BEyE | T180 | LOW | 56.7% | 56.6% | 59.7% | -3.0 pt | 5 / 7 |
| 2026-09-17 | T180 | BEyE | MEDIUM | 44.4% | 44.4% | 43.5% | +0.9 pt | 2 / 7 |
| 2026-09-17 | Rbrl | Phnx | MEDIUM | 47.7% | 47.6% | 46.6% | +1.1 pt | 2 / 5 |
| 2026-09-17 | Phnx | Rbrl | MEDIUM | 54.8% | 54.7% | 54.7% | +0.1 pt | 3 / 5 |
| 2026-09-17 | HtTk | DbTp | LOW | 49.1% | 49.1% | 49.9% | -0.8 pt | 4 / 5 |
| 2026-09-17 | DbTp | HtTk | LOW | 53.0% | 53.0% | 52.6% | +0.4 pt | 1 / 5 |
| 2026-09-24 | GpiQ | T180 | LOW | 58.9% | 58.7% | 57.0% | +2.0 pt | 6 / 7 |
| 2026-09-24 | T180 | GpiQ | LOW | 42.7% | 42.6% | 40.6% | +2.0 pt | 1 / 7 |
| 2026-09-24 | 68wv | BEyE | MEDIUM | 62.0% | 56.8% | 57.4% | +4.6 pt | 5 / 7 |
| 2026-09-24 | BEyE | 68wv | MEDIUM | 49.0% | 44.4% | 45.5% | +3.5 pt | 2 / 7 |
| 2026-09-24 | Rbrl | DbTp | LOW | 49.2% | 49.1% | 47.5% | +1.8 pt | 1 / 5 |
| 2026-09-24 | DbTp | Rbrl | MEDIUM | 48.0% | 47.9% | 48.3% | -0.3 pt | 4 / 5 |
| 2026-09-24 | HtTk | Phnx | MEDIUM | 43.9% | 43.8% | 44.5% | -0.6 pt | 2 / 5 |
| 2026-09-24 | Phnx | HtTk | MEDIUM | 57.0% | 56.9% | 55.3% | +1.7 pt | 3 / 5 |
| 2026-10-01 | 68wv | T180 | LOW | 67.4% | 67.4% | 64.1% | +3.3 pt | 5 / 7 |
| 2026-10-01 | T180 | 68wv | MEDIUM | 37.5% | 36.7% | 33.2% | +4.3 pt | 2 / 7 |
| 2026-10-01 | N9dt | BEyE | MEDIUM | 43.9% | 43.8% | 39.1% | +4.8 pt | 1 / 7 |
| 2026-10-01 | BEyE | N9dt | MEDIUM | 65.2% | 64.1% | 66.2% | -1.1 pt | 6 / 7 |
| 2026-10-01 | Rbrl | HtTk | MEDIUM | 56.8% | 56.7% | 50.6% | +6.3 pt | 3 / 5 |
| 2026-10-01 | HtTk | Rbrl | MEDIUM | 50.6% | 50.5% | 51.2% | -0.7 pt | 2 / 5 |
| 2026-10-01 | Phnx | DbTp | LOW | 58.8% | 58.6% | 58.6% | +0.2 pt | 4 / 5 |
| 2026-10-01 | DbTp | Phnx | MEDIUM | 43.5% | 43.2% | 41.3% | +2.2 pt | 1 / 5 |
| 2026-09-08 | Cm1t | Ar1t | LOW | 49.5% | 49.4% | 49.0% | +0.5 pt | 2 / 5 |
| 2026-09-08 | Ar1t | Cm1t | LOW | 50.9% | 50.9% | 50.9% | +0.0 pt | 3 / 5 |
| 2026-09-15 | Ow1t | Ar1t | LOW | 52.8% | 52.3% | 53.3% | -0.5 pt | 3 / 5 |
| 2026-09-15 | Ar1t | Ow1t | LOW | 47.7% | 47.5% | 46.6% | +1.1 pt | 2 / 5 |
| 2026-09-22 | Ow1t | Cm1t | LOW | 53.4% | 53.0% | 53.8% | -0.4 pt | 4 / 5 |
| 2026-09-22 | Cm1t | Ow1t | LOW | 46.9% | 46.8% | 45.3% | +1.6 pt | 1 / 5 |
| 2026-09-10 | Tg1h | Cm1h | LOW | 51.9% | 51.5% | 51.8% | +0.1 pt | 3 / 5 |
| 2026-09-10 | Cm1h | Tg1h | LOW | 49.0% | 48.8% | 48.4% | +0.5 pt | 2 / 5 |

- replays: 40
- mean model-estimated uplift vs fielded order: 1.13 pt
- worst: -2.98 pt; recommendation not lower in 70.0% of matches
- mean uplift vs 勝利優先 candidate: 0.51 pt
- fairness of the recommendation: mean spread 0.78, mean most games by one player 2.52, benched participant in 0.0% of matches; bias gate kept a biased split in 9, set one aside in 26
- fielded orders, estimate vs result: Brier 0.2065 (50%: 0.2500), n = 40 (both sides of each match; small sample)

## 3b. Sensitivity of the recommended order (ATDO, 7-game format, 6 replays)

| Change | Mean regret | Max regret | Seats changed |
|---|---|---|---|
| recency flatter (1 / 0.8 / 0.6) | 0.22 pt | 1.15 pt | 11.1% |
| recency steeper (1 / 0.4 / 0.2) | 0.00 pt | 0.00 pt | 18.1% |
| shrinkage prior 20 legs | 0.00 pt | 0.00 pt | 5.6% |
| shrinkage prior 45 legs | 0.00 pt | 0.00 pt | 12.5% |
| logistic k × 0.8 | 0.00 pt | 0.00 pt | 9.7% |
| logistic k × 1.2 | 0.00 pt | 0.00 pt | 0.0% |
| confidence one level lower | 0.00 pt | 0.00 pt | 13.9% |
| confidence one level higher | 0.56 pt | 3.33 pt | 11.1% |

## 4. Performance (Node, this machine)

- replay (fetch + plan + intelligence) of 40 matches: <ms> ms total
- optimizer (4 candidates) per match: median <ms> ms, max <ms> ms

## 3c. Appearance-bias gate: threshold calibration (same replays, 対戦相手最適化 candidate)

| Threshold (per one-game shift) | Mean est. match value | Mean uplift vs fielded | Worst | Not lower | Mean spread | Most games by one player | Benched participant | Biased kept / set aside |
|---|---|---|---|---|---|---|---|---|
| off (no gate) | 52.5% | 2.19 pt | -1.96 pt | 92.5% | 0.93 | 2.63 | 0.0% | 0 / 0 |
| 0 pt | 53.1% | 2.77 pt | -2.98 pt | 72.5% | 2.05 | 3.40 | 27.5% | 12 / 23 |
| 1 pt | 51.7% | 1.34 pt | -2.98 pt | 72.5% | 0.88 | 2.60 | 0.0% | 10 / 25 |
| **2 pt (default)** | 51.5% | 1.13 pt | -2.98 pt | 70.0% | 0.78 | 2.52 | 0.0% | 9 / 26 |
| 3 pt | 50.5% | 0.20 pt | -5.69 pt | 57.5% | 0.45 | 2.38 | 0.0% | 0 / 35 |
| 5 pt | 50.5% | 0.20 pt | -5.69 pt | 57.5% | 0.45 | 2.38 | 0.0% | 0 / 35 |
- requests: first sync 4, + opponent analysis (2 past seasons) 18, re-sync season resolution 2
- duplicate requests within one sync: 0

## 5. Throw-order model (same replays, 対戦相手最適化 candidate, model estimates only)

Every order below is estimated with the throw-order model on the same pre-match data. "Order-free model" is the
engine with the model switched off (the path orders saved before it keep); "internal-id order" writes the same
members in id order — what the throwing order must never follow.

| Order | Mean est. match value | Mean est. game win | Mean P(W≥1) | Mean E[W] |
|---|---|---|---|---|
| **New recommendation (throw-order model)** | 51.5% | 50.7% | 97.9% | 2.945 |
| New recommendation, members in internal-id order | 51.4% | 50.7% | 97.9% | 2.943 |
| Order-free model recommendation, as written (id order) | 51.2% | 50.6% | 97.9% | 2.937 |
| Order-free model recommendation, members in strong order | 51.2% | 50.6% | 97.9% | 2.937 |
| Fielded order, as fielded | 50.3% | 50.2% | 97.8% | 2.910 |
| Fielded order, members in strong order | 50.4% | 50.2% | 97.8% | 2.912 |

- new vs order-free recommendation: mean +0.24 pt, min +0.00 pt, max +4.49 pt (match value)
- strong order vs internal-id order, same members: mean +0.06 pt, max +0.22 pt
- seats changed vs the order-free recommendation: 15.5%; same members, throwing order changed: 1 / 65 (1.5%) games
- multi-player games decided: 104 (Cricket 24); shown order differs from internal-id order in 62 / 104 (59.6%)
- non-strong order adopted (投順変更率): 0 / 104 (0.0%); adopted gain mean —, max —
- best alternative by the estimate (adopted or not): mean +0.00 pt, max +0.00 pt (threshold +2 pt)
- why the strong order was kept: 強い順が推定でも最善 / 推定で採用 77; 強い順との差が 2pt 未満の 3; Cricket は投順の効果を推定できるデータがない 24
- LOW-confidence games: 92; non-strong order adopted among them: 0; adopted under +2 pt: 0
- fielded orders not in the strong order: 48 / 104 (46.2%) multi-player games
- fairness, new / order-free: mean spread 0.78 / 0.70, most games by one player 2.52 / 2.50, most games in one role 1.23 / 1.18, benched 0.0% / 0.0%
- hard-constraint violations (every candidate of both engines): 0
- time per generation, throw-order model (node-bounded): median <ms> ms, max <ms> ms
- time per generation, order-free model (node-bounded): median <ms> ms, max <ms> ms

## 5b. Throw-order guardrails, synthetic stress test (240 seeded one-game cases, invented teams)

One Doubles or Trios game whose members are fixed, so the throwing order is the only choice. Finishing evidence
(First 9 excess) is drawn realistic (±8) or extreme (±18). Estimates of the model on invented data, not real results.

| Confidence | Finishing evidence | Opponent order | Cases | Non-strong adopted | Mean best gain | Max best gain | Min adopted gain |
|---|---|---|---|---|---|---|---|
| HIGH | realistic (±8) | known | 70 | 1 / 70 (1.4%) | +0.07 pt | +2.31 pt | +2.31 pt |
| HIGH | realistic (±8) | unknown | 22 | 0 / 22 (0.0%) | +0.05 pt | +0.81 pt | — |
| HIGH | extreme (±18) | known | 26 | 2 / 26 (7.7%) | +0.30 pt | +3.21 pt | +2.75 pt |
| HIGH | extreme (±18) | unknown | 2 | 0 / 2 (0.0%) | +0.00 pt | +0.00 pt | — |
| MEDIUM | realistic (±8) | known | 29 | 0 / 29 (0.0%) | +0.18 pt | +1.49 pt | — |
| MEDIUM | realistic (±8) | unknown | 16 | 0 / 16 (0.0%) | +0.06 pt | +0.46 pt | — |
| MEDIUM | extreme (±18) | known | 12 | 1 / 12 (8.3%) | +0.33 pt | +2.47 pt | +2.47 pt |
| MEDIUM | extreme (±18) | unknown | 2 | 0 / 2 (0.0%) | +0.00 pt | +0.00 pt | — |
| LOW | realistic (±8) | known | 40 | 0 / 40 (0.0%) | +0.05 pt | +1.36 pt | — |
| LOW | realistic (±8) | unknown | 9 | 0 / 9 (0.0%) | +0.04 pt | +0.39 pt | — |
| LOW | extreme (±18) | known | 10 | 0 / 10 (0.0%) | +0.39 pt | +1.43 pt | — |
| LOW | extreme (±18) | unknown | 2 | 0 / 2 (0.0%) | +0.24 pt | +0.48 pt | — |

- non-strong order adopted: 4 / 240 (1.7%); adopted under +2 pt: 0
- adopted with LOW confidence: 0 / 61; adopted with the opponent order unknown: 0 / 53
- opponent order reversed → our order changed: 8 / 240 (3.3%); all with MEDIUM+ data and a known opponent order: yes
- internal ids relabelled (sort order reversed) → order changed: 0 / 240
- hard-constraint violations: 0
- time per generation, one-game case: median <ms> ms, max <ms> ms

## 6. Underdog plan (格上対策案; model estimates only)

Fixture replays:

- outcome: standard plan above 20% 40 (of 40)
- offered against the rules (shown win > 20%, LOW data or improvement < 2 pt): 0
- hard-constraint violations (standard candidates and plans): 0
- standard plans at or below 20% shown: 0 / 40

Synthetic underdog matches (120 seeded cases, invented teams; opponent 6–22 PPR stronger on average):

- outcome: offered 31; no plan improves by 2 pt 57; LOW opponent data 23; standard plan above 20% 9 (of 120)
- plan offered: A (max P(W≥1)) 31, B (max E[W]) 0; chosen improvement on the 0..1 scale mean +5.73 pt, max +13.32 pt
- both plans, improvement on the common scale: A mean +5.73 pt, B mean +0.96 pt
- P(W≥1) standard → plan: 64.7% → 70.5%; E[W] 0.939 → 1.052
- estimated match win given up (standard − plan): mean -0.45 pt, max +1.69 pt
- appearance spread standard → plan: 1.00 → 1.61
- offered against the rules (shown win > 20%, LOW data or improvement < 2 pt): 0
- hard-constraint violations (standard candidates and plans): 0
- time per generation, underdog case (4 candidates + plans, node-bounded): median <ms> ms, max <ms> ms
