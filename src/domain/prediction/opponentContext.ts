import type { DartsDiscipline, GameId, GameSlotDef, Player, PlayerId } from '../types';
import type { N01MatchIntelligenceSnapshot } from '../n01/intelligence';
import type { LeadTendency, OpponentSlotDistribution } from '../n01/positionModel';
import { leaguePriorOf, ownStatsOf } from '../n01/historyStrength';
import { formatSignatures } from '../n01/signature';
import { effectivePpr } from '../n01/effectivePpr';
import type { ConfidenceLevel } from './confidence';
import { aggregateConfidence, lowerConfidence, minConfidence, slotConfidence } from './confidence';
import { estimateFinish, finishPrior } from './finishing';
import { estimateRole, roleKeyOf, roleStructureOf, type RoleEvidence, type RoleStructure } from './roleStrength';
import {
  DEFAULT_STRENGTH_PARAMETERS,
  FALLBACK_LEAGUE_PPR,
  manualStrength,
  playerStrength,
  type PlayerStrength,
  type StrengthParameters,
} from './playerStrength';
import { sideStrength } from './teamMatchup';
import { gameWinProbability } from './matchup';

/**
 * Opponent context (MASTER SPEC Phase 3 §8, Phase 4).
 *
 * The small, self-contained input the prediction (and the optimizer) needs for one
 * order: each of our players' strength, and for each game of the order a distribution
 * over the *opponent side's* strength. It is derived from the intelligence snapshot and
 * stored inside the order (`OrderInput.opponent`), so a saved order can always be
 * re-evaluated exactly as it was generated — without the live cache.
 *
 * How the opponent side is distributed in a game:
 *
 * - Singles: the slot's player distribution, exactly.
 * - Doubles: observed pairs (weight α = samples / (samples + LINEUP_PRIOR)) mixed with
 *   pairs drawn from the slot's player distribution as if independent (1 − α).
 * - Three or more: observed line-ups (α) mixed with the line-ups of the slot's most likely
 *   players (as if independent) (1 − α).
 *
 * Version 2 (docs/THROW_ORDER_MODEL.md §5) keeps each multi-player side *in throwing order*:
 * an observed line-up in the order it was registered, a modelled one in the orders the team's
 * lead tendencies make likely (Plackett–Luce on each player's tendency to throw early, from
 * their ordered history; every order equally likely when the team has none). Each member
 * carries their strength in the game's role and their finishing estimate. Version 1 contexts
 * (orders saved before) have sides without members and are read exactly as before.
 */

export const LINEUP_PRIOR = 3;
/** Opponent sides kept per game (the rest is folded in by renormalisation). */
export const MAX_SIDES = 24;
/**
 * Ordered sides kept per multi-player game (an order splits a line-up into several sides). Beyond
 * it, the least likely sides are folded into one remainder side, so no probability is dropped.
 */
export const MAX_ORDERED_SIDES = MAX_SIDES;
/**
 * The largest side whose throwing order is modelled (4! = 24 orders). Bigger sides (Team / Gallon
 * of five or more) are kept without order, as version 1 keeps them: their orders are never
 * estimated, and enumerating them would grow factorially (8 players: 40 320 orders per line-up).
 */
export const MAX_ORDERED_MEMBERS = 4;
/**
 * How sharply a difference in lead tendency turns into a throwing order: a player with score 1
 * (always first) against one with 0 throws first with probability 1 / (1 + e^−4) ≈ 0.98.
 */
export const LEAD_SHARPNESS = 4;

export interface OpponentSideMember {
  /** Strength in this game's role (PPR points). */
  strength: number;
  /** Finishing estimate (per-visit probability inside the finishing range). */
  finish: number;
}

export interface OpponentSide {
  strength: number;
  probability: number;
  /** Version 2: the side's members in throwing order (multi-player games only). */
  members?: OpponentSideMember[];
}

/** What is known about the opponent's throwing order in a game (version 2). */
export interface OpponentOrderInfo {
  /** Estimated from the team's ordered history; `false` = every order equally likely (unknown). */
  known: boolean;
  confidence: ConfidenceLevel;
  /** Recency-weighted ordered observations of this structure. */
  samples: number;
  /** Who most likely throws first, for the explanation. */
  leaders: { name: string; probability: number }[];
}

export interface OpponentGameContext {
  gameId: GameId;
  signature: string;
  numPart: number;
  legsToWin: number | null;
  cricket: boolean;
  /** Distribution of the opponent side's strength (sums to 1). */
  sides: OpponentSide[];
  /** Most likely opponent players and their share of the slot, for explanations. */
  likely: { name: string; probability: number }[];
  /** Weighted observations of this slot. */
  samples: number;
  confidence: ConfidenceLevel;
  /** Version 2: the game's start score as n01 states it (`null` = not stated). */
  startScore?: number | null;
  /** Version 2: the game's role structure. */
  structure?: RoleStructure;
  /** Version 2, multi-player games: the opponent's throwing order. */
  order?: OpponentOrderInfo;
}

export interface OurPlayerContext {
  strength: number;
  confidence: ConfidenceLevel;
  legs: number;
  imputed: boolean;
  formAdjustment: number;
  first9Adjustment: number;
  /** Version 2: the shrunk First 9 excess behind the finishing estimate (`null` = none). */
  first9Excess?: number | null;
}

export interface OpponentContext {
  version: 1 | 2;
  generatedAt: number;
  matchId: string | null;
  matchDate: string | null;
  opponentName: string;
  leagueMeanPpr: number;
  players: Record<PlayerId, OurPlayerContext>;
  games: Record<GameId, OpponentGameContext>;
  /** Confidence of the opponent order model as a whole. */
  orderConfidence: ConfidenceLevel;
  /** Typical confidence across the games. */
  confidence: ConfidenceLevel;
  /** Version 2: the discipline the finishing priors were taken for. */
  discipline?: DartsDiscipline;
}

/** True for the context versions this build reads. */
export function isReadableContext(context: unknown): context is OpponentContext {
  const version = (context as { version?: unknown } | null | undefined)?.version;
  return version === 1 || version === 2;
}

function toOurContext(strength: PlayerStrength): OurPlayerContext {
  return {
    strength: strength.strength,
    confidence: strength.confidence,
    legs: strength.legs,
    imputed: strength.imputed,
    formAdjustment: strength.formAdjustment,
    first9Adjustment: strength.first9Adjustment,
    first9Excess: strength.first9Excess,
  };
}

function normaliseSides(sides: OpponentSide[]): OpponentSide[] {
  const merged = new Map<number, number>();
  for (const side of sides) {
    const key = Math.round(side.strength * 1000) / 1000;
    merged.set(key, (merged.get(key) ?? 0) + side.probability);
  }
  const kept = [...merged.entries()]
    .map(([strength, probability]) => ({ strength, probability }))
    .filter((side) => side.probability > 0)
    .sort((a, b) => b.probability - a.probability || a.strength - b.strength)
    .slice(0, MAX_SIDES);
  const total = kept.reduce((acc, side) => acc + side.probability, 0);
  return total > 0 ? kept.map((side) => ({ ...side, probability: side.probability / total })) : [];
}

function sidesFor(slot: OpponentSlotDistribution, strengthOf: (key: string) => number): OpponentSide[] {
  const players = slot.players.filter((player) => player.probability > 0);
  if (players.length === 0) return [];
  if (slot.numPart === 1) {
    return normaliseSides(players.map((player) => ({ strength: strengthOf(player.key), probability: player.probability })));
  }
  const alpha = slot.lineups.length > 0 ? slot.weightedSamples / (slot.weightedSamples + LINEUP_PRIOR) : 0;
  const observed = slot.lineups.map((lineup) => ({
    strength: sideStrength(lineup.keys.map(strengthOf)),
    probability: alpha * lineup.probability,
  }));
  let modelled: OpponentSide[];
  if (slot.numPart === 2 && players.length >= 2) {
    const pairs: OpponentSide[] = [];
    let total = 0;
    for (let i = 0; i < players.length; i += 1) {
      for (let j = i + 1; j < players.length; j += 1) {
        const weight = players[i].probability * players[j].probability;
        total += weight;
        pairs.push({ strength: sideStrength([strengthOf(players[i].key), strengthOf(players[j].key)]), probability: weight });
      }
    }
    modelled = pairs.map((pair) => ({ ...pair, probability: total > 0 ? ((1 - alpha) * pair.probability) / total : 0 }));
  } else {
    const expected = players.reduce((acc, player) => acc + player.probability * strengthOf(player.key), 0);
    modelled = [{ strength: expected, probability: 1 - alpha }];
  }
  return normaliseSides([...observed, ...modelled]);
}

/** Every k-subset of `items` (k ≤ items.length), in index order. */
function subsets<T>(items: readonly T[], k: number): T[][] {
  const result: T[][] = [];
  const current: T[] = [];
  const recurse = (start: number): void => {
    if (current.length === k) {
      result.push([...current]);
      return;
    }
    for (let i = start; i <= items.length - (k - current.length); i += 1) {
      current.push(items[i]);
      recurse(i + 1);
      current.pop();
    }
  };
  recurse(0);
  return result;
}

/** Every ordering of `items` with its Plackett–Luce probability under weights `lambda`. */
function orderings(items: readonly string[], lambda: (key: string) => number): { keys: string[]; probability: number }[] {
  const result: { keys: string[]; probability: number }[] = [];
  const recurse = (remaining: string[], prefix: string[], probability: number): void => {
    if (remaining.length === 0) {
      result.push({ keys: prefix, probability });
      return;
    }
    const total = remaining.reduce((acc, key) => acc + lambda(key), 0);
    for (const key of remaining) {
      recurse(
        remaining.filter((other) => other !== key),
        [...prefix, key],
        probability * (total > 0 ? lambda(key) / total : 1 / remaining.length),
      );
    }
  };
  recurse([...items], [], 1);
  return result;
}

interface OrderedSidesResult {
  sides: OpponentSide[];
  /** P(first thrower = key) over the whole distribution. */
  firsts: Map<string, number>;
}

/**
 * Version 2 sides of a multi-player slot, in throwing order. Observed line-ups keep the order they
 * were registered in (α); modelled line-ups (1 − α) are ordered by the lead tendencies, or every
 * order equally when the team has no ordered history.
 */
function orderedSidesFor(
  slot: OpponentSlotDistribution,
  member: (key: string) => OpponentSideMember,
  orderKnown: boolean,
): OrderedSidesResult {
  const firsts = new Map<string, number>();
  const players = slot.players.filter((player) => player.probability > 0);
  const k = slot.numPart;
  if (players.length < k || k > MAX_ORDERED_MEMBERS) return { sides: [], firsts };
  const leadScore = new Map((slot.lead ?? []).map((entry: LeadTendency) => [entry.key, entry.score]));
  const lambda = (key: string): number => (orderKnown ? Math.exp(LEAD_SHARPNESS * ((leadScore.get(key) ?? 0.5) - 0.5)) : 1);
  const ordered = slot.orderedLineups ?? [];
  const observedSets = ordered.length > 0 ? ordered : slot.lineups;
  const alpha = observedSets.length > 0 ? slot.weightedSamples / (slot.weightedSamples + LINEUP_PRIOR) : 0;

  const raw: { keys: string[]; probability: number }[] = [];
  if (ordered.length > 0) {
    for (const lineup of ordered) raw.push({ keys: lineup.keys, probability: alpha * lineup.probability });
  } else {
    // Line-ups seen without an order (models built before orders were read): ordered as modelled ones.
    for (const lineup of slot.lineups) {
      for (const option of orderings(lineup.keys, lambda)) raw.push({ keys: option.keys, probability: alpha * lineup.probability * option.probability });
    }
  }
  const pool = k === 2 ? players : players.slice(0, Math.min(players.length, k + 2));
  const sets = subsets(pool, k);
  const weightOf = (set: typeof pool): number => set.reduce((acc, player) => acc * player.probability, 1);
  const total = sets.reduce((acc, set) => acc + weightOf(set), 0);
  for (const set of sets) {
    const share = total > 0 ? ((1 - alpha) * weightOf(set)) / total : 0;
    if (share <= 0) continue;
    for (const option of orderings(set.map((player) => player.key), lambda)) raw.push({ keys: option.keys, probability: share * option.probability });
  }

  for (const entry of raw) firsts.set(entry.keys[0], (firsts.get(entry.keys[0]) ?? 0) + entry.probability);
  // Stored as compactly as version 1 stores strengths (3 decimals; finishing 4): a saved order
  // carries its context, and the precision beyond that is noise.
  const sides = raw.map((entry) => {
    const members = entry.keys.map(member).map((m) => ({ strength: Math.round(m.strength * 1000) / 1000, finish: Math.round(m.finish * 10_000) / 10_000 }));
    return { strength: Math.round(sideStrength(members.map((m) => m.strength)) * 1000) / 1000, probability: entry.probability, members };
  });
  return { sides: normaliseOrderedSides(sides), firsts };
}

function sideKey(side: OpponentSide): string {
  return side.members ? side.members.map((m) => `${m.strength.toFixed(3)}:${m.finish.toFixed(4)}`).join(',') : side.strength.toFixed(3);
}

function normaliseOrderedSides(sides: OpponentSide[]): OpponentSide[] {
  const merged = new Map<string, OpponentSide>();
  for (const side of sides) {
    const key = sideKey(side);
    const existing = merged.get(key);
    if (existing) existing.probability += side.probability;
    else merged.set(key, { ...side, members: side.members?.map((m) => ({ ...m })) });
  }
  const sorted = [...merged.entries()]
    .filter(([, side]) => side.probability > 0)
    .sort((a, b) => b[1].probability - a[1].probability || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([, side]) => side);
  const kept = sorted.length > MAX_ORDERED_SIDES ? [...sorted.slice(0, MAX_ORDERED_SIDES - 1), remainderSide(sorted.slice(MAX_ORDERED_SIDES - 1))] : sorted;
  const total = kept.reduce((acc, side) => acc + side.probability, 0);
  return total > 0 ? kept.map((side) => ({ ...side, probability: side.probability / total })) : [];
}

/**
 * The least likely ordered sides as one side: their total probability, and at each throwing
 * position the probability-weighted mean strength and finishing. The mixture's mass and its mean
 * strength are kept exactly, instead of being dropped and spread over the likelier sides.
 */
export function remainderSide(sides: readonly OpponentSide[]): OpponentSide {
  const probability = sides.reduce((acc, side) => acc + side.probability, 0);
  const size = sides[0]?.members?.length ?? 0;
  const weighted = (pick: (side: OpponentSide) => number): number =>
    probability > 0 ? sides.reduce((acc, side) => acc + side.probability * pick(side), 0) / probability : 0;
  const members = Array.from({ length: size }, (_, position) => ({
    strength: Math.round(weighted((side) => side.members?.[position]?.strength ?? side.strength) * 1000) / 1000,
    finish: Math.round(weighted((side) => side.members?.[position]?.finish ?? finishPrior(side.strength)) * 10_000) / 10_000,
  }));
  return {
    strength: Math.round((size > 0 ? sideStrength(members.map((member) => member.strength)) : weighted((side) => side.strength)) * 1000) / 1000,
    probability,
    ...(size > 0 ? { members } : {}),
  };
}

export interface BuildContextInput {
  snapshot: N01MatchIntelligenceSnapshot;
  /** The games of the order being made (any format with matching signatures). */
  games: readonly GameSlotDef[];
  /** Our team's players (League Order records). */
  players: readonly Player[];
  parameters?: StrengthParameters;
  /** The discipline of the format (finishing priors); absent = UNSPECIFIED. */
  discipline?: DartsDiscipline;
}

/** `null` when the snapshot has no opponent (no next match, or it could not be read). */
export function buildOpponentContext(input: BuildContextInput): OpponentContext | null {
  const { snapshot } = input;
  const opponent = snapshot.opponent;
  if (!opponent || !snapshot.nextMatch) return null;
  const parameters = input.parameters ?? DEFAULT_STRENGTH_PARAMETERS;
  const prior = leaguePriorOf(snapshot, parameters);
  const leagueMean = snapshot.leagueMeanPpr ?? FALLBACK_LEAGUE_PPR;

  // Our players' histories are found by oid first and never shared between two players
  // (see `ownStatsOf`); a player without a line counts their own PPR as a little evidence.
  const ownStats = ownStatsOf(snapshot, input.players);
  const players: Record<PlayerId, OurPlayerContext> = {};
  for (const player of input.players) {
    const stats = ownStats.get(player.id);
    const manual = player.pprSource === 'manual' || !player.n01;
    // No line in this analysis (e.g. the season's stats could not be read, so the sync kept
    // the previous PPR): the effective PPR counts as a little evidence, not the league mean.
    players[player.id] = toOurContext(
      manual || !stats || stats.seasons.length === 0
        ? manualStrength(effectivePpr(player).value, prior, parameters.priorLegs)
        : playerStrength(stats, prior, parameters),
    );
  }

  const opponentStrengths = new Map(opponent.stats.map((entry) => [entry.key, playerStrength(entry, prior, parameters)]));
  const nameOf = new Map(opponent.players.map((player) => [player.key, player.name]));
  const discipline = input.discipline ?? 'UNSPECIFIED';
  const roleEvidence = opponent.roleEvidence ?? {};
  // A member's strength in the game's role (base + role adjustment from their n01 games, when
  // any), and their finishing estimate on that strength.
  const memberOf = (game: GameSlotDef) => (key: string): OpponentSideMember => {
    const base = opponentStrengths.get(key);
    const role = estimateRole(roleEvidence[key] as RoleEvidence | undefined, roleKeyOf(game), null, base?.confidence ?? 'LOW');
    const strength = (base?.strength ?? leagueMean) + role.delta;
    return { strength, finish: estimateFinish(strength, base?.first9Excess ?? null, base?.legs ?? 0, discipline).rate };
  };
  const teamOrdered = opponent.positionModel.slots.reduce((acc, slot) => Math.max(acc, slot.teamOrderedSamples ?? 0), 0);

  const signatures = formatSignatures(input.games);
  const slotsBySignature = new Map(opponent.positionModel.slots.map((slot) => [slot.signature, slot]));
  const shapeBySignature = new Map(snapshot.games.map((game) => [game.signature, game]));
  const games: Record<GameId, OpponentGameContext> = {};
  for (const game of input.games) {
    const signature = signatures.get(game.id);
    const slot = signature ? slotsBySignature.get(signature) : undefined;
    if (!signature || !slot || slot.numPart !== game.playerCount) continue;
    const cricket = game.kinds.includes('CRICKET');
    const likely = slot.players.slice(0, 3).map((player) => ({ name: nameOf.get(player.key) ?? player.key, probability: player.probability }));
    const strengthConfidence = aggregateConfidence(
      slot.players.slice(0, Math.max(2, slot.numPart + 1)).map((player) => opponentStrengths.get(player.key)?.confidence ?? 'LOW'),
    );
    const confidence = minConfidence(slot.confidence, strengthConfidence);
    const member = memberOf(game);
    const roleStrengthOf = (key: string): number => member(key).strength;
    let sides: OpponentSide[];
    let order: OpponentOrderInfo | undefined;
    if (slot.numPart >= 2 && slot.numPart <= MAX_ORDERED_MEMBERS) {
      const known = teamOrdered > 0 && (slot.lead?.length ?? 0) > 0;
      const built = orderedSidesFor(slot, member, known);
      sides = built.sides;
      const total = [...built.firsts.values()].reduce((a, b) => a + b, 0);
      order = {
        known,
        confidence: known ? slotConfidence(slot.orderedSamples ?? 0) : 'LOW',
        samples: slot.orderedSamples ?? 0,
        leaders: [...built.firsts.entries()]
          .map(([key, probability]) => ({ key, probability: total > 0 ? probability / total : 0 }))
          .sort((a, b) => b.probability - a.probability || (a.key < b.key ? -1 : 1))
          .slice(0, 2)
          .map((entry) => ({ name: nameOf.get(entry.key) ?? entry.key, probability: entry.probability })),
      };
      if (sides.length === 0) sides = sidesFor(slot, roleStrengthOf);
    } else {
      sides = sidesFor(slot, roleStrengthOf);
    }
    games[game.id] = {
      gameId: game.id,
      signature,
      numPart: slot.numPart,
      legsToWin: game.n01?.limitLegCount ?? shapeBySignature.get(signature)?.limitLegCount ?? null,
      cricket,
      sides,
      likely,
      samples: slot.weightedSamples,
      confidence: cricket ? lowerConfidence(confidence) : confidence,
      startScore: game.n01?.startScore ?? null,
      structure: roleStructureOf(game),
      ...(order ? { order } : {}),
    };
  }
  const gameConfidences = Object.values(games).map((game) => game.confidence);
  if (gameConfidences.length === 0) return null;

  return {
    version: 2,
    generatedAt: snapshot.generatedAt,
    matchId: snapshot.nextMatch.matchId,
    matchDate: snapshot.nextMatch.date,
    opponentName: opponent.name,
    leagueMeanPpr: leagueMean,
    players,
    games,
    orderConfidence: snapshot.orderConfidence,
    confidence: aggregateConfidence(gameConfidences),
    discipline,
  };
}

/** Expected probability that a side of strength `ours` wins the game against the opponent distribution. */
export function expectedGameWin(ours: number, game: OpponentGameContext): number {
  let total = 0;
  for (const side of game.sides) total += side.probability * gameWinProbability(ours, side.strength, game);
  return total;
}

/** The opponent side's expected strength in a game. */
export function expectedOpponentStrength(game: OpponentGameContext): number {
  return game.sides.reduce((acc, side) => acc + side.probability * side.strength, 0);
}
