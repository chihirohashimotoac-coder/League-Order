import type {
  GameAssignment,
  GenerateResult,
  OrderInput,
  OrderMetrics,
  OrderSolution,
  OrderWarning,
  PlayerId,
  PlayerTally,
  PresetKey,
  ScoreBreakdown,
  ScoreWeights,
  SolutionMeta,
} from '../domain/types';
import { CANDIDATE_PRESETS, PRESETS } from '../domain/orders/presets';
import { round } from '../utils/math';
import {
  buildAllCandidates,
  describeCombo,
  selectionSignature,
  type Combo,
  type GameCandidates,
} from './candidates/combinations';
import { validateHardConstraints, type HardViolation } from './constraints/validate';
import { analyseRelaxations, precheck } from './diagnose';
import { prepare, type PreparedContext } from './prepare';
import { buildExplanation } from './scoring/explain';
import { compareEvaluations, evaluateSelection, type Evaluation } from './scoring/score';
import { beamSearch } from './search/beam';
import { buildBoundContext, type BoundContext } from './search/bound';
import { dfsSearch } from './search/dfs';
import { polish } from './search/polish';

/**
 * Order generation entry point (docs/DESIGN.md §6).
 *
 * The module touches nothing outside its input: no DOM, no storage, no randomness. Every
 * choice it makes — candidate order, tie-breaks, pruning — is a function of the input
 * alone, so the hard-constraint invariants hold on every run.
 *
 * Reproducibility is narrower than that, and it is worth being exact about. The search is
 * bounded by a wall-clock deadline. When it finishes inside that budget the solution is
 * marked `exhaustive` and is the optimum of a deterministically built candidate set, so
 * the same input always yields the same output. When the budget cuts the search short,
 * the result is the best found *so far*, and how far it got depends on the CPU the run
 * actually received: two runs of the same input on a loaded machine can stop at different
 * points and return different — equally valid, equally constraint-respecting — orders.
 *
 * `SolutionMeta.exhaustive` is what distinguishes the two cases, and the UI surfaces it
 * ("全探索完了" against "時間内の最良解") so a captain is never told an order is optimal
 * when it is merely the best one the clock allowed.
 */

export interface GenerateOptions {
  /** How many alternative candidates to return (spec §18). */
  candidateCount?: number;
  /** Overrides the per-run time budget (ms). */
  timeLimitMs?: number;
  /** Skip the alternative-preset candidates and return only the requested weights. */
  singleCandidate?: boolean;
}

interface RunOutcome {
  selection: Combo[];
  evaluation: Evaluation;
  meta: SolutionMeta;
}

function runOnce(
  ctx: PreparedContext,
  bctx: BoundContext,
  candidates: readonly GameCandidates[],
  label: string,
  presetKey: PresetKey,
  timeLimitMs: number,
  excluded: ReadonlySet<string>,
): RunOutcome | null {
  const started = performance.now();
  const deadline = started + timeLimitMs;

  // Stage 2 first: a strong incumbent makes the branch-and-bound prune hard.
  const beam = beamSearch(ctx, bctx, candidates, {
    width: Math.max(1, ctx.input.settings.beamWidth),
    deadline: started + timeLimitMs * 0.35,
  });
  if (!beam.feasible || beam.solutions.length === 0) return null;

  // Line-ups already returned as other candidates are not eligible again, so each
  // candidate the captain compares is genuinely a different order.
  const pool =
    excluded.size === 0
      ? beam.solutions
      : beam.solutions.filter((solution) => !excluded.has(selectionSignature(ctx, solution)));
  if (pool.length === 0) return null;

  let bestSelection = pool[0];
  let bestEvaluation = evaluateSelection(ctx, bestSelection);
  let stage: SolutionMeta['stage'] = 'beam';

  for (const solution of pool.slice(1)) {
    const evaluation = evaluateSelection(ctx, solution);
    if (
      compareEvaluations({ selection: solution, evaluation }, { selection: bestSelection, evaluation: bestEvaluation }) < 0
    ) {
      bestSelection = solution;
      bestEvaluation = evaluation;
    }
  }

  // Stage 1: branch and bound, seeded with the beam incumbent.
  const dfs = dfsSearch(ctx, bctx, candidates, {
    deadline,
    nodeLimit: ctx.input.settings.nodeLimit,
    incumbent: bestEvaluation.breakdown.total,
    fairnessUrgency: ctx.weights.fairness,
    excluded,
  });
  if (dfs.best) {
    const evaluation = evaluateSelection(ctx, dfs.best);
    if (evaluation.breakdown.total > bestEvaluation.breakdown.total) {
      bestSelection = dfs.best;
      bestEvaluation = evaluation;
      stage = 'dfs';
    }
  }

  // Stage 3: deterministic local improvement.
  const polished = polish(
    ctx,
    bestSelection,
    Math.max(deadline, performance.now() + 60),
    excluded,
  );
  if (polished.improved && polished.evaluation.breakdown.total > bestEvaluation.breakdown.total) {
    bestSelection = polished.selection;
    bestEvaluation = polished.evaluation;
    stage = stage === 'dfs' ? 'dfs+polish' : 'beam+polish';
  }

  return {
    selection: bestSelection,
    evaluation: bestEvaluation,
    meta: {
      stage,
      exhaustive: dfs.exhaustive && candidates.every((entry) => entry.complete),
      nodesVisited: dfs.nodes,
      elapsedMs: round(performance.now() - started, 1),
      label,
      presetKey,
    },
  };
}

/** Turns a member-set selection into slot-ordered assignments, honouring locks. */
export function materialise(ctx: PreparedContext, selection: readonly Combo[]): GameAssignment[] {
  return selection.map((combo, gi) => {
    const game = ctx.games[gi];
    const slots = new Array<string | undefined>(game.playerCount).fill(undefined);
    const locks = ctx.locksByGame[gi];

    // Locked slots first.
    const placed = new Set<number>();
    for (let slot = 0; slot < slots.length; slot += 1) {
      const pi = locks[slot];
      if (pi === undefined) continue;
      slots[slot] = ctx.playerIds[pi];
      placed.add(pi);
    }
    // Remaining members fill the remaining slots in ascending player order.
    const rest = combo.members.filter((pi) => !placed.has(pi));
    let cursor = 0;
    for (let slot = 0; slot < slots.length; slot += 1) {
      if (slots[slot] !== undefined) continue;
      slots[slot] = ctx.playerIds[rest[cursor]];
      cursor += 1;
    }
    return { gameId: game.id, playerIds: slots.filter((id): id is string => id !== undefined) };
  });
}

function buildTallies(ctx: PreparedContext, evaluation: Evaluation): PlayerTally[] {
  return ctx.playerIds.map((playerId, pi) => {
    const player = ctx.players[pi];
    const countByKind: PlayerTally['countByKind'] = {};
    for (const gameIndex of evaluation.appearances[pi]) {
      for (const kind of ctx.games[gameIndex].kinds) {
        countByKind[kind] = (countByKind[kind] ?? 0) + 1;
      }
    }
    const indices = evaluation.appearances[pi];
    let maxRun = 0;
    let run = 0;
    for (let i = 0; i < indices.length; i += 1) {
      run = i > 0 && indices[i] === indices[i - 1] + 1 ? run + 1 : 1;
      if (run > maxRun) maxRun = run;
    }
    return {
      playerId,
      count: evaluation.counts[pi],
      seasonBefore: player.seasonAppearances,
      seasonTotal: player.seasonAppearances + evaluation.counts[pi],
      effectiveRating: ctx.ratings.effective.get(playerId) ?? null,
      ratingImputed: ctx.ratings.imputed.has(playerId),
      effectivePpr: ctx.pprs.effective.get(playerId) ?? null,
      pprImputed: ctx.pprs.imputed.has(playerId),
      maxConsecutive: maxRun,
      countByKind,
    };
  });
}

function buildMetrics(ctx: PreparedContext, evaluation: Evaluation): OrderMetrics {
  return {
    totalSlots: ctx.totalSlots,
    participantCount: ctx.playerCount,
    appearanceSpread: evaluation.fairness.spread,
    appearanceStdDev: round(evaluation.fairness.stdDev),
    fairnessExcess: round(evaluation.fairness.excess, 4),
    maxConsecutive: evaluation.maxConsecutive,
    averageRating: evaluation.averageRating === null ? null : round(evaluation.averageRating, 2),
    averagePpr: evaluation.averagePpr === null ? null : round(evaluation.averagePpr, 2),
    hasImputedRating: ctx.ratings.imputed.size > 0,
    strengthWeights: { ...ctx.strengthWeights },
    discipline: ctx.discipline,
    maxRoleConcentration: evaluation.roleFairness.maxConcentration,
  };
}

function buildWarnings(
  ctx: PreparedContext,
  evaluation: Evaluation,
  candidates: readonly GameCandidates[],
  meta: SolutionMeta,
): OrderWarning[] {
  const warnings: OrderWarning[] = [];

  if (evaluation.fairness.spread > 1) {
    warnings.push({
      severity: 'warning',
      code: 'SPREAD_OVER_ONE',
      message: `出場回数の最大差が ${evaluation.fairness.spread} です。絶対条件 (出場不可・最大出場回数・ロック)、または方針の重み付け (勝利優先の戦力重視など) により完全な均等化はしていません。`,
    });
  }
  if (evaluation.consecutiveExcessTotal > 0) {
    warnings.push({
      severity: 'warning',
      code: 'CONSECUTIVE_OVER',
      message: `最大連続出場の上限超過が ${evaluation.consecutiveExcessTotal} 箇所あります (設定は Soft のため配置は有効です)。`,
    });
  }
  const { rating: ratingShare, ppr: pprShare } = ctx.strengthWeights;
  if (ratingShare + pprShare <= 0) {
    warnings.push({
      severity: 'info',
      code: 'NO_RATING',
      message:
        ctx.ratings.knownCount === 0 && ctx.pprs.knownCount === 0
          ? 'Rating・PPR が 1 名も入力されていないため、戦力評価は使用していません (適性と公平性で生成しました)。'
          : 'Rating・PPR が参加者全員で同じ値のため、戦力に差が付かず戦力評価は使用していません (適性と公平性で生成しました)。',
    });
  } else {
    if (ratingShare > 0 && ctx.ratings.imputed.size > 0) {
      warnings.push({
        severity: 'info',
        code: 'RATING_IMPUTED',
        message: `Rating 未入力 ${ctx.ratings.imputed.size} 名は 0 ではなく参加者の中央値で評価しています。`,
      });
    }
    if (pprShare > 0 && ctx.pprs.imputed.size > 0) {
      warnings.push({
        severity: 'info',
        code: 'PPR_IMPUTED',
        message: `PPR 未入力 ${ctx.pprs.imputed.size} 名は 0 ではなく参加者の中央値で評価しています。`,
      });
    }
  }
  for (let pi = 0; pi < ctx.playerCount; pi += 1) {
    if (
      ctx.input.settings.minAppearanceMode === 'soft' &&
      evaluation.counts[pi] < ctx.minAppearances[pi]
    ) {
      warnings.push({
        severity: 'warning',
        code: 'MIN_UNMET_SOFT',
        playerId: ctx.playerIds[pi],
        message: `${ctx.players[pi].name}: 最小出場回数 ${ctx.minAppearances[pi]} に届いていません (${evaluation.counts[pi]} 回)。`,
      });
    }
  }
  if (!meta.exhaustive) {
    const capped = candidates.filter((entry) => !entry.complete).length;
    warnings.push({
      severity: 'info',
      code: 'NOT_EXHAUSTIVE',
      message:
        capped > 0
          ? `探索空間が大きいため ${capped} ゲームで候補を間引きました。最良解である保証はありません (時間上限 ${ctx.input.settings.timeLimitMs}ms)。`
          : `時間上限に達したため全探索は完了していません。表示中の案は時間内の最良解です。`,
    });
  }
  return warnings;
}

function roundScore(breakdown: ScoreBreakdown): ScoreBreakdown {
  return {
    strength: round(breakdown.strength),
    gameFit: round(breakdown.gameFit),
    pairFit: round(breakdown.pairFit),
    fairness: round(breakdown.fairness),
    roleFairness: breakdown.roleFairness === undefined ? undefined : round(breakdown.roleFairness),
    novelty: round(breakdown.novelty),
    consecutivePenalty: round(breakdown.consecutivePenalty),
    seasonImbalance: round(breakdown.seasonImbalance),
    total: round(breakdown.total, 4),
    display: round(breakdown.display, 1),
  };
}

function assembleSolution(
  ctx: PreparedContext,
  bctx: BoundContext,
  candidates: readonly GameCandidates[],
  outcome: RunOutcome,
  /**
   * Scoring context for the weights the *captain* chose. Each candidate is generated
   * under its own preset's weights, so reporting each one's score under those weights
   * would make the comparison screen meaningless (a fairness-first line-up would always
   * look best on its own scale). The reported total is therefore always measured against
   * the captain's weights; the individual components are weight-independent.
   */
  referenceCtx: PreparedContext,
): OrderSolution | null {
  const assignments = materialise(ctx, outcome.selection);
  const violations = validateHardConstraints(ctx.input, assignments);
  if (violations.length > 0) return null;

  const comparable = evaluateSelection(referenceCtx, outcome.selection);

  return {
    assignments,
    tallies: buildTallies(ctx, outcome.evaluation),
    score: roundScore(comparable.breakdown),
    metrics: buildMetrics(ctx, outcome.evaluation),
    explanation: buildExplanation(ctx, bctx, outcome.selection, outcome.evaluation),
    warnings: buildWarnings(ctx, outcome.evaluation, candidates, outcome.meta),
    meta: outcome.meta,
  };
}

/**
 * When an already-shown line-up scores at least as well under this run's weights as the
 * run's own result, the preset's optimum *is* that line-up: the run only produced a
 * different order because shown line-ups are excluded. Returns the earliest such label.
 */
function bestShownLineUp(
  ctx: PreparedContext,
  shown: readonly { label: string; members: PlayerId[][] }[],
  achieved: number,
): string | undefined {
  for (const entry of shown) {
    const selection: Combo[] = [];
    let valid = entry.members.length === ctx.gameCount;
    for (let gi = 0; valid && gi < ctx.gameCount; gi += 1) {
      const members = entry.members[gi].map((id) => ctx.playerIndex.get(id));
      if (members.some((pi) => pi === undefined)) {
        valid = false;
        break;
      }
      selection.push(describeCombo(ctx, gi, (members as number[]).sort((a, b) => a - b)));
    }
    if (!valid) continue;
    if (evaluateSelection(ctx, selection).breakdown.total >= achieved - 1e-9) return entry.label;
  }
  return undefined;
}

function signature(assignments: readonly GameAssignment[]): string {
  return assignments.map((a) => `${a.gameId}:${a.playerIds.join('-')}`).join('|');
}

/**
 * Generates up to `candidateCount` line-ups: the first uses the requested weights, the
 * rest use the comparison presets (win-first / balanced / fairness-first) so the captain
 * can weigh the trade-offs side by side.
 */
export function generateOrder(input: OrderInput, options: GenerateOptions = {}): GenerateResult {
  // Static conflicts are reported before any search: a contradiction in the input is a
  // configuration problem to explain, not something to search around.
  const diagnostics = precheck(input);
  if (diagnostics.length > 0) {
    return { ok: false, candidates: [], diagnostics };
  }

  const timeLimit = options.timeLimitMs ?? input.settings.timeLimitMs;
  const runs: { label: string; presetKey: PresetKey; weights: ScoreWeights }[] = [
    {
      label: input.preset === 'CUSTOM' ? 'カスタム' : PRESETS[input.preset].label,
      presetKey: input.preset,
      weights: input.weights,
    },
  ];

  if (!options.singleCandidate) {
    const wanted = Math.max(1, options.candidateCount ?? 3);
    for (const presetKey of CANDIDATE_PRESETS) {
      if (runs.length >= wanted) break;
      if (presetKey === input.preset) continue;
      runs.push({
        label: PRESETS[presetKey].label,
        presetKey,
        weights: PRESETS[presetKey].weights,
      });
    }
  }

  // The captain's own weights define the scale every candidate is reported on.
  const referenceCtx = prepare(input);
  const perRunBudget = Math.max(120, Math.floor(timeLimit / runs.length));
  const solutions: OrderSolution[] = [];
  const seen = new Set<string>();
  const excluded = new Set<string>();
  /** Earlier candidates as player-id line-ups, to recognise a preset that agrees with one. */
  const shown: { label: string; members: PlayerId[][] }[] = [];

  for (const run of runs) {
    const runInput: OrderInput = { ...input, weights: run.weights };
    const ctx = prepare(runInput);
    const candidates = buildAllCandidates(ctx);
    if (candidates.some((entry) => entry.combos.length === 0)) continue;
    const bctx = buildBoundContext(ctx, candidates);
    const outcome = runOnce(
      ctx,
      bctx,
      candidates,
      run.label,
      run.presetKey,
      perRunBudget,
      excluded,
    );
    if (!outcome) continue;
    const sameAs = bestShownLineUp(ctx, shown, outcome.evaluation.breakdown.total);
    if (sameAs) outcome.meta = { ...outcome.meta, alternativeTo: sameAs };
    const solution = assembleSolution(ctx, bctx, candidates, outcome, referenceCtx);
    if (!solution) continue;
    const key = signature(solution.assignments);
    if (seen.has(key)) continue;
    seen.add(key);
    excluded.add(selectionSignature(ctx, outcome.selection));
    shown.push({
      label: run.label,
      members: outcome.selection.map((combo) => combo.members.map((pi) => ctx.playerIds[pi])),
    });
    solutions.push(solution);
  }

  if (solutions.length === 0) {
    const suggestions = analyseRelaxations(input);
    return {
      ok: false,
      candidates: [],
      diagnostics: [
        {
          code: 'SEARCH_EXHAUSTED',
          message:
            'すべての絶対条件を満たすオーダーが見つかりませんでした。制約を自動的に破ることはしません。',
          suggestions:
            suggestions.length > 0
              ? suggestions
              : [
                  {
                    kind: 'other',
                    message:
                      '単一の制約緩和では解決できませんでした。参加者の追加、出場不可設定の見直し、最大出場回数の引き上げを組み合わせて調整してください。',
                  },
                ],
        },
      ],
    };
  }

  return { ok: true, candidates: solutions, diagnostics: [] };
}

/**
 * Re-optimises while keeping the given locks fixed (spec §17).
 *
 * This is the same entry point as `generateOrder` — the locks are what make it
 * "partial". Pass the locks derived from the games the captain wants to keep (e.g. the
 * one they just edited by hand, or every game except the one that must change).
 */
export function reoptimise(input: OrderInput, options: GenerateOptions = {}): GenerateResult {
  return generateOrder(input, { ...options, candidateCount: options.candidateCount ?? 1 });
}

/**
 * Evaluates an assignment the captain produced by hand (spec §15).
 *
 * Metrics, tallies and reasons are always returned — even when a hard constraint is
 * violated — because the result screen has to show the captain *what* broke and by how
 * much, live, while they are still editing. `ok` reports whether the assignment is
 * legal; `violations` lists every breach.
 */
export interface ManualEvaluation {
  ok: boolean;
  solution: OrderSolution | null;
  violations: HardViolation[];
}

export function evaluateManualOrder(
  input: OrderInput,
  assignments: readonly GameAssignment[],
): ManualEvaluation {
  const violations = validateHardConstraints(input, assignments);
  const ctx = prepare(input);
  const candidates = buildAllCandidates(ctx);
  const bctx = buildBoundContext(ctx, candidates);

  const byGame = new Map(assignments.map((a) => [a.gameId, a]));
  const selection: Combo[] = [];
  for (let gi = 0; gi < ctx.gameCount; gi += 1) {
    const assignment = byGame.get(ctx.games[gi].id);
    if (!assignment) return { ok: false, solution: null, violations };
    const members = assignment.playerIds
      .map((id) => ctx.playerIndex.get(id))
      .filter((index): index is number => index !== undefined)
      .sort((a, b) => a - b);
    // An unknown or duplicated player cannot be scored; the violation list already says so.
    if (members.length !== assignment.playerIds.length) {
      return { ok: false, solution: null, violations };
    }
    selection.push(describeCombo(ctx, gi, members));
  }

  const evaluation = evaluateSelection(ctx, selection);
  const meta: SolutionMeta = {
    stage: 'dfs',
    exhaustive: false,
    nodesVisited: 0,
    elapsedMs: 0,
    label: '手動編集',
    presetKey: input.preset,
  };
  const solution: OrderSolution = {
    assignments: assignments.map((a) => ({ ...a, playerIds: [...a.playerIds] })),
    tallies: buildTallies(ctx, evaluation),
    score: roundScore(evaluation.breakdown),
    metrics: buildMetrics(ctx, evaluation),
    // The reasons are told about the violations, so a hand-edited line-up never gets a
    // "nothing is violated" rationale while the validator says otherwise (spec §15).
    explanation: buildExplanation(ctx, bctx, selection, evaluation, violations),
    warnings: buildWarnings(ctx, evaluation, candidates, meta),
    meta,
  };
  return { ok: violations.length === 0, solution, violations };
}
