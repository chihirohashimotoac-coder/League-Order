import type { GameFamily } from './gameKind';
import type { MetricId, StatLine } from './types';

/**
 * Metrics per competition family (§6 将来のCricket対応).
 *
 * Every metric names the family it belongs to and the raw counters it is pooled from. 01
 * counters are points and darts (`StatLine`); Cricket counters are marks and rounds — a
 * different unit that must never be added to a 01 counter. The catalog is the single place a
 * future Cricket view plugs into:
 *  1. give Cricket its own counter line (e.g. `marks`, `rounds`, `legs`, `winLegs` read from
 *     n01's Cricket fields `ca` / `cacnt` / `cM9`…`cM6`, after checking them against real
 *     data the way `realData.roles.test.ts` checks the 01 ones);
 *  2. add its metrics here with `implemented: true`;
 *  3. let `projection.ts` project Cricket games (family `cricket`) into that line.
 * Until then Cricket entries are `implemented: false` and no screen lists them; a family
 * nobody implemented never breaks the app, it simply offers no metrics.
 */

export type CounterFamily = Exclude<GameFamily, 'unknown'>;

export interface MetricDefinition {
  id: string;
  family: CounterFamily;
  label: string;
  /** How the pooled value is formed: always Σ numerator / Σ denominator over usable lines. */
  formula: string;
  implemented: boolean;
}

export const ZERO_ONE_COUNTERS = ['score', 'darts', 'f9Score', 'f9Darts', 'leg', 'winLeg', 'set', 'winSet', 'breakLegs', 'breakWins', 'ton00', 'ton40', 'ton70', 'ton80', 'highOut', 'bestLeg'] as const satisfies readonly (keyof StatLine)[];

export const METRIC_CATALOG: readonly MetricDefinition[] = [
  { id: 'ppr', family: '01', label: '3DA', formula: 'Σ得点 × 3 ÷ Σ投数', implemented: true },
  { id: 'first9', family: '01', label: 'First 9', formula: 'Σ最初の9投の得点 × 3 ÷ Σ最初の9投の投数', implemented: true },
  { id: 'legRate', family: '01', label: 'Leg勝率', formula: 'Σ勝利Leg ÷ ΣプレイLeg', implemented: true },
  { id: 'setRate', family: '01', label: 'Set勝率', formula: 'Σ勝利Set ÷ ΣプレイSet', implemented: true },
  { id: 'keep', family: '01', label: 'Keep率', formula: 'Σ(勝利Leg − Break勝利) ÷ Σ(プレイLeg − Break機会)', implemented: true },
  { id: 'break', family: '01', label: 'Break率', formula: 'ΣBreak勝利 ÷ ΣBreak機会', implemented: true },
  { id: 'ton80Rate', family: '01', label: '180', formula: 'Σ180の回数 ÷ ΣプレイLeg', implemented: true },
  // Planned. Not offered anywhere until implemented against verified Cricket counters.
  { id: 'mpr', family: 'cricket', label: 'MPR', formula: 'Σマーク ÷ Σラウンド', implemented: false },
  { id: 'cricketLegRate', family: 'cricket', label: 'Cricket Leg勝率', formula: 'Σ勝利Leg ÷ ΣプレイLeg（Cricketのみ）', implemented: false },
];

/** Metrics a screen may offer for a family. Unknown or unimplemented families offer none. */
export function implementedMetrics(family: GameFamily): MetricDefinition[] {
  if (family === 'unknown') return [];
  return METRIC_CATALOG.filter((m) => m.family === family && m.implemented);
}

/** The 01 metric ids, typed for the existing 01 pipeline. */
export function zeroOneMetricIds(): MetricId[] {
  return implementedMetrics('01').map((m) => m.id as MetricId);
}
