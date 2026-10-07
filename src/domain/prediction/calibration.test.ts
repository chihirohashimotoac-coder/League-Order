import { describe, expect, it } from 'vitest';
import { metrics, modelPredictor, runBacktest, type BacktestReport } from './backtest';
import { K_LEG } from './matchup';
import { PRIOR_LEGS } from './playerStrength';
import { RECENCY_WEIGHTS } from '../n01/recency';
import { fixtureLeagues } from '../../test/n01/leagues';
import { backtestGames } from '../../test/n01/backtestData';

/**
 * Historical backtest and calibration over the three fixture leagues (MASTER SPEC
 * Phase 6 §1–§2, §4). `npm run backtest` prints the same numbers as tables.
 *
 * The fixtures are simulated, so these are regression guards for the pipeline and for
 * the one property that matters most to a captain: the estimates must not claim more
 * than the data supports. They say nothing about accuracy on real leagues.
 */

const leagues = fixtureLeagues();
const reports: Record<string, BacktestReport> = Object.fromEntries(
  Object.entries(leagues).map(([name, league]) => [name, runBacktest(backtestGames(league), modelPredictor())]),
);

describe('historical backtest across ATDO / TDO / TDA (Phase 6 §1–§2)', () => {
  it.each(Object.keys(leagues))('%s: every game is predicted from strictly earlier days only', (name) => {
    const games = backtestGames(leagues[name as keyof typeof leagues]);
    let checked = 0;
    runBacktest(games, (game, history) => {
      for (const past of history) expect(past.date < game.date).toBe(true);
      checked += 1;
      return 0.5;
    });
    expect(checked).toBe(games.length);
  });

  it.each(Object.keys(leagues))('%s: game predictions are not worse than the 50% baseline (Brier, log loss)', (name) => {
    const report = reports[name];
    expect(report.games.n).toBeGreaterThan(20);
    expect(report.games.brier).toBeLessThanOrEqual(report.gameBaseline.brier);
    expect(report.games.logLoss).toBeLessThanOrEqual(report.gameBaseline.logLoss);
  });

  it('match predictions beat the 50% baseline where there are enough matches (ATDO 52, TDO 7)', () => {
    for (const name of ['atdo', 'tdo']) {
      expect(reports[name].matches.brier).toBeLessThan(reports[name].matchBaseline.brier);
    }
    // TDA has 3 matches: reported by `npm run backtest`, too few to assert anything.
    expect(reports.tda.matches.n).toBe(3);
  });

  it('is never overconfident: in every well-populated bucket the estimate is no further from 50% than the outcome', () => {
    const pooled = Object.values(reports).flatMap((report) =>
      report.predictions.map(({ game, probability }) => ({ p: probability, y: game.homeWon ? 1 : 0 })),
    );
    const buckets = metrics(pooled).calibration.filter((bucket) => bucket.count >= 15);
    expect(buckets.length).toBeGreaterThanOrEqual(2);
    for (const bucket of buckets) {
      const claimed = Math.abs(bucket.meanPredicted - 0.5);
      const observed = Math.abs(bucket.observedRate - 0.5);
      expect(claimed).toBeLessThanOrEqual(observed + 0.05);
      // And on the same side of 50% whenever the outcome is clearly away from it.
      if (observed > 0.05) expect(Math.sign(bucket.meanPredicted - 0.5)).toBe(Math.sign(bucket.observedRate - 0.5));
    }
  });
});

describe('sensitivity of the prediction to its constants (Phase 6 §4)', () => {
  const games = backtestGames(leagues.atdo);
  const base = reports.atdo.games.brier;
  const grid = [20, PRIOR_LEGS, 45].flatMap((priorLegs) =>
    [0.07, K_LEG, 0.11].flatMap((k) =>
      [[1, 0.8, 0.6], RECENCY_WEIGHTS, [1, 0.4, 0.2]].map((weights) => ({ priorLegs, k, weights })),
    ),
  );

  it('every neighbouring setting still beats the baseline, and moves Brier by less than 0.015', () => {
    for (const { priorLegs, k, weights } of grid) {
      const report = runBacktest(games, modelPredictor({ parameters: { priorLegs, weights }, k }));
      expect(report.games.brier).toBeLessThan(report.gameBaseline.brier);
      expect(Math.abs(report.games.brier - base)).toBeLessThan(0.015);
    }
  });
});
