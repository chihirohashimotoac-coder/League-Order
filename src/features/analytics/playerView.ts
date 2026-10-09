import type { PlayerPeriod } from './aggregate';
import { aggregatePlayers } from './aggregate';
import { formatValue } from './format';
import type { RankMetric } from './format';
import { MIN_SAMPLE, pairOf, reliabilityOf } from './metrics';
import { pooledAverage, rankBestLeg, rankMetric, scopePlayers } from './ranking';
import type { PlayerScope, RankingResult, ScopedPopulation } from './ranking';
import type { SeasonData } from './seasonData';
import type { MetricId, Metrics, Ratio, Reliability } from './types';

/**
 * Player Analytics view-model (design §4): pure functions from a loaded period to what the
 * screen shows. Everything here is derived from raw counts and says what it was compared to.
 */

export interface LocalPlayerBinding {
  opid: string | null;
  currentOid: string | null;
  lastSeenTournamentId: string;
}

export interface PersonMatch {
  personKey: string | null;
  /** Why no stats can be shown, when `personKey` is null. */
  reason?: string;
}

/**
 * Finds a local roster member's stats. Inside the base season the n01 `oid` is authoritative;
 * otherwise a *provably unique* `opid` is used. Nothing is guessed from names.
 */
export function findPerson(base: SeasonData, binding: LocalPlayerBinding | undefined): PersonMatch {
  if (!binding) return { personKey: null, reason: 'n01 と連携していない選手です' };
  if (binding.currentOid && binding.lastSeenTournamentId === base.tournamentId) {
    const byOid = base.players.find((p) => p.oid === binding.currentOid);
    if (byOid) return { personKey: byOid.personKey };
  }
  if (binding.opid) {
    const byOpid = base.players.find((p) => p.opid === binding.opid);
    if (byOpid?.linkable) return { personKey: byOpid.personKey };
    if (byOpid) return { personKey: null, reason: 'IDを共有する選手がいるため、同一人物として扱えません' };
  }
  return { personKey: null, reason: 'この季の成績に該当する選手を確認できません' };
}

export interface PlayerPopulation {
  people: PlayerPeriod[];
  scoped: ScopedPopulation<PlayerPeriod>;
  averages: Record<MetricId, Ratio>;
}

const AVERAGED: MetricId[] = ['ppr', 'first9', 'legRate', 'setRate', 'keep', 'break', 'ton00Rate', 'ton40Rate', 'ton70Rate', 'ton80Rate'];

export function buildPopulation(seasons: readonly SeasonData[], scope: PlayerScope, baseTournamentId: string): PlayerPopulation {
  const people = aggregatePlayers(seasons);
  const scoped = scopePlayers(people, scope, baseTournamentId);
  const averages = {} as Record<MetricId, Ratio>;
  for (const metric of AVERAGED) averages[metric] = pooledAverage(scoped.members.map((m) => m.metrics[metric]));
  return { people, scoped, averages };
}

export function rankIn(members: readonly PlayerPeriod[], metric: RankMetric): RankingResult {
  const id = (p: PlayerPeriod): string => p.personKey;
  const label = (p: PlayerPeriod): string => p.name;
  return metric === 'bestLeg' ? rankBestLeg(members, id, label) : rankMetric(members, metric, id, label);
}

/** A person's rank in a ranking: the rank out of the ranked population, or why there is none. */
export function standingOf(ranking: RankingResult, personKey: string): { rank: number | null; population: number; state: 'ranked' | 'reference' | 'none' | 'absent' } {
  const ranked = ranking.ranked.find((e) => e.id === personKey);
  if (ranked) return { rank: ranked.rank, population: ranking.population, state: 'ranked' };
  if (ranking.reference.some((e) => e.id === personKey)) return { rank: null, population: ranking.population, state: 'reference' };
  if (ranking.noData.some((e) => e.id === personKey)) return { rank: null, population: ranking.population, state: 'none' };
  return { rank: null, population: ranking.population, state: 'absent' };
}

export function reliabilityOfMetric(person: PlayerPeriod, metric: MetricId): Reliability {
  return reliabilityOf(metric, person.metrics[metric]);
}

// ---- strengths / improvement candidates ---------------------------------------------------

export type InsightKind = 'strength' | 'improve';

export interface Insight {
  kind: InsightKind;
  metric: MetricId;
  value: number;
  average: number;
  /** Relative difference for 3DA / First 9, percentage points for shares. */
  diff: number;
  diffText: string;
  sample: number;
  /** People in the comparison population with a qualifying sample. */
  population: number;
  rank: number | null;
}

export interface Insights {
  strengths: Insight[];
  improvements: Insight[];
  /** Set when nothing could be judged: the reason is shown instead of a verdict. */
  held: string | null;
}

const INSIGHT_METRICS: MetricId[] = ['ppr', 'first9', 'legRate', 'break', 'keep'];
/** Provisional: a difference smaller than this is not called a strength or a weakness. */
const MATERIAL: Partial<Record<MetricId, number>> = { ppr: 0.03, first9: 0.03, legRate: 0.05, break: 0.05, keep: 0.05 };
export const MIN_POPULATION = 5;
const PER_SIDE = 2;

/**
 * Strengths and improvement candidates: a metric whose value sits clearly above/below the
 * comparison population's pooled average, with the sample and the number of people compared.
 * Needs a sufficient sample for the person and at least {@link MIN_POPULATION} qualifying
 * people; otherwise the answer is "held", never a guess. No causal claim is made: a low
 * Leg win rate alone says nothing about finishing.
 */
export function buildInsights(person: PlayerPeriod, population: PlayerPopulation, baseRankings: (metric: MetricId) => RankingResult): Insights {
  return buildInsightsFor({ key: person.personKey, metrics: person.metrics }, population.averages, baseRankings);
}

/** Anything with pooled metrics — a player or a team — can be judged the same way. */
export interface InsightSubject {
  key: string;
  metrics: Metrics;
}

export function buildInsightsFor(
  person: InsightSubject,
  averages: Record<MetricId, Ratio>,
  baseRankings: (metric: MetricId) => RankingResult,
): Insights {
  const found: Insight[] = [];
  for (const metric of INSIGHT_METRICS) {
    const mine = person.metrics[metric];
    const avg = averages[metric];
    if (mine.value === null || avg.value === null || mine.den < MIN_SAMPLE[metric]) continue;
    const ranking = baseRankings(metric);
    if (ranking.population < MIN_POPULATION) continue;
    const relative = metric === 'ppr' || metric === 'first9';
    const diff = relative ? (mine.value - avg.value) / avg.value : mine.value - avg.value;
    const threshold = MATERIAL[metric] ?? 0.05;
    if (Math.abs(diff) < threshold) continue;
    const standing = standingOf(ranking, person.key);
    found.push({
      kind: diff > 0 ? 'strength' : 'improve',
      metric,
      value: mine.value,
      average: avg.value,
      diff,
      diffText: relative ? `${diff > 0 ? '+' : ''}${(diff * 100).toFixed(1)}%` : `${diff > 0 ? '+' : ''}${(diff * 100).toFixed(1)}pt`,
      sample: mine.den,
      population: ranking.population,
      rank: standing.rank,
    });
  }
  const byStrength = (a: Insight, b: Insight): number => Math.abs(b.diff) / (MATERIAL[b.metric] ?? 1) - Math.abs(a.diff) / (MATERIAL[a.metric] ?? 1);
  const strengths = found.filter((i) => i.kind === 'strength').sort(byStrength).slice(0, PER_SIDE);
  const improvements = found.filter((i) => i.kind === 'improve').sort(byStrength).slice(0, PER_SIDE);
  let held: string | null = null;
  if (strengths.length === 0 && improvements.length === 0) {
    const anySample = INSIGHT_METRICS.some((m) => person.metrics[m].den >= MIN_SAMPLE[m]);
    held = !anySample
      ? 'サンプル数が基準に満たないため、判定を保留します。'
      : 'ほぼ平均的、または比較対象が少ないため、強み・改善候補の判定を保留します。';
  }
  return { strengths, improvements, held };
}

// ---- trend --------------------------------------------------------------------------------

export interface TrendPoint {
  tournamentId: string;
  title: string;
  /** `null` when that season has no usable denominator (a gap, not a 0). */
  value: number | null;
  sample: number;
  divisionIndex: number | null;
}

/** One point per season, oldest first. A season without a usable denominator is a gap. */
export function trendOf(person: PlayerPeriod, metric: MetricId): TrendPoint[] {
  return [...person.seasons].reverse().map((season) => {
    const pair = pairOf(metric, season.line);
    return {
      tournamentId: season.tournamentId,
      title: season.title,
      value: pair ? pair.num / pair.den : null,
      sample: pair?.den ?? 0,
      divisionIndex: season.divisionIndex,
    };
  });
}

// ---- comparison ---------------------------------------------------------------------------

export const COMPARE_METRICS: RankMetric[] = ['ppr', 'first9', 'legRate', 'setRate', 'keep', 'break', 'ton80Rate', 'bestLeg'];

export function metricValue(person: { metrics: Metrics }, metric: RankMetric): { value: number | null; sample: number } {
  if (metric === 'bestLeg') return { value: person.metrics.extremes.bestLeg, sample: person.metrics.extremes.bestLeg === null ? 0 : 1 };
  return { value: person.metrics[metric].value, sample: person.metrics[metric].den };
}

/** Text for a cell: the value, marked as reference when the sample is under the threshold. */
export function cellText(person: { metrics: Metrics }, metric: RankMetric): { text: string; reference: boolean } {
  const { value, sample } = metricValue(person, metric);
  if (value === null) return { text: '—', reference: false };
  const reference = metric !== 'bestLeg' && sample < MIN_SAMPLE[metric];
  return { text: formatValue(metric, value), reference };
}
