import type { FairnessScope, OptimizerSettings, PresetKey, ScoreWeights } from '../types';

/**
 * Preset weights (docs/DESIGN.md §7.5).
 *
 * `fairness` is deliberately never 0 — even the win-first preset keeps a meaningful
 * fairness pull, which together with the hard max-appearance cap prevents unbounded
 * bias toward the strongest players (spec §11, §32).
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
  WIN_FIRST: {
    key: 'WIN_FIRST',
    label: '勝利優先',
    description: 'Rating と適性を最重視。公平性も完全には無視しません。',
    weights: { strength: 1, gameFit: 0.8, pairFit: 0.35, fairness: 0.4, novelty: 0, consecutive: 0.4, season: 0.1 },
    scope: 'today',
  },
  BALANCED: {
    key: 'BALANCED',
    label: 'バランス',
    description: '戦力と出場機会の均等を両立させます。',
    weights: { strength: 0.6, gameFit: 0.5, pairFit: 0.4, fairness: 0.9, novelty: 0.05, consecutive: 0.5, season: 0.25 },
    scope: 'today',
  },
  FAIRNESS_FIRST: {
    key: 'FAIRNESS_FIRST',
    label: '公平性優先',
    description: '出場回数の均等化を最優先します。',
    weights: { strength: 0.2, gameFit: 0.2, pairFit: 0.25, fairness: 2, novelty: 0.05, consecutive: 0.6, season: 0.5 },
    scope: 'today',
  },
  DEVELOPMENT: {
    key: 'DEVELOPMENT',
    label: '育成重視',
    description: 'シーズン累計の出場が少ない選手を優先的に起用します。',
    weights: { strength: 0.15, gameFit: 0.25, pairFit: 0.3, fairness: 1.2, novelty: 0.1, consecutive: 0.5, season: 1.4 },
    scope: 'season',
  },
  NEW_PAIR: {
    key: 'NEW_PAIR',
    label: '新ペア試行',
    description: '過去に組んだ回数が少ないペアを優先します。',
    weights: { strength: 0.4, gameFit: 0.4, pairFit: 0.3, fairness: 0.8, novelty: 1.2, consecutive: 0.5, season: 0.2 },
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
