import type { GameSlotDef, OrderSolution, Player, PlayerId } from '../types';
import { sortedGames } from '../games/format';

/**
 * Plain-text rendering of an order (spec §22).
 *
 * Pure so it can be unit-tested and reused by the clipboard, the share sheet and the
 * image renderer. The layout is deliberately narrow and emoji-free so it survives being
 * pasted into LINE, Slack or a mail client.
 */
export interface RenderTextOptions {
  title?: string;
  /** Include the per-player appearance table. */
  includeTally?: boolean;
  /** Include the metric summary line. */
  includeSummary?: boolean;
  /** Include hard-constraint-safe warnings. */
  includeWarnings?: boolean;
}

function nameOf(players: readonly Player[]): (id: PlayerId) => string {
  const map = new Map(players.map((player) => [player.id, player.name]));
  return (id) => map.get(id) ?? '(未設定)';
}

export function renderOrderText(
  games: readonly GameSlotDef[],
  players: readonly Player[],
  solution: OrderSolution,
  options: RenderTextOptions = {},
): string {
  const {
    title = 'ORDER',
    includeTally = true,
    includeSummary = true,
    includeWarnings = true,
  } = options;

  const name = nameOf(players);
  const ordered = sortedGames(games);
  const byGame = new Map(solution.assignments.map((a) => [a.gameId, a]));
  const lines: string[] = [title, ''];

  for (const game of ordered) {
    const assignment = byGame.get(game.id);
    const members = assignment?.playerIds.map((id) => (id ? name(id) : '(空席)')).join(' / ') ?? '(未配置)';
    lines.push(`${game.order}. ${game.name} : ${members}`);
  }

  if (includeTally) {
    lines.push('', '--- 出場回数 ---');
    const byId = new Map(players.map((player) => [player.id, player]));
    const tallies = [...solution.tallies].sort(
      (a, b) => b.count - a.count || (a.playerId < b.playerId ? -1 : 1),
    );
    for (const tally of tallies) {
      const player = byId.get(tally.playerId);
      const rating =
        tally.effectiveRating === null
          ? 'R-'
          : `R${tally.effectiveRating}${tally.ratingImputed ? '*' : ''}`;
      lines.push(
        `${player?.name ?? tally.playerId} (${rating}) 今回${tally.count}回 / Season${tally.seasonTotal}回`,
      );
    }
    if (solution.metrics.hasImputedRating) {
      lines.push('* Rating 未入力のため参加者の中央値で評価');
    }
  }

  if (includeSummary) {
    lines.push(
      '',
      '--- 評価 ---',
      `総合 ${solution.score.display} / 最大出場差 ${solution.metrics.appearanceSpread} / 最大連続 ${solution.metrics.maxConsecutive}`,
      `平均Rating ${solution.metrics.averageRating ?? '-'} / 戦力 ${Math.round(solution.score.strength * 100)}% / 適性 ${Math.round(
        solution.score.gameFit * 100,
      )}% / 公平性 ${Math.round(solution.score.fairness * 100)}%`,
    );
  }

  if (includeWarnings && solution.warnings.length > 0) {
    lines.push('', '--- 注意 ---');
    for (const warning of solution.warnings) lines.push(`- ${warning.message}`);
  }

  return lines.join('\n');
}

/** Compact variant for a quick copy: just the order rows. */
export function renderOrderTextCompact(
  games: readonly GameSlotDef[],
  players: readonly Player[],
  solution: OrderSolution,
  title = 'ORDER',
): string {
  return renderOrderText(games, players, solution, {
    title,
    includeTally: false,
    includeSummary: false,
    includeWarnings: false,
  });
}
