import type { FairnessScope, OptimizerSettings, PresetKey, ScoreWeights } from '../types';

/**
 * Preset weights (docs/DESIGN.md §7.5).
 *
 * `fairness` is deliberately never 0 — even the win-first preset keeps a meaningful
 * fairness pull, which together with the hard max-appearance cap prevents unbounded
 * bias toward the strongest players (spec §11, §32).
 *
 * The three compared presets differ in character, not just in degree (追補 v1.3 §V4):
 * win-first lets a clearly stronger player take one extra game and two Singles; balanced
 * keeps the totals even and limits Singles concentration; fairness-first minimises the
 * total spread, role concentration and consecutive runs.
 */
export interface PresetDefinition {
  key: PresetKey;
  label: string;
  description: string;
  weights: ScoreWeights;
  /** Preset-recommended fairness scope. */
  scope: FairnessScope;
}

export const PRESETS: Record<Exclude<PresetKey, 'CUSTOM'>, PresetDefinition> = {
  /**
   * Maximises the estimated chance of winning the match against the predicted opponent
   * (docs/OPPONENT_OPTIMIZER.md). Fairness, role spread and consecutive runs are kept at
   * the バランス level as soft terms — the estimated win probability replaces most of the
   * raw strength term, not the fairness — so the search never "wins" by giving the
   * strongest player every game while others sit out. Only offered with opponent data;
   * without it the run falls back to 勝利優先.
   */
  OPPONENT_OPTIMIZED: {
    key: 'OPPONENT_OPTIMIZED',
    label: '対戦相手最適化',
    description: '次戦の相手の出場予測に対して、推定 Match 勝率が最も高くなるオーダーを探します。公平性・連続出場も考慮します。',
    weights: { strength: 0.3, gameFit: 0.45, pairFit: 0.35, fairness: 0.9, roleFairness: 0.3, novelty: 0, consecutive: 0.5, season: 0.05, opponentWin: 2.4 },
    scope: 'today',
  },
  WIN_FIRST: {
    key: 'WIN_FIRST',
    label: '勝利優先',
    description: 'Rating・PPR と適性を最重視。強い選手の +1 試合は許容しますが、Singles の独占や誰かの 0 出場は避けます。',
    weights: { strength: 1, gameFit: 0.8, pairFit: 0.35, fairness: 0.25, roleFairness: 0.18, novelty: 0, consecutive: 0.35, season: 0.05 },
    scope: 'today',
  },
  BALANCED: {
    key: 'BALANCED',
    label: 'バランス',
    description: '戦力と出場機会の均等を両立させます。Singles などの集中も抑えます。',
    weights: { strength: 0.6, gameFit: 0.5, pairFit: 0.4, fairness: 0.9, roleFairness: 0.3, novelty: 0.05, consecutive: 0.5, season: 0.25 },
    scope: 'today',
  },
  FAIRNESS_FIRST: {
    key: 'FAIRNESS_FIRST',
    label: '公平性優先',
    description: '出場回数・役割 (Singles 等) の分担・連続出場の均等化を最優先します。',
    weights: { strength: 0.15, gameFit: 0.15, pairFit: 0.2, fairness: 2, roleFairness: 1.6, novelty: 0.05, consecutive: 0.9, season: 0.5 },
    scope: 'today',
  },
  DEVELOPMENT: {
    key: 'DEVELOPMENT',
    label: '育成重視',
    description: 'シーズン累計の出場が少ない選手を優先的に起用します。',
    weights: { strength: 0.15, gameFit: 0.25, pairFit: 0.3, fairness: 1.2, roleFairness: 0.6, novelty: 0.1, consecutive: 0.5, season: 1.4 },
    scope: 'season',
  },
  NEW_PAIR: {
    key: 'NEW_PAIR',
    label: '新ペア試行',
    description: '過去に組んだ回数が少ないペアを優先します。',
    weights: { strength: 0.4, gameFit: 0.4, pairFit: 0.3, fairness: 0.8, roleFairness: 0.5, novelty: 1.2, consecutive: 0.5, season: 0.2 },
    scope: 'today',
  },
};

export const DEFAULT_WEIGHTS: ScoreWeights = PRESETS.BALANCED.weights;

export function weightsForPreset(preset: PresetKey, custom: ScoreWeights): ScoreWeights {
  if (preset === 'CUSTOM') return { ...custom };
  return { ...PRESETS[preset].weights };
}

export function scopeForPreset(preset: PresetKey, fallback: FairnessScope): FairnessScope {
  if (preset === 'CUSTOM') return fallback;
  return PRESETS[preset].scope;
}

export const DEFAULT_OPTIMIZER_SETTINGS: OptimizerSettings = {
  defaultMaxConsecutive: 2,
  consecutiveMode: 'soft',
  minAppearanceMode: 'hard',
  fairnessScope: 'today',
  timeLimitMs: 1200,
  nodeLimit: 300_000,
  maxCombosPerGame: 400,
  beamWidth: 48,
};

/** The three candidate presets compared side by side in the result screen (spec §18). */
export const CANDIDATE_PRESETS: Exclude<PresetKey, 'CUSTOM'>[] = [
  'WIN_FIRST',
  'BALANCED',
  'FAIRNESS_FIRST',
];

/** Candidates compared when the opponent-optimised preset is chosen (MASTER SPEC Phase 4 §7). */
export const OPPONENT_CANDIDATE_PRESETS: Exclude<PresetKey, 'CUSTOM'>[] = [
  'OPPONENT_OPTIMIZED',
  'WIN_FIRST',
  'BALANCED',
  'FAIRNESS_FIRST',
];

/**
 * How much of the opponent weight is kept for a given data confidence (Phase 4 §8):
 * an uncertain prediction never gets to steer the whole order.
 */
export const CONFIDENCE_WEIGHT_FACTOR: Record<'HIGH' | 'MEDIUM' | 'LOW', number> = {
  HIGH: 1,
  MEDIUM: 0.7,
  LOW: 0.35,
};

/**
 * Risk attitude for opponent optimisation (Phase 4 §5). Only NEUTRAL is used today; the
 * others exist so the ranking can be switched without touching the search.
 *
 * - NEUTRAL: P(win) + ½ P(draw)
 * - CONSERVATIVE: P(not losing)
 * - AGGRESSIVE: P(win) only
 */
export type OpponentRiskMode = 'CONSERVATIVE' | 'NEUTRAL' | 'AGGRESSIVE';
export const DEFAULT_RISK_MODE: OpponentRiskMode = 'NEUTRAL';

export function riskValue(outcome: { win: number; draw: number }, mode: OpponentRiskMode = DEFAULT_RISK_MODE): number {
  if (mode === 'AGGRESSIVE') return outcome.win;
  if (mode === 'CONSERVATIVE') return outcome.win + outcome.draw;
  return outcome.win + 0.5 * outcome.draw;
}
