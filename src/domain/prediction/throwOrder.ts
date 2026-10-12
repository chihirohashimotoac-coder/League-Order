import type { DartsDiscipline } from '../types';
import { clamp } from '../../utils/math';
import type { ConfidenceLevel } from './confidence';
import { finishPrior } from './finishing';
import { gameWinProbability } from './matchup';
import type { OpponentGameContext, OpponentSide } from './opponentContext';
import { expectedGameWin } from './opponentContext';
import { cachedVisitDistribution, legRace, visitSd, type RaceMember } from './raceModel';
import type { RoleStructure } from './roleStrength';
import { sideStrength } from './teamMatchup';

/**
 * Throw order inside Doubles / Trios / Gallon games (docs/THROW_ORDER_MODEL.md).
 *
 * The calibrated logistic model (`matchup.ts`) still says how much stronger one side is than the
 * other; what it never saw is the order the members throw in. The race model (`raceModel.ts`)
 * says what an order changes, and that change is expressed in the logistic model's own unit,
 * PPR points:
 *
 *   effect = (logit P_race(ordered sides) − logit P_race(same members, no order)) / slope
 *   slope  = d logit P_race / d(PPR) of the unordered sides
 *   P_game = race_m( logistic(k · (side mean + pair bonus − opponent + effect)) )
 *
 * Both sides' orders count: our arrangement raises our effect, the opponent's lowers it. The
 * effect is capped at ±ORDER_EFFECT_CAP points. Singles have no order, and Cricket is not
 * modelled (a shared board, and PPR says little about it): their probability is exactly the
 * order-free one, and their order is always the strong order.
 *
 * The decision (`decideThrowOrder`) keeps the basic theory — the stronger player in this game
 * throws first — and only lets an estimate overrule it when the improvement in the estimated
 * game win probability is at least ORDER_MIN_GAIN (2 points) on MEDIUM or HIGH data, with the
 * opponent's order known, real order data behind the members, and a conclusion that survives the
 * stability variants (the order still beats the strong order with half the finishing evidence
 * and with the per-visit spread 20–25% wider or narrower).
 */

export const THROW_ORDER_MODEL_VERSION = 'throw-order-v1' as const;
export type ThrowOrderModelVersion = typeof THROW_ORDER_MODEL_VERSION;

/** An order other than the strong one must be at least this much better (estimated game win). */
export const ORDER_MIN_GAIN = 0.02;
/** Floating-point slack on the boundary: a gain of exactly 2 points qualifies. */
export const ORDER_GAIN_TOLERANCE = 1e-9;
/** No order effect exceeds this many PPR points either way. */
export const ORDER_EFFECT_CAP = 4;

/**
 * Start score used when n01 does not say (documented guess, shown as such): 501 for one or two
 * players, 701 for three, 1001 for four or more. The order confidence is lowered one step then.
 */
export const DEFAULT_START_SCORE: Record<RoleStructure, number> = {
  SINGLES: 501,
  DOUBLES: 501,
  TRIOS: 701,
  GALLON: 1001,
};

function logit(p: number): number {
  const q = clamp(p, 1e-9, 1 - 1e-9);
  return Math.log(q / (1 - q));
}

function flat(members: readonly RaceMember[]): RaceMember[] {
  const n = members.length;
  const mu = members.reduce((acc, m) => acc + m.mu, 0) / n;
  const finish = members.reduce((acc, m) => acc + m.finish, 0) / n;
  const sds = members.map((m) => m.sd);
  const sd = sds.every((value) => value !== undefined) ? (sds as number[]).reduce((a, b) => a + b, 0) / n : undefined;
  return members.map(() => (sd === undefined ? { mu, finish } : { mu, finish, sd }));
}

function shifted(members: readonly RaceMember[], delta: number): RaceMember[] {
  return members.map((m) => ({ ...m, mu: m.mu + delta }));
}

/**
 * The PPR-equivalent effect of how both sides are ordered, against the same members thrown in no
 * particular order (each side replaced by its average member). 0 when neither side has an order.
 */
export function orderEffect(ours: readonly RaceMember[], theirs: readonly RaceMember[], startScore: number): number {
  if (ours.length < 2 && theirs.length < 2) return 0;
  const dist = (members: readonly RaceMember[]): Float64Array => cachedVisitDistribution(members, startScore);
  const flatOurs = flat(ours);
  const flatTheirs = flat(theirs);
  const ordered = legRace(dist(ours), dist(theirs)).average;
  const neutral = legRace(dist(flatOurs), dist(flatTheirs)).average;
  const up = legRace(dist(shifted(flatOurs, 1)), dist(flatTheirs)).average;
  const down = legRace(dist(shifted(flatOurs, -1)), dist(flatTheirs)).average;
  const slope = (logit(up) - logit(down)) / 2;
  if (!(slope > 1e-6)) return 0;
  return clamp((logit(ordered) - logit(neutral)) / slope, -ORDER_EFFECT_CAP, ORDER_EFFECT_CAP);
}

export interface OrderModelOptions {
  startScore: number;
  discipline: DartsDiscipline;
  /** Multiplies every per-visit SD (stability variants only; default 1). */
  sdScale?: number;
}

/** Our side, members in throwing order (index 0 = 1投目). */
export interface OrderedSideInput {
  strengths: readonly number[];
  finish: readonly number[];
  pairBonus: number;
}

function withSd(member: RaceMember, scale: number | undefined): RaceMember {
  return scale === undefined || scale === 1 ? member : { ...member, sd: visitSd(member.mu) * scale };
}

/** The opponent side's members in throwing order; an unordered side counts as its average member. */
export function opponentMembers(side: OpponentSide, numPart: number, options: OrderModelOptions): RaceMember[] {
  const members =
    side.members && side.members.length === numPart
      ? side.members.map((member) => ({ mu: member.strength, finish: member.finish }))
      : Array.from({ length: numPart }, () => ({ mu: side.strength, finish: finishPrior(side.strength, options.discipline) }));
  return members.map((member) => withSd(member, options.sdScale));
}

/**
 * Estimated probability that our ordered side wins the game against the opponent distribution.
 * Singles and Cricket: exactly `expectedGameWin` of the side's strength (no order effect).
 */
export function orderedGameWin(side: OrderedSideInput, game: OpponentGameContext, options: OrderModelOptions): number {
  const base = sideStrength(side.strengths, side.pairBonus);
  const k = side.strengths.length;
  if (game.cricket || k < 2) return expectedGameWin(base, game);
  const ours = side.strengths.map((mu, index) => withSd({ mu, finish: side.finish[index] }, options.sdScale));
  let total = 0;
  for (const opponent of game.sides) {
    const effect = orderEffect(ours, opponentMembers(opponent, k, options), options.startScore);
    total += opponent.probability * gameWinProbability(base + effect, opponent.strength, game);
  }
  return total;
}

// ---------------------------------------------------------------------------
// Decision
// ---------------------------------------------------------------------------

/**
 * Why the strong order was kept (or `null` when it simply is the best order, or another order
 * was adopted).
 */
export type OrderFallback =
  | 'single-player'
  | 'cricket'
  | 'no-model'
  | 'small-gain'
  | 'low-confidence'
  | 'no-order-data'
  | 'opponent-order-unknown'
  | 'unstable';

export const ORDER_FALLBACK_LABELS: Record<OrderFallback, string> = {
  'single-player': '1 人のゲーム',
  cricket: 'Cricket は投順の効果を推定できるデータがないため強い順',
  'no-model': '推定勝率を計算できないため強い順',
  'small-gain': '強い順との差が 2pt 未満のため強い順',
  'low-confidence': 'データの信頼度が低いため強い順',
  'no-order-data': '投順の効果を裏付ける選手データが不足しているため強い順',
  'opponent-order-unknown': '相手の投順が分からないため強い順',
  unstable: '前提を少し変えると結論が変わる (不安定) ため強い順',
};

export interface OrderOption {
  /** Member indices in throwing order. */
  order: readonly number[];
  /** Estimated game win probability with this order. */
  probability: number;
}

export interface DecisionInput {
  /** Member indices strongest first (locked positions already respected). */
  strongOrder: readonly number[];
  /** Every order that may be used, the strong one included. */
  options: readonly OrderOption[];
  /** The weakest confidence of the data the estimate stands on. */
  confidence: ConfidenceLevel;
  /** The opponent's order in this game is known or estimated from their history. */
  opponentOrderKnown: boolean;
  /** At least one member has order-relevant evidence of MEDIUM or better (beyond the priors). */
  orderData: boolean;
  /**
   * The smallest gain of `order` over the strong order across the stability variants. The
   * conclusion is unstable when it is not positive in every variant.
   */
  robustGain?: (order: readonly number[]) => number;
}

export interface ThrowOrderDecision {
  order: number[];
  strongOrder: number[];
  adopted: 'strong' | 'model';
  /** Estimated game-win gain of the chosen order over the strong order (0 when strong). */
  gain: number;
  /** The best order by the estimate, adopted or not, and its gain. */
  bestOrder: number[];
  bestGain: number;
  probability: number | null;
  strongProbability: number | null;
  confidence: ConfidenceLevel;
  fallback: OrderFallback | null;
}

function sameOrder(a: readonly number[], b: readonly number[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function lexicographic(a: readonly number[], b: readonly number[]): number {
  for (let i = 0; i < Math.min(a.length, b.length); i += 1) if (a[i] !== b[i]) return a[i] - b[i];
  return a.length - b.length;
}

/**
 * Strong order unless an estimate clears every guardrail (module comment). Ties go to the strong
 * order, then to the order closest to it (lexicographic in strong-order ranks): never to an id.
 */
export function decideThrowOrder(input: DecisionInput): ThrowOrderDecision {
  const strongOrder = [...input.strongOrder];
  const strong = input.options.find((option) => sameOrder(option.order, strongOrder));
  if (!strong) {
    return {
      order: strongOrder,
      strongOrder,
      adopted: 'strong',
      gain: 0,
      bestOrder: strongOrder,
      bestGain: 0,
      probability: null,
      strongProbability: null,
      confidence: input.confidence,
      fallback: 'no-model',
    };
  }
  const rank = new Map(strongOrder.map((member, position) => [member, position]));
  const ranks = (order: readonly number[]): number[] => order.map((member) => rank.get(member) ?? member);
  let best = strong;
  for (const option of input.options) {
    const diff = option.probability - best.probability;
    if (diff > 1e-12 || (Math.abs(diff) <= 1e-12 && !sameOrder(best.order, strongOrder) && lexicographic(ranks(option.order), ranks(best.order)) < 0)) {
      best = option;
    }
  }
  const bestGain = best.probability - strong.probability;
  const keep = (fallback: OrderFallback | null): ThrowOrderDecision => ({
    order: strongOrder,
    strongOrder,
    adopted: 'strong',
    gain: 0,
    bestOrder: [...best.order],
    bestGain,
    probability: strong.probability,
    strongProbability: strong.probability,
    confidence: input.confidence,
    fallback,
  });
  if (sameOrder(best.order, strongOrder)) return keep(null);
  const threshold = ORDER_MIN_GAIN - ORDER_GAIN_TOLERANCE;
  if (bestGain < threshold) return keep('small-gain');
  if (input.confidence === 'LOW') return keep('low-confidence');
  if (!input.orderData) return keep('no-order-data');
  if (!input.opponentOrderKnown) return keep('opponent-order-unknown');
  if (input.robustGain && !(input.robustGain(best.order) > 0)) return keep('unstable');
  return {
    order: [...best.order],
    strongOrder,
    adopted: 'model',
    gain: bestGain,
    bestOrder: [...best.order],
    bestGain,
    probability: best.probability,
    strongProbability: strong.probability,
    confidence: input.confidence,
    fallback: null,
  };
}

/** Every permutation of `members` that keeps `fixed[position]` where one is set. */
export function permutationsWithFixed(members: readonly number[], fixed: readonly (number | undefined)[]): number[][] {
  const size = fixed.length;
  const free = members.filter((member) => !fixed.includes(member));
  const result: number[][] = [];
  const current: (number | undefined)[] = [...fixed];
  const used = new Set<number>();
  const recurse = (position: number): void => {
    if (position === size) {
      result.push([...(current as number[])]);
      return;
    }
    if (fixed[position] !== undefined) {
      recurse(position + 1);
      return;
    }
    for (const member of free) {
      if (used.has(member)) continue;
      used.add(member);
      current[position] = member;
      recurse(position + 1);
      current[position] = undefined;
      used.delete(member);
    }
  };
  recurse(0);
  return result;
}
