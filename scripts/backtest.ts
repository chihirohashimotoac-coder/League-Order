/**
 * Backtest and calibration report on the fixture leagues (`npm run backtest`).
 *
 * Prints, as Markdown, what docs/PREDICTION_MODEL.md and docs/OPPONENT_OPTIMIZER.md quote:
 *
 *   1. game / match prediction metrics per league (Brier, log loss, calibration) next to
 *      the 50% baseline — every game predicted from strictly earlier days only;
 *   2. a parameter grid (shrinkage prior × logistic k × recency weights);
 *   3. the optimizer backtest on time-travel replays: model-estimated match win of the
 *      recommended order vs the order actually fielded, under the same pre-match data;
 *   4. timings and request counts;
 *   5. the throw-order model (docs/THROW_ORDER_MODEL.md §8): on the replays, the new
 *      recommendation against the order-free model's and against internal-id order, the
 *      order decisions and their guardrails; then a seeded synthetic stress test;
 *   6. the underdog plan (docs/UNDERDOG_PLAN.md §6): when it is offered, which plan, and at
 *      what cost, on the replays and on seeded synthetic underdog matches.
 *
 * The fixtures are simulated (src/test/n01/generator.ts) and sections 5–6 add invented
 * teams (src/test/throwOrderScenarios.ts): the numbers validate the pipeline and guard
 * against regressions; they are not a measure of real-world accuracy or of real wins.
 * Deterministic: no network, seeded data, fixed clock.
 */
import { generateOrder } from '../src/optimizer/generateOrder';
import { SKEW_GAIN_THRESHOLD } from '../src/optimizer/skewGate';
import type { OrderInput, OrderSolution } from '../src/domain/types';
import { metrics, modelPredictor, runBacktest, type Metrics } from '../src/domain/prediction/backtest';
import { K_LEG } from '../src/domain/prediction/matchup';
import { PRIOR_LEGS } from '../src/domain/prediction/playerStrength';
import { RECENCY_WEIGHTS } from '../src/domain/n01/recency';
import { N01Client } from '../src/integrations/n01/client';
import type { N01Request } from '../src/integrations/n01/endpoints';
import { fetchTeamData, planN01Sync, resolveLinkedTeam } from '../src/integrations/n01/sync';
import { buildIntelligenceSnapshot, fetchIntelligence } from '../src/integrations/n01/intelligence';
import { atdoSpec, FIXTURE_NOW, fixtureLeagues, tdoSpec } from '../src/test/n01/leagues';
import { backtestGames } from '../src/test/n01/backtestData';
import { playedTeamMatches, replayMatch, type ReplayedMatch } from '../src/test/n01/replay';
import { PERTURBATIONS, orderBacktestSummary, sensitivity } from '../src/test/n01/orderBacktest';
import { createFixtureTransport } from '../src/test/n01/transport';
import { ORDER_MIN_GAIN } from '../src/domain/prediction/throwOrder';
import { ORDER_FALLBACK_LABELS, type OrderFallback } from '../src/domain/prediction/throwOrder';
import { seatChange } from '../src/test/n01/orderBacktest';
import { throwOrderCases, underdogCases } from '../src/test/throwOrderScenarios';
import {
  emptyTally,
  estimateOf,
  hardViolations,
  idOrdered,
  orderOnlyChanges,
  runStressCase,
  runUnderdogCase,
  sameOrder,
  strongOrdered,
  tallyRecords,
  withoutThrowOrderModel,
  type DecisionTally,
  type OrderEstimate,
  type StressRow,
  type UnderdogRow,
} from '../src/test/throwOrderBacktest';

const pct = (value: number): string => `${(value * 100).toFixed(1)}%`;

/**
 * The report's searches are bounded by the optimizer's node limit only, never by the
 * clock, so every number below reads the same on any machine. (The app itself stops at
 * its time limit; section 4 times it with the app's settings.)
 */
const UNTIMED = { timeLimitMs: 10 * 60 * 1000 };
const num = (value: number, digits = 4): string => (Number.isFinite(value) ? value.toFixed(digits) : '—');

function ece(m: Metrics): number {
  return m.n === 0 ? Number.NaN : m.calibration.reduce((acc, bucket) => acc + bucket.count * Math.abs(bucket.meanPredicted - bucket.observedRate), 0) / m.n;
}

function calibrationTable(m: Metrics): string[] {
  const lines = ['| 予測帯 | 件数 | 平均予測 | 実績 |', '|---|---|---|---|'];
  for (const bucket of m.calibration) {
    lines.push(`| ${pct(bucket.from)}–${pct(bucket.to)} | ${bucket.count} | ${pct(bucket.meanPredicted)} | ${pct(bucket.observedRate)} |`);
  }
  return lines;
}

function section1(): void {
  console.log('## 1. Prediction backtest (strictly earlier days only)\n');
  console.log('| League | Level | n | Brier | Brier (50%) | Log loss | Log loss (50%) | ECE |');
  console.log('|---|---|---|---|---|---|---|---|');
  const leagues = fixtureLeagues();
  const reports = Object.entries(leagues).map(([name, league]) => [name, runBacktest(backtestGames(league), modelPredictor())] as const);
  for (const [name, report] of reports) {
    console.log(`| ${name.toUpperCase()} | game | ${report.games.n} | ${num(report.games.brier)} | ${num(report.gameBaseline.brier)} | ${num(report.games.logLoss)} | ${num(report.gameBaseline.logLoss)} | ${num(ece(report.games), 3)} |`);
    console.log(`| ${name.toUpperCase()} | match | ${report.matches.n} | ${num(report.matches.brier)} | ${num(report.matchBaseline.brier)} | ${num(report.matches.logLoss)} | ${num(report.matchBaseline.logLoss)} | ${num(ece(report.matches), 3)} |`);
  }
  const pooled = reports.flatMap(([, report]) => report.predictions.map(({ game, probability }) => ({ p: probability, y: game.homeWon ? 1 : 0 })));
  console.log('\nCalibration, games, all three leagues pooled:\n');
  console.log(calibrationTable(metrics(pooled)).join('\n'));
  const atdo = reports.find(([name]) => name === 'atdo')![1];
  console.log('\nCalibration, matches (ATDO):\n');
  console.log(calibrationTable(atdo.matches).join('\n'));
}

function section2(): void {
  console.log('\n## 2. Parameter grid (ATDO games; defaults in bold)\n');
  console.log('| priorLegs | k | recency | Brier | Log loss | ECE |');
  console.log('|---|---|---|---|---|---|');
  const games = backtestGames(fixtureLeagues().atdo);
  for (const priorLegs of [20, PRIOR_LEGS, 45]) {
    for (const k of [0.07, K_LEG, 0.11]) {
      for (const weights of [[1, 0.8, 0.6], RECENCY_WEIGHTS, [1, 0.4, 0.2]]) {
        const report = runBacktest(games, modelPredictor({ parameters: { priorLegs, weights }, k }));
        const isDefault = priorLegs === PRIOR_LEGS && k === K_LEG && weights === RECENCY_WEIGHTS;
        const b = (text: string): string => (isDefault ? `**${text}**` : text);
        console.log(`| ${b(String(priorLegs))} | ${b(String(k))} | ${b(weights.join(' / '))} | ${b(num(report.games.brier))} | ${b(num(report.games.logLoss))} | ${b(num(ece(report.games), 3))} |`);
      }
    }
  }
}


interface FairnessSummary {
  meanSpread: number;
  meanMostGames: number;
  /** Share of orders in which a participant plays nothing although there are games for everyone. */
  benchedShare: number;
  kept: number;
  replaced: number;
}

function fairnessOf(solutions: readonly OrderSolution[]): FairnessSummary {
  const n = Math.max(1, solutions.length);
  return {
    meanSpread: solutions.reduce((acc, s) => acc + s.metrics.appearanceSpread, 0) / n,
    meanMostGames: solutions.reduce((acc, s) => acc + Math.max(...s.tallies.map((t) => t.count)), 0) / n,
    benchedShare:
      solutions.filter((s) => s.metrics.totalSlots >= s.metrics.participantCount && s.tallies.some((t) => t.count === 0)).length / n,
    kept: solutions.filter((s) => s.meta.skewGate?.outcome === 'kept').length,
    replaced: solutions.filter((s) => s.meta.skewGate?.outcome === 'replaced').length,
  };
}

async function replaysOfFixtures(): Promise<ReplayedMatch[]> {
  const leagues = fixtureLeagues();
  const replays: ReplayedMatch[] = [];
  for (const target of playedTeamMatches(leagues.atdo.games, 't_ABvC_5234')) {
    replays.push(await replayMatch(atdoSpec(), leagues.atdo.games, target, 't_ABvC_5234'));
  }
  for (const tournamentId of ['t_TDtu_7001', 't_TDth_7002']) {
    for (const target of playedTeamMatches(leagues.tdo.games, tournamentId)) {
      replays.push(await replayMatch(tdoSpec(), leagues.tdo.games, target, tournamentId));
    }
  }
  return replays;
}

/**
 * The appearance-bias gate's threshold against estimated match value and fairness, on the
 * replayed fixture matches (docs/DESIGN.md, appearance bias). `off` is the engine without
 * the gate. The default is a provisional policy value, not a measurement: real leagues
 * should read this table with their own data before moving it.
 */
async function section3c(): Promise<void> {
  console.log('\n## 3c. Appearance-bias gate: threshold calibration (same replays, 対戦相手最適化 candidate)\n');
  console.log('| Threshold (per one-game shift) | Mean est. match value | Mean uplift vs fielded | Worst | Not lower | Mean spread | Most games by one player | Benched participant | Biased kept / set aside |');
  console.log('|---|---|---|---|---|---|---|---|---|');
  const replays = await replaysOfFixtures();
  for (const threshold of [null, 0, 0.01, SKEW_GAIN_THRESHOLD, 0.03, 0.05]) {
    const seen: OrderSolution[] = [];
    const generate = (input: OrderInput) => {
      const result = generateOrder({ ...input, settings: { ...input.settings, skewGainThreshold: threshold } }, UNTIMED);
      if (!result.ok) throw new Error('generation failed');
      seen.push(result.candidates[0]);
      return result.candidates;
    };
    const summary = orderBacktestSummary(replays, generate);
    const fair = fairnessOf(seen);
    const mean = summary.rows.reduce((acc, row) => acc + row.recommended, 0) / Math.max(1, summary.rows.length);
    const name = threshold === null ? 'off (no gate)' : threshold === SKEW_GAIN_THRESHOLD ? `**${(threshold * 100).toFixed(0)} pt (default)**` : `${(threshold * 100).toFixed(0)} pt`;
    console.log(
      `| ${name} | ${pct(mean)} | ${(summary.meanUplift * 100).toFixed(2)} pt | ${(summary.worstUplift * 100).toFixed(2)} pt | ${pct(summary.notWorseShare)} | ${fair.meanSpread.toFixed(2)} | ${fair.meanMostGames.toFixed(2)} | ${pct(fair.benchedShare)} | ${fair.kept} / ${fair.replaced} |`,
    );
  }
}

async function section3(): Promise<ReplayedMatch[]> {
  console.log('\n## 3. Optimizer backtest (time-travel replays, model estimates only)\n');
  const leagues = fixtureLeagues();
  const started = performance.now();
  const replays: ReplayedMatch[] = [];
  for (const target of playedTeamMatches(leagues.atdo.games, 't_ABvC_5234')) {
    replays.push(await replayMatch(atdoSpec(), leagues.atdo.games, target, 't_ABvC_5234'));
  }
  for (const tournamentId of ['t_TDtu_7001', 't_TDth_7002']) {
    for (const target of playedTeamMatches(leagues.tdo.games, tournamentId)) {
      replays.push(await replayMatch(tdoSpec(), leagues.tdo.games, target, tournamentId));
    }
  }
  const replayMs = performance.now() - started;
  const recommended: OrderSolution[] = [];
  const generate = (input: OrderInput) => {
    const result = generateOrder(input, UNTIMED);
    if (!result.ok) throw new Error('generation failed');
    recommended.push(result.candidates[0]);
    return result.candidates;
  };
  const summary = orderBacktestSummary(replays, generate);
  console.log('| Date | Team | vs | 信頼度 | 推奨 (対戦相手最適化) | 勝利優先 | 実際のオーダー | 差 | 実際の勝ちゲーム |');
  console.log('|---|---|---|---|---|---|---|---|---|');
  for (const row of summary.rows) {
    const diff = row.recommended - row.fielded;
    console.log(`| ${row.date} | ${row.teamTpid} | ${row.opponentTpid} | ${row.confidence} | ${pct(row.recommended)} | ${pct(row.winFirst)} | ${pct(row.fielded)} | ${diff >= 0 ? '+' : ''}${(diff * 100).toFixed(1)} pt | ${row.gamesWonActually} / ${row.gameCount} |`);
  }
  console.log('');
  console.log(`- replays: ${summary.rows.length}`);
  console.log(`- mean model-estimated uplift vs fielded order: ${(summary.meanUplift * 100).toFixed(2)} pt`);
  console.log(`- worst: ${(summary.worstUplift * 100).toFixed(2)} pt; recommendation not lower in ${pct(summary.notWorseShare)} of matches`);
  console.log(`- mean uplift vs 勝利優先 candidate: ${(summary.meanUpliftOverWinFirst * 100).toFixed(2)} pt`);
  const fair = fairnessOf(recommended);
  console.log(
    `- fairness of the recommendation: mean spread ${fair.meanSpread.toFixed(2)}, mean most games by one player ${fair.meanMostGames.toFixed(2)}, ` +
      `benched participant in ${pct(fair.benchedShare)} of matches; bias gate kept a biased split in ${fair.kept}, set one aside in ${fair.replaced}`,
  );
  // The realised outcome of the fielded order against its own pre-match estimate.
  const fieldedPairs = summary.rows.map((row) => ({
    p: row.fielded,
    y: row.gamesWonActually * 2 > row.gameCount ? 1 : row.gamesWonActually * 2 === row.gameCount ? 0.5 : 0,
  }));
  const fieldedMetrics = metrics(fieldedPairs);
  console.log(`- fielded orders, estimate vs result: Brier ${num(fieldedMetrics.brier)} (50%: ${num(metrics(fieldedPairs.map(({ y }) => ({ p: 0.5, y }))).brier)}), n = ${fieldedMetrics.n} (both sides of each match; small sample)`);
  console.log('\n## 3b. Sensitivity of the recommended order (ATDO, 7-game format, 6 replays)\n');
  console.log('| Change | Mean regret | Max regret | Seats changed |');
  console.log('|---|---|---|---|');
  const sample = replays.filter((replay) => replay.tournamentId === 't_ABvC_5234' && replay.format.games.length === 7).slice(0, 6);
  const single = (input: OrderInput) => {
    const result = generateOrder(input, { singleCandidate: true, ...UNTIMED });
    if (!result.ok) throw new Error('generation failed');
    return result.candidates[0];
  };
  for (const perturbation of PERTURBATIONS) {
    const result = sensitivity(sample, perturbation, single);
    console.log(`| ${perturbation.name} | ${(result.meanRegret * 100).toFixed(2)} pt | ${(result.maxRegret * 100).toFixed(2)} pt | ${pct(result.meanSeatChange)} |`);
  }
  // The app's own settings (time limit included), for timing only.
  const times = replays
    .map((replay) => {
      const started = performance.now();
      generateOrder(replay.order.input);
      return performance.now() - started;
    })
    .sort((a, b) => a - b);
  console.log(`\n## 4. Performance (Node, this machine)\n`);
  console.log(`- replay (fetch + plan + intelligence) of ${replays.length} matches: ${replayMs.toFixed(0)} ms total`);
  console.log(`- optimizer (4 candidates) per match: median ${times[Math.floor(times.length / 2)].toFixed(0)} ms, max ${times[times.length - 1].toFixed(0)} ms`);
  return replays;
}

// ---------------------------------------------------------------------------
// 5. Throw-order model
// ---------------------------------------------------------------------------

const pt = (value: number, digits = 2): string => `${value >= 0 ? '+' : ''}${(value * 100).toFixed(digits)} pt`;
const meanOf = (values: readonly number[]): number => (values.length === 0 ? Number.NaN : values.reduce((a, b) => a + b, 0) / values.length);
const maxOf = (values: readonly number[]): number => (values.length === 0 ? Number.NaN : Math.max(...values));
const ptOrDash = (value: number): string => (Number.isFinite(value) ? pt(value) : '—');
const share = (count: number, total: number): string => `${count} / ${total} (${total === 0 ? '—' : pct(count / total)})`;

function timingLine(label: string, times: number[]): string {
  const sorted = [...times].sort((a, b) => a - b);
  return `- time per generation, ${label}: median ${sorted[Math.floor(sorted.length / 2)].toFixed(0)} ms, max ${sorted[sorted.length - 1].toFixed(0)} ms`;
}

function estimateRow(name: string, estimates: readonly (OrderEstimate | null)[]): string {
  const present = estimates.filter((estimate): estimate is OrderEstimate => estimate !== null);
  const avg = (pick: (estimate: OrderEstimate) => number): number => meanOf(present.map(pick));
  return `| ${name} | ${pct(avg((e) => e.value))} | ${pct(avg((e) => e.gameWin))} | ${pct(avg((e) => e.atLeastOne))} | ${avg((e) => e.expectedWins).toFixed(3)} |`;
}

function fallbackText(tally: DecisionTally): string {
  const order: (OrderFallback | 'best')[] = ['best', 'small-gain', 'low-confidence', 'no-order-data', 'opponent-order-unknown', 'unstable', 'cricket', 'large-side', 'no-model'];
  return order
    .filter((key) => (tally.fallbacks[key] ?? 0) > 0)
    .map((key) => `${key === 'best' ? '強い順が推定でも最善 / 推定で採用' : ORDER_FALLBACK_LABELS[key as OrderFallback].replace(/ため強い順$/u, '')} ${tally.fallbacks[key]}`)
    .join('; ');
}

function section5(replays: readonly ReplayedMatch[]): void {
  console.log('\n## 5. Throw-order model (same replays, 対戦相手最適化 candidate, model estimates only)\n');
  console.log('Every order below is estimated with the throw-order model on the same pre-match data. "Order-free model" is the');
  console.log('engine with the model switched off (the path orders saved before it keep); "internal-id order" writes the same');
  console.log('members in id order — what the throwing order must never follow.\n');
  const tally = emptyTally();
  const fresh: OrderSolution[] = [];
  const legacy: OrderSolution[] = [];
  const rows: { fresh: OrderEstimate | null; legacy: OrderEstimate | null; legacyStrong: OrderEstimate | null; freshId: OrderEstimate | null; fielded: OrderEstimate | null; fieldedStrong: OrderEstimate | null }[] = [];
  const freshTimes: number[] = [];
  const legacyTimes: number[] = [];
  let violations = 0;
  let seats = 0;
  let orderGames = 0;
  let orderChanged = 0;
  let fieldedGames = 0;
  let fieldedNotStrong = 0;
  for (const replay of replays) {
    const input = replay.order.input;
    let started = performance.now();
    const result = generateOrder(input, UNTIMED);
    freshTimes.push(performance.now() - started);
    const legacyInput = withoutThrowOrderModel(input);
    started = performance.now();
    const legacyResult = generateOrder(legacyInput, UNTIMED);
    legacyTimes.push(performance.now() - started);
    if (!result.ok || !legacyResult.ok) throw new Error('generation failed');
    const best = result.candidates[0];
    const previous = legacyResult.candidates[0];
    fresh.push(best);
    legacy.push(previous);
    violations += hardViolations(input, result.candidates) + hardViolations(legacyInput, legacyResult.candidates);
    tallyRecords(tally, best.throwOrder ?? [], ORDER_MIN_GAIN);
    seats += seatChange(best.assignments, previous.assignments);
    const onlyOrder = orderOnlyChanges(best.assignments, previous.assignments);
    orderGames += onlyOrder.games;
    orderChanged += onlyOrder.changed;
    const fieldedStrong = strongOrdered(input, replay.actual);
    for (const assignment of replay.actual) {
      if (assignment.playerIds.length < 2) continue;
      fieldedGames += 1;
      if (!sameOrder(assignment.playerIds, fieldedStrong.find((a) => a.gameId === assignment.gameId)!.playerIds)) fieldedNotStrong += 1;
    }
    rows.push({
      fresh: estimateOf(input, best.assignments),
      freshId: estimateOf(input, idOrdered(best.assignments)),
      legacy: estimateOf(input, previous.assignments),
      legacyStrong: estimateOf(input, strongOrdered(input, previous.assignments)),
      fielded: estimateOf(input, replay.actual),
      fieldedStrong: estimateOf(input, fieldedStrong),
    });
  }
  console.log('| Order | Mean est. match value | Mean est. game win | Mean P(W≥1) | Mean E[W] |');
  console.log('|---|---|---|---|---|');
  console.log(estimateRow('**New recommendation (throw-order model)**', rows.map((row) => row.fresh)));
  console.log(estimateRow('New recommendation, members in internal-id order', rows.map((row) => row.freshId)));
  console.log(estimateRow('Order-free model recommendation, as written (id order)', rows.map((row) => row.legacy)));
  console.log(estimateRow('Order-free model recommendation, members in strong order', rows.map((row) => row.legacyStrong)));
  console.log(estimateRow('Fielded order, as fielded', rows.map((row) => row.fielded)));
  console.log(estimateRow('Fielded order, members in strong order', rows.map((row) => row.fieldedStrong)));
  const diff = (pick: (row: (typeof rows)[number]) => [OrderEstimate | null, OrderEstimate | null]): number[] =>
    rows.flatMap((row) => {
      const [a, b] = pick(row);
      return a && b ? [a.value - b.value] : [];
    });
  const overLegacy = diff((row) => [row.fresh, row.legacy]);
  const overId = diff((row) => [row.fresh, row.freshId]);
  console.log('');
  console.log(`- new vs order-free recommendation: mean ${pt(meanOf(overLegacy))}, min ${pt(Math.min(...overLegacy))}, max ${pt(maxOf(overLegacy))} (match value)`);
  console.log(`- strong order vs internal-id order, same members: mean ${pt(meanOf(overId))}, max ${pt(maxOf(overId))}`);
  console.log(`- seats changed vs the order-free recommendation: ${pct(seats / replays.length)}; same members, throwing order changed: ${share(orderChanged, orderGames)} games`);
  console.log(`- multi-player games decided: ${tally.records} (Cricket ${tally.cricket}); shown order differs from internal-id order in ${share(tally.notIdOrder, tally.records)}`);
  console.log(`- non-strong order adopted (投順変更率): ${share(tally.adopted, tally.records)}; adopted gain mean ${ptOrDash(meanOf(tally.adoptedGains))}, max ${ptOrDash(maxOf(tally.adoptedGains))}`);
  console.log(`- best alternative by the estimate (adopted or not): mean ${ptOrDash(meanOf(tally.bestGains))}, max ${ptOrDash(maxOf(tally.bestGains))} (threshold ${pt(ORDER_MIN_GAIN, 0)})`);
  console.log(`- why the strong order was kept: ${fallbackText(tally)}`);
  console.log(`- LOW-confidence games: ${tally.lowRecords}; non-strong order adopted among them: ${tally.adoptedLow}; adopted under ${pt(ORDER_MIN_GAIN, 0)}: ${tally.adoptedUnderThreshold}`);
  console.log(`- fielded orders not in the strong order: ${share(fieldedNotStrong, fieldedGames)} multi-player games`);
  const freshFair = fairnessOf(fresh);
  const legacyFair = fairnessOf(legacy);
  const concentration = (solutions: readonly OrderSolution[]): string => meanOf(solutions.map((s) => s.metrics.maxRoleConcentration ?? 0)).toFixed(2);
  console.log(
    `- fairness, new / order-free: mean spread ${freshFair.meanSpread.toFixed(2)} / ${legacyFair.meanSpread.toFixed(2)}, ` +
      `most games by one player ${freshFair.meanMostGames.toFixed(2)} / ${legacyFair.meanMostGames.toFixed(2)}, ` +
      `most games in one role ${concentration(fresh)} / ${concentration(legacy)}, benched ${pct(freshFair.benchedShare)} / ${pct(legacyFair.benchedShare)}`,
  );
  console.log(`- hard-constraint violations (every candidate of both engines): ${violations}`);
  console.log(timingLine('throw-order model (node-bounded)', freshTimes));
  console.log(timingLine('order-free model (node-bounded)', legacyTimes));
}

function stressTable(rows: readonly StressRow[]): void {
  console.log('| Confidence | Finishing evidence | Opponent order | Cases | Non-strong adopted | Mean best gain | Max best gain | Min adopted gain |');
  console.log('|---|---|---|---|---|---|---|---|');
  for (const confidence of ['HIGH', 'MEDIUM', 'LOW'] as const) {
    for (const extreme of [false, true]) {
      for (const known of [true, false]) {
        const group = rows.filter((row) => row.confidence === confidence && row.extreme === extreme && row.orderKnown === known);
        if (group.length === 0) continue;
        const adopted = group.filter((row) => row.record.adopted === 'model');
        const gains = group.map((row) => Math.max(0, row.record.bestGain ?? 0));
        const adoptedGains = adopted.map((row) => row.record.probability! - row.record.strongProbability!);
        console.log(
          `| ${confidence} | ${extreme ? 'extreme (±18)' : 'realistic (±8)'} | ${known ? 'known' : 'unknown'} | ${group.length} | ${share(adopted.length, group.length)} | ${ptOrDash(meanOf(gains))} | ${ptOrDash(maxOf(gains))} | ${adoptedGains.length ? pt(Math.min(...adoptedGains)) : '—'} |`,
        );
      }
    }
  }
}

function section5b(): void {
  const cases = throwOrderCases(240);
  console.log('\n## 5b. Throw-order guardrails, synthetic stress test (240 seeded one-game cases, invented teams)\n');
  console.log('One Doubles or Trios game whose members are fixed, so the throwing order is the only choice. Finishing evidence');
  console.log('(First 9 excess) is drawn realistic (±8) or extreme (±18). Estimates of the model on invented data, not real results.\n');
  const rows = cases.map((entry) => runStressCase(entry, UNTIMED));
  stressTable(rows);
  const adopted = rows.filter((row) => row.record.adopted === 'model');
  const low = rows.filter((row) => row.confidence === 'LOW');
  const unknown = rows.filter((row) => !row.orderKnown);
  const flipped = rows.filter((row) => !sameOrder(row.record.order, row.reversed.order));
  const flippedGuarded = flipped.filter((row) => row.confidence !== 'LOW' && row.orderKnown);
  const relabelChanged = rows.filter((row) => !sameOrder(row.record.order, row.relabelled));
  const underThreshold = adopted.filter((row) => row.record.probability! - row.record.strongProbability! < ORDER_MIN_GAIN - 1e-9);
  console.log('');
  console.log(`- non-strong order adopted: ${share(adopted.length, rows.length)}; adopted under ${pt(ORDER_MIN_GAIN, 0)}: ${underThreshold.length}`);
  console.log(`- adopted with LOW confidence: ${low.filter((row) => row.record.adopted === 'model').length} / ${low.length}; adopted with the opponent order unknown: ${unknown.filter((row) => row.record.adopted === 'model').length} / ${unknown.length}`);
  console.log(`- opponent order reversed → our order changed: ${share(flipped.length, rows.length)}; all with MEDIUM+ data and a known opponent order: ${flipped.length === flippedGuarded.length ? 'yes' : 'NO'}`);
  console.log(`- internal ids relabelled (sort order reversed) → order changed: ${relabelChanged.length} / ${rows.length}`);
  console.log(`- hard-constraint violations: ${rows.reduce((acc, row) => acc + row.violations, 0)}`);
  console.log(timingLine('one-game case', rows.map((row) => row.ms)));
}

// ---------------------------------------------------------------------------
// 6. Underdog plan
// ---------------------------------------------------------------------------

const REASON_LABELS: Record<UnderdogRow['reason'], string> = {
  offered: 'offered',
  'no-opponent': 'no opponent data',
  'not-underdog': 'standard plan above 20%',
  'low-confidence': 'LOW opponent data',
  'not-stronger': 'opponent not stronger',
  'no-improvement': 'no plan improves by 2 pt',
  'not-run': 'not run',
};

function underdogLines(rows: readonly UnderdogRow[]): void {
  const counts = new Map<UnderdogRow['reason'], number>();
  for (const row of rows) counts.set(row.reason, (counts.get(row.reason) ?? 0) + 1);
  console.log(`- outcome: ${[...counts].map(([reason, count]) => `${REASON_LABELS[reason]} ${count}`).join('; ')} (of ${rows.length})`);
  const offered = rows.filter((row) => row.suggestion !== null).map((row) => ({ row, s: row.suggestion! }));
  if (offered.length > 0) {
    const a = offered.filter(({ s }) => s.objective === 'atLeastOne').length;
    const gainsA = offered.map(({ s }) => s.compared.atLeastOne).filter((g): g is number => g !== null);
    const gainsB = offered.map(({ s }) => s.compared.expectedWins).filter((g): g is number => g !== null);
    console.log(`- plan offered: A (max P(W≥1)) ${a}, B (max E[W]) ${offered.length - a}; chosen improvement on the 0..1 scale mean ${pt(meanOf(offered.map(({ s }) => s.improvement)))}, max ${pt(maxOf(offered.map(({ s }) => s.improvement)))}`);
    console.log(`- both plans, improvement on the common scale: A mean ${ptOrDash(meanOf(gainsA))}, B mean ${ptOrDash(meanOf(gainsB))}`);
    console.log(`- P(W≥1) standard → plan: ${pct(meanOf(offered.map(({ s }) => s.standard.atLeastOne)))} → ${pct(meanOf(offered.map(({ s }) => s.plan.atLeastOne)))}; E[W] ${meanOf(offered.map(({ s }) => s.standard.expectedGames)).toFixed(3)} → ${meanOf(offered.map(({ s }) => s.plan.expectedGames)).toFixed(3)}`);
    console.log(`- estimated match win given up (standard − plan): mean ${pt(meanOf(offered.map(({ s }) => s.matchWinLoss)))}, max ${pt(maxOf(offered.map(({ s }) => s.matchWinLoss)))}`);
    const spread = (solutions: readonly OrderSolution[]): string => meanOf(solutions.map((s) => s.metrics.appearanceSpread)).toFixed(2);
    console.log(`- appearance spread standard → plan: ${spread(offered.map(({ row }) => row.standard))} → ${spread(offered.map(({ s }) => s.solution))}`);
  }
  console.log(`- offered against the rules (shown win > 20%, LOW data or improvement < 2 pt): ${rows.reduce((acc, row) => acc + row.ruleBreaks, 0)}`);
  console.log(`- hard-constraint violations (standard candidates and plans): ${rows.reduce((acc, row) => acc + row.violations, 0)}`);
}

function section6(replays: readonly ReplayedMatch[]): void {
  console.log('\n## 6. Underdog plan (格上対策案; model estimates only)\n');
  console.log('Fixture replays:\n');
  const replayRows = replays.map((replay) => runUnderdogCase(replay.order.input, UNTIMED));
  underdogLines(replayRows);
  const shown = replayRows.map((row) => Math.round((row.standard.prediction?.win ?? 1) * 100));
  console.log(`- standard plans at or below 20% shown: ${shown.filter((value) => value <= 20).length} / ${replayRows.length}`);
  console.log('\nSynthetic underdog matches (120 seeded cases, invented teams; opponent 6–22 PPR stronger on average):\n');
  const synthetic = underdogCases(120).map((input) => runUnderdogCase(input, UNTIMED));
  underdogLines(synthetic);
  console.log(timingLine('underdog case (4 candidates + plans, node-bounded)', synthetic.map((row) => row.ms)));
}

async function section4(): Promise<void> {
  const log: N01Request[] = [];
  const client = new N01Client(createFixtureTransport({ log }), { now: () => FIXTURE_NOW });
  const selection = { leagueId: 'lg_l3hI_3397', leagueTitle: 'ATDO', tournamentId: 't_ABvC_5234', teamTpid: 'GpiQ' };
  const data = await fetchTeamData(client, selection, () => FIXTURE_NOW);
  let n = 0;
  const plan = planN01Sync({ team: { id: 't', name: 'kalavinka', createdAt: 0 }, localPlayers: [], existingFormat: null, data, now: FIXTURE_NOW, newId: (p) => `${p}_${++n}` });
  const firstSync = log.length;
  const fetched = await fetchIntelligence(client, data, { historyDepth: 2, now: () => FIXTURE_NOW });
  buildIntelligenceSnapshot({ teamId: 't', data, format: plan.format, fetched, historyDepth: 2, now: FIXTURE_NOW });
  const withIntel = log.length;
  const resyncLog: N01Request[] = [];
  const resync = new N01Client(createFixtureTransport({ log: resyncLog }), { now: () => FIXTURE_NOW });
  await resolveLinkedTeam(resync, plan.team.n01!);
  const key = (request: N01Request): string => `${request.operation}?${new URLSearchParams(request.params).toString()}`;
  const duplicates = log.length - new Set(log.map(key)).size;
  console.log(`- requests: first sync ${firstSync}, + opponent analysis (2 past seasons) ${withIntel - firstSync}, re-sync season resolution ${resyncLog.length}`);
  console.log(`- duplicate requests within one sync: ${duplicates}`);
}

async function main(): Promise<void> {
  console.log('# League Order — backtest report (fixture leagues)\n');
  console.log('Simulated data: validates the pipeline, not real-world accuracy.\n');
  section1();
  section2();
  const replays = await section3();
  await section3c();
  await section4();
  section5(replays);
  section5b();
  section6(replays);
}

void main();
