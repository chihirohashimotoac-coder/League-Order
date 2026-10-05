/**
 * Spec §38 sample verification. Run with: npx tsx scripts/sample.ts
 * Prints the generated order, tallies, metrics and reasons for manual inspection.
 */
import { generateOrder } from '../src/optimizer/generateOrder';
import {
  orderInput,
  pair,
  sampleFormatGames,
  sampleFormatGames11,
  sampleRoster,
} from '../src/test/factories';
import type { OrderInput, OrderSolution } from '../src/domain/types';

function show(title: string, input: OrderInput): void {
  const names = new Map(input.players.map((p) => [p.id, p.name]));
  const gamesById = new Map(input.games.map((g) => [g.id, g]));
  console.log(`\n${'='.repeat(78)}\n${title}\n${'='.repeat(78)}`);

  const result = generateOrder(input);
  if (!result.ok) {
    console.log('生成不可:');
    for (const diagnostic of result.diagnostics) {
      console.log(`  ! ${diagnostic.message}`);
      for (const suggestion of diagnostic.suggestions) console.log(`      → ${suggestion.message}`);
    }
    return;
  }

  result.candidates.forEach((solution: OrderSolution, index: number) => {
    console.log(
      `\n--- 候補${index + 1}: ${solution.meta.label} (総合 ${solution.score.display}) ` +
        `stage=${solution.meta.stage} exhaustive=${solution.meta.exhaustive} ` +
        `nodes=${solution.meta.nodesVisited} ${solution.meta.elapsedMs}ms ---`,
    );
    console.log('| # | Game            | Players');
    for (const assignment of solution.assignments) {
      const game = gamesById.get(assignment.gameId)!;
      console.log(
        `| ${String(game.order).padEnd(1)} | ${game.name.padEnd(15)} | ` +
          assignment.playerIds.map((id) => names.get(id)).join(' / '),
      );
    }
    console.log('\n| Player | Rating | 今回 | Season | 最大連続 |');
    for (const tally of solution.tallies) {
      console.log(
        `| ${(names.get(tally.playerId) ?? '').padEnd(6)} | ` +
          `${String(tally.effectiveRating ?? '-').padStart(6)}${tally.ratingImputed ? '*' : ' '}| ` +
          `${String(tally.count).padStart(4)} | ${String(tally.seasonTotal).padStart(6)} | ` +
          `${String(tally.maxConsecutive).padStart(8)} |`,
      );
    }
    console.log(
      `\n最大出場差 ${solution.metrics.appearanceSpread} / 標準偏差 ${solution.metrics.appearanceStdDev} / ` +
        `公平性超過 ${solution.metrics.fairnessExcess} / 平均Rating ${solution.metrics.averageRating} / ` +
        `最大連続 ${solution.metrics.maxConsecutive}`,
    );
    console.log(
      `score: strength=${solution.score.strength} gameFit=${solution.score.gameFit} ` +
        `pairFit=${solution.score.pairFit} fairness=${solution.score.fairness} ` +
        `consecPenalty=${solution.score.consecutivePenalty} total=${solution.score.total}`,
    );
    for (const warning of solution.warnings) console.log(`  [${warning.severity}] ${warning.message}`);

    if (index === 0) {
      console.log('\n生成理由 (候補1):');
      for (const factor of solution.explanation.overall) {
        console.log(`  * ${factor.label}: ${factor.detail}`);
      }
      for (const game of solution.explanation.games) {
        const def = gamesById.get(game.gameId)!;
        console.log(`\n  Game ${def.order} ${def.name} — ${game.playerIds.map((id) => names.get(id)).join(' / ')}`);
        for (const factor of game.factors) {
          console.log(`    - [${factor.tone[0]}] ${factor.label}: ${factor.detail}`);
        }
      }
    }
  });
}

const roster = sampleRoster();
show('§38 サンプル: 5名 (14/14/11/8/4) / 10枠', orderInput(roster, sampleFormatGames()));
show('§38 サンプル: 11枠 (割り切れないケース)', orderInput(roster, sampleFormatGames11()));
show(
  '§38 サンプル: ペア相性 + 禁止ペア + 出場不可',
  orderInput(roster, sampleFormatGames(), {
    pairs: [pair('p1', 'p2', 'FORBIDDEN'), pair('p3', 'p5', 'VERY_GOOD'), pair('p1', 'p4', 'DISCOURAGED')],
    participants: roster.map((p, i) => ({
      playerId: p.id,
      include: true,
      excludedGameIds: i === 4 ? ['g1'] : [],
      excludedKinds: i === 3 ? (['TRIOS'] as const).slice() : [],
      ...(i === 2 ? { window: { fromOrder: 2 } } : {}),
    })),
  }),
);
