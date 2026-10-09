import type { MetricId, Ratio } from './types';

/** Labels and number formats shared by every analytics screen. */
export type RankMetric = MetricId | 'bestLeg';

export const METRIC_LABEL: Record<RankMetric, string> = {
  ppr: '3DA',
  first9: 'First 9',
  legRate: 'Leg勝率',
  setRate: 'Set勝率',
  keep: 'Keep率',
  break: 'Break率',
  ton00Rate: '100+',
  ton40Rate: '140+',
  ton70Rate: '170+',
  ton80Rate: '180',
  bestLeg: 'Best Leg',
};

/** The metrics offered in rankings, in display order. */
export const RANK_METRICS: RankMetric[] = ['ppr', 'first9', 'legRate', 'setRate', 'keep', 'break', 'ton80Rate', 'bestLeg'];

/** 3DA and First 9 are points; Best Leg is darts; the rest are shares of legs / sets. */
export function formatValue(metric: RankMetric, value: number | null): string {
  if (value === null || !Number.isFinite(value)) return '—';
  if (metric === 'ppr' || metric === 'first9') return value.toFixed(2);
  if (metric === 'bestLeg') return `${value}本`;
  if (metric === 'ton00Rate' || metric === 'ton40Rate' || metric === 'ton70Rate' || metric === 'ton80Rate') return `${(value * 100).toFixed(1)}%`;
  return `${(value * 100).toFixed(1)}%`;
}

export function formatRatio(metric: MetricId, ratio: Ratio): string {
  return formatValue(metric, ratio.value);
}

/** What the denominator behind a metric counts. */
export const SAMPLE_UNIT: Record<RankMetric, string> = {
  ppr: 'ダーツ',
  first9: '投(First 9)',
  legRate: 'Leg',
  setRate: 'Set',
  keep: 'Leg',
  break: 'Leg',
  ton00Rate: 'Leg',
  ton40Rate: 'Leg',
  ton70Rate: 'Leg',
  ton80Rate: 'Leg',
  bestLeg: '',
};

export function formatSample(metric: RankMetric, sample: number): string {
  return metric === 'bestLeg' ? '' : `${sample.toLocaleString('ja-JP')}${SAMPLE_UNIT[metric]}`;
}

export function formatDateTime(epochMs: number): string {
  const d = new Date(epochMs + 9 * 60 * 60 * 1000);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}/${pad(d.getUTCMonth() + 1)}/${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}
