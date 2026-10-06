import type { GameSlotDef, StructuralKind } from '../types';
import { STRUCTURAL_KINDS } from '../types';
import { minimalSsd, sumSquaredDeviation } from './fairness';

/**
 * Role fairness (docs/DESIGN.md 追補 v1.3 §V2, D-20).
 *
 * The appearance-fairness metric looks at each player's *total*, so it cannot tell
 *
 *     A: Singles ×4, Doubles ×0      B: Singles ×0, Doubles ×4
 *
 * from an order where both play two of each — both totals are 4. Role fairness closes
 * that gap: it applies the same excess-SSD measure to each structural role (Singles,
 * Doubles, Trios, Gallon, Team) separately, so "A A A A" in four Singles reads as
 * concentrated and "A B C D" as spread.
 *
 * Each game belongs to exactly one role, so a "Doubles 501" game counts once (as
 * Doubles) and the game kinds 501 / Cricket never count as a role at all. A game that
 * carries no structural kind is placed by its head count (1 = Singles, 2 = Doubles,
 * 3 = Trios, more = Team): that is a fact about the game, not a guess.
 *
 * Unlike the total-appearance score, this one is normalised *linearly* against the
 * most concentrated distribution the role allows:
 *
 *     RoleFairness = 1 − Σ_role excess(role) / Σ_role maxExcess(role)      ∈ [0, 1]
 *
 * SSD grows with the square of the concentration, so the penalty is convex: moving
 * from "A B C D" to "A A B C" costs less than moving from "A A A B" to "A A A A". That
 * is what lets a win-first order use its best player twice in Singles when the gain is
 * real while still never handing them every Singles game for a marginal gain.
 *
 * It is never a hard constraint — few players, absences or exclusions can make
 * concentration unavoidable, and then the order is still produced.
 */

export interface RoleGroup {
  role: StructuralKind;
  /** Indices (into the sorted game list) of the games in this role. */
  gameIndices: number[];
  /** Total slots in this role. */
  slots: number;
  /** Fewest-possible SSD for these slots spread over the participants. */
  minSsd: number;
  /** `maxSsd - minSsd`: the excess of the most concentrated legal-looking spread. */
  maxExcess: number;
}

/** The role a game belongs to. */
export function roleOfGame(game: Pick<GameSlotDef, 'kinds' | 'playerCount'>): StructuralKind {
  for (const kind of STRUCTURAL_KINDS) {
    if (game.kinds.includes(kind)) return kind;
  }
  if (game.playerCount <= 1) return 'SINGLES';
  if (game.playerCount === 2) return 'DOUBLES';
  if (game.playerCount === 3) return 'TRIOS';
  return 'TEAM';
}

/**
 * SSD of the most concentrated spread of `slots` appearances over `players` people when
 * nobody can appear more than `perPlayerCap` times (once per game of the role). Every
 * achievable spread is majorised by it, so it bounds the SSD from above.
 */
export function maximalSsd(slots: number, perPlayerCap: number, players: number): number {
  if (players <= 0 || slots <= 0 || perPlayerCap <= 0) return 0;
  const counts = new Array<number>(players).fill(0);
  let left = slots;
  for (let i = 0; i < players && left > 0; i += 1) {
    counts[i] = Math.min(perPlayerCap, left);
    left -= counts[i];
  }
  return sumSquaredDeviation(counts);
}

/** Groups the (sorted) games by role, in the fixed role order. */
export function buildRoleGroups(games: readonly GameSlotDef[], playerCount: number): RoleGroup[] {
  const groups: RoleGroup[] = [];
  for (const role of STRUCTURAL_KINDS) {
    const gameIndices: number[] = [];
    let slots = 0;
    games.forEach((game, index) => {
      if (roleOfGame(game) !== role) return;
      gameIndices.push(index);
      slots += Math.max(0, game.playerCount);
    });
    if (gameIndices.length === 0) continue;
    const zeros = new Array<number>(Math.max(0, playerCount)).fill(0);
    const minSsd = minimalSsd(zeros, slots);
    const maxSsd = maximalSsd(slots, gameIndices.length, playerCount);
    groups.push({ role, gameIndices, slots, minSsd, maxExcess: Math.max(0, maxSsd - minSsd) });
  }
  return groups;
}

export interface RoleFairnessResult {
  /** Excess SSD per group, aligned with the groups. */
  excess: number[];
  totalExcess: number;
  /** 1 − totalExcess / Σ maxExcess, in [0, 1]. 1 when no role can be concentrated. */
  score: number;
  /** Largest number of games one player plays inside a single role. */
  maxConcentration: number;
}

/** Converts a total excess into the 0..1 score for the given groups. */
export function roleScore(groups: readonly RoleGroup[], totalExcess: number): number {
  const capacity = groups.reduce((acc, group) => acc + group.maxExcess, 0);
  if (capacity <= 0) return 1;
  return Math.max(0, Math.min(1, 1 - totalExcess / capacity));
}

/**
 * Evaluates role fairness from per-group appearance counts
 * (`countsByGroup[group][player]`).
 */
export function evaluateRoleFairness(
  groups: readonly RoleGroup[],
  countsByGroup: readonly (readonly number[])[],
): RoleFairnessResult {
  const excess: number[] = [];
  let totalExcess = 0;
  let maxConcentration = 0;
  groups.forEach((group, index) => {
    const counts = countsByGroup[index] ?? [];
    const value = Math.max(0, sumSquaredDeviation(counts) - group.minSsd);
    excess.push(value);
    totalExcess += value;
    for (const count of counts) maxConcentration = Math.max(maxConcentration, count);
  });
  return { excess, totalExcess, score: roleScore(groups, totalExcess), maxConcentration };
}

/** The most games of a role any one player needs to play for the role to be spread evenly. */
export function roleFairShare(group: RoleGroup, playerCount: number): number {
  return Math.ceil(group.slots / Math.max(1, playerCount));
}
