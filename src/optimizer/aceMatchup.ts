import type { GameId, OrderInput, OrderSolution, PlayerId } from '../domain/types';
import { evaluateManualOrder } from './generateOrder';

/**
 * "Who takes the opponent's ace?" (docs/THROW_ORDER_MODEL.md §7, Singles).
 *
 * There is no fixed rule that our ace meets theirs: the order maximises the estimated match
 * outcome, and that sometimes means receiving their ace slot with another player and sending our
 * ace where a game is likelier to be won. When it does, the screen says so — with the estimate of
 * the line-up that would put our ace in their ace's slot, so the captain can see the trade.
 */

/** The opponent's strongest Singles slot must stand out by this much (PPR points) to be "the ace slot". */
export const ACE_MARGIN = 2;

export interface AceNote {
  /** The Singles game where the opponent's expected player is strongest. */
  aceGameId: GameId;
  /** Their expected strength there, and who they most likely field. */
  aceStrength: number;
  aceLikely: string | null;
  /** Our strongest Singles player in this line-up and the game they play. */
  ourAce: PlayerId;
  ourAceGameId: GameId;
  /** Who receives the opponent's ace slot instead. */
  receiver: PlayerId;
  /** Estimated match win of this line-up, and of the same line-up with the two swapped (`null` = not allowed). */
  current: number;
  swapped: number | null;
}

export function singlesAceNote(input: OrderInput, solution: OrderSolution): AceNote | null {
  const prediction = solution.prediction;
  if (!prediction || !input.opponent) return null;
  const byGame = new Map(prediction.games.map((game) => [game.gameId, game]));
  const singles = input.games
    .filter((game) => game.playerCount === 1 && byGame.has(game.id))
    .map((game) => {
      const predicted = byGame.get(game.id)!;
      const assignment = solution.assignments.find((entry) => entry.gameId === game.id);
      return { game, predicted, playerId: assignment?.playerIds[0] ?? '' };
    })
    .filter((entry) => entry.playerId !== '');
  if (singles.length < 2) return null;

  const ace = singles.reduce((best, entry) => (entry.predicted.opponentStrength > best.predicted.opponentStrength ? entry : best));
  const others = singles.filter((entry) => entry !== ace);
  const othersMean = others.reduce((acc, entry) => acc + entry.predicted.opponentStrength, 0) / others.length;
  if (ace.predicted.opponentStrength - othersMean < ACE_MARGIN) return null;

  const ours = singles.reduce((best, entry) => (entry.predicted.ourStrength > best.predicted.ourStrength ? entry : best));
  if (ours === ace || ours.playerId === ace.playerId) return null;
  // A tie for our strongest player is no "ace" to explain.
  if (singles.some((entry) => entry !== ours && Math.abs(entry.predicted.ourStrength - ours.predicted.ourStrength) < 1e-9)) return null;

  const swappedAssignments = solution.assignments.map((assignment) => {
    if (assignment.gameId === ace.game.id) return { ...assignment, playerIds: [ours.playerId] };
    if (assignment.gameId === ours.game.id) return { ...assignment, playerIds: [ace.playerId] };
    return assignment;
  });
  const evaluation = evaluateManualOrder(input, swappedAssignments);
  const likely = input.opponent.games[ace.game.id]?.likely[0];
  return {
    aceGameId: ace.game.id,
    aceStrength: ace.predicted.opponentStrength,
    aceLikely: likely ? `${likely.name} ${Math.round(likely.probability * 100)}%` : null,
    ourAce: ours.playerId,
    ourAceGameId: ours.game.id,
    receiver: ace.playerId,
    current: prediction.win,
    swapped: evaluation.ok && evaluation.solution?.prediction ? evaluation.solution.prediction.win : null,
  };
}
