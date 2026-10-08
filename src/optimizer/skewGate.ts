import type { PlayerId, PresetKey, SkewGateReport } from '../domain/types';
import { riskValue } from '../domain/orders/presets';
import { independentGamesModel } from '../domain/prediction/matchWinProbability';
import { gameWinProbability } from '../domain/prediction/matchup';
import { sideStrength } from '../domain/prediction/teamMatchup';
import { minConfidence, type ConfidenceLevel } from '../domain/prediction/confidence';
import { mean } from '../utils/math';
import { buildAllCandidates, describeCombo, selectionSignature, type Combo } from './candidates/combinations';
import { prepare, type PreparedContext } from './prepare';
import { compareEvaluations, evaluateSelection, type Evaluation } from './scoring/score';
import { buildBoundContext } from './search/bound';
import { hardFeasible, polish } from './search/polish';
import { rerankByMatchOutcome, selectionMatchValue } from './rerank';
import { searchOnce } from './searchOnce';

/**
 * The bias gate (docs/DESIGN.md, appearance bias).
 *
 * The strength terms of 勝利優先 and 対戦相手最適化 reward giving strong players more
 * games, and the strength they read is normalised over today's participants — so a gap of
 * 0.003 Rating looked as large as a gap of twelve. That produced 2/1/1/0 over four Singles
 * for four near-identical players and 4/3/1/0 over eight. Bias towards stronger players
 * is not forbidden; it has to be earned:
 *
 *  1. The *even line-up* is found by the same engine with fairness made the dominant term
 *     (the best line-up among the most even ones the Hard conditions allow).
 *  2. A biased line-up stands only if its estimated match-outcome gain over the even one
 *     reaches `SKEW_GAIN_THRESHOLD × steps² × (1 | 1.5 for MEDIUM data)`, where `steps` is
 *     the bias in one-game shifts. Bigger biases must earn disproportionately more.
 *  3. LOW-confidence data earns nothing: no bias at all.
 *
 * The gain is measured with the order's own opponent when it has one, and otherwise
 * against an opponent as strong as our average participant — a model reference, never
 * shown as a win rate. Hard conditions need no special case: every line-up judged is
 * already Hard-feasible, and an unevenness the Hard conditions force is in the even
 * line-up too, so it is never charged as bias.
 *
 * The threshold is a provisional policy value, not a measurement; see docs/DESIGN.md.
 */

/**
 * Match-outcome gain (win + ½ draw) a one-game shift of bias must earn (HIGH-confidence
 * data; MEDIUM needs 1.5×). A provisional policy value, not a measurement. On the 40
 * replayed fixture matches (`npm run backtest`, section 3c) 0 pt still lets somebody sit
 * out in a quarter of the matches, and 2 pt is the largest value for which the worst
 * replay stays inside the backtest's long-standing −5 pt guard (3 pt does not). Real
 * leagues should calibrate it; docs/DESIGN.md (追補 v1.5 W1) has the table.
 */
export const SKEW_GAIN_THRESHOLD = 0.02;

/** Multiplier on the required gain by data confidence; `null` = no bias at all. */
export const SKEW_CONFIDENCE_FACTOR: Record<ConfidenceLevel, number | null> = {
  HIGH: 1,
  MEDIUM: 1.5,
  LOW: null,
};

/** Added to the fairness and role-fairness weights of the even-line-up search (large enough to dominate). */
export const EVEN_REFERENCE_BOOST = 100;

const GATED_PRESETS: ReadonlySet<PresetKey> = new Set(['WIN_FIRST', 'OPPONENT_OPTIMIZED', 'CUSTOM']);
const EPSILON = 1e-9;

interface ValueModel {
  basis: SkewGateReport['basis'];
  value(selection: readonly Combo[]): number;
  confidenceOf(playerIndex: number): ConfidenceLevel;
  /** Confidence of the model itself (the opponent data), before any player. */
  base: ConfidenceLevel;
}

function valueModel(ctx: PreparedContext): ValueModel | null {
  // The order's own opponent, whenever it has one — whichever preset is being run.
  if (ctx.opponent) {
    const opponent = ctx.opponent;
    return {
      basis: 'opponent',
      value: (selection) => selectionMatchValue(ctx, selection),
      confidenceOf: (pi) => opponent.players[ctx.playerIds[pi]]?.confidence ?? 'LOW',
      base: opponent.confidence,
    };
  }

  // No opponent: an opponent as strong as our average participant, in PPR — the metric
  // the game-win model was calibrated on. Without PPR there is nothing to measure.
  const strengths = ctx.playerIds.map((id) => ctx.pprs.effective.get(id) ?? null);
  if (ctx.pprs.knownCount === 0 || strengths.some((value) => value === null)) return null;
  const ppr = strengths as number[];
  const reference = mean(ppr);
  const evidence = ctx.input.strengthBasis?.players;
  return {
    basis: 'reference',
    value: (selection) => {
      const probabilities = selection.map((combo, gi) => {
        const members = combo.members;
        let bonus = 0;
        let pairs = 0;
        for (let i = 0; i < members.length; i += 1) {
          for (let j = i + 1; j < members.length; j += 1) {
            bonus += ctx.pairBonusPpr[members[i]][members[j]];
            pairs += 1;
          }
        }
        const side = sideStrength(
          members.map((pi) => ppr[pi]),
          pairs > 0 ? bonus / pairs : 0,
        );
        const game = ctx.games[gi];
        return gameWinProbability(side, reference, {
          legsToWin: game.n01?.limitLegCount ?? null,
          cricket: game.kinds.includes('CRICKET'),
        });
      });
      return riskValue(independentGamesModel.outcome(probabilities));
    },
    // Hand-typed numbers and imputed values are LOW; only synced data can be MEDIUM or HIGH.
    confidenceOf: (pi) => (ctx.pprs.imputed.has(ctx.playerIds[pi]) ? 'LOW' : (evidence?.[ctx.playerIds[pi]]?.confidence ?? 'LOW')),
    base: 'HIGH',
  };
}

/** The gain a bias of `steps` one-game shifts must earn, or `null` when no bias is allowed. */
export function requiredGain(steps: number, confidence: ConfidenceLevel, threshold = SKEW_GAIN_THRESHOLD): number | null {
  const factor = SKEW_CONFIDENCE_FACTOR[confidence];
  return factor === null ? null : threshold * steps * steps * factor;
}

/** How uneven a line-up is: the larger of the appearance excess and the role excess. */
function unevenness(evaluation: Evaluation): number {
  return Math.max(evaluation.fairness.excess, evaluation.roleFairness.totalExcess);
}

function countsById(ctx: PreparedContext, evaluation: Evaluation): Record<PlayerId, number> {
  return Object.fromEntries(ctx.playerIds.map((id, index) => [id, evaluation.counts[index]]));
}

interface Reference {
  selection: Combo[];
  exhaustive: boolean;
}

/**
 * The most even line-up the Hard conditions allow (best of the rest by the run's own terms).
 *
 * `excluded` (line-ups already shown as other candidates) is for the line-up the gate may
 * *choose*; the line-up it *judges against* is searched with an empty set, because a
 * comparison base does not have to be a new order. `searchPastExcluded` lets this search
 * go on to the branch and bound when the beam holds nothing but excluded line-ups.
 */
export function searchEvenReference(
  ctx: PreparedContext,
  excluded: ReadonlySet<string>,
  timeLimitMs: number,
  searchPastExcluded = false,
): Reference | null {
  const weights = ctx.input.weights;
  const evenCtx = prepare({
    ...ctx.input,
    weights: {
      ...weights,
      fairness: weights.fairness + EVEN_REFERENCE_BOOST,
      roleFairness: weights.roleFairness + EVEN_REFERENCE_BOOST,
    },
  });
  const candidates = buildAllCandidates(evenCtx);
  if (candidates.some((entry) => entry.combos.length === 0)) return null;
  const found = searchOnce(
    evenCtx,
    buildBoundContext(evenCtx, candidates),
    candidates,
    Math.max(60, Math.floor(timeLimitMs * 0.4)),
    excluded,
    searchPastExcluded,
  );
  if (!found) return null;
  // Among the even line-ups the opponent-aware run picks by estimated match outcome too,
  // so the even line-up it is judged against is the best even one by the same measure.
  // Only line-ups as even as the most even one found take part: the re-ranking tolerance is
  // a share of the whole score span, and in a big format it can be wider than one step of
  // role evenness, which would let match value buy unevenness into the "even" base.
  let selection = found.selection;
  if ((evenCtx.weights.opponentWin ?? 0) > 0 && evenCtx.opponent) {
    const all = [...found.pool, ...(found.dfsBest ? [found.dfsBest] : []), found.selection].map((candidate) => ({
      selection: candidate,
      evaluation: evaluateSelection(evenCtx, candidate),
    }));
    const floor = Math.min(...all.map((entry) => unevenness(entry.evaluation)));
    const level = all.filter((entry) => unevenness(entry.evaluation) <= floor + EPSILON);
    const anchor = level.reduce((winner, entry) => (compareEvaluations(entry, winner) < 0 ? entry : winner));
    const reranked = rerankByMatchOutcome(
      evenCtx,
      level.map((entry) => entry.selection),
      anchor.evaluation,
    );
    selection = reranked ? reranked.selection : anchor.selection;
  }
  // The same people index the same way in both contexts; only the weights differ.
  return {
    selection: selection.map((combo, gi) => describeCombo(ctx, gi, combo.members)),
    exhaustive: found.exhaustive,
  };
}

export interface GateInput {
  ctx: PreparedContext;
  presetKey: PresetKey;
  best: { selection: Combo[]; evaluation: Evaluation };
  /** Other complete line-ups the search produced (beam, branch and bound, rerank). */
  pool: readonly Combo[][];
  excluded: ReadonlySet<string>;
  timeLimitMs: number;
}

export interface GateOutcome {
  selection: Combo[];
  evaluation: Evaluation;
  /** `undefined` when there was nothing to judge (the best line-up is as even as any). */
  report?: SkewGateReport;
  /** The even-line-up search finished (true when none was needed). */
  exhaustive: boolean;
  /** The line-up differs from the best-by-score one. */
  changed: boolean;
}

interface Judged {
  selection: Combo[];
  evaluation: Evaluation;
  steps: number;
  gain: number;
  required: number | null;
  confidence: ConfidenceLevel;
  pass: boolean;
}

/** Reads the verdict out of a line-up judged against the even one (see {@link SkewGateReport}). */
function reportOf(
  ctx: PreparedContext,
  outcome: SkewGateReport['outcome'],
  basis: SkewGateReport['basis'],
  even: Evaluation | null,
  biased: Judged,
): SkewGateReport {
  return {
    outcome,
    basis,
    gain: biased.gain,
    required: biased.required,
    steps: biased.steps,
    confidence: biased.confidence,
    evenCounts: even ? countsById(ctx, even) : {},
    biasedCounts: countsById(ctx, biased.evaluation),
  };
}

export function applySkewGate(input: GateInput): GateOutcome {
  const { ctx, best } = input;
  const unchanged: GateOutcome = { selection: best.selection, evaluation: best.evaluation, exhaustive: true, changed: false };
  const threshold = ctx.input.settings.skewGainThreshold === undefined ? SKEW_GAIN_THRESHOLD : ctx.input.settings.skewGainThreshold;
  if (threshold === null || !GATED_PRESETS.has(input.presetKey) || unevenness(best.evaluation) <= EPSILON) return unchanged;

  // The line-up judged against needs no new order, so the shown ones do not exclude it.
  const reference = searchEvenReference(ctx, new Set(), input.timeLimitMs);
  const unverified = (even: Evaluation | null, exhaustive = false): GateOutcome => {
    // No even line-up to judge against (or none the gate may show): the bias is neither
    // justified nor refuted. It is reported as unjudged and the search as unfinished.
    const steps = even ? Math.max(0, unevenness(best.evaluation) - unevenness(even)) / 2 : 0;
    const judged: Judged = { selection: best.selection, evaluation: best.evaluation, steps, gain: 0, required: null, confidence: 'LOW', pass: false };
    return { ...unchanged, exhaustive, report: reportOf(ctx, 'unverified', valueModel(ctx)?.basis ?? 'reference', even, judged) };
  };
  if (!reference) return unverified(null);
  const referenceEvaluation = evaluateSelection(ctx, reference.selection);
  const referenceUnevenness = unevenness(referenceEvaluation);
  // The best line-up is already as even as the Hard conditions allow: nothing to judge.
  if (unevenness(best.evaluation) <= referenceUnevenness + EPSILON) {
    return { ...unchanged, exhaustive: reference.exhaustive };
  }

  const model = valueModel(ctx);
  const referenceValue = model ? model.value(reference.selection) : 0;

  const judge = (selection: Combo[], evaluation: Evaluation): Judged => {
    const steps = Math.max(0, unevenness(evaluation) - referenceUnevenness) / 2;
    if (steps <= EPSILON) {
      return { selection, evaluation, steps: 0, gain: 0, required: 0, confidence: 'HIGH', pass: true };
    }
    if (!model) return { selection, evaluation, steps, gain: 0, required: null, confidence: 'LOW', pass: false };
    let confidence = model.base;
    // Everyone whose games differ from the even line-up — in total or inside a role — is
    // part of the bias, so the bias is only as believable as the data on all of them.
    for (let pi = 0; pi < ctx.playerCount; pi += 1) {
      const differs =
        evaluation.counts[pi] !== referenceEvaluation.counts[pi] ||
        evaluation.roleCounts.some((counts, group) => counts[pi] !== referenceEvaluation.roleCounts[group][pi]);
      if (differs) confidence = minConfidence(confidence, model.confidenceOf(pi));
    }
    const gain = model.value(selection) - referenceValue;
    const required = requiredGain(steps, confidence, threshold);
    return { selection, evaluation, steps, gain, required, confidence, pass: required !== null && gain >= required - 1e-12 };
  };

  const judged: Judged[] = [];
  const seen = new Set<string>();
  const consider = (selection: Combo[], evaluation?: Evaluation): void => {
    if (selection.length !== ctx.gameCount) return;
    const key = selectionSignature(ctx, selection);
    if (seen.has(key) || input.excluded.has(key)) return;
    seen.add(key);
    if (!hardFeasible(ctx, selection)) return;
    judged.push(judge(selection, evaluation ?? evaluateSelection(ctx, selection)));
  };
  consider(reference.selection, referenceEvaluation);
  consider(best.selection, best.evaluation);
  for (const selection of input.pool) consider(selection);

  let passing = judged.filter((entry) => entry.pass);
  let exhaustive = reference.exhaustive;
  if (passing.length === 0) {
    // The even line-up judged against is one that is already shown as another candidate,
    // and nothing else in the pool is as even: look for another even one that may be shown.
    const alternative = searchEvenReference(ctx, input.excluded, input.timeLimitMs, true);
    if (alternative) {
      exhaustive = exhaustive && alternative.exhaustive;
      consider(alternative.selection);
      passing = judged.filter((entry) => entry.pass);
    }
  }
  // Still nothing the gate could stand behind: say so, rather than present the bias as checked.
  if (passing.length === 0) return unverified(referenceEvaluation);
  let chosen = passing.reduce((winner, entry) =>
    compareEvaluations(entry, winner) < 0 ? entry : winner,
  );
  const rejectedBest = judged.find((entry) => entry.selection === best.selection);

  // The search pool may not hold every justified step between the even line-up and a
  // bias that is too large: climb from the chosen line-up, one move at a time, taking
  // only moves that still pass the gate and still raise the score.
  const climbed = polish(
    ctx,
    chosen.selection,
    performance.now() + Math.max(40, input.timeLimitMs * 0.2),
    input.excluded,
    12,
    (selection, evaluation) => judge(selection, evaluation).pass,
    // An opponent-aware run is after the estimated match outcome, so that is what the
    // admissible moves raise; every other run keeps raising its own score.
    model?.basis === 'opponent' && (ctx.weights.opponentWin ?? 0) > 0 ? (selection) => model.value(selection) : undefined,
  );
  if (climbed.improved) chosen = judge(climbed.selection, climbed.evaluation);

  const biased = chosen.steps > EPSILON ? chosen : rejectedBest;
  const report: SkewGateReport | undefined = biased
    ? reportOf(ctx, chosen.steps > EPSILON ? 'kept' : 'replaced', model?.basis ?? 'reference', referenceEvaluation, biased)
    : undefined;

  return {
    selection: chosen.selection,
    evaluation: chosen.evaluation,
    report,
    exhaustive,
    changed: chosen.selection !== best.selection,
  };
}
