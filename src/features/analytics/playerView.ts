import { isUsableOpid } from '../../domain/n01/identity';
import type { PlayerPeriod } from './aggregate';
import { aggregatePlayers } from './aggregate';
import { formatValue } from './format';
import type { RankMetric } from './format';
import { MIN_SAMPLE, pairOf, reliabilityOf } from './metrics';
import { pooledAverage, rankBestLeg, rankMetric, scopePlayers } from './ranking';
import type { PlayerScope, RankingResult, ScopedPopulation } from './ranking';
import type { SeasonData } from './seasonData';
import { fullName, nameRelation } from './personLink';
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

// ---- ⑩ a member found across the period (本人照合 ⑨ applied) -------------------------------------

export type PeriodPersonState =
  /** Figures in the period (`inBase`: also in the base season). */
  | 'found'
  /** Known (registered), but no stats row in the base season — 今季 / 指定季 only. */
  | 'none-base'
  /** Known, but no stats row anywhere in the period. */
  | 'none-period'
  /** Their row is held by 本人照合 (several candidates / too little evidence). */
  | 'held'
  | 'unknown';

export interface PeriodPersonMatch {
  personKey: string | null;
  state: PeriodPersonState;
  inBase: boolean;
  reason?: string;
}

/**
 * Finds a League Order member in the period: their row of the base season (by its `oid` when the
 * member was last seen there, else a member id that names one row there), else — in a multi-season
 * period — their row of the season they were last seen in, else the one person their member id belongs
 * to in the period. A member without a stats row in the base season is still found when the period
 * has their figures elsewhere; a blank season is never counted as 0.
 */
export function findPersonInPeriod(
  seasons: readonly SeasonData[],
  /** `null`: the base season could not be read (a multi-season period goes on with the seasons read). */
  base: SeasonData | null,
  binding: (LocalPlayerBinding & { name?: string | null }) | undefined,
  links: { keyOf: ReadonlyMap<string, string>; held: readonly { row: { key: string } }[] },
  multi: boolean,
  withFigures: ReadonlySet<string>,
): PeriodPersonMatch {
  if (!binding) return { personKey: null, state: 'unknown', inBase: false, reason: 'n01 と連携していない選手です' };
  const rowsOf = (s: SeasonData): { key: string; opid: string | null; name: string }[] => [
    ...s.players.map((p) => ({ key: `${s.tournamentId}:${p.oid}`, opid: p.opid, name: p.name })),
    ...(s.heldPlayers ?? []).map((p) => ({ key: `${s.tournamentId}:${p.oid}`, opid: p.opid, name: p.name })),
    ...(s.roster ?? []).filter((r) => !s.players.some((p) => p.oid === r.oid) && !(s.heldPlayers ?? []).some((p) => p.oid === r.oid)).map((r) => ({ key: `${s.tournamentId}:${r.oid}`, opid: r.opid, name: r.name })),
  ];
  // A row found by the member id only must not be someone else under a reused id: it is taken only
  // when its name is the member's (or the same given name under another surname); a name that cannot
  // be compared (no known split) is not taken on the id alone.
  const splits = new Map<string, [string, string] | null>();
  for (const s of seasons) for (const r of rowsOf(s)) { const parts = r.name.normalize('NFKC').trim().split(/\s+/u); if (parts.length === 2) splits.set(fullName(r.name), [parts[0].toLowerCase(), parts[1].toLowerCase()]); }
  const otherPerson = (name: string): boolean => {
    if (!binding.name) return false;
    // Only the same name: a surname change is the business of 本人照合 (given name, team, adjacent
    // seasons), never of a member id alone.
    return nameRelation(binding.name, name, splits) !== 'same';
  };
  const REUSED = 'この会員IDの行は別の氏名の選手です（会員IDの再利用の可能性）。本人を特定できません';
  let rowKey: string | null = null;
  // 1. The row the member was last seen as (its season and oid), wherever it is in the period.
  const seen = seasons.find((s) => s.tournamentId === binding.lastSeenTournamentId);
  if (binding.currentOid && seen && (seen === base || multi) && rowsOf(seen).some((r) => r.key === `${seen.tournamentId}:${binding.currentOid}`)) rowKey = `${seen.tournamentId}:${binding.currentOid}`;
  // 2. The member id in the base season.
  let reused = false;
  let sharedNow = false;
  // A season whose roster was not read (or is short) cannot show that one row under the id is the only
  // one: its rows are never taken on the member id alone (the exact row of step 1 still is).
  let unproven = false;
  const proves = (s: SeasonData): boolean => isUsableOpid(binding.opid, s.sharedOpidSet);
  if (!rowKey && binding.opid && base) {
    const hits = rowsOf(base).filter((r) => r.opid === binding.opid);
    // Two rows under the id now: neither is chosen — a multi-season period looks for the member's own
    // earlier rows below (the base season's rows left out).
    if (hits.length > 1) sharedNow = true;
    // Someone else under the id now: not them — their own earlier rows are still looked for below.
    else if (hits.length === 1 && otherPerson(hits[0].name)) reused = true;
    else if (hits.length === 1 && !proves(base)) unproven = true;
    else if (hits.length === 1) rowKey = hits[0].key;
  }
  if (!rowKey && sharedNow && !multi) return { personKey: null, state: 'held', inBase: false, reason: 'IDを共有する選手がいるため、同一人物として扱えません' };
  // 3. Multi-season: the one person the member id belongs to in the period.
  if (!rowKey && multi && binding.opid) {
    const all = seasons.filter((s) => !(sharedNow && s === base)).flatMap((s) => rowsOf(s).filter((r) => r.opid === binding.opid && !otherPerson(r.name)).map((r) => ({ ...r, proven: proves(s) })));
    if (all.some((r) => !r.proven)) unproven = true;
    const hits = all.filter((r) => r.proven);
    const keys = new Set(hits.map((r) => links.keyOf.get(r.key) ?? r.key));
    if (keys.size > 1) return { personKey: null, state: 'held', inBase: false, reason: 'この会員IDの行が期間内で複数の人に分かれているため、本人を特定できません（本人照合の内訳を確認してください）' };
    if (keys.size === 1) rowKey = hits[0].key;
  }
  if (!rowKey && unproven) return { personKey: null, state: 'held', inBase: false, reason: 'この会員IDの行がある季の名簿を取得できず、会員IDだけでは本人を確認できません' };
  if (!rowKey && sharedNow) return { personKey: null, state: 'held', inBase: false, reason: '今季は会員IDを共有する行が複数あり、期間内の過去季でも本人を1人に確認できません' };
  if (!rowKey) return { personKey: null, state: 'unknown', inBase: false, reason: reused ? REUSED : multi ? '選択期間の名簿・成績に該当する選手を確認できません' : 'この季の成績に該当する選手を確認できません' };
  if (links.held.some((h) => h.row.key === rowKey)) return { personKey: null, state: 'held', inBase: false, reason: '本人照合が保留です（候補が複数か根拠が不足。内訳で確認できます）' };
  const personKey = links.keyOf.get(rowKey) ?? null;
  if (!personKey) return { personKey: null, state: 'unknown', inBase: false, reason: 'この季の成績に該当する選手を確認できません' };
  const inBase = !!base && base.players.some((p) => p.personKey === personKey);
  if (inBase) return { personKey, state: 'found', inBase };
  if (multi && withFigures.has(personKey)) return { personKey, state: 'found', inBase };
  return { personKey, state: multi ? 'none-period' : 'none-base', inBase, reason: multi ? '選択期間に出場記録なし' : '今季は出場記録なし' };
}
