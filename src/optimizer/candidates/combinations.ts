import { mean } from '../../utils/math';
import { expectedGameWin } from '../../domain/prediction/opponentContext';
import { sideStrength } from '../../domain/prediction/teamMatchup';
import type { PreparedContext } from '../prepare';

/**
 * Per-game candidate line-ups (docs/DESIGN.md §6.3 Stage 0).
 *
 * A candidate is a *set* of player indices of exactly the required size. Building the
 * search over sets rather than per-slot choices makes four hard constraints
 * structurally impossible rather than merely detectable:
 *
 * - required player count (every combo has exactly `playerCount` members)
 * - no duplicate player inside a game (combos are sets)
 * - forbidden pairs (combos containing one are never emitted)
 * - locked assignments (combos missing a locked player are never emitted)
 */
export interface Combo {
  /** Player indices, ascending. */
  members: number[];
  /** Mean composite strength (Rating / PPR blend, 0..1) of the members. */
  strength: number;
  /** Mean game aptitude of the members. */
  gameFit: number;
  /** Mean pair affinity over all member pairs (0.5 for single-player games). */
  pairFit: number;
  /** Mean pair novelty over all member pairs (0.5 for single-player games). */
  novelty: number;
  /**
   * Estimated chance of winning this game against the predicted opponent, from the same
   * functions the result screen's 推定勝率 uses. 0.5 when the game has no opponent data.
   */
  oppWin: number;
  /** Static, count-independent part of the score; used for ordering and pruning. */
  localScore: number;
}

export interface GameCandidates {
  gameIndex: number;
  combos: Combo[];
  /** Best achievable values over the kept combos — the per-game upper bounds. */
  maxStrength: number;
  maxGameFit: number;
  maxPairFit: number;
  maxNovelty: number;
  maxOppWin: number;
  /** True when the full combination space was enumerated without sampling. */
  complete: boolean;
  /** Number of combos before the cap was applied. */
  rawCount: number;
}

function binomial(n: number, k: number): number {
  if (k < 0 || k > n) return 0;
  let result = 1;
  for (let i = 0; i < k; i += 1) {
    result = (result * (n - i)) / (i + 1);
    if (result > 1e12) return Infinity;
  }
  return Math.round(result);
}

/** Builds the scored descriptor for an arbitrary member set (also used by the local
 * search, which explores member sets that are not in the pre-built candidate lists). */
export function describeCombo(ctx: PreparedContext, gameIndex: number, members: number[]): Combo {
  const strength = mean(members.map((pi) => ctx.strength[pi]));
  const gameFit = mean(members.map((pi) => ctx.gameFit[gameIndex][pi]));

  let pairFit = 0.5;
  let novelty = 0.5;
  if (members.length >= 2) {
    const values: number[] = [];
    const novelties: number[] = [];
    for (let i = 0; i < members.length; i += 1) {
      for (let j = i + 1; j < members.length; j += 1) {
        values.push(ctx.pairValue[members[i]][members[j]]);
        novelties.push(ctx.pairNovelty[members[i]][members[j]]);
      }
    }
    pairFit = mean(values);
    novelty = mean(novelties);
  }

  let oppWin = 0.5;
  const opponentGame = ctx.opponentGames[gameIndex];
  if (opponentGame) {
    let bonus = 0;
    let pairsCount = 0;
    for (let i = 0; i < members.length; i += 1) {
      for (let j = i + 1; j < members.length; j += 1) {
        bonus += ctx.pairBonusPpr[members[i]][members[j]];
        pairsCount += 1;
      }
    }
    const side = sideStrength(
      members.map((pi) => ctx.predictionStrength[pi]),
      pairsCount > 0 ? bonus / pairsCount : 0,
    );
    oppWin = expectedGameWin(side, opponentGame);
  }

  const w = ctx.weights;
  const localScore =
    w.strength * strength +
    w.gameFit * gameFit +
    w.pairFit * pairFit +
    w.novelty * novelty +
    (w.opponentWin ?? 0) * oppWin;

  return { members, strength, gameFit, pairFit, novelty, oppWin, localScore };
}

/** True when any member pair is marked FORBIDDEN (a hard constraint). */
export function hasForbiddenPair(ctx: PreparedContext, members: readonly number[]): boolean {
  for (let i = 0; i < members.length; i += 1) {
    for (let j = i + 1; j < members.length; j += 1) {
      if (ctx.pairForbidden[members[i]][members[j]]) return true;
    }
  }
  return false;
}

/** Lexicographic enumeration of every valid combo. Used whenever the space is small. */
function enumerateAll(
  ctx: PreparedContext,
  pool: readonly number[],
  size: number,
  required: readonly number[],
): number[][] {
  const result: number[][] = [];
  const current: number[] = [];

  const recurse = (start: number): void => {
    if (current.length === size) {
      for (const req of required) {
        if (!current.includes(req)) return;
      }
      if (!hasForbiddenPair(ctx, current)) result.push([...current]);
      return;
    }
    const remainingNeeded = size - current.length;
    for (let i = start; i <= pool.length - remainingNeeded; i += 1) {
      const candidate = pool[i];
      let conflicts = false;
      for (const member of current) {
        if (ctx.pairForbidden[member][candidate]) {
          conflicts = true;
          break;
        }
      }
      if (conflicts) continue;
      current.push(candidate);
      recurse(i + 1);
      current.pop();
    }
  };

  recurse(0);
  return result;
}

/**
 * Deterministic fallback for the rare case where the combination space is too large
 * to enumerate (e.g. a 5-player team game with 20 eligible players).
 *
 * Every eligible player is used as an anchor exactly once, so no player can be
 * structurally squeezed out of the candidate pool — which is what keeps the fairness
 * term meaningful. For each anchor two companions sets are built: the strongest
 * partners, and the least-played-with partners.
 */
function sampleDiverse(
  ctx: PreparedContext,
  gameIndex: number,
  pool: readonly number[],
  size: number,
  required: readonly number[],
): number[][] {
  const merit = (pi: number): number =>
    ctx.weights.strength * ctx.strength[pi] + ctx.weights.gameFit * ctx.gameFit[gameIndex][pi];

  const byMerit = [...pool].sort((a, b) => merit(b) - merit(a) || a - b);
  const seen = new Set<string>();
  const result: number[][] = [];

  const tryBuild = (anchor: number, order: readonly number[]): void => {
    const members = [...new Set([...required, anchor])];
    if (members.length > size) return;
    for (const candidate of order) {
      if (members.length === size) break;
      if (members.includes(candidate)) continue;
      if (members.some((member) => ctx.pairForbidden[member][candidate])) continue;
      members.push(candidate);
    }
    if (members.length !== size) return;
    members.sort((a, b) => a - b);
    const key = members.join(',');
    if (seen.has(key)) return;
    seen.add(key);
    result.push(members);
  };

  const byNovelty = (anchor: number): number[] =>
    [...pool].sort(
      (a, b) => ctx.pairNovelty[anchor][b] - ctx.pairNovelty[anchor][a] || merit(b) - merit(a) || a - b,
    );

  for (const anchor of byMerit) tryBuild(anchor, byMerit);
  for (const anchor of byMerit) tryBuild(anchor, byNovelty(anchor));
  return result;
}

/** Builds and caps the candidate list for a single game. */
export function buildGameCandidates(ctx: PreparedContext, gameIndex: number): GameCandidates {
  const game = ctx.games[gameIndex];
  const pool = ctx.eligibleLists[gameIndex];
  const required = ctx.requiredByGame[gameIndex];
  const size = game.playerCount;
  const cap = Math.max(1, ctx.input.settings.maxCombosPerGame);

  const space = binomial(pool.length, size);
  // A generous raw ceiling: full enumeration stays cheap well above the kept cap.
  const rawCeiling = Math.max(cap * 20, 5000);

  let raw: number[][];
  let complete: boolean;
  if (space <= rawCeiling) {
    raw = enumerateAll(ctx, pool, size, required);
    complete = true;
  } else {
    raw = sampleDiverse(ctx, gameIndex, pool, size, required);
    complete = false;
  }

  const described = raw.map((members) => describeCombo(ctx, gameIndex, members));
  const rawCount = described.length;

  let combos = described;
  if (described.length > cap) {
    complete = false;
    // Half the budget to the strongest combos, half to combos that keep playing time
    // spread across players, so pruning never silently kills fairness.
    const byScore = [...described].sort(
      (a, b) => b.localScore - a.localScore || compareMembers(a.members, b.members),
    );
    const half = Math.max(1, Math.floor(cap / 2));
    const picked: Combo[] = [];
    const seen = new Set<string>();
    const push = (combo: Combo): void => {
      const key = combo.members.join(',');
      if (seen.has(key)) return;
      seen.add(key);
      picked.push(combo);
    };
    for (const combo of byScore.slice(0, half)) push(combo);

    // Round-robin over players: for each player take their best remaining combo. This
    // guarantees broad player coverage within the cap.
    const perPlayer = new Map<number, Combo[]>();
    for (const combo of byScore) {
      for (const member of combo.members) {
        const list = perPlayer.get(member);
        if (list) list.push(combo);
        else perPlayer.set(member, [combo]);
      }
    }
    const players = [...perPlayer.keys()].sort((a, b) => a - b);
    let round = 0;
    while (picked.length < cap) {
      let added = false;
      for (const player of players) {
        if (picked.length >= cap) break;
        const list = perPlayer.get(player)!;
        if (round < list.length) {
          push(list[round]);
          added = true;
        }
      }
      if (!added) break;
      round += 1;
    }
    combos = picked;
  }

  combos.sort((a, b) => b.localScore - a.localScore || compareMembers(a.members, b.members));

  return {
    gameIndex,
    combos,
    maxStrength: combos.reduce((acc, c) => Math.max(acc, c.strength), 0),
    maxGameFit: combos.reduce((acc, c) => Math.max(acc, c.gameFit), 0),
    maxPairFit: combos.reduce((acc, c) => Math.max(acc, c.pairFit), 0),
    maxNovelty: combos.reduce((acc, c) => Math.max(acc, c.novelty), 0),
    maxOppWin: combos.reduce((acc, c) => Math.max(acc, c.oppWin), 0),
    complete,
    rawCount,
  };
}

/** Deterministic ordering helper for equal-score combos. */
export function compareMembers(a: readonly number[], b: readonly number[]): number {
  const length = Math.min(a.length, b.length);
  for (let i = 0; i < length; i += 1) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return a.length - b.length;
}

/**
 * Stable identity of a complete selection, expressed in player ids so it stays
 * comparable across runs that use different weights. Used to return genuinely
 * different alternatives rather than the same line-up three times.
 */
export function selectionSignature(
  ctx: PreparedContext,
  selection: readonly Combo[],
): string {
  return selection
    .map((combo) => combo.members.map((pi) => ctx.playerIds[pi]).join('.'))
    .join('|');
}

export function buildAllCandidates(ctx: PreparedContext): GameCandidates[] {
  return ctx.games.map((_, index) => buildGameCandidates(ctx, index));
}
