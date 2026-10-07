/**
 * Match win probability (MASTER SPEC Phase 3 §10–§11).
 *
 * The match goes to the side that wins more than half of the games. From the game
 * probabilities p1..pn the distribution of games won is the Poisson-binomial
 * distribution, computed exactly by dynamic programming:
 *
 *   P(win)  = P(W ≥ ⌊n/2⌋ + 1)
 *   P(draw) = P(W = n/2)          (only for an even number of games)
 *
 * — never the mean of the game probabilities, which says nothing about winning *enough*
 * games.
 *
 * Independence is an approximation: the same player appears in several games, and a
 * player's form on the night moves all of them together. The calculation sits behind
 * {@link MatchOutcomeModel} so a (seeded) Monte Carlo model with shared form can replace
 * it without touching any caller.
 */

export interface MatchOutcome {
  win: number;
  draw: number;
  loss: number;
  /** Expected games won. */
  expectedGames: number;
  /** Games needed to win the match. */
  need: number;
  gameCount: number;
  /** `distribution[w]` = P(exactly w games won). */
  distribution: number[];
}

export interface MatchOutcomeModel {
  readonly name: string;
  outcome(gameProbabilities: readonly number[]): MatchOutcome;
}

export function poissonBinomial(probabilities: readonly number[]): number[] {
  let distribution = [1];
  for (const p of probabilities) {
    const next = new Array<number>(distribution.length + 1).fill(0);
    for (let w = 0; w < distribution.length; w += 1) {
      next[w] += distribution[w] * (1 - p);
      next[w + 1] += distribution[w] * p;
    }
    distribution = next;
  }
  return distribution;
}

export const independentGamesModel: MatchOutcomeModel = {
  name: 'independent-games',
  outcome(probabilities) {
    const n = probabilities.length;
    const distribution = poissonBinomial(probabilities);
    const need = Math.floor(n / 2) + 1;
    let win = 0;
    for (let w = need; w <= n; w += 1) win += distribution[w];
    const draw = n % 2 === 0 && n > 0 ? distribution[n / 2] : 0;
    return {
      win,
      draw,
      loss: Math.max(0, 1 - win - draw),
      expectedGames: probabilities.reduce((acc, p) => acc + p, 0),
      need,
      gameCount: n,
      distribution,
    };
  },
};

/** Weight of a draw when a single number must rank orders (a draw is half a win). */
export const DRAW_VALUE = 0.5;

export function matchValue(outcome: Pick<MatchOutcome, 'win' | 'draw'>): number {
  return outcome.win + DRAW_VALUE * outcome.draw;
}

export function matchOutcome(probabilities: readonly number[], model: MatchOutcomeModel = independentGamesModel): MatchOutcome {
  return model.outcome(probabilities);
}
