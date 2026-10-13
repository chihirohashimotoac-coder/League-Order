import { effectiveSlots, slotFamily } from './gameKind';
import type { RankMetric } from './format';
import { RANK_METRICS } from './format';
import type { GameScope } from './roleGames';
import type { SeasonData } from './seasonData';
import type { MetricId } from './types';

/**
 * Which metrics a game-kind view may rank, and why the others are left out. A ranking is only
 * offered when every candidate's figure has the same definition over the same games.
 */

/** Start scores of the 01 slots in force in a season (`[501, 1001]` for ATDO). */
export function startScoresOf(season: Pick<SeasonData, 'slots' | 'divisions'>): number[] {
  const divisions = season.divisions.length > 0 ? season.divisions.map((d) => d.index) : [null];
  const scores = new Set<number>();
  for (const division of divisions) {
    for (const slot of effectiveSlots(season.slots, division)) {
      if (slotFamily(slot).family === '01' && slot.startScore !== null && slot.startScore > 0) scores.add(slot.startScore);
    }
  }
  return [...scores].sort((a, b) => a - b);
}

/**
 * n01's season Best Leg has no start score attached. It is offered only when every season of
 * the period plays the same set of start scores, and is then labelled with that set.
 */
export function bestLegBasis(seasons: readonly Pick<SeasonData, 'slots' | 'divisions'>[]): { comparable: boolean; label: string } {
  const sets = seasons.map((s) => startScoresOf(s).join('/'));
  const unique = [...new Set(sets)];
  if (unique.length !== 1 || unique[0] === '') return { comparable: false, label: '開始点数の構成が季によって異なるため比較しません' };
  return { comparable: true, label: unique[0].includes('/') ? `開始点数 ${unique[0]} の区別なし（n01公式値）` : `${unique[0]}（n01公式値）` };
}

export interface ScopeMetrics {
  /** Offered in the ranking selector. */
  rank: RankMetric[];
  /** Shown as cards (a card without data says why). */
  cards: MetricId[];
  notes: string[];
}

const ALL_CARDS: MetricId[] = ['ppr', 'first9', 'legRate', 'setRate', 'keep', 'break'];

export function scopeMetrics(scope: GameScope, seasons: readonly SeasonData[], entity: 'player' | 'team'): ScopeMetrics {
  if (scope === 'all01') {
    const best = bestLegBasis(seasons);
    return {
      rank: best.comparable ? RANK_METRICS : RANK_METRICS.filter((m) => m !== 'bestLeg'),
      cards: ALL_CARDS,
      notes: best.comparable ? [] : [`Best Leg: ${best.label}`],
    };
  }
  if (scope === 'singles' || entity === 'team') {
    return { rank: ['ppr', 'legRate', 'setRate'], cards: ALL_CARDS, notes: ['First 9・Keep/Break・180等はゲーム記録に含まれないため、この表示では順位を付けません。'] };
  }
  return {
    rank: ['legRate', 'setRate'],
    cards: ALL_CARDS,
    notes: ['選手個人の3DAは全員を同じ条件で復元できないため、順位に含めません。Leg/Set勝率はペア・チームとしての結果です。'],
  };
}
