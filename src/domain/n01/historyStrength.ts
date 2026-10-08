import type { Player, PlayerId } from '../types';
import type { ConfidenceLevel } from '../prediction/confidence';
import { playerConfidence } from '../prediction/confidence';
import {
  DEFAULT_STRENGTH_PARAMETERS,
  MANUAL_PPR_LEGS,
  leagueFirst9Gap,
  playerStrength,
  type LeaguePrior,
  type StrengthParameters,
} from '../prediction/playerStrength';
import { DARTS_PER_LEG_ESTIMATE, playerKey, type HistoricalPlayerStats } from './history';
import { effectivePpr, pprSourceOf } from './effectivePpr';
import type { N01MatchIntelligenceSnapshot } from './intelligence';

/**
 * Our own players' strength when an order is made (F03).
 *
 * `Player.n01.stats` keeps *this season's* numbers exactly as the last sync stored them.
 * The strength an order is generated with is a separate, derived value: the same
 * recency-weighted, Darts-weighted, 30-leg-shrunk estimate the opponent-aware path
 * already uses for our players (`playerStrength`), over the seasons the last analysis
 * returned. A player with no rows this season but a full season before is therefore
 * rated on that season in the ordinary order too, and the two paths agree on the number.
 *
 * - A hand-entered PPR (`pprSource: 'manual'`, or a player not linked to n01) wins and
 *   is reported as manual.
 * - A linked player with analysis lines is rated on them (`current` when only this
 *   season contributed, `history` when earlier seasons did).
 * - A linked player the analysis has no lines for keeps the PPR the last sync stored
 *   (`carried`, low confidence) — a failed history request falls back to the old value,
 *   never to 0 or to the league mean.
 * - Nobody known: `unknown`, `ppr: null`; the optimizer imputes the participants' median.
 *
 * The result is a copy of each player whose `ppr` is the value used (like
 * `withEffectivePpr`) plus a record of where each number came from, so a saved order
 * keeps both. Nothing stored is rewritten.
 */

export type StrengthOrigin = 'manual' | 'current' | 'history' | 'carried' | 'unknown';

export interface StrengthBasisEntry {
  origin: StrengthOrigin;
  /** The PPR the order used (`null` = Unknown). */
  ppr: number | null;
  /** This season's PPR as n01 reported it, when there is one. */
  currentPpr: number | null;
  /** Recency-weighted legs behind the estimate (a hand-entered PPR counts as a few). */
  legs: number;
  /** Season indexes (0 = this season, 1 = the one before …) that contributed. */
  seasons: number[];
  confidence: ConfidenceLevel;
}

export interface StrengthBasisSeason {
  tournamentId: string;
  title: string;
  seasonIndex: number;
  /** Recency weight of the season. */
  weight: number;
}

export interface StrengthBasis {
  /** When the analysis behind the numbers was made (0 when there was none). */
  generatedAt: number;
  seasons: StrengthBasisSeason[];
  players: Record<PlayerId, StrengthBasisEntry>;
}

export interface HistoryStrengthResult {
  players: Player[];
  basis: StrengthBasis;
}

/** The shrinkage prior, built exactly as the opponent-aware path builds it. */
export function leaguePriorOf(
  snapshot: Pick<N01MatchIntelligenceSnapshot, 'leagueMeanPpr' | 'ourStats' | 'opponent'>,
  parameters: StrengthParameters = DEFAULT_STRENGTH_PARAMETERS,
): LeaguePrior {
  return {
    meanPpr: snapshot.leagueMeanPpr,
    first9Gap: leagueFirst9Gap([...snapshot.ourStats, ...(snapshot.opponent?.stats ?? [])], parameters.weights),
  };
}

/**
 * Each of our players' history in a snapshot, or `undefined` when it cannot be told
 * (no line, a stale binding, or two of our players resolving to one history — what an
 * older snapshot made of people sharing an opid). Found by `oid` first, since the `opid`
 * may be shared with a namesake.
 */
export function ownStatsOf(
  snapshot: Pick<N01MatchIntelligenceSnapshot, 'tournamentId' | 'ourPlayers' | 'ourStats'>,
  players: readonly Player[],
): Map<PlayerId, HistoricalPlayerStats | undefined> {
  const statsByKey = new Map(snapshot.ourStats.map((entry) => [entry.key, entry]));
  const keyByOid = new Map(snapshot.ourPlayers.map((entry) => [entry.oid, entry.key]));
  const keyOf = (player: Player): string | null => {
    const binding = player.n01;
    if (!binding) return null;
    const byOid =
      binding.currentOid && binding.lastSeenTournamentId === snapshot.tournamentId
        ? keyByOid.get(binding.currentOid)
        : undefined;
    return byOid ?? playerKey(binding.opid, binding.lastSeenTournamentId, binding.currentOid);
  };
  const keys = new Map(players.map((player) => [player.id, keyOf(player)]));
  const claims = new Map<string, number>();
  for (const key of keys.values()) if (key) claims.set(key, (claims.get(key) ?? 0) + 1);
  return new Map(
    players.map((player) => {
      const key = keys.get(player.id);
      return [player.id, key && (claims.get(key) ?? 0) === 1 ? statsByKey.get(key) : undefined];
    }),
  );
}

/** Confidence of this season's n01 numbers when no analysis is at hand (from the stored legs). */
function storedConfidence(player: Player): { legs: number; confidence: ConfidenceLevel } {
  const stats = player.n01?.stats;
  if (!stats) return { legs: 0, confidence: 'LOW' };
  const legs = stats.legs ?? stats.darts / DARTS_PER_LEG_ESTIMATE;
  return { legs, confidence: playerConfidence(legs) };
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

export function applyHistoryStrength(
  players: readonly Player[],
  snapshot: N01MatchIntelligenceSnapshot | null,
  parameters: StrengthParameters = DEFAULT_STRENGTH_PARAMETERS,
): HistoryStrengthResult {
  const prior = snapshot ? leaguePriorOf(snapshot, parameters) : null;
  const own = snapshot ? ownStatsOf(snapshot, players) : new Map<PlayerId, HistoricalPlayerStats | undefined>();
  const entries: Record<PlayerId, StrengthBasisEntry> = {};

  const result = players.map((player): Player => {
    const effective = effectivePpr(player);
    const currentPpr = player.n01?.stats?.ppr ?? null;

    if (pprSourceOf(player) === 'manual') {
      entries[player.id] = {
        origin: effective.value === null ? 'unknown' : 'manual',
        ppr: effective.value,
        currentPpr,
        legs: effective.value === null ? 0 : MANUAL_PPR_LEGS,
        seasons: [],
        confidence: 'LOW',
      };
      return effective.value === player.ppr ? player : { ...player, ppr: effective.value };
    }

    const history = own.get(player.id);
    if (prior && history && history.seasons.some((line) => line.darts > 0)) {
      const strength = playerStrength(history, prior, parameters);
      if (!strength.imputed) {
        const seasons = history.seasons.filter((line) => line.darts > 0).map((line) => line.seasonIndex);
        const value = round2(strength.strength);
        entries[player.id] = {
          origin: seasons.every((index) => index === 0) ? 'current' : 'history',
          ppr: value,
          currentPpr,
          legs: strength.legs,
          seasons,
          confidence: strength.confidence,
        };
        return value === player.ppr ? player : { ...player, ppr: value };
      }
    }

    if (effective.value !== null) {
      // The analysis has nothing for this player (or there was none): a hand-typed
      // fallback, or the PPR the last sync stored. The stored one is as good as its legs
      // when there is no analysis at all, and low confidence when the analysis could not
      // vouch for it (a failed history request falls back to the old value, never to 0).
      const typed = effective.origin === 'manual-fallback';
      const stored = storedConfidence(player);
      entries[player.id] = typed
        ? { origin: 'manual', ppr: effective.value, currentPpr, legs: MANUAL_PPR_LEGS, seasons: [], confidence: 'LOW' }
        : snapshot
          ? { origin: 'carried', ppr: effective.value, currentPpr, legs: stored.legs, seasons: [], confidence: 'LOW' }
          : { origin: 'current', ppr: effective.value, currentPpr, legs: stored.legs, seasons: [0], confidence: stored.confidence };
      return effective.value === player.ppr ? player : { ...player, ppr: effective.value };
    }

    entries[player.id] = { origin: 'unknown', ppr: null, currentPpr, legs: 0, seasons: [], confidence: 'LOW' };
    return player.ppr === null ? player : { ...player, ppr: null };
  });

  return {
    players: result,
    basis: {
      generatedAt: snapshot?.generatedAt ?? 0,
      seasons: (snapshot?.seasons ?? []).map((season) => ({ ...season })),
      players: entries,
    },
  };
}
