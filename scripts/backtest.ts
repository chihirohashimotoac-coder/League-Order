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
 *   4. timings and request counts.
 *
 * The fixtures are simulated (src/test/n01/generator.ts): the numbers validate the
 * pipeline and guard against regressions; they are not a measure of real-world accuracy.
 * Deterministic: no network, seeded data, fixed clock.
 */
import { generateOrder } from '../src/optimizer/generateOrder';
import type { OrderInput } from '../src/domain/types';
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

const pct = (value: number): string => `${(value * 100).toFixed(1)}%`;
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

async function section3(): Promise<void> {
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
  const generate = (input: OrderInput) => {
    const result = generateOrder(input);
    if (!result.ok) throw new Error('generation failed');
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
    const result = generateOrder(input, { singleCandidate: true, timeLimitMs: Math.floor(input.settings.timeLimitMs / 4) });
    if (!result.ok) throw new Error('generation failed');
    return result.candidates[0];
  };
  for (const perturbation of PERTURBATIONS) {
    const result = sensitivity(sample, perturbation, single);
    console.log(`| ${perturbation.name} | ${(result.meanRegret * 100).toFixed(2)} pt | ${(result.maxRegret * 100).toFixed(2)} pt | ${pct(result.meanSeatChange)} |`);
  }
  const times = summary.rows.map((row) => row.optimizerMs).sort((a, b) => a - b);
  console.log(`\n## 4. Performance (Node, this machine)\n`);
  console.log(`- replay (fetch + plan + intelligence) of ${replays.length} matches: ${replayMs.toFixed(0)} ms total`);
  console.log(`- optimizer (4 candidates) per match: median ${times[Math.floor(times.length / 2)].toFixed(0)} ms, max ${times[times.length - 1].toFixed(0)} ms`);
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
  await section3();
  await section4();
}

void main();
