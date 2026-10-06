import type {
  ExplanationFactor,
  ExplanationTone,
  GameExplanation,
  OrderExplanation,
} from '../../domain/types';
import { GAME_KIND_LABELS, PAIR_AFFINITY_LABELS } from '../../domain/types';
import { runLengths } from '../../domain/orders/consecutive';
import { roleFairShare } from '../../domain/orders/roleFairness';
import { DARTS_DISCIPLINE_TAGS } from '../../domain/types';
import { describeStrengthWeights } from '../../domain/players/strength';
import { round } from '../../utils/math';
import type { Combo } from '../candidates/combinations';
import type { HardViolation } from '../constraints/validate';
import type { PreparedContext } from '../prepare';
import type { Evaluation } from './score';
import type { BoundContext } from '../search/bound';

/**
 * Explanation builder (docs/DESIGN.md §8, spec §19).
 *
 * This reads the *same* values the optimizer scored — `Combo.strength`,
 * `Combo.gameFit`, `Combo.pairFit`, the appearance counts from `Evaluation`, the ideal
 * counts from the bound context — rather than inspecting the finished line-up and
 * guessing at a rationale after the fact. If a number appears in a reason, that number
 * is literally a term of the objective that produced the line-up.
 */

function toneFor(value: number, positiveAt = 0.6, negativeAt = 0.4): ExplanationTone {
  if (value >= positiveAt) return 'positive';
  if (value <= negativeAt) return 'negative';
  return 'neutral';
}

function formatRating(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

export function buildExplanation(
  ctx: PreparedContext,
  bctx: BoundContext,
  selection: readonly Combo[],
  evaluation: Evaluation,
  /**
   * Hard-constraint violations of the line-up being explained.
   *
   * Empty for anything the search produced — a solution that breaks a hard constraint is
   * never returned — but a hand-edited line-up can break one, and the reasons must then
   * say so. An explanation that asserts "nothing is violated" next to a validator that
   * says otherwise is worse than no explanation at all: it teaches the captain to
   * distrust the screen.
   */
  violations: readonly HardViolation[] = [],
): OrderExplanation {
  const games: GameExplanation[] = [];
  const w = ctx.weights;

  const violationsByGame = new Map<string, HardViolation[]>();
  const globalViolations: HardViolation[] = [];
  for (const violation of violations) {
    if (violation.gameId === undefined) {
      globalViolations.push(violation);
      continue;
    }
    const list = violationsByGame.get(violation.gameId);
    if (list) list.push(violation);
    else violationsByGame.set(violation.gameId, [violation]);
  }

  for (let gi = 0; gi < selection.length; gi += 1) {
    const combo = selection[gi];
    const game = ctx.games[gi];
    const factors: ExplanationFactor[] = [];
    const names = combo.members.map((pi) => ctx.players[pi].name);

    // --- Strength -----------------------------------------------------------
    factors.push(...strengthFactors(ctx, combo));

    // --- Game aptitude -----------------------------------------------------
    const kindLabels = game.kinds.map((kind) => GAME_KIND_LABELS[kind]).join(' / ');
    const skillParts = combo.members.map((pi) => {
      const levels = game.kinds
        .map((kind) => ctx.players[pi].skills[kind])
        .filter((level): level is NonNullable<typeof level> => level !== undefined);
      const text = levels.length > 0 ? levels.join('/') : '未設定';
      return `${ctx.players[pi].name} ${text}`;
    });
    factors.push({
      key: 'gameFit',
      label: `${kindLabels} 適性`,
      value: round(combo.gameFit),
      detail: `${skillParts.join(' , ')} (評価 ${(combo.gameFit * 100).toFixed(0)}%)`,
      tone: toneFor(combo.gameFit),
    });

    // --- Pair affinity -----------------------------------------------------
    if (combo.members.length >= 2) {
      const pairDetails: string[] = [];
      const noveltyDetails: string[] = [];
      for (let i = 0; i < combo.members.length; i += 1) {
        for (let j = i + 1; j < combo.members.length; j += 1) {
          const a = combo.members[i];
          const b = combo.members[j];
          const setting = ctx.input.pairs.find(
            (pair) =>
              (pair.a === ctx.playerIds[a] && pair.b === ctx.playerIds[b]) ||
              (pair.a === ctx.playerIds[b] && pair.b === ctx.playerIds[a]),
          );
          const affinity = setting?.affinity ?? 'NEUTRAL';
          pairDetails.push(
            `${ctx.players[a].name} / ${ctx.players[b].name}: ${PAIR_AFFINITY_LABELS[affinity]}`,
          );
          noveltyDetails.push(
            `${ctx.players[a].name} / ${ctx.players[b].name}: 過去 ${setting?.pastTogetherCount ?? 0} 回`,
          );
        }
      }
      factors.push({
        key: 'pairFit',
        label: 'ペア相性',
        value: round(combo.pairFit),
        detail: pairDetails.join(' , '),
        tone: toneFor(combo.pairFit, 0.7, 0.35),
      });
      if (w.novelty > 0) {
        factors.push({
          key: 'novelty',
          label: '新ペア度',
          value: round(combo.novelty),
          detail: noveltyDetails.join(' , '),
          tone: toneFor(combo.novelty, 0.7, 0.35),
        });
      }
    }

    // --- Fairness ----------------------------------------------------------
    const fairnessParts = combo.members.map((pi) => {
      const count = evaluation.counts[pi];
      const ideal = bctx.idealCounts[pi];
      const diff = count - ideal;
      const diffText = diff === 0 ? '理想どおり' : diff > 0 ? `理想+${diff}` : `理想${diff}`;
      return `${ctx.players[pi].name} ${count}回 (${diffText})`;
    });
    factors.push({
      key: 'fairness',
      label: '出場回数',
      value: round(evaluation.fairness.score),
      detail: `${fairnessParts.join(' , ')} / 全体の最大出場差 ${evaluation.fairness.spread}`,
      tone: evaluation.fairness.excess === 0 ? 'positive' : 'neutral',
    });

    // --- Role fairness ------------------------------------------------------
    const groupIndex = ctx.roleOfGame[gi];
    const group = ctx.roleGroups[groupIndex];
    if (group && group.gameIndices.length > 1) {
      const share = roleFairShare(group, ctx.playerCount);
      const roleLabel = GAME_KIND_LABELS[group.role];
      const parts = combo.members.map((pi) => {
        const count = evaluation.roleCounts[groupIndex]?.[pi] ?? 0;
        return `${ctx.players[pi].name} ${count}回`;
      });
      const over = combo.members.some((pi) => (evaluation.roleCounts[groupIndex]?.[pi] ?? 0) > share);
      factors.push({
        key: 'roleFairness',
        label: `${roleLabel} の分担`,
        detail: `${roleLabel} 全${group.gameIndices.length}試合のうち ${parts.join(' , ')} (均等なら1人${share}回まで)`,
        tone: over ? 'neutral' : 'positive',
      });
    }

    // --- Consecutive appearances -------------------------------------------
    const consecutiveNotes: string[] = [];
    for (const pi of combo.members) {
      const indices = evaluation.appearances[pi];
      const runs = runLengths(indices);
      const limit = ctx.maxConsecutive[pi];
      const maxRun = runs.length > 0 ? Math.max(...runs) : 0;
      if (maxRun >= 2) {
        const over = Number.isFinite(limit) && maxRun > limit;
        consecutiveNotes.push(
          `${ctx.players[pi].name} 最大${maxRun}連続${Number.isFinite(limit) ? ` (上限${limit})` : ''}${over ? ' ⚠' : ''}`,
        );
      }
    }
    if (consecutiveNotes.length > 0) {
      const hasOver = consecutiveNotes.some((note) => note.includes('⚠'));
      factors.push({
        key: 'consecutive',
        label: '連続出場',
        detail: consecutiveNotes.join(' , '),
        tone: hasOver ? 'negative' : 'neutral',
      });
    }

    // --- Locks and hard constraints ----------------------------------------
    const locked = ctx.locksByGame[gi]
      .map((pi, slot) => (pi === undefined ? null : `スロット${slot + 1}: ${ctx.players[pi].name}`))
      .filter((entry): entry is string => entry !== null);
    if (locked.length > 0) {
      factors.push({
        key: 'lock',
        label: 'ロック',
        detail: `${locked.join(' , ')} はロックにより固定されています。`,
        tone: 'neutral',
      });
    }
    const gameViolations = violationsByGame.get(game.id) ?? [];
    factors.push(
      gameViolations.length > 0
        ? {
            key: 'constraint',
            label: '絶対条件違反',
            detail: gameViolations.map((violation) => violation.message).join(' '),
            tone: 'negative',
          }
        : {
            key: 'constraint',
            label: '絶対条件',
            detail: `出場不可・出場可能範囲・最大出場回数・禁止ペアのいずれにも違反していません (${names.join(' / ')})。`,
            tone: 'positive',
          },
    );

    games.push({ gameId: game.id, playerIds: combo.members.map((pi) => ctx.playerIds[pi]), factors });
  }

  // --- Order-level summary --------------------------------------------------
  const overall: ExplanationFactor[] = [];

  // Violations that are not tied to a single game (appearance bounds, locks) belong at
  // the top of the summary, ahead of any soft score that would otherwise read as praise.
  if (violations.length > 0) {
    overall.push({
      key: 'constraint',
      label: '絶対条件違反',
      detail:
        globalViolations.length > 0
          ? globalViolations.map((violation) => violation.message).join(' ')
          : `${violations.length} 件の違反があります (各ゲームの理由を確認してください)。`,
      tone: 'negative',
    });
  }

  overall.push(
    {
      key: 'fairness',
      label: '出場回数の均等性',
      value: round(evaluation.fairness.score),
      detail:
        evaluation.fairness.excess === 0
          ? `${ctx.totalSlots}枠を${ctx.playerCount}名へ、算術上もっとも均等に配分しました (最大差 ${evaluation.fairness.spread})。`
          : `理想配分からの超過 ${round(evaluation.fairness.excess, 2)} (最大差 ${evaluation.fairness.spread})。絶対条件、または方針の重み付け (戦力優先など) により完全な均等にはしていません。`,
      tone: evaluation.fairness.excess === 0 ? 'positive' : 'neutral',
    },
    {
      key: 'strength',
      label: '戦力 (Strength)',
      value: round(evaluation.strengthRaw),
      detail: overallStrengthDetail(ctx, evaluation),
      tone: toneFor(evaluation.strengthRaw),
    },
    {
      key: 'gameFit',
      label: 'ゲーム適性',
      value: round(evaluation.gameFitRaw),
      detail: `全ゲーム平均の適性評価 ${(evaluation.gameFitRaw * 100).toFixed(0)}%`,
      tone: toneFor(evaluation.gameFitRaw),
    },
  );

  const roleNotes = ctx.roleGroups
    .map((group, index) => ({ group, counts: evaluation.roleCounts[index] ?? [] }))
    .filter(({ group }) => group.gameIndices.length > 1)
    .map(({ group, counts }) => {
      const most = Math.max(0, ...counts);
      const who = counts
        .map((count, pi) => (count === most && most > 0 ? ctx.players[pi].name : null))
        .filter((name): name is string => name !== null);
      return `${GAME_KIND_LABELS[group.role]} ${group.gameIndices.length}試合: 最多 ${most}回 (${who.join('・')}) / 均等なら${roleFairShare(group, ctx.playerCount)}回`;
    });
  if (roleNotes.length > 0) {
    overall.push({
      key: 'roleFairness',
      label: '役割の分散 (Singles 等の集中度)',
      value: round(evaluation.roleFairness.score),
      detail: roleNotes.join(' ・ '),
      tone: evaluation.roleFairness.totalExcess === 0 ? 'positive' : evaluation.roleFairness.score >= 0.6 ? 'neutral' : 'negative',
    });
  }

  if (ctx.multiPlayerGameCount > 0) {
    overall.push({
      key: 'pairFit',
      label: 'ペア相性',
      value: round(evaluation.pairFitRaw),
      detail: `${ctx.multiPlayerGameCount} 件の複数人ゲームにおける相性平均 ${(evaluation.pairFitRaw * 100).toFixed(0)}%`,
      tone: toneFor(evaluation.pairFitRaw, 0.7, 0.35),
    });
  }

  overall.push({
    key: 'consecutive',
    label: '連続出場',
    value: round(1 - evaluation.breakdown.consecutivePenalty),
    detail:
      evaluation.consecutiveExcessTotal === 0
        ? `最大連続 ${evaluation.maxConsecutive} 試合。設定上限の超過はありません。`
        : `上限超過が ${evaluation.consecutiveExcessTotal} 箇所あります (最大連続 ${evaluation.maxConsecutive} 試合)。`,
    tone: evaluation.consecutiveExcessTotal === 0 ? 'positive' : 'negative',
  });

  if (ctx.effectiveSeasonWeight > 0) {
    overall.push({
      key: 'season',
      label: 'シーズン公平性',
      value: round(1 - evaluation.breakdown.seasonImbalance),
      detail: `シーズン累計込みの理想配分からの超過 ${round(evaluation.seasonFairness.excess, 2)}`,
      tone: evaluation.seasonFairness.excess === 0 ? 'positive' : 'neutral',
    });
  }

  return { games, overall };
}

// ---------------------------------------------------------------------------
// Strength
// ---------------------------------------------------------------------------

function formatPprValue(value: number): string {
  return Number.isInteger(value) ? String(value) : String(Math.round(value * 100) / 100);
}

/**
 * The basis line shown wherever strength is explained: "戦力評価 Rating 70% / PPR 30%
 * (SOFT)". `null` when neither metric is used.
 */
export function strengthBasis(ctx: PreparedContext): string | null {
  const blend = describeStrengthWeights(ctx.strengthWeights);
  if (!blend) return null;
  const tag = ctx.discipline === 'UNSPECIFIED' ? 'ダーツ種別未設定' : DARTS_DISCIPLINE_TAGS[ctx.discipline];
  return `戦力評価 ${blend} (${tag})`;
}

/**
 * Per-game strength reasons. Each metric that actually carries weight is quoted per
 * player, with imputed values marked as provisional — never as if they were entered.
 */
function strengthFactors(ctx: PreparedContext, combo: Combo): ExplanationFactor[] {
  const factors: ExplanationFactor[] = [];
  const basis = strengthBasis(ctx);
  if (!basis) {
    factors.push({
      key: 'strength',
      label: '戦力',
      detail:
        'Rating・PPR の入力が無い (または参加者全員が同じ値の) ため、戦力は評価に使用していません。',
      tone: 'neutral',
    });
    return factors;
  }

  const useRating = ctx.strengthWeights.rating > 0;
  const usePpr = ctx.strengthWeights.ppr > 0;
  const parts = combo.members.map((pi) => {
    const id = ctx.playerIds[pi];
    const pieces: string[] = [];
    if (useRating) {
      const value = ctx.ratings.effective.get(id);
      pieces.push(
        value === null || value === undefined
          ? 'Rating未入力'
          : `Rt.${formatRating(value)}${ctx.ratings.imputed.has(id) ? '(暫定)' : ''}`,
      );
    }
    if (usePpr) {
      const value = ctx.pprs.effective.get(id);
      pieces.push(
        value === null || value === undefined
          ? 'PPR未入力'
          : `PPR ${formatPprValue(value)}${ctx.pprs.imputed.has(id) ? '(暫定)' : ''}`,
      );
    }
    return `${ctx.players[pi].name} ${pieces.join(' / ')}`;
  });
  factors.push({
    key: 'strength',
    label: useRating && !usePpr ? 'Rating' : usePpr && !useRating ? 'PPR' : '戦力',
    value: round(combo.strength),
    detail: `${parts.join(' , ')} — ${basis} で ${(combo.strength * 100).toFixed(0)}%`,
    tone: toneFor(combo.strength),
  });

  const ratingImputed = useRating && combo.members.some((pi) => ctx.ratings.imputed.has(ctx.playerIds[pi]));
  const pprImputed = usePpr && combo.members.some((pi) => ctx.pprs.imputed.has(ctx.playerIds[pi]));
  if (ratingImputed) {
    factors.push({
      key: 'strength',
      label: 'Rating未入力',
      detail: `Rating 未入力の選手は 0 ではなく参加者の中央値 ${
        ctx.ratings.imputationValue === null ? '—' : formatRating(ctx.ratings.imputationValue)
      } を暫定値として評価しています。`,
      tone: 'neutral',
    });
  }
  if (pprImputed) {
    factors.push({
      key: 'strength',
      label: 'PPR未入力',
      detail: `PPR 未入力の選手は 0 ではなく参加者の中央値 ${
        ctx.pprs.imputationValue === null ? '—' : formatPprValue(ctx.pprs.imputationValue)
      } を暫定値として評価しています。`,
      tone: 'neutral',
    });
  }
  return factors;
}

function overallStrengthDetail(ctx: PreparedContext, evaluation: Evaluation): string {
  const basis = strengthBasis(ctx);
  if (!basis) return 'Rating・PPR に差が無いため戦力評価は使用していません。';
  const parts: string[] = [basis];
  if (ctx.strengthWeights.rating > 0 && evaluation.averageRating !== null) {
    parts.push(
      `出場枠の平均 Rating ${evaluation.averageRating.toFixed(2)}${
        ctx.ratings.imputed.size > 0 ? ` (未入力 ${ctx.ratings.imputed.size} 名は中央値で代替)` : ''
      }`,
    );
  }
  if (ctx.strengthWeights.ppr > 0 && evaluation.averagePpr !== null) {
    parts.push(
      `平均 PPR ${evaluation.averagePpr.toFixed(2)}${
        ctx.pprs.imputed.size > 0 ? ` (未入力 ${ctx.pprs.imputed.size} 名は中央値で代替)` : ''
      }`,
    );
  }
  return parts.join(' ・ ');
}
