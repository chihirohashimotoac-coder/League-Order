import type { PlayerId, ThrowOrderMemberBasis, ThrowOrderRecord } from '../domain/types';
import { normalizeName } from '../domain/n01/names';
import { minConfidence, type ConfidenceLevel } from '../domain/prediction/confidence';
import { partialFinish } from '../domain/prediction/finishing';
import { orderDecisionConfidence } from '../domain/prediction/predictOrder';
import type { OpponentGameContext } from '../domain/prediction/opponentContext';
import {
  decideThrowOrder,
  orderedGameWin,
  permutationsWithFixed,
  type OrderOption,
  type ThrowOrderDecision,
} from '../domain/prediction/throwOrder';
import type { PreparedContext } from './prepare';

/**
 * Throwing order inside one game of a line-up (docs/THROW_ORDER_MODEL.md §6).
 *
 * The search chooses *who* plays (member sets); the order inside a game is decided here, for
 * each set, by one rule shared by every caller:
 *
 *  1. Locked slots keep their player in their slot.
 *  2. The other members fill the other slots strongest first: role strength in this game, then
 *     the history-corrected strength, Rating, PPR and name — content, never an internal id
 *     (an id is only the last resort between two players whose data is identical, where the
 *     tactical order is the same either way).
 *  3. With opponent data and the throw-order model, every order the locks allow is estimated,
 *     and another order replaces the strong one only through `decideThrowOrder`'s guardrails.
 *
 * The order changes nothing but the game's own win estimate, so choosing it per set keeps every
 * other term — fairness, roles, consecutive games, hard constraints — exactly as the search sees
 * it, and maximising each game maximises the match objectives too (they increase in every game).
 */

export interface ComboOrder {
  /** Player indices in throwing order (1投目 first). */
  order: number[];
  /** Strongest first, with locked slots respected. */
  strongOrder: number[];
  /** The decision, with opponent data (`null` without: the strong order is the rule). */
  decision: ThrowOrderDecision | null;
  /** Estimated game win of `order` (`null` without opponent data). */
  probability: number | null;
  /** True when the order came from the caller (a hand edit), not from the rule. */
  manual: boolean;
}

/** Stability variants: half of the finishing evidence, and a wider / narrower spread per visit. */
const VARIANTS: readonly { finishShare?: number; sdScale?: number }[] = [{ finishShare: 0.5 }, { sdScale: 1.25 }, { sdScale: 0.8 }];

/** Members' finishing evidence that counts as order data (beyond the priors). */
function hasOrderData(ctx: PreparedContext, gi: number, members: readonly number[]): boolean {
  return members.some((pi) => {
    const finish = ctx.memberBases[gi][pi]?.finish;
    return finish !== undefined && finish.source === 'first9' && finish.confidence !== 'LOW';
  });
}

/** Content-only ranking of two members for the strong order (negative = `a` throws earlier). */
export function compareForOrder(ctx: PreparedContext, gi: number, a: number, b: number): number {
  const EPS = 1e-9;
  const role = ctx.rankStrength[gi][b] - ctx.rankStrength[gi][a];
  if (Math.abs(role) > EPS) return role;
  const base = ctx.rankStrength[gi][b] - ctx.rankDelta[gi][b] - (ctx.rankStrength[gi][a] - ctx.rankDelta[gi][a]);
  if (Math.abs(base) > EPS) return base;
  const rating = (ctx.ratings.effective.get(ctx.playerIds[b]) ?? -Infinity) - (ctx.ratings.effective.get(ctx.playerIds[a]) ?? -Infinity);
  if (Number.isFinite(rating) && Math.abs(rating) > EPS) return rating;
  const ppr = (ctx.pprs.effective.get(ctx.playerIds[b]) ?? -Infinity) - (ctx.pprs.effective.get(ctx.playerIds[a]) ?? -Infinity);
  if (Number.isFinite(ppr) && Math.abs(ppr) > EPS) return ppr;
  const nameA = normalizeName(ctx.players[a].name);
  const nameB = normalizeName(ctx.players[b].name);
  if (nameA !== nameB) return nameA < nameB ? -1 : 1;
  // Identical data: the tactical order is the same whichever goes first.
  return ctx.playerIds[a] < ctx.playerIds[b] ? -1 : ctx.playerIds[a] > ctx.playerIds[b] ? 1 : 0;
}

/** Locked slot → player index for a game (undefined = free). */
function fixedSlots(ctx: PreparedContext, gi: number, members: readonly number[]): (number | undefined)[] {
  const locks = ctx.locksByGame[gi];
  return locks.map((pi) => (pi !== undefined && members.includes(pi) ? pi : undefined));
}

export function strongOrderFor(ctx: PreparedContext, gi: number, members: readonly number[]): number[] {
  const fixed = fixedSlots(ctx, gi, members);
  const free = members.filter((pi) => !fixed.includes(pi)).sort((a, b) => compareForOrder(ctx, gi, a, b));
  let cursor = 0;
  const order = fixed.map((pi) => (pi !== undefined ? pi : free[cursor++]));
  // A game whose slots outnumber its members (never produced by the search) keeps what it has.
  return order.filter((pi): pi is number => pi !== undefined);
}

function pairBonusOf(ctx: PreparedContext, members: readonly number[]): number {
  let bonus = 0;
  let pairs = 0;
  for (let i = 0; i < members.length; i += 1) {
    for (let j = i + 1; j < members.length; j += 1) {
      bonus += ctx.pairBonusPpr[members[i]][members[j]];
      pairs += 1;
    }
  }
  return pairs > 0 ? bonus / pairs : 0;
}

/**
 * Probabilities of an ordered side against one opponent game, kept per opponent game object
 * and keyed by every number that enters the estimate — so a hit is exactly what a miss computes,
 * across runs and across generations.
 */
const probabilityCache = new WeakMap<OpponentGameContext, Map<string, number>>();

export function orderedProbability(
  ctx: PreparedContext,
  gi: number,
  order: readonly number[],
  variant: { finishShare?: number; sdScale?: number } = {},
): number {
  const game = ctx.opponentGames[gi]!;
  const strengths = order.map((pi) => ctx.rankStrength[gi][pi]);
  const finish = order.map((pi) => {
    const estimate = ctx.memberBases[gi][pi]!.finish;
    return variant.finishShare === undefined ? estimate.rate : partialFinish(estimate, variant.finishShare);
  });
  const pairBonus = pairBonusOf(ctx, order);
  const key = `${ctx.startScore[gi]}|${ctx.discipline}|${variant.sdScale ?? 1}|${pairBonus}|${strengths.join(',')}|${finish.join(',')}`;
  let memo = probabilityCache.get(game);
  if (!memo) {
    memo = new Map();
    probabilityCache.set(game, memo);
  }
  const hit = memo.get(key);
  if (hit !== undefined) return hit;
  const value = orderedGameWin({ strengths, finish, pairBonus }, game, {
    startScore: ctx.startScore[gi],
    discipline: ctx.discipline,
    ...(variant.sdScale === undefined ? {} : { sdScale: variant.sdScale }),
  });
  if (memo.size > 20_000) memo.clear();
  memo.set(key, value);
  return value;
}

/** The largest game the order model enumerates (4! = 24 orders); bigger sides keep the strong order. */
export const MAX_ORDERED_PLAYERS = 4;

function decide(ctx: PreparedContext, gi: number, members: readonly number[], strongOrder: number[]): ThrowOrderDecision {
  const game = ctx.opponentGames[gi]!;
  const fixed = fixedSlots(ctx, gi, members);
  const orders = permutationsWithFixed(members, fixed);
  const options: OrderOption[] = orders.map((order) => ({ order, probability: orderedProbability(ctx, gi, order) }));
  const confidence = orderDecisionConfidence(
    minConfidence(game.confidence, ...members.map((pi) => ctx.memberBases[gi][pi]!.confidence)),
    ctx.startKnown[gi],
  );
  const opponentOrderKnown = !!game.order?.known && game.order.confidence !== 'LOW';
  return decideThrowOrder({
    strongOrder,
    options,
    confidence,
    opponentOrderKnown,
    orderData: hasOrderData(ctx, gi, members),
    robustGain: (order) =>
      Math.min(...VARIANTS.map((variant) => orderedProbability(ctx, gi, order, variant) - orderedProbability(ctx, gi, strongOrder, variant))),
  });
}

/**
 * The order for a member set (`explicit`: a hand-edited order, kept as given and estimated as is).
 * Memoised per prepared context: the same set is asked for by every search stage.
 */
export function chooseOrder(ctx: PreparedContext, gi: number, members: readonly number[], explicit?: readonly number[]): ComboOrder {
  const strongOrder = strongOrderFor(ctx, gi, members);
  const modelled = ctx.throwOrderModel && ctx.opponentGames[gi] !== null && ctx.memberBases[gi].every((basis) => basis !== null);
  if (explicit) {
    const order = [...explicit];
    if (members.length < 2 || !modelled) {
      return { order, strongOrder, decision: null, probability: null, manual: true };
    }
    const probability = orderedProbability(ctx, gi, order);
    const strongProbability = orderedProbability(ctx, gi, strongOrder);
    const confidence: ConfidenceLevel = orderDecisionConfidence(
      minConfidence(ctx.opponentGames[gi]!.confidence, ...members.map((pi) => ctx.memberBases[gi][pi]!.confidence)),
      ctx.startKnown[gi],
    );
    const same = order.length === strongOrder.length && order.every((pi, index) => pi === strongOrder[index]);
    return {
      order,
      strongOrder,
      decision: {
        order,
        strongOrder,
        adopted: same ? 'strong' : 'model',
        gain: probability - strongProbability,
        bestOrder: order,
        bestGain: probability - strongProbability,
        probability,
        strongProbability,
        confidence,
        fallback: null,
      },
      probability,
      manual: !same,
    };
  }

  const key = `${gi}|${[...members].sort((a, b) => a - b).join(',')}`;
  const memo = ctx.orderMemo.get(key);
  if (memo) return memo;

  let result: ComboOrder;
  if (members.length < 2) {
    result = { order: [...members], strongOrder, decision: null, probability: null, manual: false };
  } else if (!modelled) {
    result = { order: strongOrder, strongOrder, decision: null, probability: null, manual: false };
  } else {
    const game = ctx.opponentGames[gi]!;
    if (game.cricket || members.length > MAX_ORDERED_PLAYERS) {
      const probability = orderedProbability(ctx, gi, strongOrder);
      result = {
        order: strongOrder,
        strongOrder,
        decision: {
          order: strongOrder,
          strongOrder,
          adopted: 'strong',
          gain: 0,
          bestOrder: strongOrder,
          bestGain: 0,
          probability,
          strongProbability: probability,
          confidence: game.confidence,
          fallback: game.cricket ? 'cricket' : 'no-model',
        },
        probability,
        manual: false,
      };
    } else {
      const decision = decide(ctx, gi, members, strongOrder);
      result = { order: decision.order, strongOrder, decision, probability: decision.probability, manual: false };
    }
  }
  ctx.orderMemo.set(key, result);
  return result;
}

// ---------------------------------------------------------------------------
// Records for the solution
// ---------------------------------------------------------------------------

function tendencyText(game: OpponentGameContext | null): string | null {
  if (!game?.order) return null;
  if (!game.order.known) return '相手の投順は過去データから推定できません (全順を同等と仮定)';
  const leaders = game.order.leaders.map((entry) => `${entry.name} ${Math.round(entry.probability * 100)}%`).join(' / ');
  return `相手の 1 投目の予想: ${leaders} (投順の観測 ${game.order.samples.toFixed(1)} 回分)`;
}

/** The record of how a game's order was decided, in player ids (for the screen and the saved order). */
export function throwOrderRecord(ctx: PreparedContext, gi: number, chosen: ComboOrder): ThrowOrderRecord {
  const ids = (order: readonly number[]): PlayerId[] => order.map((pi) => ctx.playerIds[pi]);
  const basis: ThrowOrderMemberBasis[] = chosen.strongOrder.map((pi) => {
    const entry = ctx.rankRole[gi][pi];
    return {
      playerId: ctx.playerIds[pi],
      strength: ctx.rankStrength[gi][pi],
      roleDelta: ctx.rankDelta[gi][pi],
      source: entry.source,
      confidence: entry.confidence,
      games: entry.games,
    };
  });
  const decision = chosen.decision;
  const sameAsStrong = chosen.order.every((pi, index) => pi === chosen.strongOrder[index]);
  return {
    gameId: ctx.games[gi].id,
    order: ids(chosen.order),
    strongOrder: ids(chosen.strongOrder),
    adopted: chosen.manual && !sameAsStrong ? 'manual' : sameAsStrong ? 'strong' : 'model',
    fallback: decision?.fallback ?? null,
    probability: decision?.probability ?? null,
    strongProbability: decision?.strongProbability ?? null,
    bestGain: decision ? decision.bestGain : null,
    confidence: decision?.confidence ?? null,
    opponentTendency: ctx.throwOrderModel ? tendencyText(ctx.opponentGames[gi]) : null,
    ...(ctx.rankBlend ? { blendScale: true } : {}),
    basis,
  };
}
