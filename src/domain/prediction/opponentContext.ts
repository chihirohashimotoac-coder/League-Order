import type { GameId, GameSlotDef, Player, PlayerId } from '../types';
import type { N01MatchIntelligenceSnapshot } from '../n01/intelligence';
import type { OpponentSlotDistribution } from '../n01/positionModel';
import { playerKey } from '../n01/history';
import { formatSignatures } from '../n01/signature';
import { effectivePpr } from '../n01/effectivePpr';
import type { ConfidenceLevel } from './confidence';
import { aggregateConfidence, lowerConfidence, minConfidence } from './confidence';
import {
  DEFAULT_STRENGTH_PARAMETERS,
  FALLBACK_LEAGUE_PPR,
  leagueFirst9Gap,
  manualStrength,
  playerStrength,
  type LeaguePrior,
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
 * - Three or more: observed line-ups (α) mixed with the expected side strength
 *   (mean field: Σ share · strength) — enumerating every line-up would add nothing a
 *   captain could check.
 */

export const LINEUP_PRIOR = 3;
/** Opponent sides kept per game (the rest is folded in by renormalisation). */
export const MAX_SIDES = 24;

export interface OpponentSide {
  strength: number;
  probability: number;
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
}

export interface OurPlayerContext {
  strength: number;
  confidence: ConfidenceLevel;
  legs: number;
  imputed: boolean;
  formAdjustment: number;
  first9Adjustment: number;
}

export interface OpponentContext {
  version: 1;
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
}

function toOurContext(strength: PlayerStrength): OurPlayerContext {
  return {
    strength: strength.strength,
    confidence: strength.confidence,
    legs: strength.legs,
    imputed: strength.imputed,
    formAdjustment: strength.formAdjustment,
    first9Adjustment: strength.first9Adjustment,
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

export interface BuildContextInput {
  snapshot: N01MatchIntelligenceSnapshot;
  /** The games of the order being made (any format with matching signatures). */
  games: readonly GameSlotDef[];
  /** Our team's players (League Order records). */
  players: readonly Player[];
  parameters?: StrengthParameters;
}

/** `null` when the snapshot has no opponent (no next match, or it could not be read). */
export function buildOpponentContext(input: BuildContextInput): OpponentContext | null {
  const { snapshot } = input;
  const opponent = snapshot.opponent;
  if (!opponent || !snapshot.nextMatch) return null;
  const parameters = input.parameters ?? DEFAULT_STRENGTH_PARAMETERS;
  const prior: LeaguePrior = {
    meanPpr: snapshot.leagueMeanPpr,
    first9Gap: leagueFirst9Gap([...snapshot.ourStats, ...opponent.stats], parameters.weights),
  };
  const leagueMean = snapshot.leagueMeanPpr ?? FALLBACK_LEAGUE_PPR;

  const ourStatsByKey = new Map(snapshot.ourStats.map((entry) => [entry.key, entry]));
  const players: Record<PlayerId, OurPlayerContext> = {};
  for (const player of input.players) {
    const binding = player.n01;
    const key = binding ? playerKey(binding.opid, binding.lastSeenTournamentId, binding.currentOid) : null;
    const stats = key ? ourStatsByKey.get(key) : undefined;
    const manual = player.pprSource === 'manual' || !binding;
    // No line in this analysis (e.g. the season's stats could not be read, so the sync kept
    // the previous PPR): the effective PPR counts as a little evidence, not the league mean.
    players[player.id] = toOurContext(
      manual || !stats || stats.seasons.length === 0
        ? manualStrength(effectivePpr(player).value, prior, parameters.priorLegs)
        : playerStrength(stats, prior, parameters),
    );
  }

  const opponentStrengths = new Map(opponent.stats.map((entry) => [entry.key, playerStrength(entry, prior, parameters)]));
  const strengthOf = (key: string): number => opponentStrengths.get(key)?.strength ?? leagueMean;
  const nameOf = new Map(opponent.players.map((player) => [player.key, player.name]));

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
    games[game.id] = {
      gameId: game.id,
      signature,
      numPart: slot.numPart,
      legsToWin: game.n01?.limitLegCount ?? shapeBySignature.get(signature)?.limitLegCount ?? null,
      cricket,
      sides: sidesFor(slot, strengthOf),
      likely,
      samples: slot.weightedSamples,
      confidence: cricket ? lowerConfidence(confidence) : confidence,
    };
  }
  const gameConfidences = Object.values(games).map((game) => game.confidence);
  if (gameConfidences.length === 0) return null;

  return {
    version: 1,
    generatedAt: snapshot.generatedAt,
    matchId: snapshot.nextMatch.matchId,
    matchDate: snapshot.nextMatch.date,
    opponentName: opponent.name,
    leagueMeanPpr: leagueMean,
    players,
    games,
    orderConfidence: snapshot.orderConfidence,
    confidence: aggregateConfidence(gameConfidences),
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
