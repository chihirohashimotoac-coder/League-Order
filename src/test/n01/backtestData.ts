import type { BacktestGame } from '../../domain/prediction/backtest';
import type { GeneratedLeague } from './generator';

/** Fixture league games in the backtest's shape (test-only). */
export function backtestGames(league: GeneratedLeague): BacktestGame[] {
  return league.games.map((game) => ({
    matchId: `${game.tournamentId}:${game.matchId}`,
    date: game.date,
    season: game.seasonOrdinal,
    home: game.homeOpids,
    away: game.awayOpids,
    homeWon: game.homeWon,
    legsToWin: game.legsToWin,
    cricket: game.matchType === 'cricket',
    lines: game.lines.map((line) => ({ key: line.opid, score: line.score, darts: line.darts, legs: line.legs, legsWon: line.legsWon })),
  }));
}
