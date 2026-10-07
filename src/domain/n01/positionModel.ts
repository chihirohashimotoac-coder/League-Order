import type { ConfidenceLevel } from '../prediction/confidence';
import { orderModelConfidence, slotConfidence } from '../prediction/confidence';
import { recencyWeight, RECENCY_WEIGHTS } from './recency';

/**
 * Opponent position model (MASTER SPEC Phase 2 §7–§9).
 *
 * "Who will they put in Singles 2?" is a distribution, never an answer. It is built from
 * the opponent's past orders and shrunk, level by level, towards broader evidence when
 * a slot has been seen only a few times:
 *
 *     slot (SINGLES|01|2)  →  structure (all SINGLES|01 games)  →  team (any game)
 *     →  base (half uniform, half by strength)
 *
 * Each level is a Dirichlet-style blend: `(observed + β · prior) / (Σ observed + β)`, with
 * `β = POSITION_PRIOR_STRENGTH` matches' worth of seats. Each level is pooled only from
 * the observations *outside* the level below it (the structure level from the other
 * slots of that structure, the team level from the other structures), so one sighting
 * is never counted three times. Recency weights apply to every observation. Only players
 * on the opponent's current roster are given any probability.
 *
 * `probability` is a player's share of the slot's seats and sums to 1 over the roster;
 * the chance a player appears in a k-player slot is about `min(1, k · probability)`.
 */

export const POSITION_PRIOR_STRENGTH = 3;

export interface OrderObservation {
  seasonIndex: number;
  matchId: string;
  signature: string;
  playerKeys: string[];
}

export interface PositionSlotInput {
  gameId: string;
  signature: string;
  numPart: number;
}

export interface RosterEntry {
  key: string;
  /** Strength used for the base prior (PPR), `null` when unknown. */
  strength: number | null;
}

export interface SlotPlayerProbability {
  key: string;
  /** Recency-weighted seats this player filled in this slot. */
  appearanceCount: number;
  /** Share of the slot's seats (sums to 1 over the roster). */
  probability: number;
}

export interface ObservedLineup {
  keys: string[];
  weight: number;
  /** Share among the observed line-ups of this slot (sums to 1). */
  probability: number;
}

export interface OpponentSlotDistribution {
  gameId: string;
  signature: string;
  numPart: number;
  /** Matches in which this slot was observed (unweighted). */
  sampleCount: number;
  /** The same, recency-weighted. */
  weightedSamples: number;
  players: SlotPlayerProbability[];
  /** Exact line-ups seen (current roster only), for multi-player slots. */
  lineups: ObservedLineup[];
  confidence: ConfidenceLevel;
}

export interface OpponentPositionModel {
  slots: OpponentSlotDistribution[];
  /** Distinct past matches observed (unweighted). */
  orderSampleCount: number;
  weightedMatches: number;
  confidence: ConfidenceLevel;
}

export interface PositionModelInput {
  observations: readonly OrderObservation[];
  slots: readonly PositionSlotInput[];
  roster: readonly RosterEntry[];
  weights?: readonly number[];
  priorStrength?: number;
}

function structureKey(signature: string): string {
  return signature.split('|').slice(0, 2).join('|');
}

function normalise(values: Map<string, number>): Map<string, number> {
  let total = 0;
  for (const value of values.values()) total += value;
  const result = new Map<string, number>();
  for (const [key, value] of values) result.set(key, total > 0 ? value / total : 1 / values.size);
  return result;
}

function blend(counts: Map<string, number>, prior: Map<string, number>, beta: number): Map<string, number> {
  let observed = 0;
  for (const value of counts.values()) observed += value;
  const result = new Map<string, number>();
  for (const [key, p] of prior) {
    result.set(key, ((counts.get(key) ?? 0) + beta * p) / (observed + beta));
  }
  return normalise(result);
}

export function buildPositionModel(input: PositionModelInput): OpponentPositionModel {
  const weights = input.weights ?? RECENCY_WEIGHTS;
  const prior = input.priorStrength ?? POSITION_PRIOR_STRENGTH;
  const keys = input.roster.map((entry) => entry.key);
  const onRoster = new Set(keys);

  // Base prior: half uniform, half by strength (when any strength is known).
  const base = new Map<string, number>();
  const strengths = input.roster.map((entry) => entry.strength).filter((value): value is number => value !== null);
  const floor = strengths.length > 0 ? Math.min(...strengths) - 5 : 0;
  for (const entry of input.roster) {
    const strengthShare =
      strengths.length > 0 ? Math.max(1, (entry.strength ?? strengths.reduce((a, b) => a + b, 0) / strengths.length) - floor) : 1;
    base.set(entry.key, strengthShare);
  }
  const strengthPrior = normalise(base);
  const basePrior = new Map(keys.map((key) => [key, 0.5 / Math.max(1, keys.length) + 0.5 * (strengthPrior.get(key) ?? 0)]));

  const seatCounts = (filter: (observation: OrderObservation) => boolean): Map<string, number> => {
    const counts = new Map<string, number>();
    for (const observation of input.observations) {
      if (!filter(observation)) continue;
      const w = recencyWeight(observation.seasonIndex, weights);
      for (const key of observation.playerKeys) {
        if (onRoster.has(key)) counts.set(key, (counts.get(key) ?? 0) + w);
      }
    }
    return counts;
  };

  // β is always POSITION_PRIOR_STRENGTH matches' worth of the seats counted at that level.
  const seatsPerMatch = Math.max(1, input.slots.reduce((acc, slot) => acc + slot.numPart, 0));
  const structureSeats = (structure: string): number =>
    Math.max(1, input.slots.filter((slot) => structureKey(slot.signature) === structure).reduce((acc, slot) => acc + slot.numPart, 0));

  const baseShare = normalise(basePrior);

  const matches = new Map<string, number>();
  for (const observation of input.observations) {
    matches.set(`${observation.seasonIndex}:${observation.matchId}`, recencyWeight(observation.seasonIndex, weights));
  }
  const weightedMatches = [...matches.values()].reduce((a, b) => a + b, 0);

  const slots = input.slots.map((slot): OpponentSlotDistribution => {
    const structure = structureKey(slot.signature);
    const teamCounts = seatCounts((observation) => structureKey(observation.signature) !== structure);
    const teamPrior = blend(teamCounts, baseShare, prior * Math.max(1, seatsPerMatch - structureSeats(structure)));
    const structureCounts = seatCounts(
      (observation) => structureKey(observation.signature) === structure && observation.signature !== slot.signature,
    );
    const structurePrior = blend(structureCounts, teamPrior, prior * structureSeats(structure));
    const slotObservations = input.observations.filter((observation) => observation.signature === slot.signature);
    const slotCounts = seatCounts((observation) => observation.signature === slot.signature);
    const distribution = blend(slotCounts, structurePrior, prior * slot.numPart);

    const weightedSamples = slotObservations.reduce((acc, observation) => acc + recencyWeight(observation.seasonIndex, weights), 0);

    const lineupWeights = new Map<string, number>();
    if (slot.numPart >= 2) {
      for (const observation of slotObservations) {
        if (!observation.playerKeys.every((key) => onRoster.has(key))) continue;
        const key = [...observation.playerKeys].sort().join('+');
        lineupWeights.set(key, (lineupWeights.get(key) ?? 0) + recencyWeight(observation.seasonIndex, weights));
      }
    }
    const lineupTotal = [...lineupWeights.values()].reduce((a, b) => a + b, 0);

    return {
      gameId: slot.gameId,
      signature: slot.signature,
      numPart: slot.numPart,
      sampleCount: slotObservations.length,
      weightedSamples,
      players: keys
        .map((key) => ({ key, appearanceCount: slotCounts.get(key) ?? 0, probability: distribution.get(key) ?? 0 }))
        .sort((a, b) => b.probability - a.probability || (a.key < b.key ? -1 : 1)),
      lineups: [...lineupWeights.entries()]
        .map(([key, weight]) => ({ keys: key.split('+'), weight, probability: lineupTotal > 0 ? weight / lineupTotal : 0 }))
        .sort((a, b) => b.weight - a.weight || (a.keys.join() < b.keys.join() ? -1 : 1)),
      confidence: slotConfidence(weightedSamples),
    };
  });

  return {
    slots,
    orderSampleCount: matches.size,
    weightedMatches,
    confidence: orderModelConfidence(weightedMatches),
  };
}
