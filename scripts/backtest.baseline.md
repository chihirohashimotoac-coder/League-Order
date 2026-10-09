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
| 2026-09-10 | GpiQ | BEyE | LOW | 49.8% | 49.8% | 48.4% | +1.4 pt | 5 / 7 |
| 2026-09-10 | BEyE | GpiQ | LOW | 51.6% | 51.6% | 52.9% | -1.3 pt | 2 / 7 |
| 2026-09-10 | 68wv | N9dt | MEDIUM | 68.7% | 67.9% | 64.2% | +4.5 pt | 6 / 7 |
| 2026-09-10 | N9dt | 68wv | MEDIUM | 41.4% | 41.3% | 39.0% | +2.4 pt | 1 / 7 |
| 2026-09-10 | Rbrl | HtTk | LOW | 51.4% | 51.2% | 51.5% | -0.1 pt | 5 / 5 |
| 2026-09-10 | HtTk | Rbrl | LOW | 49.3% | 49.3% | 49.9% | -0.7 pt | 0 / 5 |
| 2026-09-10 | Phnx | DbTp | LOW | 50.2% | 50.2% | 50.2% | +0.0 pt | 4 / 5 |
| 2026-09-10 | DbTp | Phnx | LOW | 50.7% | 50.7% | 50.7% | +0.0 pt | 1 / 5 |
| 2026-09-17 | GpiQ | N9dt | MEDIUM | 54.9% | 54.9% | 55.8% | -0.9 pt | 4 / 7 |
| 2026-09-17 | N9dt | GpiQ | LOW | 43.9% | 43.9% | 44.1% | -0.2 pt | 3 / 7 |
| 2026-09-17 | BEyE | T180 | LOW | 57.4% | 57.4% | 61.0% | -3.6 pt | 5 / 7 |
| 2026-09-17 | T180 | BEyE | MEDIUM | 43.7% | 43.6% | 42.8% | +0.8 pt | 2 / 7 |
| 2026-09-17 | Rbrl | Phnx | MEDIUM | 47.8% | 47.8% | 47.4% | +0.5 pt | 2 / 5 |
| 2026-09-17 | Phnx | Rbrl | MEDIUM | 54.0% | 54.0% | 54.0% | +0.1 pt | 3 / 5 |
| 2026-09-17 | HtTk | DbTp | LOW | 49.0% | 48.9% | 49.8% | -0.8 pt | 4 / 5 |
| 2026-09-17 | DbTp | HtTk | LOW | 53.1% | 53.1% | 52.8% | +0.3 pt | 1 / 5 |
| 2026-09-24 | GpiQ | T180 | LOW | 58.9% | 58.9% | 56.8% | +2.1 pt | 6 / 7 |
| 2026-09-24 | T180 | GpiQ | LOW | 42.1% | 42.1% | 39.5% | +2.6 pt | 1 / 7 |
| 2026-09-24 | 68wv | BEyE | MEDIUM | 61.7% | 60.5% | 56.7% | +5.0 pt | 5 / 7 |
| 2026-09-24 | BEyE | 68wv | MEDIUM | 44.8% | 44.6% | 46.0% | -1.2 pt | 2 / 7 |
| 2026-09-24 | Rbrl | DbTp | LOW | 48.3% | 48.2% | 47.3% | +1.0 pt | 1 / 5 |
| 2026-09-24 | DbTp | Rbrl | MEDIUM | 48.2% | 48.2% | 48.2% | +0.0 pt | 4 / 5 |
| 2026-09-24 | HtTk | Phnx | MEDIUM | 44.4% | 44.4% | 45.0% | -0.6 pt | 2 / 5 |
| 2026-09-24 | Phnx | HtTk | MEDIUM | 56.7% | 56.7% | 54.3% | +2.4 pt | 3 / 5 |
| 2026-10-01 | 68wv | T180 | LOW | 67.7% | 67.7% | 64.8% | +2.9 pt | 5 / 7 |
| 2026-10-01 | T180 | 68wv | MEDIUM | 37.2% | 36.5% | 33.0% | +4.2 pt | 2 / 7 |
| 2026-10-01 | N9dt | BEyE | MEDIUM | 43.9% | 43.7% | 39.3% | +4.5 pt | 1 / 7 |
| 2026-10-01 | BEyE | N9dt | MEDIUM | 64.8% | 63.8% | 65.7% | -0.9 pt | 6 / 7 |
| 2026-10-01 | Rbrl | HtTk | MEDIUM | 57.4% | 57.2% | 51.0% | +6.3 pt | 3 / 5 |
| 2026-10-01 | HtTk | Rbrl | MEDIUM | 50.3% | 50.3% | 51.0% | -0.7 pt | 2 / 5 |
| 2026-10-01 | Phnx | DbTp | LOW | 58.3% | 58.2% | 57.7% | +0.6 pt | 4 / 5 |
| 2026-10-01 | DbTp | Phnx | MEDIUM | 44.2% | 44.2% | 42.2% | +2.0 pt | 1 / 5 |
| 2026-09-08 | Cm1t | Ar1t | LOW | 49.4% | 49.2% | 48.9% | +0.5 pt | 2 / 5 |
| 2026-09-08 | Ar1t | Cm1t | LOW | 50.9% | 50.9% | 50.9% | +0.0 pt | 3 / 5 |
| 2026-09-15 | Ow1t | Ar1t | LOW | 52.6% | 52.2% | 53.1% | -0.5 pt | 3 / 5 |
| 2026-09-15 | Ar1t | Ow1t | LOW | 47.8% | 47.5% | 46.7% | +1.1 pt | 2 / 5 |
| 2026-09-22 | Ow1t | Cm1t | LOW | 53.1% | 52.8% | 53.6% | -0.4 pt | 4 / 5 |
| 2026-09-22 | Cm1t | Ow1t | LOW | 46.9% | 46.8% | 45.4% | +1.5 pt | 1 / 5 |
| 2026-09-10 | Tg1h | Cm1h | LOW | 51.7% | 51.4% | 51.6% | +0.1 pt | 3 / 5 |
| 2026-09-10 | Cm1h | Tg1h | LOW | 49.0% | 48.8% | 48.5% | +0.5 pt | 2 / 5 |

- replays: 40
- mean model-estimated uplift vs fielded order: 0.89 pt
- worst: -3.61 pt; recommendation not lower in 67.5% of matches
- mean uplift vs 勝利優先 candidate: 0.18 pt
- fairness of the recommendation: mean spread 0.70, mean most games by one player 2.50, benched participant in 0.0% of matches; bias gate kept a biased split in 7, set one aside in 28
- fielded orders, estimate vs result: Brier 0.2081 (50%: 0.2500), n = 40 (both sides of each match; small sample)

## 3b. Sensitivity of the recommended order (ATDO, 7-game format, 6 replays)

| Change | Mean regret | Max regret | Seats changed |
|---|---|---|---|
| recency flatter (1 / 0.8 / 0.6) | 0.77 pt | 4.12 pt | 20.8% |
| recency steeper (1 / 0.4 / 0.2) | 0.00 pt | 0.00 pt | 11.1% |
| shrinkage prior 20 legs | 0.00 pt | 0.00 pt | 5.6% |
| shrinkage prior 45 legs | 0.00 pt | 0.00 pt | 2.8% |
| logistic k × 0.8 | 0.00 pt | 0.00 pt | 2.8% |
| logistic k × 1.2 | 0.00 pt | 0.00 pt | 0.0% |
| confidence one level lower | 0.00 pt | 0.00 pt | 9.7% |
| confidence one level higher | 0.59 pt | 3.54 pt | 6.9% |

## 4. Performance (Node, this machine)

- replay (fetch + plan + intelligence) of 40 matches: <ms> ms total
- optimizer (4 candidates) per match: median <ms> ms, max <ms> ms

## 3c. Appearance-bias gate: threshold calibration (same replays, 対戦相手最適化 candidate)

| Threshold (per one-game shift) | Mean est. match value | Mean uplift vs fielded | Worst | Not lower | Mean spread | Most games by one player | Benched participant | Biased kept / set aside |
|---|---|---|---|---|---|---|---|---|
| off (no gate) | 52.6% | 2.29 pt | -1.94 pt | 92.5% | 0.93 | 2.63 | 0.0% | 0 / 0 |
| 0 pt | 53.0% | 2.72 pt | -3.61 pt | 75.0% | 1.95 | 3.33 | 25.0% | 12 / 23 |
| 1 pt | 51.6% | 1.33 pt | -3.61 pt | 75.0% | 0.93 | 2.65 | 0.0% | 11 / 24 |
| **2 pt (default)** | 51.2% | 0.89 pt | -3.61 pt | 67.5% | 0.70 | 2.50 | 0.0% | 7 / 28 |
| 3 pt | 50.5% | 0.25 pt | -5.56 pt | 60.0% | 0.47 | 2.38 | 0.0% | 1 / 34 |
| 5 pt | 50.4% | 0.11 pt | -5.56 pt | 57.5% | 0.45 | 2.38 | 0.0% | 0 / 35 |
- requests: first sync 4, + opponent analysis (2 past seasons) 12, re-sync season resolution 2
- duplicate requests within one sync: 0
