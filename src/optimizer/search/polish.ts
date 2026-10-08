import {
  describeCombo,
  hasForbiddenPair,
  selectionSignature,
  type Combo,
} from '../candidates/combinations';
import { consecutiveExcess } from '../../domain/orders/consecutive';
import type { PreparedContext } from '../prepare';
import { evaluateSelection, type Evaluation } from '../scoring/score';

/**
 * Deterministic hill climbing (docs/DESIGN.md §6.3 Stage 3).
 *
 * The anytime search can stop mid-tree, so a cheap local improvement pass is worth a
 * lot: it fixes the "one player is one game short" situations that a truncated
 * depth-first search typically leaves behind.
 *
 * Two neighbourhoods are explored, both scanned in a fixed order (game index, then
 * slot, then player index) with no randomness at all, so the result is reproducible:
 *
 * - **replace**: swap one fielded player for another eligible player
 * - **exchange**: swap two fielded players between two different games
 *
 * Every candidate move is re-checked against the hard constraints before it is scored,
 * so polishing can never produce an infeasible line-up.
 */
export interface PolishResult {
  selection: Combo[];
  evaluation: Evaluation;
  improved: boolean;
  passes: number;
}

export function hardFeasible(ctx: PreparedContext, selection: readonly Combo[]): boolean {
  const counts = new Array<number>(ctx.playerCount).fill(0);
  const appearances: number[][] = Array.from({ length: ctx.playerCount }, () => []);

  for (let gi = 0; gi < selection.length; gi += 1) {
    const members = selection[gi].members;
    if (members.length !== ctx.games[gi].playerCount) return false;
    if (new Set(members).size !== members.length) return false;
    if (hasForbiddenPair(ctx, members)) return false;
    for (const required of ctx.requiredByGame[gi]) {
      if (!members.includes(required)) return false;
    }
    for (const pi of members) {
      if (!ctx.eligible[gi][pi]) return false;
      counts[pi] += 1;
      appearances[pi].push(gi);
    }
  }

  for (let pi = 0; pi < ctx.playerCount; pi += 1) {
    if (counts[pi] > ctx.maxAppearances[pi]) return false;
    if (ctx.input.settings.minAppearanceMode === 'hard' && counts[pi] < ctx.minAppearances[pi]) {
      return false;
    }
    if (ctx.input.settings.consecutiveMode === 'hard') {
      const limit = ctx.maxConsecutive[pi];
      if (Number.isFinite(limit) && consecutiveExcess(appearances[pi], limit) > 0) return false;
    }
  }
  return true;
}

function withMembers(
  ctx: PreparedContext,
  selection: readonly Combo[],
  gameIndex: number,
  members: number[],
): Combo[] {
  const next = [...selection];
  next[gameIndex] = describeCombo(ctx, gameIndex, [...members].sort((a, b) => a - b));
  return next;
}

export function polish(
  ctx: PreparedContext,
  initial: readonly Combo[],
  deadline: number,
  excluded: ReadonlySet<string> = new Set(),
  maxPasses = 12,
  /** Extra condition a move must meet (the bias gate climbs only through justified steps). */
  accept?: (selection: Combo[], evaluation: Evaluation) => boolean,
  /** What a move must raise; the run's score unless told otherwise. */
  objective?: (selection: Combo[], evaluation: Evaluation) => number,
): PolishResult {
  let current = [...initial];
  let evaluation = evaluateSelection(ctx, current);
  let improved = false;
  let passes = 0;

  for (; passes < maxPasses; passes += 1) {
    let bestSelection: Combo[] | null = null;
    let bestEvaluation = evaluation;
    let bestGain = 1e-9;

    const consider = (next: Combo[]): void => {
      if (!hardFeasible(ctx, next)) return;
      if (excluded.size > 0 && excluded.has(selectionSignature(ctx, next))) return;
      const nextEval = evaluateSelection(ctx, next);
      if (accept && !accept(next, nextEval)) return;
      const gain = objective
        ? objective(next, nextEval) - objective(current, evaluation)
        : nextEval.breakdown.total - evaluation.breakdown.total;
      if (gain > bestGain) {
        bestGain = gain;
        bestSelection = next;
        bestEvaluation = nextEval;
      }
    };

    // Neighbourhood 1: replace a single fielded player.
    for (let gi = 0; gi < current.length; gi += 1) {
      if (performance.now() > deadline) break;
      const members = current[gi].members;
      for (let slot = 0; slot < members.length; slot += 1) {
        const outgoing = members[slot];
        if (ctx.requiredByGame[gi].includes(outgoing)) continue;
        for (const incoming of ctx.eligibleLists[gi]) {
          if (incoming === outgoing || members.includes(incoming)) continue;
          const next = [...members];
          next[slot] = incoming;
          consider(withMembers(ctx, current, gi, next));
        }
      }
    }

    // Neighbourhood 2: exchange two fielded players between two games.
    for (let gi = 0; gi < current.length; gi += 1) {
      if (performance.now() > deadline) break;
      for (let gj = gi + 1; gj < current.length; gj += 1) {
        const a = current[gi].members;
        const b = current[gj].members;
        for (let i = 0; i < a.length; i += 1) {
          if (ctx.requiredByGame[gi].includes(a[i])) continue;
          for (let j = 0; j < b.length; j += 1) {
            if (ctx.requiredByGame[gj].includes(b[j])) continue;
            if (a[i] === b[j]) continue;
            if (b.includes(a[i]) || a.includes(b[j])) continue;
            if (!ctx.eligible[gi][b[j]] || !ctx.eligible[gj][a[i]]) continue;
            const nextA = [...a];
            const nextB = [...b];
            nextA[i] = b[j];
            nextB[j] = a[i];
            let next = withMembers(ctx, current, gi, nextA);
            next = withMembers(ctx, next, gj, nextB);
            consider(next);
          }
        }
      }
    }

    if (bestSelection === null) break;
    current = bestSelection;
    evaluation = bestEvaluation;
    improved = true;
    if (performance.now() > deadline) {
      passes += 1;
      break;
    }
  }

  return { selection: current, evaluation, improved, passes };
}
