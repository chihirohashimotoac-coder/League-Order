import { describe, expect, it } from 'vitest';
import { renderOrderText, renderOrderTextCompact } from './renderText';
import { generateOrder } from '../../optimizer/generateOrder';
import { orderInput, player, sampleFormatGames, sampleRoster } from '../../test/factories';

function fixture(roster = sampleRoster()) {
  const games = sampleFormatGames();
  const input = orderInput(roster, games);
  const result = generateOrder(input);
  if (!result.ok) throw new Error('fixture should be satisfiable');
  return { games, roster, solution: result.candidates[0] };
}

describe('renderOrderText (spec §22)', () => {
  it('lists every game in display order with the assigned players', () => {
    const { games, roster, solution } = fixture();
    const text = renderOrderText(games, roster, solution, { title: 'TEST ORDER' });

    expect(text.startsWith('TEST ORDER')).toBe(true);
    for (const game of games) {
      expect(text).toContain(`${game.order}. ${game.name} :`);
    }
    for (const p of roster) {
      expect(text).toContain(p.name);
    }
  });

  it('includes the tally and the evaluation summary', () => {
    const { games, roster, solution } = fixture();
    const text = renderOrderText(games, roster, solution);
    expect(text).toContain('--- 出場回数 ---');
    expect(text).toContain('--- 評価 ---');
    expect(text).toContain(`最大出場差 ${solution.metrics.appearanceSpread}`);
    expect(text).toContain('Season');
  });

  it('marks an imputed rating rather than printing 0', () => {
    const roster = sampleRoster();
    roster[2] = player({ id: 'p3', name: 'Chiba', rating: null });
    const { games, solution } = fixture(roster);
    const text = renderOrderText(games, roster, solution);
    expect(text).toContain('* Rating 未入力のため参加者の中央値で評価');
    // The unknown player's line must not show a zero rating.
    const line = text.split('\n').find((row) => row.startsWith('Chiba '))!;
    expect(line).not.toContain('(R0)');
  });

  it('omits the extras in compact mode', () => {
    const { games, roster, solution } = fixture();
    const text = renderOrderTextCompact(games, roster, solution);
    expect(text).not.toContain('--- 出場回数 ---');
    expect(text).not.toContain('--- 評価 ---');
    expect(text.split('\n').filter((line) => line.includes(' : '))).toHaveLength(games.length);
  });

  it('renders without a crash when a slot is empty', () => {
    const { games, roster, solution } = fixture();
    const broken = {
      ...solution,
      assignments: solution.assignments.map((assignment, index) =>
        index === 0 ? { ...assignment, playerIds: [''] } : assignment,
      ),
    };
    expect(renderOrderText(games, roster, broken)).toContain('(空席)');
  });
});
