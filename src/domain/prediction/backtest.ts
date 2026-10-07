import type { HistoricalPlayerStats, SeasonStatLine } from '../n01/history';
import { leagueMeanPpr } from '../n01/history';
import { gameWinProbability } from './matchup';
import { DEFAULT_STRENGTH_PARAMETERS, playerStrength, type StrengthParameters } from './playerStrength';
import { sideStrength } from './teamMatchup';
import { independentGamesModel } from './matchWinProbability';
import { K_LEG } from './matchup';

/**
 * Backtesting (MASTER SPEC Phase 3 "BACKTEST", Phase 6 §1–§2).
 *
 * Games are replayed in date order. For each match day, the predictor sees only the
 * games played on *earlier* days — never the day itself, never anything later — so no
 * result can leak into its own prediction. The harness enforces that; it is not left
 * to the predictor.
 *
 * Metrics: Brier score, log loss and calibration buckets, for games and for matches,
 * always next to the 50% constant baseline. A model is worth showing only if it does
 * not do worse than that baseline.
 */

export interface BacktestLine {
  key: string;
  score: number;
  darts: number;
  legs: number;
  legsWon: number;
}

export interface BacktestGame {
  matchId: string;
  /** `YYYY-MM-DD` */
  date: string;
  /** Chronological season number (0 = oldest). */
  season: number;
  home: string[];
  away: string[];
  homeWon: boolean;
  legsToWin: number | null;
  cricket: boolean;
  /** What happened in this game (becomes history for later games). */
  lines: BacktestLine[];
}

/** Probability that the home side wins `game`, from `history` (earlier days only). */
export type Predictor = (game: BacktestGame, history: readonly BacktestGame[]) => number;

export interface CalibrationBucket {
  from: number;
  to: number;
  count: number;
  meanPredicted: number;
  observedRate: number;
}

export interface Metrics {
  n: number;
  brier: number;
  logLoss: number;
  calibration: CalibrationBucket[];
}

export interface BacktestReport {
  games: Metrics;
  gameBaseline: Metrics;
  matches: Metrics;
  matchBaseline: Metrics;
  /** Predictions in replay order (for inspection). */
  predictions: { game: BacktestGame; probability: number }[];
}

const EPS = 1e-6;

export function metrics(pairs: readonly { p: number; y: number }[], buckets = 10): Metrics {
  const n = pairs.length;
  if (n === 0) return { n: 0, brier: Number.NaN, logLoss: Number.NaN, calibration: [] };
  let brier = 0;
  let logLoss = 0;
  const bins = Array.from({ length: buckets }, (_, index) => ({ from: index / buckets, to: (index + 1) / buckets, count: 0, sumP: 0, sumY: 0 }));
  for (const { p, y } of pairs) {
    const clipped = Math.min(1 - EPS, Math.max(EPS, p));
    brier += (p - y) ** 2;
    logLoss += -(y * Math.log(clipped) + (1 - y) * Math.log(1 - clipped));
    const bin = bins[Math.min(buckets - 1, Math.floor(p * buckets))];
    bin.count += 1;
    bin.sumP += p;
    bin.sumY += y;
  }
  return {
    n,
    brier: brier / n,
    logLoss: logLoss / n,
    calibration: bins
      .filter((bin) => bin.count > 0)
      .map((bin) => ({ from: bin.from, to: bin.to, count: bin.count, meanPredicted: bin.sumP / bin.count, observedRate: bin.sumY / bin.count })),
  };
}

export function runBacktest(games: readonly BacktestGame[], predictor: Predictor): BacktestReport {
  const ordered = [...games].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const predictions: { game: BacktestGame; probability: number }[] = [];
  let historyEnd = 0;
  for (let index = 0; index < ordered.length; index += 1) {
    const game = ordered[index];
    // Only strictly earlier days are history.
    while (historyEnd < ordered.length && ordered[historyEnd].date < game.date) historyEnd += 1;
    const history = ordered.slice(0, historyEnd);
    predictions.push({ game, probability: predictor(game, history) });
  }

  const gamePairs = predictions.map(({ game, probability }) => ({ p: probability, y: game.homeWon ? 1 : 0 }));

  const byMatch = new Map<string, { probabilities: number[]; won: number; total: number }>();
  for (const { game, probability } of predictions) {
    const entry = byMatch.get(game.matchId) ?? { probabilities: [], won: 0, total: 0 };
    entry.probabilities.push(probability);
    entry.won += game.homeWon ? 1 : 0;
    entry.total += 1;
    byMatch.set(game.matchId, entry);
  }
  const matchPairs: { p: number; y: number }[] = [];
  const matchBaselinePairs: { p: number; y: number }[] = [];
  for (const entry of byMatch.values()) {
    const outcome = independentGamesModel.outcome(entry.probabilities);
    const y = entry.won * 2 > entry.total ? 1 : entry.won * 2 === entry.total ? 0.5 : 0;
    matchPairs.push({ p: outcome.win + 0.5 * outcome.draw, y });
    const coinFlip = independentGamesModel.outcome(entry.probabilities.map(() => 0.5));
    matchBaselinePairs.push({ p: coinFlip.win + 0.5 * coinFlip.draw, y });
  }

  return {
    games: metrics(gamePairs),
    gameBaseline: metrics(gamePairs.map(({ y }) => ({ p: 0.5, y }))),
    matches: metrics(matchPairs),
    matchBaseline: metrics(matchBaselinePairs),
    predictions,
  };
}

/** The constant 50% model. */
export const coinFlipPredictor: Predictor = () => 0.5;

export interface ModelPredictorOptions {
  parameters?: StrengthParameters;
  k?: number;
}

/**
 * The real model as a predictor: player strengths rebuilt from `history` alone (seasons
 * counted back from the game's own season), then the same matchup function the app uses.
 */
export function modelPredictor(options: ModelPredictorOptions = {}): Predictor {
  const parameters = options.parameters ?? DEFAULT_STRENGTH_PARAMETERS;
  const k = options.k ?? K_LEG;
  return (game, history) => {
    const perPlayer = new Map<string, Map<number, SeasonStatLine>>();
    const allLines: { score: number; darts: number; seasonIndex: number }[] = [];
    for (const past of history) {
      const seasonIndex = game.season - past.season;
      if (seasonIndex < 0) continue;
      for (const line of past.lines) {
        const seasons = perPlayer.get(line.key) ?? new Map<number, SeasonStatLine>();
        const current = seasons.get(seasonIndex) ?? {
          tournamentId: String(past.season),
          seasonIndex,
          teamTpid: null,
          score: 0,
          darts: 0,
          legs: 0,
          matches: 0,
          legsWon: 0,
          first9Score: null,
          first9Darts: null,
          highOut: null,
          bestLeg: null,
          ton: null,
          ton40: null,
          ton70: null,
          ton80: null,
        };
        current.score += line.score;
        current.darts += line.darts;
        current.legs = (current.legs ?? 0) + line.legs;
        current.legsWon = (current.legsWon ?? 0) + line.legsWon;
        current.matches = (current.matches ?? 0) + 1;
        seasons.set(seasonIndex, current);
        perPlayer.set(line.key, seasons);
        allLines.push({ score: line.score, darts: line.darts, seasonIndex });
      }
    }
    const prior = { meanPpr: leagueMeanPpr(allLines, parameters.weights), first9Gap: null };
    const strengthOf = (key: string): number => {
      const seasons = perPlayer.get(key);
      const stats: Pick<HistoricalPlayerStats, 'seasons'> | null = seasons
        ? { seasons: [...seasons.values()].sort((a, b) => a.seasonIndex - b.seasonIndex) }
        : null;
      return playerStrength(stats, prior, parameters).strength;
    };
    return gameWinProbability(sideStrength(game.home.map(strengthOf)), sideStrength(game.away.map(strengthOf)), game, k);
  };
}
