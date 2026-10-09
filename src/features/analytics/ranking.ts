import type { PlayerPeriod, TeamPeriod } from './aggregate';
import { MIN_SAMPLE } from './metrics';
import type { MetricId, Ratio } from './types';

/**
 * Own rankings (design §3, ランキング). These are *League Order's* orderings of observed
 * figures. They are a different thing from n01's official standings, which stay per season
 * and per division in `OfficialStandingRow` and are never mixed into these lists.
 */

export interface RankCandidate {
  id: string;
  label: string;
  value: number | null;
  /** The denominator behind {@link value} (darts, legs, sets…). */
  sample: number;
}

export interface RankedEntry extends RankCandidate {
  /** Competition rank (1,2,2,4); `null` for entries not ranked. */
  rank: number | null;
}

export interface RankingResult {
  /** Qualified entries in rank order. */
  ranked: RankedEntry[];
  /** Has a value but too small a sample: shown as reference, never ranked. */
  reference: RankedEntry[];
  /** No usable denominator: "no data", not a 0. */
  noData: RankedEntry[];
  /** Number of ranked entries (the population the rank is out of). */
  population: number;
  excluded: number;
}

export type Direction = 'desc' | 'asc';

function byStableOrder(a: RankCandidate, b: RankCandidate): number {
  if (a.label !== b.label) return a.label < b.label ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** Ranks by raw value (ties share a rank, the next rank skips), then a fixed label/id order. */
export function rankCandidates(
  candidates: readonly RankCandidate[],
  options: { direction?: Direction; minSample: number },
): RankingResult {
  const direction = options.direction ?? 'desc';
  const qualified = candidates.filter((c) => c.value !== null && c.sample >= options.minSample && c.sample > 0);
  const reference = candidates.filter((c) => c.value !== null && c.sample > 0 && c.sample < options.minSample);
  const noData = candidates.filter((c) => c.value === null || c.sample <= 0);
  qualified.sort((a, b) => {
    const diff = direction === 'desc' ? b.value! - a.value! : a.value! - b.value!;
    return diff !== 0 ? diff : byStableOrder(a, b);
  });
  const ranked: RankedEntry[] = [];
  qualified.forEach((c, index) => {
    const previous = ranked[index - 1];
    ranked.push({ ...c, rank: previous && previous.value === c.value ? previous.rank : index + 1 });
  });
  return {
    ranked,
    reference: reference.sort(byStableOrder).map((c) => ({ ...c, rank: null })),
    noData: noData.sort(byStableOrder).map((c) => ({ ...c, rank: null })),
    population: ranked.length,
    excluded: reference.length + noData.length,
  };
}

/** Occasion-weighted mean of the candidates: Σ numerator / Σ denominator (not a mean of means). */
export function pooledAverage(ratios: readonly Ratio[]): Ratio {
  let num = 0;
  let den = 0;
  for (const ratio of ratios) {
    if (ratio.den > 0) {
      num += ratio.num;
      den += ratio.den;
    }
  }
  return { num, den, value: den > 0 ? num / den : null };
}

export type PlayerScope = { kind: 'team'; teamId: string } | { kind: 'division'; divisionIndex: number } | { kind: 'league' };

export interface ScopedPopulation<T> {
  members: T[];
  /** True when some member also played in another division during the period (design §3). */
  includesOtherDivisions: boolean;
}

/**
 * The people a ranking is drawn from. Membership is decided by the *base season*: who was
 * on the team / in the division then. Their figures cover the whole chosen period.
 */
export function scopePlayers(
  players: readonly PlayerPeriod[],
  scope: PlayerScope,
  baseTournamentId: string,
): ScopedPopulation<PlayerPeriod> {
  const members = players.filter((player) => {
    const base = player.seasons.find((s) => s.tournamentId === baseTournamentId);
    if (!base) return false;
    if (scope.kind === 'team') return base.teamId === scope.teamId;
    if (scope.kind === 'division') return base.divisionIndex === scope.divisionIndex;
    return true;
  });
  const includesOtherDivisions =
    scope.kind === 'division' &&
    members.some((player) => player.seasons.some((s) => s.divisionIndex !== scope.divisionIndex));
  return { members, includesOtherDivisions };
}

export type TeamScope = { kind: 'division'; divisionIndex: number } | { kind: 'league' };

export function scopeTeams(teams: readonly TeamPeriod[], scope: TeamScope, baseTournamentId: string): ScopedPopulation<TeamPeriod> {
  const members = teams.filter((team) => {
    const base = team.seasons.find((s) => s.tournamentId === baseTournamentId);
    if (!base) return false;
    return scope.kind === 'league' || base.divisionIndex === scope.divisionIndex;
  });
  const includesOtherDivisions =
    scope.kind === 'division' && members.some((team) => team.seasons.some((s) => s.divisionIndex !== scope.divisionIndex));
  return { members, includesOtherDivisions };
}

/** Candidates for one metric. "Lower is better" for Best Leg is handled by {@link rankBestLeg}. */
export function ratioCandidates<T extends { metrics: { [K in MetricId]: Ratio } }>(
  items: readonly T[],
  metric: MetricId,
  id: (item: T) => string,
  label: (item: T) => string,
): RankCandidate[] {
  return items.map((item) => ({ id: id(item), label: label(item), value: item.metrics[metric].value, sample: item.metrics[metric].den }));
}

export function rankMetric<T extends { metrics: { [K in MetricId]: Ratio } }>(
  items: readonly T[],
  metric: MetricId,
  id: (item: T) => string,
  label: (item: T) => string,
): RankingResult {
  return rankCandidates(ratioCandidates(items, metric, id, label), { direction: 'desc', minSample: MIN_SAMPLE[metric] });
}

/** Best Leg: fewest darts first. Needs no sample threshold; 0 / missing are already `null`. */
export function rankBestLeg<T extends { metrics: { extremes: { bestLeg: number | null } } }>(
  items: readonly T[],
  id: (item: T) => string,
  label: (item: T) => string,
): RankingResult {
  return rankCandidates(
    items.map((item) => ({ id: id(item), label: label(item), value: item.metrics.extremes.bestLeg, sample: item.metrics.extremes.bestLeg === null ? 0 : 1 })),
    { direction: 'asc', minSample: 1 },
  );
}
