import type { PairAffinity, PairSetting, PlayerId, TeamId } from '../types';

/** Canonical, order-independent key for a player pair. */
export function pairKey(a: PlayerId, b: PlayerId): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

export interface PairLookup {
  affinity(a: PlayerId, b: PlayerId): PairAffinity;
  pastTogether(a: PlayerId, b: PlayerId): number;
  isForbidden(a: PlayerId, b: PlayerId): boolean;
  setting(a: PlayerId, b: PlayerId): PairSetting | undefined;
}

/** Builds an O(1) lookup over the team's pair settings. Missing pairs are NEUTRAL. */
export function buildPairLookup(pairs: readonly PairSetting[]): PairLookup {
  const map = new Map<string, PairSetting>();
  for (const pair of pairs) map.set(pairKey(pair.a, pair.b), pair);

  const get = (a: PlayerId, b: PlayerId) => map.get(pairKey(a, b));

  return {
    setting: get,
    affinity: (a, b) => get(a, b)?.affinity ?? 'NEUTRAL',
    pastTogether: (a, b) => get(a, b)?.pastTogetherCount ?? 0,
    isForbidden: (a, b) => get(a, b)?.affinity === 'FORBIDDEN',
  };
}

/** Normalises a pair into canonical `a < b` order. */
export function canonicalPair(
  teamId: TeamId,
  a: PlayerId,
  b: PlayerId,
): { teamId: TeamId; a: PlayerId; b: PlayerId } {
  return a < b ? { teamId, a, b } : { teamId, a: b, b: a };
}
