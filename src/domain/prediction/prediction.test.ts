import { describe, expect, it } from 'vitest';
import type { GameSlotDef, Player } from '../types';
import type { SeasonStatLine } from '../n01/history';
import { FALLBACK_LEAGUE_PPR, FIRST9_CAP, FORM_CAP, PRIOR_LEGS, manualStrength, playerStrength } from './playerStrength';
import { K_CRICKET_FACTOR, gameWinProbability, legWinProbability, raceProbability } from './matchup';
import { PAIR_AFFINITY_PPR_BONUS, meanPairBonus, sideStrength } from './teamMatchup';
import { independentGamesModel, matchValue, poissonBinomial } from './matchWinProbability';
import { buildOpponentContext, expectedGameWin, type OpponentGameContext } from './opponentContext';
import { predictOrder } from './predictOrder';
import { coinFlipPredictor, metrics, modelPredictor, runBacktest, type BacktestGame } from './backtest';
import { N01Client } from '../../integrations/n01/client';
import { fetchTeamData, planN01Sync } from '../../integrations/n01/sync';
import { buildIntelligenceSnapshot, fetchIntelligence } from '../../integrations/n01/intelligence';
import { createFixtureTransport } from '../../test/n01/transport';
import { FIXTURE_NOW, fixtureLeagues } from '../../test/n01/leagues';
import { backtestGames } from '../../test/n01/backtestData';

const line = (seasonIndex: number, score: number, darts: number, legs: number, extra: Partial<SeasonStatLine> = {}): SeasonStatLine => ({
  tournamentId: `t${seasonIndex}`,
  seasonIndex,
  teamTpid: null,
  score,
  darts,
  legs,
  matches: null,
  legsWon: null,
  first9Score: null,
  first9Darts: null,
  highOut: null,
  bestLeg: null,
  ton: null,
  ton40: null,
  ton70: null,
  ton80: null,
  ...extra,
});

const PRIOR = { meanPpr: 50, first9Gap: null };

describe('player strength', () => {
  it('shrinks towards the league mean: (n·x + k·μ) / (n + k)', () => {
    // 10 legs at PPR 80: (10·80 + 30·50) / 40 = 57.5
    const few = playerStrength({ seasons: [line(0, 800, 30, 10)] }, PRIOR);
    expect(few.rawPpr).toBeCloseTo(80, 9);
    expect(few.shrunkPpr).toBeCloseTo((10 * 80 + PRIOR_LEGS * 50) / (10 + PRIOR_LEGS), 9);
    // 120 legs at PPR 80 are believed much more.
    const many = playerStrength({ seasons: [line(0, 9600, 360, 120)] }, PRIOR);
    expect(many.shrunkPpr).toBeGreaterThan(few.shrunkPpr);
    expect(many.confidence).toBe('HIGH');
    expect(few.confidence).toBe('LOW');
  });

  it('a player with no data is the league mean at LOW confidence (never 0)', () => {
    expect(playerStrength(null, PRIOR)).toMatchObject({ strength: 50, imputed: true, confidence: 'LOW' });
    expect(playerStrength({ seasons: [line(0, 0, 0, 0)] }, PRIOR).strength).toBe(50);
    expect(playerStrength(null, { meanPpr: null, first9Gap: null }).strength).toBe(FALLBACK_LEAGUE_PPR);
  });

  it('caps the recent-form and First 9 adjustments', () => {
    const hot = playerStrength({ seasons: [line(0, 9000, 300, 100), line(1, 3000, 300, 100)] }, PRIOR);
    expect(hot.formAdjustment).toBeGreaterThan(0);
    expect(hot.formAdjustment).toBeLessThanOrEqual(FORM_CAP);
    const scorer = playerStrength({ seasons: [line(0, 5000, 300, 100, { first9Score: 9000, first9Darts: 300 })] }, { meanPpr: 50, first9Gap: 5 });
    expect(scorer.first9Adjustment).toBeGreaterThan(0);
    expect(scorer.first9Adjustment).toBeLessThanOrEqual(FIRST9_CAP);
    expect(playerStrength({ seasons: [line(0, 5000, 300, 100)] }, { meanPpr: 50, first9Gap: 5 }).first9Adjustment).toBe(0);
  });

  it('a hand-entered PPR counts as a little evidence', () => {
    const guest = manualStrength(70, PRIOR);
    expect(guest.strength).toBeGreaterThan(50);
    expect(guest.strength).toBeLessThan(70);
    expect(guest.confidence).toBe('LOW');
    expect(manualStrength(null, PRIOR).imputed).toBe(true);
  });
});

describe('matchup', () => {
  it('is 50% for equal strength, symmetric and monotone', () => {
    const shape = { legsToWin: 1, cricket: false };
    expect(gameWinProbability(55, 55, shape)).toBeCloseTo(0.5, 12);
    expect(gameWinProbability(60, 50, shape) + gameWinProbability(50, 60, shape)).toBeCloseTo(1, 12);
    expect(gameWinProbability(60, 50, shape)).toBeGreaterThan(gameWinProbability(55, 50, shape));
    expect(legWinProbability(10)).toBeCloseTo(1 / (1 + Math.exp(-0.9)), 12);
  });

  it('a longer race amplifies the stronger side; cricket is flatter', () => {
    const p = legWinProbability(6);
    expect(raceProbability(p, 1)).toBeCloseTo(p, 12);
    // first to 2: p² + 2p²(1 − p)
    expect(raceProbability(p, 2)).toBeCloseTo(p * p + 2 * p * p * (1 - p), 12);
    expect(raceProbability(p, 3)).toBeGreaterThan(raceProbability(p, 2));
    expect(gameWinProbability(60, 50, { legsToWin: 1, cricket: true })).toBeCloseTo(legWinProbability(10, 0.09 * K_CRICKET_FACTOR), 12);
  });

  it('never returns exactly 0 or 1', () => {
    expect(gameWinProbability(180, 0, { legsToWin: 5, cricket: false })).toBeLessThan(1);
    expect(gameWinProbability(0, 180, { legsToWin: 5, cricket: false })).toBeGreaterThan(0);
  });
});

describe('pairs and teams', () => {
  it('averages a side, trims from five players, and adds pair affinity for pairs only', () => {
    expect(sideStrength([60, 40])).toBe(50);
    expect(sideStrength([60], 5)).toBe(60);
    expect(sideStrength([100, 50, 50, 50, 0])).toBe(50);
    expect(sideStrength([60, 40], meanPairBonus(['VERY_GOOD']))).toBe(50 + PAIR_AFFINITY_PPR_BONUS.VERY_GOOD);
    expect(meanPairBonus([])).toBe(0);
  });
});

describe('match win probability (Poisson-binomial)', () => {
  it('matches brute-force enumeration and is not the mean of the games', () => {
    const p = [0.62, 0.55, 0.48, 0.71, 0.3, 0.5, 0.66];
    let brute = 0;
    for (let mask = 0; mask < 1 << p.length; mask += 1) {
      let probability = 1;
      let wins = 0;
      p.forEach((value, index) => {
        const won = (mask >> index) & 1;
        probability *= won ? value : 1 - value;
        wins += won;
      });
      if (wins >= 4) brute += probability;
    }
    const outcome = independentGamesModel.outcome(p);
    expect(outcome.win).toBeCloseTo(brute, 12);
    expect(outcome.need).toBe(4);
    expect(outcome.distribution.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 12);
    expect(outcome.expectedGames).toBeCloseTo(p.reduce((a, b) => a + b, 0), 12);
    expect(outcome.win).not.toBeCloseTo(p.reduce((a, b) => a + b, 0) / p.length, 2);
  });

  it('handles draws for an even number of games', () => {
    const outcome = independentGamesModel.outcome([0.5, 0.5, 0.5, 0.5]);
    expect(outcome.draw).toBeCloseTo(6 / 16, 12);
    expect(outcome.win).toBeCloseTo(5 / 16, 12);
    expect(outcome.win + outcome.draw + outcome.loss).toBeCloseTo(1, 12);
    expect(matchValue(outcome)).toBeCloseTo(0.5, 12);
    expect(poissonBinomial([])).toEqual([1]);
  });
});

async function atdoContext() {
  const client = new N01Client(createFixtureTransport(), { now: () => FIXTURE_NOW });
  const data = await fetchTeamData(client, { leagueId: 'lg_l3hI_3397', leagueTitle: 'ATDO', tournamentId: 't_ABvC_5234', teamTpid: 'GpiQ' }, () => FIXTURE_NOW);
  let n = 0;
  const plan = planN01Sync({ team: { id: 'team_kv', name: 'kalavinka', createdAt: 0 }, localPlayers: [], existingFormat: null, data, now: FIXTURE_NOW, newId: (p) => `${p}_${++n}` });
  const fetched = await fetchIntelligence(client, data, { historyDepth: 2, now: () => FIXTURE_NOW });
  const snapshot = buildIntelligenceSnapshot({ teamId: 'team_kv', data, format: plan.format, fetched, historyDepth: 2, now: FIXTURE_NOW });
  return { snapshot, format: plan.format, players: plan.players };
}

describe('opponent uncertainty', () => {
  it('expected win is the probability-weighted mixture over the opponent sides', () => {
    const game: OpponentGameContext = {
      gameId: 'g',
      signature: 'SINGLES|01|1',
      numPart: 1,
      legsToWin: 2,
      cricket: false,
      sides: [{ strength: 60, probability: 0.7 }, { strength: 40, probability: 0.3 }],
      likely: [],
      samples: 5,
      confidence: 'MEDIUM',
    };
    const direct = 0.7 * gameWinProbability(50, 60, game) + 0.3 * gameWinProbability(50, 40, game);
    expect(expectedGameWin(50, game)).toBeCloseTo(direct, 12);
    // Not the same as playing the "average" opponent.
    expect(expectedGameWin(50, game)).not.toBeCloseTo(gameWinProbability(50, 54, game), 4);
  });

  it('builds a compact context for every game of the managed format', async () => {
    const { snapshot, format, players } = await atdoContext();
    const context = buildOpponentContext({ snapshot, games: format.games, players })!;
    expect(context.opponentName).toBe('スピンコブラ');
    expect(Object.keys(context.games)).toEqual(format.games.map((game) => game.id));
    for (const game of Object.values(context.games)) {
      expect(game.sides.reduce((acc, side) => acc + side.probability, 0)).toBeCloseTo(1, 9);
      expect(game.sides.length).toBeGreaterThan(0);
    }
    expect(Object.keys(context.players)).toHaveLength(players.length);
    const nakamura = players.find((player) => player.name === '中村 蓮')!;
    expect(context.players[nakamura.id]).toMatchObject({ imputed: true, confidence: 'LOW' });
    expect(JSON.stringify(context).length).toBeLessThan(20_000);
  });

  it('maps a hand-made format onto the opponent slots by signature, skipping games that do not fit', async () => {
    const { snapshot, players } = await atdoContext();
    const manual: GameSlotDef[] = [
      { id: 'm1', order: 1, name: 'S1', kinds: ['SINGLES', 'G501'], playerCount: 1 },
      { id: 'm2', order: 2, name: 'D1', kinds: ['DOUBLES', 'G501'], playerCount: 2 },
      { id: 'm3', order: 3, name: 'C', kinds: ['SINGLES', 'CRICKET'], playerCount: 1 },
    ];
    const context = buildOpponentContext({ snapshot, games: manual, players })!;
    expect(Object.keys(context.games).sort()).toEqual(['m1', 'm2']);
  });
});

describe('order predictions and explanations', () => {
  it('predicts each game with confidence and reasons, and the match from them', async () => {
    const { snapshot, format, players } = await atdoContext();
    const context = buildOpponentContext({ snapshot, games: format.games, players })!;
    const roster = players.filter((player) => player.n01?.stats);
    const byName = (name: string): Player => roster.find((player) => player.name === name)!;
    const order = format.games.map((game, index) => ({
      gameId: game.id,
      playerIds: roster.slice(index % 2, (index % 2) + game.playerCount).map((player) => player.id),
    }));
    const prediction = predictOrder(context, order)!;
    expect(prediction.games).toHaveLength(7);
    expect(prediction.win + prediction.draw + prediction.loss).toBeCloseTo(1, 9);
    expect(prediction.draw).toBe(0);
    for (const game of prediction.games) {
      expect(game.probability).toBeGreaterThan(0);
      expect(game.probability).toBeLessThan(1);
      expect(game.reasons[0]).toMatch(/^PPR差 [+-]\d+\.\d/);
      expect(game.reasons.some((reason) => reason.startsWith('相手の予想'))).toBe(true);
    }
    // A stronger single player is a better bet in the same slot.
    const singles = format.games.find((game) => game.kinds.includes('SINGLES'))!;
    const strong = predictOrder(context, [{ gameId: singles.id, playerIds: [byName('橋本 千尋').id] }])!;
    const weak = predictOrder(context, [{ gameId: singles.id, playerIds: [byName('伊藤 由佳').id] }])!;
    expect(strong.games[0].probability).toBeGreaterThan(weak.games[0].probability);
  });
});

describe('backtest framework', () => {
  it('never shows a prediction any game from the same day or later', () => {
    const games = backtestGames(fixtureLeagues().atdo);
    let checked = 0;
    runBacktest(games, (game, history) => {
      for (const past of history) expect(past.date < game.date).toBe(true);
      checked += 1;
      return 0.5;
    });
    expect(checked).toBe(games.length);
  });

  it('scores the constant 50% model at Brier 0.25 and log loss ln 2', () => {
    const report = runBacktest(backtestGames(fixtureLeagues().atdo), coinFlipPredictor);
    expect(report.games.brier).toBeCloseTo(0.25, 12);
    expect(report.games.logLoss).toBeCloseTo(Math.log(2), 12);
    expect(report.games.calibration.reduce((acc, bucket) => acc + bucket.count, 0)).toBe(report.games.n);
  });

  it('computes Brier, log loss and calibration buckets exactly', () => {
    const result = metrics([{ p: 0.8, y: 1 }, { p: 0.8, y: 0 }, { p: 0.2, y: 0 }]);
    expect(result.brier).toBeCloseTo((0.04 + 0.64 + 0.04) / 3, 12);
    expect(result.logLoss).toBeCloseTo(-(Math.log(0.8) + Math.log(0.2) + Math.log(0.8)) / 3, 12);
    expect(result.calibration).toEqual([
      { from: 0.2, to: 0.3, count: 1, meanPredicted: 0.2, observedRate: 0 },
      { from: 0.8, to: 0.9, count: 2, meanPredicted: 0.8, observedRate: 0.5 },
    ]);
  });

  it('the model does not do worse than the 50% baseline on the ATDO-like league', () => {
    const report = runBacktest(backtestGames(fixtureLeagues().atdo), modelPredictor());
    expect(report.games.n).toBeGreaterThan(200);
    expect(report.games.brier).toBeLessThan(report.gameBaseline.brier);
    expect(report.games.logLoss).toBeLessThan(report.gameBaseline.logLoss);
    expect(report.matches.brier).toBeLessThan(report.matchBaseline.brier);
  });

  it('with no history at all the model is exactly the coin flip', () => {
    const game: BacktestGame = { matchId: 'm', date: '2026-01-01', season: 0, home: ['a'], away: ['b'], homeWon: true, legsToWin: 2, cricket: false, lines: [] };
    expect(modelPredictor()(game, [])).toBeCloseTo(0.5, 12);
  });
});
